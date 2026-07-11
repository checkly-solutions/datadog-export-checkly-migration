/**
 * Generates Playwright spec files from Datadog browser tests.
 *
 * Reads: exports/browser-tests.json
 * Outputs: checkly-migrated/tests/browser/*.spec.ts
 *
 * These spec files are designed for Checkly BrowserCheck constructs.
 *
 * Iframe handling:
 *   Datadog handles iframes transparently. element.url on each step reflects
 *   the iframe src when the element lives inside one. This generator detects
 *   URL divergence between the page context and element.url and marks those
 *   steps with an iframe-provenance comment. The step then emits through the
 *   SAME firstMatch() chain as every other step: firstMatch already probes the
 *   main page then every page.frames() frame, so one mechanism serves both. No
 *   auto-waiting frame lookup is emitted anywhere, so a zero-iframe page cannot
 *   hang.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { sanitizeFilename, sanitizeIdentifier, hasPrivateLocations, escapeTemplateLiteral, escapeString, escapeRegex, parseDatadogRegex, deriveEnginesFromDeviceIds, deviceFamily } from './shared/utils.ts';
import { trackVariablesFromMultiple, loadExistingVariableUsage, writeVariableUsageReport } from './shared/variable-tracker.ts';
import { getOutputRoot, getExportsDir } from './shared/output-config.ts';
import { FlagCollector, type MigrationFlagsFile } from './shared/migration-flags.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ElementLocator {
  url?: string;              // URL where DD found this element (iframe signal)
  targetOuterHTML?: string;
  // Human-pinned CSS/XPath override, attempted FIRST by Datadog's own runtime.
  // values is an ordered list of { type, value } and failTestOnCannotLocate maps
  // to the "If user specified locator fails, fail test" checkbox. All fields
  // optional so a step without a userLocator parses.
  userLocator?: {
    values?: Array<{ type?: string; value?: string }>;
    failTestOnCannotLocate?: boolean;
  };
  multiLocator?: {
    ro?: string;
    co?: string;
    cl?: string;
    // Class+Text XPath: the sixth Datadog strategy, present on effectively every
    // step. Optional string, sits with the class rungs.
    clt?: string;
    at?: string;
    ab?: string;
    // Shadow-DOM nested locator (its own nested multiLocator for the shadow-root
    // host), present on web-component elements. Typed defensively as an
    // unknown-shaped record so an sd-bearing step parses without crashing; it is
    // never read to build a candidate (the shadow-dom-locator flag surfaces it).
    sd?: unknown;
  };
}

interface BrowserStep {
  type: string;
  name?: string;
  allowFailure?: boolean;
  /**
   * The Datadog per-step element-retry timeout, in SECONDS. Drives the firstMatch
   * settle budget for this step via deriveSettleBudgetMs. A value of 0, undefined,
   * or negative means "no per-step override, use the test default" (Datadog stores
   * timeout: 0 to mean use-default, NOT zero milliseconds), so those are treated as
   * absent and fall through to the test's initialNavigationTimeout, then to the
   * Datadog-parity default const.
   */
  timeout?: number;
  params?: {
    value?: string;
    element?: ElementLocator;
    check?: string;
    x?: number;
    y?: number;
    subtestPublicId?: string;
    playingTabId?: number;
    request?: {
      options?: {
        extract_values?: Array<{
          name: string;
          type: string;
          parser: {
            type: string;
            value: string;
          };
          secure?: boolean;
          example?: string;
        }>;
      };
      config?: {
        request?: {
          method?: string;
          url?: string;
          body?: string;
          headers?: Record<string, string>;
          basicAuth?: {
            type?: string;
            username?: string;
            password?: string;
          };
        };
      };
    };
  };
}

interface BrowserTest {
  public_id: string;
  name: string;
  locations: string[];
  privateLocations: string[];
  originalLocations: string[];
  status?: string;
  tags?: string[];
  steps?: BrowserStep[];
  config?: {
    request?: {
      url?: string;
    };
    setCookie?: string;
    variables?: Array<{
      name: string;
      pattern: string;
      type: string;
      secure?: boolean;
      example?: string;
    }>;
  };
  options?: {
    tick_every?: number;
    retry?: {
      count?: number;
      interval?: number;
    };
    ignoreServerCertificateError?: boolean;
    /**
     * The Datadog test-level navigation timeout, in SECONDS. Used as the firstMatch
     * settle budget fallback for any step with no per-step timeout override.
     * Threaded per-step through StepFlagContext.navTimeoutSec (substeps inherit the
     * parent test's value). A value of 0, undefined, or negative means "use default"
     * and is treated as absent by deriveSettleBudgetMs, exactly like a step timeout.
     */
    initialNavigationTimeout?: number;
    /**
     * The Datadog browser device profiles this test declares (produced by the
     * step 01 export; the field lives at options.device_ids, never
     * config.device_ids). Desktop browser.viewport syntax only (chrome.laptop_large
     * style); see the shared-types JSDoc on DatadogTest.options.device_ids /
     * BrowserTest.options.device_ids. Fed to deriveEnginesFromDeviceIds in
     * generateSpecFile to decide the Playwright engine set and emit the multi-browser
     * flags.
     */
    device_ids?: string[];
  };
  isSubtest?: boolean;
  referencedBy?: string[];
}

interface Locator {
  type: string;
  value: string;
  // The rung provenance: which strategy produced this candidate. Optional so every
  // existing literal like { type: 'id', value: '#username' } stays valid.
  source?: 'userLocator' | 'role' | 'testId' | 'text' | 'attr' | 'name' | 'id' | 'class' | 'clt' | 'at' | 'ab';
  // The accessible name, populated ONLY for role candidates; consumed by the
  // generateLocatorCode role case as the getByRole { name } option.
  name?: string;
  // True when this candidate is an ab/at/clt sourced xpath that has at least one
  // stabler sibling, so it is a Datadog-recorded breadcrumb rather than a live
  // pass-if-any candidate. A static stale path cannot self-heal the way Datadog
  // recomputes it, so a live rung can silently match a coincidental wrong element (a
  // divergence, not a reproduction). withLocator partitions these out of the live
  // firstMatch chain and re-emits each as a single-line provenance comment. Left unset
  // when a candidate is live, INCLUDING the last-resort case where the ONLY candidates
  // are ab/at/clt (nothing stabler exists to demote to) and a user-pinned userLocator
  // xpath (the exemption keys on source, never on type).
  provenanceOnly?: boolean;
}

/**
 * Per-step flag context threaded through the generator call tree, mirroring the
 * existing usedVarNames threading discipline (never a module-level mutable
 * binding). One collector is created per step-07 run in main() and passed by
 * reference; publicId and stepIndex identify the originating check and step so a
 * fired flag attributes correctly (the substep case keeps the PARENT publicId).
 */
export interface StepFlagContext {
  collector: FlagCollector;
  publicId: string;
  stepIndex: number;
  /**
   * The per-spec set of already-taken variable/const names, threaded from
   * generateSpecFile so a hoisted multi-candidate factory const (withLocator)
   * dedupes against every other emitted name via uniqueVarName. Optional so every
   * existing call site that constructs a StepFlagContext without it stays valid;
   * withLocator falls back to a fresh empty set when it is absent.
   */
  usedVarNames?: Set<string>;
  /**
   * Per-spec secret-routing state, threaded from generateSpecFile with the same
   * optional discipline as usedVarNames. `used` is the per-check collision ledger
   * the derivePasswordEnvKey ladder disambiguates against (seeded with existing
   * config-variable names so a derived key never rebinds an existing variable);
   * `routed` accumulates the derived keys in step order, which generateSpecFile
   * returns and writes into the _manifest.json files[].secretKeys entry for step 08
   * to declare construct-side. Optional so every existing call site that constructs
   * a StepFlagContext without it stays valid; generateTypeText falls back to a fresh
   * local state object when it is absent so direct emitter tests still dedupe within
   * the single call.
   */
  secretKeys?: { used: Set<string>; routed: string[] };
  /**
   * The test-level navigation timeout in SECONDS (options.initialNavigationTimeout),
   * threaded from generateSpecFile at every per-step ctx construction (including the
   * substep ctx, which inherits the PARENT test's value). withLocator reads this as
   * the fallback settle-budget source when a step carries no per-step timeout.
   * Optional with the same discipline as usedVarNames/secretKeys so every existing
   * call site that constructs a StepFlagContext without it stays valid;
   * deriveSettleBudgetMs treats an absent (or 0/negative) value the same way,
   * returning null so the call site emits the byte-stable two-argument firstMatch
   * form.
   */
  navTimeoutSec?: number;
  /**
   * Per-spec set of local variable names visible to variable interpolation.
   * Mutable because a runApiTest extract_values registers new names mid-spec that
   * later steps (including inlined substeps) must resolve as `${name}` rather than
   * `${process.env.name}`. One shared Set instance per spec, never a copy, so a
   * name registered by an earlier step is visible to every later step. Optional so
   * every existing call site (and Partial-built tool-test contexts) stays valid;
   * when absent, interpolation behaves as an empty set.
   */
  localVarNames?: Set<string>;
  /**
   * Per-spec API-response counter box. An object (not a bare number) so the
   * increment propagates by reference across the whole call tree, mirroring the
   * secretKeys object pattern; the first runApiTest in a spec emits `apiResponse`,
   * the second `apiResponse2`, and inlined substeps continue the parent numbering.
   * Optional so every existing call site stays valid; when absent, a call derives a
   * throwaway box and starts fresh.
   */
  apiResponse?: { counter: number };
  /**
   * Subtest public_id to test-data map for playSubTest inlining, built per run in
   * main(). Optional so every existing call site (and Partial-built tool-test
   * contexts) stays valid; when absent, playSubTest falls through to its not-found
   * branch.
   */
  subtests?: ReadonlyMap<string, BrowserTest>;
}

/**
 * Datadog key-name to Playwright KeyboardEvent.key alias map.
 *
 * A frozen module-level lookup table (mirrors the FREQUENCY_MAP idiom in
 * src/shared/utils.ts; a const table is not mutable module state). Keys are
 * lowercased so lookup is case-insensitive; values are the canonical
 * KeyboardEvent.key strings Playwright's page.keyboard.press() accepts, verified
 * against the Datadog synthetics actions docs, MDN Key_Values, the in-repo
 * Playwright skill, and live Playwright docs. Space maps to a single space
 * character (its KeyboardEvent.key value). Already-canonical names (Enter, Tab,
 * Escape, ArrowUp, ...) round-trip through the lowercased key. F-keys and single
 * printable characters are handled in generatePressKey by pattern, not by rows.
 */
const PRESS_KEY_ALIAS_MAP: Readonly<Record<string, string>> = Object.freeze({
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  space: ' ',
  spacebar: ' ',
  arrowup: 'ArrowUp',
  up: 'ArrowUp',
  arrowdown: 'ArrowDown',
  down: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  left: 'ArrowLeft',
  arrowright: 'ArrowRight',
  right: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  insert: 'Insert',
});

/**
 * Set-Cookie attribute-token predicate. Pure, side-effect free.
 *
 * Returns true when a trimmed Set-Cookie token is a cookie attribute (Secure,
 * HttpOnly, Path=, Expires=, Domain=, SameSite=, Max-Age, Priority) rather than
 * the cookie's own name=value pair, so the caller can filter it out. Anchored at
 * the token start and case-insensitive; each attribute is accepted both bare and
 * with an `=`-value, and the token must be exactly the attribute name or the name
 * followed by `=`, so a real cookie whose name only starts with one of these
 * (e.g. path2, secureToken) is NOT filtered.
 */
const COOKIE_ATTRIBUTE_TOKEN_REGEX = /^(secure|httponly|path|expires|domain|samesite|max-age|priority)(=|$)/i;

function isCookieAttributeToken(token: string): boolean {
  return COOKIE_ATTRIBUTE_TOKEN_REGEX.test(token.trim());
}

interface GeneratedFile {
  logicalId: string;
  name: string;
  filename: string;
  stepCount: number;
  hasIframes: boolean;
  // True when any locator-consuming step in this spec resolved two or more
  // candidates (an emitted firstMatch chain). Mirrors hasIframes byte-for-byte in
  // style; src/08 reads it from _manifest.json to append the reviewMultiSelector tag.
  hasMultiCandidate: boolean;
  // Derived env-var keys this spec routed type="password" fills to, in step order.
  // Mirrors hasMultiCandidate's manifest-transport style: src/08 reads it from
  // _manifest.json to declare construct-side environmentVariables as
  // { key, value: "", secret: true }. Empty when the spec has no password steps.
  // Deterministic: same export always yields the same keys.
  secretKeys: string[];
  // The deduped canonical-order Playwright engine list derived from
  // options.device_ids. Mirrors secretKeys' manifest-transport style: src/08 reads
  // it from _manifest.json to branch BrowserCheck vs PlaywrightCheck and src/12
  // reads it for the multi-browser report section. Empty when no device_ids are
  // declared.
  pwEngines: string[];
}

interface GenerationResult {
  successCount: number;
  errorCount: number;
  iframeTestCount: number;
  iframeStepCount: number;
  // Count of specs whose emitted body references the co-located firstMatch helper
  // symbol (multi-candidate chains, including iframe-classified element steps folded
  // into the same chain). main() gates the helpers.ts write on this being greater
  // than zero across both passes.
  helperImportTestCount: number;
}

/** Stored per iframe-step so we can log the source URL */
interface IframeContext {
  iframeSrc: string;
}

// ---------------------------------------------------------------------------
// Iframe detection helpers
// ---------------------------------------------------------------------------

/**
 * Check if a URL is an auth/SSO redirect (not an iframe).
 */
export function isAuthRedirectUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return /(?:login\.|identity\.|auth\.|oauth|okta|sso)/.test(hostname);
  } catch {
    return false;
  }
}

/**
 * Check if a URL path contains known iframe patterns.
 */
export function isKnownIframeUrl(elementUrl: string): boolean {
  try {
    const urlPath = new URL(elementUrl).pathname.toLowerCase();
    return /\/(frames|embed|widget)\//.test(urlPath);
  } catch {
    return false;
  }
}

/**
 * Extract the pathname from a URL (for logging).
 */
export function extractIframeSrcPath(elementUrl: string): string {
  try {
    return new URL(elementUrl).pathname;
  } catch {
    return elementUrl;
  }
}

/**
 * Get the first meaningful path segment from a URL.
 * e.g. "/awaf-profile/" → "awaf-profile", "/CipherWeb/admin/..." → "CipherWeb"
 */
export function getFirstPathSegment(urlStr: string): string {
  try {
    const segments = new URL(urlStr).pathname.split('/').filter(Boolean);
    return segments[0] || '';
  } catch {
    return '';
  }
}

/**
 * Decide whether a same-origin divergent element step INTERLEAVES with the current
 * page context. The physical rationale: a frame's content coexists with the host
 * page, so genuine in-frame steps ALTERNATE with host-page steps; a client-side
 * navigation moves the whole context forward and does not come back.
 *
 * Interleaving is true when a later element step returns to the current context's
 * first path segment (contextSegment) WITHOUT an intervening goToUrl to the
 * divergent segment. If instead the flow moves forward and never returns (or an
 * explicit goToUrl re-bases the context to the divergent segment first), it is
 * client-side navigation, not a frame boundary.
 *
 * Pure and deterministic: a single forward scan from divergentIndex+1, no
 * wall-clock, no randomness.
 */
function isDivergentStepInterleaved(
  steps: BrowserStep[],
  divergentIndex: number,
  contextSegment: string,
  divergentSegment: string,
): boolean {
  for (let j = divergentIndex + 1; j < steps.length; j++) {
    const later = steps[j];

    // A goToUrl to the divergent segment re-bases the whole context there, so any
    // subsequent return to contextSegment is a fresh navigation, not interleaving.
    if (later.type === 'goToUrl') {
      if (getFirstPathSegment(later.params?.value || '') === divergentSegment) return false;
      continue;
    }

    const laterUrl = later.params?.element?.url;
    if (!laterUrl) continue;
    if (isAuthRedirectUrl(laterUrl)) continue;

    const laterSegment = getFirstPathSegment(laterUrl);
    // A later element step back on the current context segment means the divergent
    // step sat between two host-page steps: genuine interleaving.
    if (laterSegment === contextSegment) return true;
  }
  return false;
}

/**
 * Pre-analyze all steps to detect which ones target elements inside iframes.
 *
 * Detection rules (applied per step that has element.url):
 *   1. Auth/SSO URLs are temporary redirects: skip, do not update page context.
 *   2. Same URL as current page context: not an iframe.
 *   3. Known iframe URL path patterns (/frames/, /embed/, /widget/): iframe.
 *   4. Different hostname from current page context: cross-origin iframe.
 *   5. Same origin, first path segment diverges from the CURRENT page context, and
 *      the divergent context INTERLEAVES with the current context (a later element
 *      step returns to the current segment with no intervening goToUrl to the
 *      divergent segment): iframe. A divergence that simply moves forward and does
 *      not return is client-side (SPA) navigation, not a frame boundary.
 *   6. Same origin, no interleaving: page navigation, update the context to the
 *      new url and its first segment.
 *
 * The context first segment is MAINTAINED (recomputed as the context updates), never
 * the stale start-url segment: comparing against a stale segment over-classifies
 * later same-origin steps as iframes.
 */
export function analyzeStepsForIframes(
  startUrl: string | undefined,
  steps: BrowserStep[]
): Map<number, IframeContext> {
  const result = new Map<number, IframeContext>();

  let currentPageUrl = startUrl || '';
  let currentPageHostname = '';
  try {
    currentPageHostname = new URL(currentPageUrl).hostname;
  } catch { /* ignore */ }
  // Maintained current-context first segment (recomputed as the context updates),
  // never the stale start-url segment (which over-classifies later steps as iframes).
  let currentFirstSegment = getFirstPathSegment(currentPageUrl);

  let seenAuthSteps = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // goToUrl steps update the current page URL and its maintained first segment.
    if (step.type === 'goToUrl') {
      const goUrl = step.params?.value || '';
      currentPageUrl = goUrl;
      try { currentPageHostname = new URL(goUrl).hostname; } catch { /* ignore */ }
      currentFirstSegment = getFirstPathSegment(goUrl);
      continue;
    }

    const elementUrl = step.params?.element?.url;
    if (!elementUrl) continue;

    // Rule 1: Auth/SSO, skip
    if (isAuthRedirectUrl(elementUrl)) {
      seenAuthSteps = true;
      continue;
    }

    let elementHostname = '';
    try { elementHostname = new URL(elementUrl).hostname; } catch { continue; }

    // Rule 2: Same URL, not an iframe
    if (elementUrl === currentPageUrl) continue;

    // Rule 3: Known iframe URL patterns (/frames/, /embed/, /widget/). Precedence is
    // unchanged: a known iframe path classifies regardless of interleaving.
    if (isKnownIframeUrl(elementUrl)) {
      result.set(i, { iframeSrc: elementUrl });
      continue;
    }

    // Rule 4: Cross-origin, iframe (unchanged)
    if (elementHostname !== currentPageHostname && currentPageHostname) {
      result.set(i, { iframeSrc: elementUrl });
      continue;
    }

    // Rule 5: Same origin, post-auth path divergence from the CURRENT context, but
    // only when the divergent context INTERLEAVES with the current context. A
    // forward-only divergence (SPA client navigation) is NOT a frame boundary.
    const elementFirstSegment = getFirstPathSegment(elementUrl);
    if (
      seenAuthSteps &&
      currentFirstSegment &&
      elementFirstSegment !== currentFirstSegment &&
      isDivergentStepInterleaved(steps, i, currentFirstSegment, elementFirstSegment)
    ) {
      result.set(i, { iframeSrc: elementUrl });
      continue;
    }

    // Rule 6: Same origin, no interleaving, page navigation. Update the context url
    // AND its maintained first segment so the next divergence check compares against
    // where the flow actually is, not where it started.
    currentPageUrl = elementUrl;
    currentFirstSegment = elementFirstSegment;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Shared helpers file (written once, imported by specs that need it)
// ---------------------------------------------------------------------------

/**
 * The emitted co-located helpers module.
 *
 * Written once to tests/browser/helpers.ts and imported by specs that reference
 * a helper symbol (gated on actual use). This is CODE THAT RUNS in the Checkly
 * runtime (Playwright / Node 22, Chromium-only): wall-clock reads and bounded
 * waits are correct and expected HERE. The tool's determinism rules govern the
 * migration tool and its tool tests, not this emitted runtime source.
 *
 * firstMatch() regenerates Datadog's self-healing multiLocator behavior: it
 * probes an ordered list of candidate locators with an INSTANT count (count
 * returns immediately with no auto-wait), returning the first candidate that
 * matches, main-page rungs first then every currently-existing frame from the
 * synchronous frame snapshot, so a zero-iframe page adds zero wait and no rung
 * calls an auto-waiting frame lookup. On a first miss it runs one bounded settle
 * loop for late-rendering frames and DOM, then on true exhaustion returns the
 * PRIMARY main-page candidate so Playwright's own auto-wait throws a real,
 * debuggable TimeoutError that names the intended selector, and it emits the
 * MIGRATION-LOCATOR-EXHAUSTION token as a boxed test.step plus a console.error
 * breadcrumb. That token is the single greppable locator-exhaustion marker for
 * humans and Checkly Rocky AI, baked into generated source rather than an API tag.
 *
 * firstMatch is the ONLY exported locator mechanism: there is no separate
 * frame-scanning helper (an auto-waiting frame-lookup body hangs on zero-iframe
 * pages). Iframe-classified steps fold into this same chain via its page.frames()
 * rung, so the module exports firstMatch and the exhaustion token only, and no
 * rung anywhere calls an auto-waiting frame lookup.
 */
export const SHARED_HELPERS_SOURCE = `import { test, type Page, type Frame, type Locator } from "@playwright/test";

/**
 * The front-loaded, greppable locator-exhaustion marker. Baked into generated
 * source so it surfaces in run logs, traces, and to Checkly Rocky AI without any
 * runtime tagging capability. The assertion helper (assertOnFirstMatch) reuses this
 * identical string, so it lives here as the one source of truth.
 */
export const LOCATOR_EXHAUSTION_TOKEN = "MIGRATION-LOCATOR-EXHAUSTION";

/**
 * The candidate-factory signature firstMatch and assertOnFirstMatch already accept
 * (root: Page | Frame) => Locator[]. Exporting it as a named alias lets each
 * multi-candidate spec annotate its hoisted factory const so root stays
 * contextually typed WITHOUT the spec naming Page, Frame, or Locator itself (those
 * types are imported by this module on line 1, not by the spec). Migrated specs
 * are hand-edited after migration; a named type on each factory keeps the intent
 * readable.
 */
export type CandidateFactory = (root: Page | Frame) => Locator[];

/**
 * Datadog-parity default settle budget for the bounded exhaustion rescan, in
 * milliseconds, used when a step carries no per-step or navigation timeout in the
 * export. Datadog retries locating a step's element for 60 seconds by default,
 * adjustable up to 300 seconds, so 60000 matches that heal window. firstMatch takes
 * the budget as a parameter defaulting to this const; a timeout-bearing step passes
 * a value derived from its export timeout, a timeout-less step inherits this
 * default. This is the ONLY wait firstMatch ever spends, and it is explicit and
 * numeric: a defaulted retry-until-pass helper would mean an INFINITE timeout,
 * reintroducing the unbounded-wait hang this design exists to remove.
 */
const EXHAUSTION_RESCAN_BUDGET_MS = 60000;

/** Backoff intervals between rescan passes, in milliseconds; the sum stays within the budget. */
const RESCAN_INTERVALS_MS = [100, 250, 500, 1000];

/**
 * Regenerate Datadog's self-healing multiLocator: probe an ordered candidate list
 * with instant count() and return the first that matches, main page first then
 * every frame, with a bounded settle rescan and a primary-candidate fallback on
 * exhaustion. See the module JSDoc for the full contract.
 *
 * @param page - The Playwright page under test.
 * @param makeCandidates - A factory that, given a root (the page or a frame),
 *   returns the ordered Locator[] to probe against that root, highest priority
 *   first.
 * @param budgetMs - The total settle budget in milliseconds. Defaults to the
 *   Datadog-parity const; a timeout-bearing step passes a value derived from its
 *   export timeout. Defensively capped at 240000 (Checkly's hard limit) inside the
 *   body so a hostile or absurd value can never produce an unbounded wait.
 * @returns The first matching locator (strict-safe via .first()); on exhaustion the
 *   candidate that attaches first within the remaining budget (the candidate
 *   likeliest to resolve), or the primary main-page candidate when nothing attaches.
 */
export async function firstMatch(page: Page, makeCandidates: (root: Page | Frame) => Locator[], budgetMs: number = EXHAUSTION_RESCAN_BUDGET_MS): Promise<Locator> {
  // Defensive cap: the budget is a derived-from-export number, so bound it at
  // Checkly's hard 240000ms browser-check limit before spending any of it. This
  // keeps every wait bounded and numeric even for an absurd export timeout.
  const cappedBudgetMs = Math.min(budgetMs, 240000);
  const tried: string[] = [];

  // One pass: main-page rungs first (instant count() probes), then every non-main
  // frame from the synchronous page.frames() snapshot. Returns the first match, or
  // null when nothing matched this pass.
  const scanOnce = async (): Promise<Locator | null> => {
    for (const loc of makeCandidates(page)) {
      tried.push(loc.toString());
      if ((await loc.count()) > 0) return loc.first();
    }
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      for (const loc of makeCandidates(frame)) {
        tried.push(loc.toString());
        if ((await loc.count()) > 0) return loc.first();
      }
    }
    return null;
  };

  const first = await scanOnce();
  if (first) return first;

  // Bounded settle loop: give late-rendering frames and DOM a chance, within the
  // capped numeric budget.
  let spent = 0;
  for (const interval of RESCAN_INTERVALS_MS) {
    if (spent >= cappedBudgetMs) break;
    await page.waitForTimeout(interval);
    spent += interval;
    const hit = await scanOnce();
    if (hit) return hit;
  }

  // Attach-race phase: the instant-count ladder found nothing, but a candidate may
  // simply be slow to attach. Spend the REMAINING
  // budget racing ALL candidates (main page first, then every current frame) for
  // first-attached and return the winner, the candidate likeliest to resolve. This
  // fixes the false-fail where a slow element matchable only by a NON-primary
  // candidate would otherwise be abandoned in favor of the primary. Every wait
  // stays bounded (the per-racer timeout is the remaining budget); a rejection
  // suppressor on each racer keeps a losing waitFor timeout from surfacing as an
  // unhandled rejection.
  const remaining = cappedBudgetMs - spent;
  if (remaining > 0) {
    const racers: Promise<Locator>[] = [];
    const addRacers = (root: Page | Frame): void => {
      for (const loc of makeCandidates(root)) {
        const candidate = loc.first();
        const p = candidate.waitFor({ state: "attached", timeout: remaining }).then(() => candidate);
        p.catch(() => {});
        racers.push(p);
      }
    };
    addRacers(page);
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      addRacers(frame);
    }
    if (racers.length > 0) {
      try {
        return await Promise.any(racers);
      } catch {
        // Nothing attached within the remaining budget; fall through to exhaustion.
      }
    }
  }

  // True exhaustion: emit the greppable signal as a boxed test.step plus a
  // console.error breadcrumb, then return the PRIMARY main-page candidate so the
  // caller's action produces a real native TimeoutError naming the intended
  // selector. The helper never throws here: a late-appearing element can still
  // succeed via the terminal action's own auto-wait.
  const summary = \`\${LOCATOR_EXHAUSTION_TOKEN}: no locator matched after \${tried.length} candidate probe(s)\`;
  await test.step(summary, async () => {
    console.error(\`[\${LOCATOR_EXHAUSTION_TOKEN}] tried candidates: \${tried.join(" | ")}\`);
  }, { box: true });
  return makeCandidates(page)[0].first();
}

/**
 * Per-attempt bound for a positive multi-candidate assertion probe, in
 * milliseconds. Explicit and numeric for the same reason firstMatch's budget is: a
 * defaulted expect timeout on a probe attempt would be Playwright's global default,
 * and a defaulted toPass would be infinite. Every non-final probe carries this
 * bound; only the final attempt runs uncaught with no override so the native
 * assertion error surfaces intact.
 */
const PROBE_ASSERT_TIMEOUT_MS = 2500;

/**
 * Positive multi-candidate assertion self-healing. Datadog's multiLocator is N
 * ways to find the SAME element, so a positive assertion is
 * faithfully reproduced by trying each resolving candidate in priority order and
 * passing on the FIRST that satisfies the assertion. This is the assertion-level
 * analogue of firstMatch and it REPLACES the silent narrow-to-first weakening: a
 * fallback candidate can now rescue an assertion that the primary candidate would
 * have failed, exactly as Datadog's own healing would.
 *
 * Candidate collection mirrors firstMatch's rung order: main page first, then every
 * currently-existing frame from the synchronous page.frames() snapshot, keeping only
 * candidates that resolve (count greater than zero). Each non-final resolving
 * candidate is probed with an explicit PROBE_ASSERT_TIMEOUT_MS bound, catching the
 * failure and continuing. The FINAL attempt runs uncaught with no timeout override
 * so the native assertion TimeoutError surfaces with its real message. When every
 * earlier resolving candidate failed, or when ZERO candidates resolve (the final
 * attempt then runs against the primary main-page candidate), it first emits the
 * SAME greppable exhaustion signal firstMatch does, reusing LOCATOR_EXHAUSTION_TOKEN.
 *
 * @param page - The Playwright page under test.
 * @param makeCandidates - The same (root) => Locator[] factory firstMatch takes.
 * @param assertion - An async callback receiving a resolved Locator and an OPTIONAL
 *   timeout; on a probe attempt the timeout is PROBE_ASSERT_TIMEOUT_MS, on the final
 *   attempt it is undefined (native default). The callback runs the actual matcher.
 */
export async function assertOnFirstMatch(
  page: Page,
  makeCandidates: (root: Page | Frame) => Locator[],
  assertion: (el: Locator, timeout?: number) => Promise<void>,
): Promise<void> {
  // Collect resolving candidates in firstMatch's rung order: main page, then frames.
  const resolving: Locator[] = [];
  const tried: string[] = [];
  const collectFrom = async (root: Page | Frame): Promise<void> => {
    for (const loc of makeCandidates(root)) {
      tried.push(loc.toString());
      if ((await loc.count()) > 0) resolving.push(loc.first());
    }
  };
  await collectFrom(page);
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    await collectFrom(frame);
  }

  // The final attempt runs against the last resolving candidate, or the primary
  // main-page candidate when nothing resolved (so the caller still gets a real,
  // debuggable native error rather than a silent skip).
  const attempts = resolving.length > 0 ? resolving : [makeCandidates(page)[0].first()];

  for (let i = 0; i < attempts.length - 1; i++) {
    const candidate = attempts[i];
    try {
      await assertion(candidate, PROBE_ASSERT_TIMEOUT_MS);
      return;
    } catch {
      // This candidate did not satisfy the assertion; try the next one.
    }
  }

  // Exhaustion path: every earlier resolving candidate failed, or nothing resolved.
  // Emit the SAME distinctive signal firstMatch uses (one token const, no drift),
  // then run the final attempt uncaught so the native assertion error surfaces.
  if (resolving.length !== 1) {
    const summary = \`\${LOCATOR_EXHAUSTION_TOKEN}: no candidate satisfied the assertion after \${tried.length} probe(s)\`;
    await test.step(summary, async () => {
      console.error(\`[\${LOCATOR_EXHAUSTION_TOKEN}] assertion probed candidates: \${tried.join(" | ")}\`);
    }, { box: true });
  }
  const finalCandidate = attempts[attempts.length - 1];
  await assertion(finalCandidate);
}
`;

// ---------------------------------------------------------------------------
// Variable handling
// ---------------------------------------------------------------------------

export function extractVariableContent(test: BrowserTest): string[] {
  const content: string[] = [];
  if (test.config?.request?.url) content.push(test.config.request.url);
  for (const step of test.steps || []) {
    if (step.params?.value) content.push(step.params.value);
    if (step.params?.request?.config?.request?.url) {
      content.push(step.params.request.config.request.url);
    }
  }
  return content;
}

export function convertVariables(str: string, localVarNames?: ReadonlySet<string>): string {
  if (!str) return str;
  return str.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, varName) => {
    if (localVarNames?.has(varName)) return `\${${varName}}`;
    return `\${process.env.${varName}}`;
  });
}

/**
 * Generation-time moment-token table. Each entry maps a moment display-format
 * token to the JS Date accessor expression evaluated against a `const d` inside the
 * emitted date IIFE. Month and weekday names use the en-US locale accessor because
 * Datadog renders English month/day names; a non-English locale is out of scope
 * here.
 *
 * The table is deliberately explicit so "recognized-but-unmapped" (Do, in the
 * tokenizer but with no entry here) is distinguishable from "unrecognized" (any
 * other alphabetic run). Both route to the date-token-unknown passthrough.
 * Source: moment.js display-format spec.
 */
const MOMENT_TOKENS: Record<string, string> = {
  YYYY: 'String(d.getFullYear())',
  YY:   'String(d.getFullYear()).slice(-2)',
  MMMM: "d.toLocaleString('en-US',{month:'long'})",
  MMM:  "d.toLocaleString('en-US',{month:'short'})",
  MM:   "String(d.getMonth()+1).padStart(2,'0')",
  M:    'String(d.getMonth()+1)',
  DD:   "String(d.getDate()).padStart(2,'0')",
  D:    'String(d.getDate())',
  dddd: "d.toLocaleString('en-US',{weekday:'long'})",
  ddd:  "d.toLocaleString('en-US',{weekday:'short'})",
  dd:   "d.toLocaleString('en-US',{weekday:'short'}).slice(0,2)",
  HH:   "String(d.getHours()).padStart(2,'0')",
  H:    'String(d.getHours())',
  hh:   "String(((d.getHours()+11)%12)+1).padStart(2,'0')",
  h:    'String(((d.getHours()+11)%12)+1)',
  mm:   "String(d.getMinutes()).padStart(2,'0')",
  m:    'String(d.getMinutes())',
  ss:   "String(d.getSeconds()).padStart(2,'0')",
  s:    'String(d.getSeconds())',
  A:    "(d.getHours()<12?'AM':'PM')",
  a:    "(d.getHours()<12?'am':'pm')",
};

/**
 * Longest-match-first tokenizer for moment formats. Matches a bracketed literal
 * first, then tokens ordered longest-first so MMMM never
 * degrades to MMM and M never eats the Ms inside MMM. `Do` is IN the recognized
 * set even though it has no MOMENT_TOKENS entry (so it flags as unknown rather
 * than tokenizing as D + o). Built with string escapes only, no raw control
 * bytes (generator-encoding hazard).
 */
const MOMENT_TOKEN_RE = /(\[[^\]]*\]|YYYY|YY|MMMM|MMM|MM|M|DD|Do|D|dddd|ddd|dd|HH|H|hh|h|mm|m|ss|s|A|a)/g;

/**
 * Convert a Datadog local variable pattern to a JS expression.
 * Handles: alphanumeric(N), alphabetic(N), numeric(N), uuid,
 *          timestamp(N, fmt), date(N, fmt)
 *
 * @param pattern - The raw Datadog pattern text (may contain multiple tokens).
 * @param unknownTokens - Optional out-param: any moment token outside the
 *   MOMENT_TOKENS table (recognized-but-unmapped like Do, or unrecognized runs
 *   like Q) is pushed here, deduplicated within one call, so the caller can emit
 *   a single date-token-unknown flag. Existing call sites omit it.
 */
export function convertPatternToJs(pattern: string, unknownTokens?: string[]): string {
  const chars: Record<string, string> = {
    alphanumeric: `'abcdefghijklmnopqrstuvwxyz0123456789'`,
    alphabetic: `'abcdefghijklmnopqrstuvwxyz'`,
    numeric: `'0123456789'`,
  };

  // Replace each {{ func(args) }} or {{ func }} token with a JS expression
  const js = pattern.replace(/\{\{\s*(\w+)(?:\(([^)]*)\))?\s*\}\}/g, (_, func, args) => {
    const fn = func.toLowerCase();
    if (fn === 'uuid') {
      return `' + crypto.randomUUID() + '`;
    }
    if (chars[fn]) {
      const len = parseInt(args?.trim() || '10', 10);
      return `' + Array.from({ length: ${len} }, () => ${chars[fn]}[Math.floor(Math.random() * ${chars[fn]}.length)]).join('') + '`;
    }
    if (fn === 'timestamp') {
      const offset = parseInt(args?.split(',')[0]?.trim() || '0', 10);
      return `' + String(Date.now() + ${offset * 1000}) + '`;
    }
    if (fn === 'date') {
      // Split the args on the FIRST comma only. The offset/format separator and the
      // format's own commas are the same character; splitting on every comma drops
      // everything after the format comma, so date(0d,MMM D, YYYY) would lose
      // ", YYYY". Everything after the first comma is the format, verbatim (single
      // trim only).
      const raw = args || '0';
      const firstComma = raw.indexOf(',');
      const offsetPart = firstComma === -1 ? raw : raw.slice(0, firstComma);
      const fmt = firstComma === -1 ? '' : raw.slice(firstComma + 1).trim();
      const offsetDays = parseInt(offsetPart.trim() || '0', 10);
      if (fmt) {
        // Tokenize the format left-to-right, longest-match-first. Each mapped
        // token becomes its Date accessor expression; a bracketed [literal] and
        // every non-token chunk become JSON.stringify-quoted literals so a
        // hostile format (quotes, backslashes) cannot break out of the emitted
        // string; a recognized-but-unmapped token (Do) or an unrecognized
        // alphabetic run (Q) passes through as a quoted literal AND is reported via
        // unknownTokens (never silent).
        const dateExpr = buildDateExpr(fmt, offsetDays, unknownTokens);
        return `' + ${dateExpr} + '`;
      }
      return `' + new Date(Date.now() + ${offsetDays} * 86400000).toISOString().split('T')[0] + '`;
    }
    // Unknown function — leave a placeholder
    return `' + '' /* TODO: unsupported Datadog pattern: ${func}(${args || ''}) */ + '`;
  });

  // Clean up concatenation artifacts from the replacements
  return `'${js}'`.replace(/' \+ '/g, '');
}

/**
 * Build the emitted date IIFE body for a moment format string.
 *
 * Returns a self-contained IIFE expression of the shape
 * `(() => { const d = new Date(Date.now() + <days> * 86400000); return <piece> + <piece> + ...; })()`
 * where each piece is either a MOMENT_TOKENS accessor expression or a
 * JSON.stringify-quoted literal. The pieces are joined with ` + ` so the emitted
 * spec stays a single readable concatenation.
 *
 * Tokenization is longest-match-first via MOMENT_TOKEN_RE, consuming the format
 * left-to-right so each character belongs to exactly one token:
 *   - mapped token           -> its accessor expression;
 *   - bracketed [literal]     -> JSON.stringify of the inner text (brackets stripped);
 *   - recognized-but-unmapped -> JSON.stringify passthrough + reported unknown (Do);
 *   - literal chunk between matches -> JSON.stringify verbatim; any alphabetic run
 *     inside such a chunk is an unrecognized token (Q) -> reported unknown too.
 * Unknown tokens are pushed onto unknownTokens, deduped within this one format.
 *
 * @param fmt - The moment format string (already stripped of the offset).
 * @param offsetDays - The day offset applied to Date.now().
 * @param unknownTokens - Optional out-param collecting unmapped/unrecognized tokens.
 */
function buildDateExpr(fmt: string, offsetDays: number, unknownTokens?: string[]): string {
  const pieces: string[] = [];
  const reportUnknown = (token: string) => {
    if (unknownTokens && !unknownTokens.includes(token)) unknownTokens.push(token);
  };

  // Emit a literal chunk (never a moment token). Any alphabetic run inside it is
  // an unrecognized moment token: report it, but still pass the whole chunk through
  // verbatim so the output is deterministic.
  const emitLiteralChunk = (chunk: string) => {
    if (chunk === '') return;
    for (const m of chunk.match(/[A-Za-z]+/g) || []) reportUnknown(m);
    pieces.push(JSON.stringify(chunk));
  };

  MOMENT_TOKEN_RE.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MOMENT_TOKEN_RE.exec(fmt)) !== null) {
    // Literal text between the previous match and this one.
    emitLiteralChunk(fmt.slice(lastIndex, match.index));

    const token = match[0];
    if (token.startsWith('[') && token.endsWith(']')) {
      // Bracketed literal: emit the inner text verbatim, brackets stripped.
      pieces.push(JSON.stringify(token.slice(1, -1)));
    } else if (MOMENT_TOKENS[token]) {
      pieces.push(MOMENT_TOKENS[token]);
    } else {
      // Recognized-but-unmapped token (Do): passthrough + report.
      reportUnknown(token);
      pieces.push(JSON.stringify(token));
    }
    lastIndex = MOMENT_TOKEN_RE.lastIndex;
  }
  // Trailing literal after the final match.
  emitLiteralChunk(fmt.slice(lastIndex));

  const body = pieces.length > 0 ? pieces.join(' + ') : '""';
  return `(() => { const d = new Date(Date.now() + ${offsetDays} * 86400000); return ${body}; })()`;
}

// ---------------------------------------------------------------------------
// Locator extraction
// ---------------------------------------------------------------------------

/**
 * Extensible denylist of dynamic-id RegExp shapes. Belt-and-suspenders, NEVER
 * exhaustive: a new dynamic-id scheme (Angular ng-, React :r0:, MUI mui-<N>, ...)
 * will always slip through. The durable half of the fix is DEMOTION (raw id ranks
 * below role/text/attr in extractLocator, so a dynamic id is only chosen when
 * nothing stabler exists); this denylist just prunes known-bad shapes. There is
 * intentionally NO literal allowlist: the denylist is precision-tested so semantic
 * ids (email, password, submit-button, okta-signin-submit) survive without being
 * enumerated.
 */
export const DYNAMIC_ID_PATTERNS: readonly RegExp[] = [
  /^input\d+$/,                                                   // Okta classic widget input<N>
  /-\d{10,}-/,                                                    // any 10+-digit timestamp segment
  /^rc-menu-uuid-/,                                               // antd rc-menu, regenerated every render
  /^pendo-/,                                                      // Pendo guide ids (hex suffix rotates)
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // full GUID (8-4-4-4-12)
];

/**
 * True when an id matches a known dynamic/hashed shape and must be rejected as a
 * candidate. Tests the id against DYNAMIC_ID_PATTERNS. Pure.
 */
export function isDynamicId(id: string): boolean {
  return DYNAMIC_ID_PATTERNS.some((pattern) => pattern.test(id));
}

/** Standard HTML tag names, for the bare-tag skip in rewriteUserLocatorValue and role derivation. */
const STANDARD_HTML_TAGS = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'blockquote', 'body',
  'button', 'canvas', 'caption', 'cite', 'code', 'col', 'colgroup', 'dd', 'details',
  'dialog', 'div', 'dl', 'dt', 'em', 'fieldset', 'figcaption', 'figure', 'footer',
  'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'html', 'i', 'iframe',
  'img', 'input', 'label', 'legend', 'li', 'main', 'nav', 'ol', 'optgroup', 'option',
  'p', 'pre', 'section', 'select', 'small', 'span', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'video',
]);

/** Tag-to-implicit-role map, for elements with no explicit role= attribute. */
const IMPLICIT_ROLE_BY_TAG: Readonly<Record<string, string>> = {
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
  button: 'button', img: 'img', select: 'combobox', textarea: 'textbox',
};

/**
 * Derive a role-scoped candidate from targetOuterHTML ONLY. The role comes from an
 * explicit role= attribute or a small tag-to-implicit-role map (a[href] -> link,
 * h1..h6 -> heading, button -> button, img -> img, select -> combobox, textarea ->
 * textbox, input[type=submit|button] -> button, other input -> textbox). The
 * accessible name comes ONLY from targetOuterHTML in preference order aria-label,
 * inner text, alt, title, then value on button-type inputs; original case is
 * preserved. Returns null when no name derives, because a nameless role rung is
 * weaker than the text rung and is skipped. NEVER reads multiLocator.ro: observed
 * ro values encode zero real ARIA roles (they are always xpaths). The ro channel is
 * read only by the separate defensive deriveRoRoleCandidate rung, which stays silent
 * on every observed shape; this function itself never reads ro. Pure.
 */
export function deriveRoleCandidate(targetHtml: string): { role: string; name: string } | null {
  if (!targetHtml) return null;

  const tagMatch = targetHtml.match(/^\s*<([a-zA-Z][a-zA-Z0-9]*)/);
  const tag = tagMatch ? tagMatch[1].toLowerCase() : '';

  // Role: explicit role= attribute wins; else the tag's implicit role.
  const explicitRole = targetHtml.match(/(?:^|\s)role="([^"]+)"/);
  let role = explicitRole ? explicitRole[1].trim() : '';
  if (!role) {
    if (tag === 'a' && /(?:^|\s)href="/.test(targetHtml)) {
      role = 'link';
    } else if (tag === 'input') {
      const typeMatch = targetHtml.match(/(?:^|\s)type="([^"]*)"/);
      const inputType = typeMatch ? typeMatch[1].toLowerCase() : '';
      role = inputType === 'submit' || inputType === 'button' ? 'button' : 'textbox';
    } else if (IMPLICIT_ROLE_BY_TAG[tag]) {
      role = IMPLICIT_ROLE_BY_TAG[tag];
    }
  }
  if (!role) return null;

  const name = deriveAccessibleName(targetHtml);
  if (!name) return null;
  return { role, name };
}

/**
 * The closed set of ARIA roles this file will ever emit, derived ONCE from the
 * VALUES of IMPLICIT_ROLE_BY_TAG (heading, button, img, combobox, textbox). Reused
 * by deriveRoRoleCandidate's bare-token guard so there is a single role vocabulary,
 * not a forked list. A bare ro token is only trusted as a role if it is a member.
 */
const KNOWN_ROLE_SET: ReadonlySet<string> = new Set(Object.values(IMPLICIT_ROLE_BY_TAG));

/**
 * Defensively recover an ARIA role from multiLocator.ro. Observed ro values are
 * never a bare ARIA role (they are always xpaths), so this parse is DEFENSIVE and
 * ADDITIVE and is expected to return null on all current data and the golden seed.
 * It exists only so an account whose ro genuinely carries a role signal is not
 * silently dropped. deriveRoleCandidate (the primary role rung) still reads
 * targetOuterHTML ONLY; the ro channel is read here alone.
 *
 * Recognition rules, closed and conservative (anything else returns null):
 *   a. Bare role token: ro is ^[a-z]+$ after trim+lowercase AND a member of
 *      KNOWN_ROLE_SET (the IMPLICIT_ROLE_BY_TAG values). Returns { role }, no name.
 *   b. local-name() predicate: ro carries local-name()="tag" (double or single
 *      quoted); the tag is mapped through IMPLICIT_ROLE_BY_TAG ONLY (the anchor-href
 *      and input-type special cases in deriveRoleCandidate need attribute context ro
 *      cannot supply, so they are deliberately skipped). When the same ro carries the
 *      text() equality form (translate(...) = "text"), the final quoted string of
 *      that predicate is surfaced as the accessible name. Returns null when the tag
 *      has no implicit-role mapping.
 *   c. Everything else (id-anchored, class-anchored, text-only, malformed): null.
 *
 * The returned role value is always a KNOWN_ROLE_SET member, so it can never carry a
 * slash, at sign, parenthesis, quote, or whitespace: hostile ro text cannot reach
 * emission as a role. The accessible name renders through the SAME escapeString choke
 * point in the generateLocatorCode role case as every other role name. Pure.
 */
export function deriveRoRoleCandidate(ro: string | undefined): { role: string; name?: string } | null {
  if (!ro) return null;

  // Rule a: a bare role token (no xpath syntax), a known ARIA role.
  const bare = ro.trim().toLowerCase();
  if (/^[a-z]+$/.test(bare) && KNOWN_ROLE_SET.has(bare)) {
    return { role: bare };
  }

  // Rule b: a local-name()="tag" predicate mapped through IMPLICIT_ROLE_BY_TAG only.
  const localName = ro.match(/local-name\(\)\s*=\s*(?:"([a-zA-Z][a-zA-Z0-9]*)"|'([a-zA-Z][a-zA-Z0-9]*)')/);
  if (localName) {
    const tag = (localName[1] || localName[2]).toLowerCase();
    const role = IMPLICIT_ROLE_BY_TAG[tag];
    if (!role) return null;

    // Surface the text() equality name when present: the FINAL double-quoted string
    // of a text()[normalize-space(translate(...)) = "text"] predicate. The
    // final match is taken deliberately so the earlier local-name()="tag" quoted
    // string is never mistaken for the name. Skipped (name stays undefined) when no
    // text() predicate exists.
    let name: string | undefined;
    if (/text\(\)/.test(ro)) {
      const eqMatches = [...ro.matchAll(/=\s*"([^"]*)"/g)];
      const last = eqMatches[eqMatches.length - 1];
      if (last && last[1].trim()) name = last[1].trim();
    }
    return name ? { role, name } : { role };
  }

  // Rule c: id-anchored, class-anchored, text-only, or malformed ro carries no role.
  return null;
}

/**
 * Derive the accessible name for a role candidate from targetOuterHTML, original
 * case preserved. Preference order: aria-label, inner text between tags, alt,
 * title, then value on button-type inputs. Returns '' when none is derivable.
 */
function deriveAccessibleName(targetHtml: string): string {
  const ariaLabel = targetHtml.match(/(?:^|\s)aria-label="([^"]*)"/);
  if (ariaLabel && ariaLabel[1].trim()) return ariaLabel[1].trim();

  const innerText = targetHtml.match(/>([^<]+)</);
  if (innerText && innerText[1].trim()) return innerText[1].trim();

  const alt = targetHtml.match(/(?:^|\s)alt="([^"]*)"/);
  if (alt && alt[1].trim()) return alt[1].trim();

  const title = targetHtml.match(/(?:^|\s)title="([^"]*)"/);
  if (title && title[1].trim()) return title[1].trim();

  const typeMatch = targetHtml.match(/(?:^|\s)type="([^"]*)"/);
  const inputType = typeMatch ? typeMatch[1].toLowerCase() : '';
  if (inputType === 'submit' || inputType === 'button') {
    const value = targetHtml.match(/(?:^|\s)value="([^"]*)"/);
    if (value && value[1].trim()) return value[1].trim();
  }
  return '';
}

/**
 * Derive stable-attribute selector candidates from targetOuterHTML: name=, href=,
 * and NON-EMPTY aria-label= (an empty aria-label="" must yield nothing). Every
 * returned candidate carries source 'attr'. Pure.
 */
export function deriveStableAttrCandidates(targetHtml: string): Locator[] {
  const candidates: Locator[] = [];
  if (!targetHtml) return candidates;

  const nameMatch = targetHtml.match(/(?:^|\s)name="([^"]+)"/);
  if (nameMatch) candidates.push({ type: 'attr', value: `[name="${nameMatch[1]}"]`, source: 'attr' });

  const hrefMatch = targetHtml.match(/(?:^|\s)href="([^"]+)"/);
  if (hrefMatch) candidates.push({ type: 'attr', value: `[href="${hrefMatch[1]}"]`, source: 'attr' });

  const ariaMatch = targetHtml.match(/(?:^|\s)aria-label="([^"]+)"/);
  if (ariaMatch && ariaMatch[1].trim()) {
    candidates.push({ type: 'attr', value: `[aria-label="${ariaMatch[1]}"]`, source: 'attr' });
  }
  return candidates;
}

/**
 * Rewrite a userLocator CSS value into a usable selector. A space-separated
 * bare-word class list ('btn primary large') becomes a dotted selector
 * ('.btn.primary.large'); a single bare STANDARD html tag ('h1') returns null
 * meaning skip the rung (it matches every such element, useless); real selector
 * syntax ('#login .field') and a single non-standard bare token ('descope-wc', a
 * possible custom element) pass through verbatim. Pure.
 */
export function rewriteUserLocatorValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Real selector syntax (contains a selector metacharacter) passes through verbatim.
  if (/[.#\[\]:>+~()]/.test(trimmed)) return trimmed;

  const tokens = trimmed.split(/\s+/).filter(Boolean);

  // A single bare standard tag is a useless locator: skip the rung.
  if (tokens.length === 1) {
    return STANDARD_HTML_TAGS.has(tokens[0].toLowerCase()) ? null : trimmed;
  }

  // Multiple bare word tokens are a class list: join into a dotted selector.
  return `.${tokens.join('.')}`;
}

/**
 * Pick the best usable text from a co content array. Preference: directText, then
 * alt (image alt-text surface), then innerText, then anything else usable. Values
 * are trimmed; entries empty after trim are skipped. Returns null when nothing
 * usable exists. Pure.
 */
export function pickContentText(entries: Array<{ text?: string; textType?: string }>): string | null {
  const usable = entries
    .map((e) => ({ text: (e.text || '').trim(), textType: e.textType || '' }))
    .filter((e) => e.text !== '');
  if (usable.length === 0) return null;

  const order = ['directText', 'alt', 'innerText'];
  for (const preferred of order) {
    const hit = usable.find((e) => e.textType === preferred);
    if (hit) return hit.text;
  }
  return usable[0].text;
}

/**
 * Extract the ordered candidate list that feeds the firstMatch() chain.
 *
 * Returns an ordered Locator[] (never a single early-return pick): [] for an
 * undefined element and for zero derivable candidates. The userLocator is index 0
 * and trusted (a human pinned it, so it is EXEMPT from the dynamic-id rejection
 * every other rung obeys); role is scoped from targetOuterHTML only; data-testid is
 * checked BEFORE any raw id extraction; text from co is the RAW trimmed original
 * (regex assembly is generateLocatorCode's job); dynamic ids and hashed classes are
 * demoted then denylist-rejected. A final marking pass sets provenanceOnly on every
 * ab/at/clt sourced xpath rung WHEN a stabler sibling exists, so withLocator can
 * keep those Datadog-recorded breadcrumbs out of the live chain; it marks none when
 * they are the only signal (last resort) and never touches a userLocator xpath
 * (demotion keys on source, not on type). Pure: no FlagCollector, no I/O, no ctx
 * parameter (the zero-candidate emit is withLocator's seam; the shadow-dom-locator
 * flag is emitted elsewhere).
 *
 * ORDERING HONESTY: this precedence is an engineering decision validated empirically
 * by the generalization smoke tests and per-check npx checkly test. It is NOT a
 * reproduction of a documented Datadog inter-strategy ordering (no such ordering is
 * published). Only rung #1 (userLocator first) is Datadog-authoritative. Rung 2b is
 * the separate defensive deriveRoRoleCandidate ro role rung: purely additive,
 * deduped against the targetOuterHTML-derived role, and silent on every observed ro
 * shape.
 */
export function extractLocator(element?: ElementLocator): Locator[] {
  if (!element) return [];

  const targetHtml = element.targetOuterHTML || '';
  const multiLocator = element.multiLocator || {};
  const candidates: Locator[] = [];

  // Rung 1: userLocator (source 'userLocator'). First values[] entry; css routed
  // through rewriteUserLocatorValue (null result skips the rung); xpath passed
  // through defensively (docs allow it). EXEMPT from isDynamicId rejection:
  // rejecting a human-pinned selector would discard the best available signal.
  const firstUser = element.userLocator?.values?.[0];
  if (firstUser?.value) {
    if (firstUser.type === 'xpath') {
      candidates.push({ type: 'xpath', value: firstUser.value, source: 'userLocator' });
    } else {
      const rewritten = rewriteUserLocatorValue(firstUser.value);
      if (rewritten !== null) candidates.push({ type: 'userLocator', value: rewritten, source: 'userLocator' });
    }
  }

  // Rung 2: role (source 'role', name populated) from targetOuterHTML only.
  const roleCand = deriveRoleCandidate(targetHtml);
  if (roleCand) candidates.push({ type: 'role', value: roleCand.role, source: 'role', name: roleCand.name });

  // Rung 2b: the DEFENSIVE ro role rung. Purely additive. Observed ro is never a
  // role, so this stays silent on all current data; it fires only when ro genuinely
  // encodes a role (bare token or a local-name() predicate). Same { type: 'role',
  // value, source, name } shape as rung 2, so the type-and-value dedupe below
  // collapses any overlap with the targetOuterHTML-derived role; no dedupe change is
  // needed.
  const roRole = deriveRoRoleCandidate(multiLocator.ro);
  if (roRole) candidates.push({ type: 'role', value: roRole.role, source: 'role', name: roRole.name });

  // Rung 3: testId (source 'testId') from an ANCHORED data-testid match, checked
  // BEFORE any raw id extraction. The bare id, not an attribute selector, so
  // generateLocatorCode emits getByTestId(value).
  const testIdMatch = targetHtml.match(/(?:^|\s)data-testid="([^"]+)"/);
  if (testIdMatch) candidates.push({ type: 'testId', value: testIdMatch[1], source: 'testId' });

  // Rung 4: text (source 'text') from co via JSON.parse + pickContentText. The
  // candidate value is the RAW trimmed original text; the anchored case-insensitive
  // regex is assembled in generateLocatorCode, never here.
  if (multiLocator.co) {
    try {
      const content = JSON.parse(multiLocator.co) as Array<{ text?: string; textType?: string }>;
      const picked = pickContentText(content);
      if (picked) candidates.push({ type: 'text', value: picked, source: 'text' });
    } catch { /* ignore malformed co */ }
  }

  // Rung 5: attr (source 'attr') from name/href/non-empty aria-label.
  candidates.push(...deriveStableAttrCandidates(targetHtml));

  // Rung 6: id (source 'id'). Whitespace-anchored (?:^|\s)id="..." so a
  // data-testid can never be swallowed. A plain word-boundary anchor is NOT
  // sufficient here: \b matches between the '-' and the 'i' of data-testid, so
  // \bid="..." would still leak the data-testid value; only a preceding
  // start-or-whitespace guard is safe. Then the ro rung's raw-@id form as a
  // secondary source. REJECT any id where isDynamicId is true (demotion is this
  // rung's position, rejection is the denylist).
  const anchoredIdMatch = targetHtml.match(/(?:^|\s)id="([^"]+)"/);
  if (anchoredIdMatch && !isDynamicId(anchoredIdMatch[1])) {
    candidates.push({ type: 'id', value: `#${anchoredIdMatch[1]}`, source: 'id' });
  }
  if (multiLocator.ro && multiLocator.ro.startsWith('//*[@id="')) {
    const roId = multiLocator.ro.match(/\/\/\*\[@id="([^"]+)"\]/);
    if (roId && !isDynamicId(roId[1])) {
      candidates.push({ type: 'id', value: `#${roId[1]}`, source: 'id' });
    }
  }

  // Rung 7: class (source 'class') from cl with the existing contains-extraction,
  // rejecting a first token that matches HASHED_CLASS_PREFIX_REGEX; then clt
  // (source 'clt') as an xpath-emitted candidate when present.
  if (multiLocator.cl) {
    // The class name is the LAST double-quoted argument of the contains() call in
    // both the simple form (contains(@class, " x ")) and the concat form
    // (contains(concat(' ', normalize-space(@class), ' '), " x ")), whose inner
    // concat() commas defeat a naive first-arg regex. Take the final quoted run.
    const classMatch = multiLocator.cl.match(/"\s*([^"]+?)\s*"\s*\)[^"]*$/);
    if (classMatch) {
      const className = classMatch[1].trim();
      const selector = `.${className.replace(/\s+/g, '.')}`;
      if (!HASHED_CLASS_PREFIX_REGEX.test(selector)) {
        candidates.push({ type: 'class', value: selector, source: 'class' });
      }
    }
  }
  if (multiLocator.clt) candidates.push({ type: 'xpath', value: multiLocator.clt, source: 'clt' });

  // Rung 8: at (source 'at') ONLY when the at xpath carries an attribute predicate
  // (contains an '@'); a bare absolute path is as brittle as ab, so it is skipped.
  if (multiLocator.at && multiLocator.at.includes('@')) {
    candidates.push({ type: 'xpath', value: multiLocator.at, source: 'at' });
  }

  // Rung 9: ab (source 'ab') last resort.
  if (multiLocator.ab) candidates.push({ type: 'xpath', value: multiLocator.ab, source: 'ab' });

  // Deduplicate by type + value so the ro-derived id never duplicates the
  // outerHTML-derived id (and any other coincidental overlap collapses).
  const seen = new Set<string>();
  const deduped = candidates.filter((c) => {
    const key = `${c.type}\u0000${c.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Marking pass: the ab/at/clt sourced xpath rungs are Datadog-recorded
  // breadcrumbs, not live pass-if-any candidates. A static stale path cannot
  // self-heal the way Datadog recomputes it at runtime, so a live rung can silently
  // match a coincidental wrong element. When at least one candidate is sourced
  // OUTSIDE the stale set, mark every stale-sourced candidate provenanceOnly
  // (withLocator then partitions it out of the live chain and re-emits it as a
  // one-line breadcrumb comment). When ALL candidates are stale-sourced, mark NONE:
  // the chain would otherwise deactivate on zero live candidates, so the stale rungs
  // stay live as last resort. The marking is keyed STRICTLY on source membership in
  // {ab, at, clt}, never on the locator type being xpath, so a user-pinned userLocator
  // xpath is never demoted. The list is never reordered, removed from, or re-pushed
  // to: candidates[0] stays live by construction (a stale rung is only marked when a
  // stabler sibling exists, and the earliest stable rung precedes every stale one in
  // extraction order).
  const hasStablerCandidate = deduped.some((c) => !c.source || !STALE_XPATH_SOURCES.has(c.source));
  if (hasStablerCandidate) {
    for (const c of deduped) {
      if (c.source && STALE_XPATH_SOURCES.has(c.source)) c.provenanceOnly = true;
    }
  }

  return deduped;
}

/**
 * The candidate sources whose xpath is a Datadog-recorded breadcrumb rather than a
 * live selector: ab (absolute path), structural at, and clt. Demotion keys on
 * membership in this set, NEVER on the locator type being xpath, so a user-pinned
 * userLocator xpath (source 'userLocator') stays a live candidate.
 */
const STALE_XPATH_SOURCES = new Set(['ab', 'at', 'clt']);

/**
 * The six element-action step types whose emitted code consumes a resolved
 * locator (extractLocator). These are the only step types locator-residue detection
 * applies to: they are the ones that route a locator value into the generated spec.
 * Non-locator steps (goToUrl, wait, assertPageContains, etc.) are never inspected,
 * and an unsupported step type already carries the unsupported-step-type flag, so
 * residue-flagging a non-emitted step would be noise.
 */
const LOCATOR_CONSUMING_STEP_TYPES = new Set([
  'typeText',
  'click',
  'hover',
  'selectOption',
  'assertElementPresent',
  'assertElementContent',
]);

/**
 * SVG geometry attributes. An xpath that anchors its selection on one of these is
 * the RCA's Maxwell shape: descendant selection by circle/path coordinates,
 * identical in every row of a chart or diagram and meaningless as a stable
 * selector. Matched as an attribute equality test in the xpath value.
 */
const SVG_GEOMETRY_ATTR_REGEX = /@(cx|cy|r|rx|ry|x1|y1|x2|y2|d|points)=/;

/**
 * A class selector whose FIRST token is a CSS-in-JS hash prefix. These hashes
 * (styled-components `.sc-`, Emotion `.css-`, AWS-UI `.awsui_`) rotate every build,
 * so a selector led by one is anchored to nothing durable. A selector led by a
 * semantic token (`.ant-btn.sc-x`) deliberately does not match: it has a real
 * leading signal.
 */
const HASHED_CLASS_PREFIX_REGEX = /^\.(sc-|css-|awsui_)/;

/** The serialized-object recording artifact, in either its text or xpath-literal form. */
const SERIALIZED_OBJECT_ARTIFACT = '[object Object]';

/**
 * Classify recording residue on a RESOLVED locator value.
 *
 * Pure and side-effect free: reads no environment, mutates nothing, and never
 * touches extractLocator's selection logic (candidate reordering, demotion, and
 * rejection happen there; this only OBSERVES the single value the current extractor
 * already picked). Detection only: a match never means the locator is guessed,
 * synthesized, or replaced. Recovery (rebuilding a locator from the residue) is
 * permanently out of scope; the information to build a real locator does not exist
 * in the export.
 *
 * Four ordered predicates, first hit wins, so a step records at most one locator
 * residue flag:
 *   1. value contains the serialized-object artifact, ANY type (dual-form: the same
 *      artifact leaks into both co-derived text values and at-derived xpath
 *      literals, and a substring test on the RESOLVED value catches both without
 *      inspecting multiLocator keys) -> unconvertible-locator
 *   2. xpath anchored on an SVG geometry attribute -> unconvertible-locator
 *   3. class led by a hashed CSS-in-JS token -> unconvertible-locator
 *   4. xpath with no attribute predicate and no text() function (purely
 *      structural/positional) -> xpath-positional
 *
 * @param locator - The non-null resolved locator to classify.
 * @returns The reason plus a short residue-class detail phrase, or null when the
 *          locator carries a usable signal (the majority case).
 */
export function detectLocatorResidue(
  locator: Locator,
): { reason: 'unconvertible-locator' | 'xpath-positional'; detail: string } | null {
  const { type, value } = locator;

  // Rule 1: the serialized-object artifact, any locator type (dual-form).
  if (value.includes(SERIALIZED_OBJECT_ARTIFACT)) {
    return { reason: 'unconvertible-locator', detail: 'serialized-object recording artifact' };
  }

  // Rule 2: xpath anchored on SVG geometry coordinates.
  if (type === 'xpath' && SVG_GEOMETRY_ATTR_REGEX.test(value)) {
    return { reason: 'unconvertible-locator', detail: 'SVG-geometry-anchored xpath' };
  }

  // Rule 3: class selector led by a rotating CSS-in-JS hash token.
  if (type === 'class' && HASHED_CLASS_PREFIX_REGEX.test(value)) {
    return { reason: 'unconvertible-locator', detail: 'hashed-class-anchored selector' };
  }

  // Rule 4: xpath with no attribute predicate and no text() (structural only).
  if (type === 'xpath' && !value.includes('@') && !value.includes('text()')) {
    return { reason: 'xpath-positional', detail: 'structural-only xpath (no attribute, no text)' };
  }

  return null;
}

/**
 * Emit the Playwright locator expression for a single candidate (the per-candidate
 * builder that withLocator assembles the firstMatch chain from).
 *
 * receiver defaults to 'page' so single-candidate emission of an id-only element
 * stays byte-identical (page.locator with the hash-id selector); the firstMatch
 * chain passes a frame receiver per rung.
 *
 * role  -> receiver.getByRole("role", { name: "name" }) with escapeString on both,
 *          NEVER an exact-match option: getByRole name matching is already
 *          case-insensitive substring (verified live, Playwright locators ref), so
 *          adding { exact: true } would reintroduce the case trap.
 * testId-> receiver.getByTestId("value") on the bare test id.
 * text  -> receiver.getByText(new RegExp(J, "i")) where J is the generation-time
 *          JSON.stringify of "^" + escapeRegex(trimmed) + "$". co is a WHOLE-STRING
 *          comparison, not a substring one: Datadog's ro emits
 *          normalize-space(translate(., UPPER, lower)) = "text", i.e. "..." equality,
 *          never contains. The anchored regex reproduces whole-string, the "i" flag
 *          reproduces the case-fold, and trim() plus Playwright's own whitespace
 *          normalization (which applies even to a regex getByText, per current
 *          playwright.dev docs) reproduce normalize-space. So the anchor is faithful
 *          to Datadog's own runtime, never a weakening. The new RegExp(JSON.stringify(...))
 *          idiom (shared with the startsWith path) means hostile regex-breaking
 *          characters in co text can never escape the emitted string literal.
 * userLocator css -> receiver.locator("selector").
 * xpath (userLocator xpath, clt, at, ab) -> receiver.locator("xpath=...").
 * id/class/name/attr -> receiver.locator("selector") string form.
 *
 * The _ctx parameter is threaded from the withLocator seam; it is unused here (the
 * zero-candidate flag fires upstream, residue detection fires at the generateStepCode
 * seam).
 */
export function generateLocatorCode(locator: Locator, _ctx: StepFlagContext, receiver: string = 'page'): string {
  switch (locator.type) {
    case 'role': {
      const namePart = locator.name ? `, { name: "${escapeString(locator.name)}" }` : '';
      return `${receiver}.getByRole("${escapeString(locator.value)}"${namePart})`;
    }
    case 'testId':
      return `${receiver}.getByTestId("${escapeString(locator.value)}")`;
    case 'text': {
      // co is a whole-string comparison (ro emits normalize-space(translate) = "text"
      // equality, never contains), so anchor whole-string (^...$) and case-fold with
      // "i". escapeRegex neutralizes co metacharacters; JSON.stringify quotes the
      // whole pattern so quotes, backslashes, and newlines cannot break out of the
      // RegExp constructor argument. trim() plus Playwright's own whitespace
      // normalization (which applies even to a regex getByText) reproduce normalize-space.
      const pattern = `^${escapeRegex(locator.value.trim())}$`;
      return `${receiver}.getByText(new RegExp(${JSON.stringify(pattern)}, "i"))`;
    }
    case 'xpath':
      return `${receiver}.locator("xpath=${escapeString(locator.value)}")`;
    case 'userLocator':
    case 'id':
    case 'name':
    case 'attr':
    case 'class':
    default:
      return `${receiver}.locator("${escapeString(locator.value)}")`;
  }
}

/**
 * Describe a Datadog step for the preserved-DD-step comment: the step type plus
 * the double-quoted step name when present (for example: click "Click ghost").
 *
 * Contract: NEVER include step.params values. Typed values can be credentials;
 * keeping them out of the flags file and report surfaces is a hard requirement. This
 * text is passed RAW to emitFlag; escaping happens exactly
 * once inside the shared formatInlineMarker, so this must not pre-escape.
 */
export function describeDatadogStep(step: BrowserStep): string {
  return step.name ? `${step.type} "${step.name}"` : step.type;
}

/**
 * The candidate-source values that make a chain's LEADING rung weak. A chain whose
 * first candidate is one of these has no user-pinned, role, testId, text, or
 * stable-attribute lead, so it degrades to a best-effort selector and is surfaced
 * (never deactivated) via weak-fallback-chain.
 */
const WEAK_LEAD_SOURCES = new Set(['id', 'class', 'clt', 'at', 'ab']);

/**
 * Classify the strength of an ordered candidate chain by its LEADING rung.
 *
 * Pure and total. Returns 'weak' when the first candidate's source is one of id,
 * class, clt, at, ab (a best-effort selector lead); returns 'strong' otherwise
 * (userLocator, role, testId, text, attr, name). Grades on the first candidate
 * only: a weak lead with stronger followers is still a weak chain, because the
 * lead is what the emitted chain probes first. An empty array classifies 'strong'
 * (there is no weak lead to flag; the zero-candidate case is a separate slice).
 */
export function classifyChainStrength(candidates: Locator[]): 'weak' | 'strong' {
  const lead = candidates[0];
  if (!lead || !lead.source) return 'strong';
  return WEAK_LEAD_SOURCES.has(lead.source) ? 'weak' : 'strong';
}

/**
 * Map a candidate's rung provenance to a short human-readable comment label. The
 * label channel is a CLOSED enum (the Locator.source union) plus the internal
 * Locator.type fallback, never raw Datadog export text, so this is not an
 * interpolation surface. The three xpath rungs are disambiguated so a reviewer sees
 * WHICH xpath flavor a candidate came from;
 * the absolute-path rung is annotated as the most brittle. The interpunct is
 * U+00B7 (a printable UTF-8 character, not a control byte and not an em-dash),
 * per the repo output rule.
 *
 * @param c - The candidate whose source label to render.
 * @returns The trailing-comment label for this candidate.
 */
export function candidateSourceLabel(c: Locator): string {
  switch (c.source) {
    case 'userLocator':
      return 'userLocator (pinned)';
    case 'clt':
      return 'xpath (clt)';
    case 'at':
      return 'xpath (at)';
    case 'ab':
      return 'xpath (ab · absolute, most brittle)';
    case undefined:
      // No recorded rung provenance: fall back to the internal locator type so
      // the comment is never empty (still a closed internal value, never export text).
      return c.type;
    default:
      // role, testId, text, attr, name, id, class: the source string verbatim.
      return c.source;
  }
}

/**
 * Build the emitted candidate-factory source for the firstMatch chain, one
 * candidate per line with a trailing provenance comment.
 *
 * Returns a multi-line factory expression of shape:
 *   (root) => [
 *         <expr1>, // <label1>
 *         <expr2>, // <label2>
 *       ]
 * where each <expr> is the UNCHANGED generateLocatorCode(candidate, ctx, 'root')
 * output so every candidate re-queries against the root firstMatch passes it (the
 * page or a frame). The receiver is the literal 'root', never 'page', so the same
 * factory probes the main page and every frame uniformly. The per-candidate
 * EXPRESSION bytes are identical to the former single-line join; only the line
 * breaks, the trailing `, // <label>` comment channel, and the 6/4-space indents
 * are new. Every candidate line carries a trailing comma, including the last, so
 * a future reorder never touches a neighbour line. Column alignment is
 * deliberately NOT attempted: pathological xpath lengths make padEnd alignment
 * worse than a single leading space, so the rule is the simple deterministic one
 * space before `//`.
 *
 * The 6-space candidate indent and 4-space closing-bracket indent are baked for
 * the 4-space named-const context this factory is hoisted into (withLocator).
 *
 * Every interpolation routes through generateLocatorCode, whose escaping
 * (escapeString / the JSON.stringify RegExp idiom) is the single choke point, so
 * a hostile Datadog value can never break out of the emitted string literal; this
 * emitter only concatenates those already-safe expressions and the closed-enum
 * source labels (candidateSourceLabel), never raw export text.
 */
export function buildCandidateFactoryExpr(candidates: Locator[], ctx: StepFlagContext): string {
  const lines = candidates.map(
    (c) => `      ${generateLocatorCode(c, ctx, 'root')}, // ${candidateSourceLabel(c)}`,
  );
  return `(root) => [\n${lines.join('\n')}\n    ]`;
}

/**
 * The chain-emission descriptor handed to a withLocator build callback.
 *
 * withLocator resolves the ordered candidate list once and packages the emitted
 * expressions here so each of the six locator-consuming generators interpolates a
 * ready-made locator expression without re-deriving anything:
 *   - candidates: the ordered LIVE Locator[] (index 0 is the primary). Demoted
 *     breadcrumbs (ab/at/clt provenance-only) are excluded here; they are surfaced
 *     as single-line comments by withLocator and never ride the chain.
 *   - isMulti: true when two or more candidates resolved (drives firstMatch vs direct).
 *   - locatorExpr: the expression an action/assertion applies its call to. For a
 *     single candidate it is the direct page-receiver expression (byte-stable with
 *     the pre-chain emission); for multi it is the parenthesized awaited firstMatch
 *     call, safe to suffix .click() / wrap in expect().
 *   - factoryExpr: the hoisted factory const NAME (multi only; '' otherwise). The
 *     factory arrow itself is emitted as a `const <name>: CandidateFactory = ...`
 *     declaration by withLocator BEFORE the built statement; the build callbacks
 *     interpolate this name into firstMatch(page, <name>) / assertOnFirstMatch(page,
 *     <name>, ...), so a multi-line arrow never sits inline inside an await.
 *   - primaryExpr: the primary candidate as a direct page-receiver expression
 *     (the negative-assertion seam pins negatives to this).
 */
export interface LocatorChainCode {
  candidates: Locator[];
  isMulti: boolean;
  locatorExpr: string;
  factoryExpr: string;
  primaryExpr: string;
}

/**
 * Derive the firstMatch settle budget in milliseconds from the export's Datadog
 * timeout.
 *
 * Precedence: the per-step step.timeout, else the test's initialNavigationTimeout,
 * else null (no export timeout, so the call site emits the byte-stable
 * two-argument firstMatch form and the helper falls back to its const default).
 *
 * Datadog stores these values in SECONDS, and a value of 0, undefined, or negative
 * means "no override, use the test default" rather than "zero milliseconds", so any
 * non-finite or non-positive input is treated as absent (a zero step timeout falls
 * through to the nav timeout, never emitting a zero or near-zero budget). The chosen
 * seconds value is converted to milliseconds and clamped to a 2500ms floor and a
 * 240000ms cap. The floor guards a derived budget from regressing below a usable
 * minimum; the 240000ms cap is Checkly's hard browser-check limit.
 *
 * Datadog default: a browser test retries locating a step's element for 60 seconds
 * by default, adjustable up to 300 seconds, and the export values are in seconds.
 *
 * @param stepTimeoutSec - the per-step Datadog timeout in seconds (0/undefined/negative = absent).
 * @param navTimeoutSec - the test-level navigation timeout in seconds (0/undefined/negative = absent).
 * @returns the clamped budget in milliseconds, or null when no export timeout is present.
 */
export function deriveSettleBudgetMs(stepTimeoutSec?: number, navTimeoutSec?: number): number | null {
  const FLOOR_MS = 2500;
  const CAP_MS = 240000;
  // Treat any non-finite or non-positive input as absent (the zero-means-default rule).
  const secToMs = (s?: number): number | undefined =>
    typeof s === 'number' && Number.isFinite(s) && s > 0 ? s * 1000 : undefined;
  const chosen = secToMs(stepTimeoutSec) ?? secToMs(navTimeoutSec);
  if (chosen === undefined) return null;
  return Math.min(Math.max(chosen, FLOOR_MS), CAP_MS);
}

/**
 * Emit a locator-consuming statement, firing the zero-candidate flag when no
 * locator can be derived.
 *
 * Non-null path: return the two-space indent plus build(generateLocatorCode(...)),
 * preserving the emitted statement byte for byte.
 *
 * Null path: fire the deactivating locator-unresolvable flag (no candidate means the
 * step cannot run and everything after it breaks, so the honest, safe-by-default
 * move is deactivate-and-flag on the construct side, driven by deactivates: true
 * here). Return the loud marker (with the preserved DD step) followed by the intended
 * statement rendered as a comment. This path NEVER returns a runnable statement and
 * NEVER emits a Playwright skip (a skip deploys an active-but-skipping check).
 *
 * Pin-authority emit decision: when userLocator.failTestOnCannotLocate is true AND
 * the pin was derivable (live primary source userLocator), emit the pinned locator
 * ALONE (no firstMatch, no factory const, no non-pin candidate, no provenance
 * breadcrumbs) so a pin miss fails the step natively, matching Datadog's
 * fail-on-pin-miss checkbox; when the flag is true but the pin could not be derived,
 * keep the self-healing chain and surface a non-deactivating
 * user-locator-pin-unresolvable flag (never a silent divergence). The gate keys on
 * the parsed boolean and the pin's source, never on candidate type, so css and xpath
 * pins behave identically.
 */
export function withLocator(
  step: BrowserStep,
  ctx: StepFlagContext,
  build: (chain: LocatorChainCode) => string,
): string {
  // extractLocator returns an ORDERED Locator[]. An empty array is TRUTHY in
  // JavaScript, so the presence test is a length check, not a null check.
  const candidates = extractLocator(step.params?.element);

  // Partition the LIVE candidates (everything not demoted to provenance-only) from
  // the demoted ab/at/clt breadcrumbs. Every emission decision below reads LIVE only:
  // isMulti, classifyChainStrength, primaryExpr from live[0], the factory hoist gate,
  // buildCandidateFactoryExpr(live), and chain.candidates. The extractLocator marking
  // pass guarantees that if candidates.length > 0 then live.length > 0 (the all-stale
  // last-resort case marks nothing), so the zero-candidate branch below stays keyed
  // on candidates.length and its behavior is unchanged.
  const live = candidates.filter((c) => !c.provenanceOnly);
  const provenance = candidates.filter((c) => c.provenanceOnly);

  // Honor userLocator.failTestOnCannotLocate, the Datadog "If user specified locator
  // fails, fail test" checkbox. When the flag is true Datadog
  // ignores the stored multiLocator strategies and fails the step if the pinned
  // selector misses, so a self-healing fallback chain would DIVERGE from Datadog by
  // passing on a wrong element. The gate keys on the parsed boolean plus the live
  // primary's userLocator source, NEVER on the candidate type, so a css pin and an
  // xpath pin both emit pin-only.
  //   - pinOnly: the flag is true AND the pin was derivable (userLocator is index 0
  //     of extractLocator and exempt from demotion, so a derivable pin makes
  //     live[0].source === 'userLocator'). Emit the pin alone: no firstMatch call, no
  //     factory const, no non-pin candidate expression, and no provenance breadcrumbs
  //     (Datadog itself ignores the stored strategies in this mode).
  //   - pinUnresolvable: the flag is true but the userLocator rung was SKIPPED (empty
  //     value, or rewriteUserLocatorValue rejected a lone bare standard tag), so the
  //     live primary is not the pin. Keeping the chain silent would hide that this step
  //     no longer reproduces Datadog's fail-on-pin-miss authority, so surface a
  //     non-deactivating user-locator-pin-unresolvable flag and fall through to the
  //     normal chain (never a silent divergence).
  const pinAuthority = step.params?.element?.userLocator?.failTestOnCannotLocate === true;
  const pinOnly = pinAuthority && live[0]?.source === 'userLocator';
  const pinUnresolvable = pinAuthority && live[0]?.source !== 'userLocator';

  if (candidates.length > 0) {
    // Degrade flags fire BEFORE the statement, through the one emit seam, and are
    // prepended as markers exactly like the residue marker pattern in
    // generateStepCode. Neither flag deactivates: a degraded-but-resolved chain stays
    // ACTIVE; deactivation remains exclusively the zero-candidate slice below.
    let markers = '';

    // (a) shadow-dom-locator: the element carries a nested sd (shadow-DOM host)
    // locator. The step's normal chain IS emitted, so shadow-root piercing IS
    // attempted at runtime: Playwright locators pierce OPEN shadow roots automatically
    // for user-facing locators (getByRole/getByText/getByLabel/getByTestId) and CSS
    // locators; XPath candidates do NOT pierce; closed shadow roots cannot be resolved
    // by any Playwright locator. The message is variant-aware:
    //   - variant A (at least one non-xpath live candidate): the chain can pierce an
    //     open root, so state the capability and its two limits (XPath, closed roots).
    //   - variant B (every live candidate is xpath, the last-resort all-stale case):
    //     no emitted candidate can pierce even an open root, so state the stronger
    //     honest surface and the remedy.
    // Neither variant deactivates and neither suppresses the chain (attempt preserved).
    if (step.params?.element?.multiLocator?.sd !== undefined) {
      const anyNonXpath = live.some((c) => c.type !== 'xpath');
      const sdMessage = anyNonXpath
        ? 'Shadow-DOM host detected; role, text, testId, and CSS candidates pierce open shadow roots automatically at runtime, XPath candidates do not, and closed shadow roots cannot be resolved by any Playwright locator.'
        : 'Shadow-DOM host detected; every emitted candidate is XPath and cannot pierce a shadow root, open or closed, until a CSS or user-facing locator is added.';
      markers +=
        ctx.collector.emitFlag(
          {
            reason: 'shadow-dom-locator',
            publicId: ctx.publicId,
            stepIndex: ctx.stepIndex,
            message: sdMessage,
          },
          describeDatadogStep(step),
        ) + '\n';
    }

    // When the pin is authoritative (pinOnly), Datadog ignores the stored strategies
    // entirely, so the provenance breadcrumbs for the (suppressed) chain are not
    // emitted either: the pinned locator ONLY. Otherwise emit the breadcrumbs below.
    //
    // Provenance breadcrumbs: each demoted ab/at/clt rung is re-emitted as ONE
    // four-space-indented single-line // comment so a reviewer keeps the last-known
    // Datadog path. The value is neutralized to a single line via the same
    // truncate-then-JSON.stringify idiom the residue marker uses (bounded to 120
    // chars, then JSON.stringify), so a quote, backslash, or newline in a hostile
    // export value cannot break the comment line. A single-line // comment (never a
    // block comment) is used so a comment-terminator sequence in the value cannot
    // close the comment early.
    if (!pinOnly) {
      for (const p of provenance) {
        const truncated = p.value.length > 120 ? `${p.value.slice(0, 120)}...` : p.value;
        markers += `    // Datadog-recorded path (${candidateSourceLabel(p)}), provenance only: ${JSON.stringify(truncated)}\n`;
      }
    }

    // The flag is true but the pin could not be derived into a candidate (empty value,
    // or rewriteUserLocatorValue rejected a lone bare standard tag). The self-healing
    // chain is emitted instead, which does NOT reproduce Datadog's fail-on-pin-miss
    // authority, so surface the divergence with a non-deactivating flag (this flag
    // never sets deactivates). The message names the CONDITION only, never the raw
    // selector value; describeDatadogStep also omits params values, so no selector
    // leaks into the DD-original line.
    if (pinUnresolvable) {
      markers +=
        ctx.collector.emitFlag(
          {
            reason: 'user-locator-pin-unresolvable',
            publicId: ctx.publicId,
            stepIndex: ctx.stepIndex,
            message:
              'userLocator.failTestOnCannotLocate is true but the pinned selector could not be derived into a candidate; the self-healing chain was emitted instead, so this step will not fail on a pin miss until the pin is reviewed.',
          },
          describeDatadogStep(step),
        ) + '\n';
    }

    // A pin-only step forces single-candidate emission regardless of how many
    // strategies the chain would otherwise carry. isMulti is the multi-candidate gate
    // for the factory hoist, the weak-fallback-chain flag, and the firstMatch call;
    // forcing it false makes the pin emit as a direct statement with no scaffolding. A
    // pinned step is user authority, not a weak fallback chain, so the weak gate below
    // must also see isMulti false.
    const isMulti = !pinOnly && live.length >= 2;

    // (b) weak-fallback-chain: a MULTI-candidate chain whose leading rung is a
    // best-effort selector (id/class/clt/at/ab). Gated on isMulti by name and
    // intent: the reason is weak-fallback-CHAIN, so a lone id-only locator (no
    // fallback rungs) is not a chain and must not flood the flags. Reads LIVE
    // candidates only: a chain classified from the live set, since the demoted rungs
    // never ride it.
    if (isMulti && classifyChainStrength(live) === 'weak') {
      markers +=
        ctx.collector.emitFlag(
          {
            reason: 'weak-fallback-chain',
            publicId: ctx.publicId,
            stepIndex: ctx.stepIndex,
            message: `Locator chain is led by a weak ${live[0].source} rung; emitted with fallbacks but may match imprecisely, review recommended.`,
          },
          describeDatadogStep(step),
        ) + '\n';
    }
    const primaryExpr = generateLocatorCode(live[0], ctx);

    // Multi-candidate steps hoist their candidate factory into a named const
    // (readability Option C) and reference it from an awaited firstMatch call;
    // single-candidate main-page steps keep the direct byte-stable emission (never
    // a firstMatch call for zero or one candidate, an invariant the import gate
    // depends on).
    //
    // The const NAME is reserved UNCONDITIONALLY for the isMulti case, BEFORE build
    // runs, because the built statement must interpolate the name (via factoryExpr)
    // while the const declaration text is assembled here. Reserving unconditionally
    // keeps uniqueVarName's suffix numbering deterministic (the reservation order
    // does not depend on which build callback fires). The name routes through
    // generateElementVarName -> sanitizeIdentifier -> uniqueVarName (the identifier
    // guard is inherited), so a hostile step name can never emit an invalid or
    // duplicate identifier.
    let factoryName = '';
    let constDecl = '';
    if (isMulti) {
      const used = ctx.usedVarNames ?? new Set<string>();
      const slug = generateElementVarName(step);
      // generateElementVarName returns its own 'element' fallback when the step
      // name yields no usable words; in that case use the 'step<N>Locators' base so
      // the const still reads as a locator factory rather than a bare 'element'.
      const base =
        slug === 'element'
          ? `step${ctx.stepIndex + 1}Locators`
          : `step${ctx.stepIndex + 1}${slug.charAt(0).toUpperCase()}${slug.slice(1)}`;
      factoryName = uniqueVarName(base, used);
    }

    const factoryExpr = factoryName; // the hoisted const NAME (multi only; '' otherwise)

    // Derive the settle budget from the export timeout (per-step step.timeout wins,
    // else the test-level navTimeoutSec, else null). The third firstMatch argument is
    // interpolated ONCE here, at the single withLocator emit seam, so every firstMatch
    // consumer (actions, soft assertions, iframe-folded steps) inherits the derived
    // budget uniformly. When the derivation is null (no export timeout, or a
    // zero/negative one) the two-argument call is emitted byte-identically to the
    // no-budget form, so timeout-less call sites stay stable and the helper uses its
    // Datadog-parity default const. A pin-only step forces isMulti false above and
    // emits no firstMatch call, so it never reaches this seam.
    const settleBudgetMs = deriveSettleBudgetMs(step.timeout, ctx.navTimeoutSec);
    const budgetArg = settleBudgetMs !== null ? `, ${settleBudgetMs}` : '';
    const locatorExpr = isMulti ? `(await firstMatch(page, ${factoryName}${budgetArg}))` : primaryExpr;

    // The chain carries the LIVE candidates only (index 0 is the live primary); the
    // demoted breadcrumbs are already surfaced as provenance comments in markers and
    // never ride the emitted chain. A pin-only step narrows chain.candidates to the
    // pin alone (live[0]) so any consumer sees the truthful single-candidate set,
    // matching the emitted pin-only statement.
    const chainCandidates = pinOnly ? live.slice(0, 1) : live;
    const chain: LocatorChainCode = { candidates: chainCandidates, isMulti, locatorExpr, factoryExpr, primaryExpr };
    const built = build(chain);

    // Emit the hoisted const BEFORE the built statement, but ONLY when the built
    // text actually references the name. Negative-polarity multi-candidate
    // assertions pin to primaryExpr and never touch the factory, so an unconditional
    // hoist would emit an unused const. A false-positive containment
    // hit merely emits a harmless extra const (acceptable); a false negative would
    // leave a dangling reference, which cannot happen because the only writers of
    // firstMatch(page, <name>) / assertOnFirstMatch(page, <name>, ...) put the name
    // in the built text.
    if (isMulti && factoryName && built.includes(factoryName)) {
      constDecl = `    const ${factoryName}: CandidateFactory = ${buildCandidateFactoryExpr(live, ctx)};\n`;
    }

    // withLocator no longer injects a positional indent: the build callbacks return
    // FULLY-INDENTED statements (each line starts with its own four spaces), so the
    // markers, the optional const declaration, and the built text simply concatenate.
    return `${markers}${constDecl}${built}`;
  }

  // Zero-candidate path: deactivate the whole check and comment out the intended
  // action. build() receives a synthetic chain whose locatorExpr is
  // the placeholder; EVERY line of the built statement is commented out (a
  // multi-line built statement must not leave a trailing runnable line), each at
  // four-space body depth after stripping its own leading whitespace.
  const marker = ctx.collector.emitFlag(
    {
      reason: 'locator-unresolvable',
      publicId: ctx.publicId,
      stepIndex: ctx.stepIndex,
      message:
        'No locator candidate could be derived for this step; it is commented out and the check is deactivated for review.',
      deactivates: true,
    },
    describeDatadogStep(step),
  );
  const placeholderChain: LocatorChainCode = {
    candidates: [],
    isMulti: false,
    locatorExpr: 'page.locator(/* locator-unresolvable */)',
    factoryExpr: '',
    primaryExpr: 'page.locator(/* locator-unresolvable */)',
  };
  const commentedAction = build(placeholderChain)
    .split('\n')
    .map((line) => `    // ${line.replace(/^\s+/, '')}`)
    .join('\n');
  return `${marker}\n${commentedAction}`;
}

/**
 * Assemble the deterministic exports/migration-flags.json artifact from the per-run
 * collector. The stable seam main() and the tool tests call.
 *
 * Delegates to the collector's toFile() rather than re-implementing the assembly
 * (reuse, don't fork). The result carries no wall-clock value: the golden harness
 * byte-compares the output tree and the determinism rules forbid timestamp reads, so
 * the artifact needs no normalization entry. Step 08 recovers both the flagged and
 * the deactivated public_id sets from the written JSON.
 */
export function buildMigrationFlagsFile(collector: FlagCollector): MigrationFlagsFile {
  return collector.toFile();
}

// ---------------------------------------------------------------------------
// Naming helper for fallback variables
// ---------------------------------------------------------------------------

/**
 * Generate a descriptive camelCase variable name from a step name.
 * e.g. 'Click on div "Recent Reports..."' → "divRecentReports"
 */
export function generateElementVarName(step: BrowserStep): string {
  const name = step.name || step.type;
  let cleaned = name
    .replace(/^(Click on|Type text on|Hover over|Select option on|Assert|Test)\s*/i, '')
    .replace(/["']/g, '')
    .replace(/\.\.\./g, '')
    .replace(/[^a-zA-Z0-9_\s]/g, ' ')
    .trim();

  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 4);
  if (words.length === 0) return 'element';

  const camel = words
    .map((w, i) => {
      const lower = w.toLowerCase();
      return i === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');

  // Route through the canonical sanitizer: a digit-leading camelCase base like
  // '3dotstoeditMenu' would otherwise emit an invalid
  // `const 3dotstoeditMenu`, a bundle-time SyntaxError. Sanitizing here (not at
  // the call site) means uniqueVarName's counter suffix appends to an already
  // valid base, and every current and future caller inherits the guard.
  return sanitizeIdentifier(camel);
}

/** Return a unique variable name, appending a counter if needed. */
export function uniqueVarName(base: string, used: Set<string>): string {
  let name = base;
  let counter = 2;
  while (used.has(name)) {
    name = `${base}${counter}`;
    counter++;
  }
  used.add(name);
  return name;
}

// ---------------------------------------------------------------------------
// Step code generators (element steps route through the single firstMatch chain,
// which already probes the main page then all page.frames() frames)
// ---------------------------------------------------------------------------

export function generateGoToUrl(step: BrowserStep, localVarNames?: ReadonlySet<string>): string {
  const url = convertVariables(escapeTemplateLiteral(step.params?.value || ''), localVarNames);
  return `    await page.goto(\`${url}\`);`;
}

/**
 * Strict password-field detector. Anchored to an <input> tag that carries a type
 * attribute equal to "password" (single or double quoted), case-insensitive. This is
 * the ONLY auto-route trigger: a recorded password would otherwise land as a
 * plaintext literal in a committed .spec.ts, and this predicate gates the routing
 * that replaces the literal with a process.env reference. Detection is deliberately
 * narrow: a false-positive route would sever a working plain field, so only a
 * declared type="password" routes; the advisory net below surfaces secret-like
 * NON-password fields without ever rewriting them.
 */
const IS_PASSWORD_FIELD = /<input\b[^>]*\btype\s*=\s*["']password["']/i;

/**
 * Secret-like identifier heuristic (advisory). Word-boundary alternation over
 * common credential-field name forms (password/passcode/pwd/secret/token/api key/
 * credential). Matched ONLY against a field's extracted IDENTIFYING attribute
 * values (name, id, data-testid, placeholder, aria-label, autocomplete), never the
 * raw outerHTML and never the typed value, so a matched substring can never be a
 * password the user typed. A hit records a low-severity possible-plaintext-secret
 * flag and leaves the fill UNCHANGED (never rewrite a non-password field; the
 * routing is strict type="password").
 *
 * The scanned identifier is normalized so `_` and `-` act as word separators (via
 * matchesSecretLike): a field named `api_token` or `login-secret` splits into
 * `api token` / `login secret`, so the word-boundary alternation catches the
 * credential token that would otherwise sit mid-word (an underscore is a JS `\w`
 * character, so a raw `\btoken\b` would miss `api_token`).
 */
const SECRET_LIKE = /\b(pass(word|code)?|pwd|secret|token|api[-_]?key|credential)\b/i;

/**
 * True when a field's extracted identifier string looks secret-like. The identifier
 * is normalized so `_`/`-` become spaces before the SECRET_LIKE scan,
 * so `api_token` and `login-secret` match even though the raw underscore/hyphen
 * would suppress the word boundary. Pure.
 */
function matchesSecretLike(identifier: string): boolean {
  return SECRET_LIKE.test(identifier.replace(/[_-]/g, ' '));
}

/**
 * Per-check secret-key derivation ladder. Deterministic, collision-proof,
 * readable-first. Extracts a tier-1 identifier from the recorded
 * HTML in preference order data-testid, name, id; a present identifier becomes
 * sanitizeIdentifier(raw).toUpperCase() (a valid, non-digit-leading env-var name),
 * an absent one becomes BROWSER_SECRET_STEP<n> (1-based). On a collision within the
 * check (the used set already holds the candidate) it falls to <candidate>_STEP<n>,
 * then to BROWSER_SECRET_<sanitized-uppercased publicId>_STEP<n>. The final key is
 * added to `used` and returned. Pure aside from mutating the passed `used` set,
 * which is the per-check collision ledger threaded through StepFlagContext (same
 * discipline as usedVarNames). No wall-clock, no randomness: the same inputs always
 * yield the same key, so the emitted spec and the manifest stay byte-deterministic.
 *
 * The extraction regex reads an attribute value and routes it through
 * sanitizeIdentifier, so a hostile targetOuterHTML value can never interpolate raw
 * HTML into emitted code.
 *
 * @param html - The step element's targetOuterHTML.
 * @param stepIndex - Zero-based step index (rendered one-based in fallback keys).
 * @param publicId - The check's Datadog public_id (tier-3 disambiguator).
 * @param used - The per-check set of already-taken keys; mutated with the result.
 * @returns The derived, collision-free, uppercase env-var key.
 */
export function derivePasswordEnvKey(
  html: string,
  stepIndex: number,
  publicId: string,
  used: Set<string>,
): string {
  const attr = (name: string): string | undefined =>
    new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(html)?.[1];
  const raw = attr('data-testid') || attr('name') || attr('id');

  const candidate = raw
    ? sanitizeIdentifier(raw).toUpperCase()
    : `BROWSER_SECRET_STEP${stepIndex + 1}`;

  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  const tier2 = `${candidate}_STEP${stepIndex + 1}`;
  if (!used.has(tier2)) {
    used.add(tier2);
    return tier2;
  }
  const tier3 = `BROWSER_SECRET_${sanitizeIdentifier(publicId).toUpperCase()}_STEP${stepIndex + 1}`;
  used.add(tier3);
  return tier3;
}

/**
 * Extract the identifying attribute values a secret-like scan is allowed to read.
 * ONLY name, id, data-testid, placeholder, aria-label, and autocomplete; NEVER the
 * value attribute and NEVER the raw outerHTML, so a typed password can never be what
 * SECRET_LIKE matches. Returns the concatenated attribute values as one scannable
 * string. Pure.
 */
function extractSecretLikeIdentifiers(html: string): string {
  const names = ['name', 'id', 'data-testid', 'placeholder', 'aria-label', 'autocomplete'];
  const values: string[] = [];
  for (const n of names) {
    const m = new RegExp(`\\b${n}\\s*=\\s*["']([^"']*)["']`, 'i').exec(html);
    if (m && m[1]) values.push(m[1]);
  }
  return values.join(' ');
}

/**
 * Emit a Playwright fill for a Datadog typeText step, routing recorded passwords to
 * process.env references. Ordered branches, variable-branch first (matching the
 * generatePressKey discipline):
 *
 *   (1) The value already references a Datadog {{ VAR }}: the existing
 *       convertVariables emission is byte-identical and NO secret flag fires. The
 *       value is already secret-safe; rerouting would sever a working reference.
 *   (2) IS_PASSWORD_FIELD matches the element's targetOuterHTML (strict trigger):
 *       derive a per-check env key, record it on ctx.secretKeys.routed for the
 *       manifest, emit exactly one secret-value-required flag naming the KEY and
 *       field identifier (never the value), and emit the fill referencing
 *       process.env.<KEY>. The key and routed value are computed BEFORE withLocator
 *       so even the zero-candidate commented-out fill carries the env reference,
 *       never plaintext.
 *   (3) SECRET_LIKE matches the field's identifying attributes only (advisory): emit
 *       exactly one possible-plaintext-secret flag naming the field identifier and
 *       leave the fill UNCHANGED (never rewrite a non-password field). An
 *       autocomplete="current-password" hint on a non-password-typed field is an
 *       advisory signal only, never an auto-route, honoring the strict type="password"
 *       trigger.
 *   (4) Otherwise the byte-identical current emission.
 *
 * ctx.secretKeys is optional: a direct emitter test that constructs a bare
 * StepFlagContext gets a fresh local state object, so the derivation still
 * dedupes within the single call.
 */
export function generateTypeText(step: BrowserStep, ctx: StepFlagContext): string {
  const rawValue = step.params?.value || '';
  const html = step.params?.element?.targetOuterHTML || '';

  // Branch (1): an already-variable value is secret-safe; keep it byte-identical.
  const hasVariable = /\{\{\s*\w+\s*\}\}/.test(rawValue);

  // Branch (2): strict type="password" auto-route.
  if (!hasVariable && IS_PASSWORD_FIELD.test(html)) {
    // Fall back to a fresh local state object when ctx.secretKeys is absent so
    // direct emitter tests work; the per-spec state (threaded from generateSpecFile)
    // is the real collision ledger and manifest sink.
    const secretState = ctx.secretKeys ?? { used: new Set<string>(), routed: [] as string[] };
    const key = derivePasswordEnvKey(html, ctx.stepIndex, ctx.publicId, secretState.used);
    secretState.routed.push(key);

    const identifier = extractSecretLikeIdentifiers(html);
    const marker = ctx.collector.emitFlag(
      {
        reason: 'secret-value-required',
        publicId: ctx.publicId,
        stepIndex: ctx.stepIndex,
        message:
          `Password field ${identifier ? `(${identifier}) ` : ''}routed to process.env.${key}; ` +
          `Datadog does not export secret values, so set ${key} before running this check.`,
      },
      describeDatadogStep(step),
    );
    // Route BEFORE withLocator: the routed fill references process.env.<KEY>, so even
    // the zero-candidate commented-out path carries the env reference and never the
    // plaintext value.
    const routedFill = withLocator(
      step,
      ctx,
      (chain) => `    await ${chain.locatorExpr}.fill(\`\${process.env.${key}}\`);`,
    );
    return `${marker}\n${routedFill}`;
  }

  // Branch (3): secret-like NON-password field (advisory). Scan ONLY the extracted
  // identifying attributes, never the raw HTML or the value.
  const value = convertVariables(escapeTemplateLiteral(rawValue), ctx.localVarNames);
  if (!hasVariable) {
    const identifier = extractSecretLikeIdentifiers(html);
    if (identifier && matchesSecretLike(identifier)) {
      const marker = ctx.collector.emitFlag(
        {
          reason: 'possible-plaintext-secret',
          publicId: ctx.publicId,
          stepIndex: ctx.stepIndex,
          message:
            `Field (${identifier}) has a secret-like identifier but is not type="password"; ` +
            `its typed value is emitted as plaintext. Review whether it should be a secret and route it manually.`,
        },
        describeDatadogStep(step),
      );
      const advisedFill = withLocator(step, ctx, (chain) => `    await ${chain.locatorExpr}.fill(\`${value}\`);`);
      return `${marker}\n${advisedFill}`;
    }
  }

  // Branch (4): byte-identical current emission (neutral field, or an
  // already-variable value routed through convertVariables above).
  return withLocator(step, ctx, (chain) => `    await ${chain.locatorExpr}.fill(\`${value}\`);`);
}

export function generateClick(step: BrowserStep, ctx: StepFlagContext): string {
  return withLocator(step, ctx, (chain) => `    await ${chain.locatorExpr}.click();`);
}

export function generateHover(step: BrowserStep, ctx: StepFlagContext): string {
  return withLocator(step, ctx, (chain) => `    await ${chain.locatorExpr}.hover();`);
}

/**
 * Emit a Playwright key press for a Datadog `pressKey` step.
 *
 * Emitted through page.keyboard.press(): the press form for a key not aimed at an
 * element, matching Datadog pressKey semantics (verified against the Playwright
 * skill and live docs). Resolution order: (1) the {{ VAR }}/hasVariable branch
 * stays FIRST and byte-for-byte unchanged (a variable key resolves at runtime and
 * must be neither mapped nor flagged); (2) a known Datadog key name normalizes via
 * PRESS_KEY_ALIAS_MAP (Esc to Escape, Del to Delete, Up to ArrowUp, Return to
 * Enter, Space to a single space, ...), case-insensitively; (3) an F-key
 * (f1..f12) canonicalizes to uppercase F plus the number; (4) a single printable
 * character passes through verbatim (case preserved; Playwright treats 'A' as
 * Shift+a). Anything unresolved fires a key-unmapped flag through the threaded
 * collector and comments the press line out, so an unknown name never reaches
 * page.keyboard.press as active code where it would silently fail at runtime.
 * Modifier chords have zero incidence and no modifiers field exists in any export
 * type, so a compound name deterministically takes the key-unmapped path.
 */
export function generatePressKey(step: BrowserStep, ctx: StepFlagContext): string {
  const key = step.params?.value || 'Enter';
  const hasVariable = /\{\{\s*\w+\s*\}\}/.test(key);
  if (hasVariable) {
    const converted = convertVariables(escapeTemplateLiteral(key), ctx.localVarNames);
    return `    await page.keyboard.press(\`${converted}\`);`;
  }

  const resolved = resolvePlaywrightKey(key);
  if (resolved !== null) {
    return `    await page.keyboard.press("${escapeString(resolved)}");`;
  }

  const marker = ctx.collector.emitFlag(
    {
      reason: 'key-unmapped',
      publicId: ctx.publicId,
      stepIndex: ctx.stepIndex,
      message: `Datadog key name ${JSON.stringify(key)} has no Playwright KeyboardEvent.key mapping; the press is commented out for review.`,
    },
    describeDatadogStep(step),
  );
  return `${marker}\n    // await page.keyboard.press("${escapeString(key)}");`;
}

/**
 * Resolve a raw Datadog key name to its canonical Playwright KeyboardEvent.key
 * form, or null when the name is unmapped. Pure, side-effect free. Checks the alias
 * map (case-insensitive), then the f1..f12 F-key pattern, then a
 * single-printable-character passthrough (case preserved).
 */
function resolvePlaywrightKey(rawKey: string): string | null {
  const trimmed = rawKey.trim();
  if (trimmed === '') return null;

  const mapped = PRESS_KEY_ALIAS_MAP[trimmed.toLowerCase()];
  if (mapped !== undefined) return mapped;

  const fKeyMatch = /^f([1-9]|1[0-2])$/i.exec(trimmed);
  if (fKeyMatch) return `F${fKeyMatch[1]}`;

  if ([...trimmed].length === 1) return trimmed;

  return null;
}

export function generatePlaySubTest(step: BrowserStep, ctx: StepFlagContext): string {
  const subtestId = step.params?.subtestPublicId;
  if (!subtestId) {
    return `    // TODO: playSubTest step missing subtestPublicId`;
  }
  const subtest = ctx.subtests?.get(subtestId);
  if (!subtest) {
    return `    // TODO: Subtest "${subtestId}" not found in export; ensure it is exported or add the appropriate tag`;
  }

  // Inline the subtest steps directly
  const substeps = subtest.steps || [];
  if (substeps.length === 0) {
    return `    // Subtest "${subtest.name}" (${subtestId}) has no steps`;
  }

  // Prefer the PARENT per-spec used-name set so inlined-subtest hoisted consts
  // dedupe against outer-step consts; fall back to a local set when the parent
  // context has none (a caller that constructed a bare StepFlagContext).
  const usedVarNames = ctx.usedVarNames ?? new Set<string>();
  let code = `    // --- Inlined subtest: ${subtest.name} (${subtestId}) ---`;
  for (let i = 0; i < substeps.length; i++) {
    // Rebuild a per-substep context keeping the PARENT publicId (the check whose
    // spec and construct are affected) and using the substep's index, so flags
    // fired inside an inlined subtest attribute to the parent check. Thread the
    // shared used-name set so hoisted factory consts dedupe across the boundary.
    // Inherit the parent test's navigation timeout so a substep's derived firstMatch
    // settle budget matches the enclosing test. Inherit the
    // parent per-spec state too: a substep's runApiTest must continue the PARENT
    // apiResponse numbering, its extract_values names must land in the PARENT
    // localVarNames set, and a nested playSubTest must resolve against the same map.
    const substepCtx: StepFlagContext = { collector: ctx.collector, publicId: ctx.publicId, stepIndex: i, usedVarNames, navTimeoutSec: ctx.navTimeoutSec, localVarNames: ctx.localVarNames, apiResponse: ctx.apiResponse, subtests: ctx.subtests };
    code += '\n\n' + generateStepCode(substeps[i], i, false, usedVarNames, substepCtx);
  }
  code += `\n    // --- End subtest: ${subtest.name} ---`;
  return code;
}

export function generateSelectOption(step: BrowserStep, ctx: StepFlagContext): string {
  const value = convertVariables(escapeTemplateLiteral(step.params?.value || ''), ctx.localVarNames);
  return withLocator(step, ctx, (chain) => `    await ${chain.locatorExpr}.selectOption(\`${value}\`);`);
}

/**
 * Emit a Playwright hard-wait for a Datadog `wait` step.
 *
 * The seconds-to-ms `* 1000` conversion is correct: Datadog documents browser wait
 * steps in seconds with a 300-second maximum
 * (https://docs.datadoghq.com/synthetics/browser_tests/actions/). This is
 * parse-hardening around that conversion, not unit-detection.
 *
 * Valid input (a number in the inclusive 1..300 range) emits the byte-identical
 * `await page.waitForTimeout(<seconds * 1000>);` with no flag (no advisory on normal
 * waits). A missing, empty, non-numeric, `<= 0`, or `> 300` value is not silently
 * defaulted to a 1-second wait; it fires a `wait-value-invalid` flag through the
 * threaded collector, preserves the DD step, and comments the waitForTimeout line
 * out so the spec still parses but never runs an invented pause.
 * `page.waitForTimeout(ms)` stays the faithful literal translation for valid waits
 * (no deterministic web-first replacement).
 */
export function generateWait(step: BrowserStep, ctx: StepFlagContext): string {
  // Real exports carry a JSON number; the local BrowserStep type says string, so
  // widen the read here (not the type) to accept either form.
  const raw = step.params?.value as unknown;
  const isEmptyString = typeof raw === 'string' && raw.trim() === '';
  const seconds =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  const invalid =
    raw === undefined || raw === null || isEmptyString || Number.isNaN(seconds) || seconds <= 0 || seconds > 300;

  if (invalid) {
    const marker = ctx.collector.emitFlag(
      {
        reason: 'wait-value-invalid',
        publicId: ctx.publicId,
        stepIndex: ctx.stepIndex,
        message: `Wait value ${JSON.stringify(raw)} is missing, non-numeric, or outside the 1..300 second range; the wait is commented out for review.`,
      },
      describeDatadogStep(step),
    );
    return `${marker}\n    // await page.waitForTimeout(/* wait-value-invalid */);`;
  }

  return `    await page.waitForTimeout(${seconds * 1000});`;
}

export function generateRefresh(_step: BrowserStep): string {
  return `    await page.reload();`;
}

export function generateScroll(step: BrowserStep): string {
  const x = step.params?.x || 0;
  const y = step.params?.y || 0;
  return `    await page.evaluate(() => window.scrollBy(${x}, ${y}));`;
}

/**
 * The set of assertElementContent check operators whose intent is NEGATIVE: the
 * assertion holds when the element does NOT match. These are the only two negative
 * operators observed, so the classifier is a small closed set, not an engine.
 * notIsEmpty is deliberately NOT here: non-emptiness is an existence claim, so it
 * classifies positive (see assertionPolarity JSDoc).
 */
const NEGATIVE_ASSERTION_CHECKS = new Set(['notContains', 'notEquals']);

/**
 * Classify an assertion step's polarity for the emission seam. Pure and total: it
 * takes a BrowserStep and returns exactly one of 'positive' | 'negative' for every
 * possible input, with no I/O, no collector, and no step mutation.
 *
 * Classification table:
 *   - assertElementPresent            => positive (an existence claim)
 *   - assertElementContent contains   => positive
 *   - assertElementContent equals     => positive
 *   - assertElementContent startsWith => positive
 *   - assertElementContent notIsEmpty => positive (non-emptiness is an existence
 *       claim, NOT an absence trap: it asserts the element has some content, so it
 *       rides the pass-if-any self-healing chain like any other positive)
 *   - assertElementContent notContains => negative
 *   - assertElementContent notEquals   => negative
 *   - any unrecognized or missing check => positive
 *
 * The unknown-check default is positive because the two failure modes are not
 * symmetric: a wrongly-positive assertion fails LOUDLY at runtime (the assertion
 * simply does not hold), whereas a wrongly-negative assertion is a false-green trap
 * (a not.* matcher passes vacuously when the element is absent). Defaulting unknown
 * operators positive can never manufacture a silent pass. The flag that surfaces an
 * unimplemented operator is emitted at the emission site
 * (generateAssertElementContent), NOT by this classifier: keeping the classifier a
 * pure two-value function is the whole point of the seam.
 *
 * This two-value contract is the entire boundary with the per-operator matcher map.
 * The matcher map (notEquals, notIsEmpty, greater, lessThan, assertPageLacks
 * dispatch, DOM-presence semantics, convertVariables in assert values) plugs into
 * this polarity, adding no new classification axis.
 *
 * @param step - The assertion BrowserStep to classify (its type and params.check).
 * @returns 'positive' or 'negative'; never anything else.
 */
export function assertionPolarity(step: BrowserStep): 'positive' | 'negative' {
  // assertElementPresent has no check semantics: the type alone makes it a positive
  // existence assertion, so an accidental params.check never flips it.
  if (step.type === 'assertElementPresent') return 'positive';

  const check = step.params?.check;
  if (check !== undefined && NEGATIVE_ASSERTION_CHECKS.has(check)) return 'negative';

  // Everything else, including unknown and missing checks, is positive by the
  // safe-default rule above.
  return 'positive';
}

/**
 * The set of assertElementContent check operators with an implemented matcher in
 * the emitter: contains, equals, startsWith, notContains, notEquals (native pinned
 * negative), notIsEmpty (positive non-whitespace matcher), greater and lessThan
 * (numeric-parse matchers). An operator OUTSIDE this set is still surfaced with the
 * assertion-operator-unknown flag rather than silently emitting a possibly-wrong
 * matcher: the flag seam is retained so a genuinely unknown or future operator never
 * becomes a silent false green. notContains and notEquals are implemented and
 * negative; the rest are implemented and positive.
 */
const IMPLEMENTED_ASSERTION_CHECKS = new Set([
  'contains',
  'equals',
  'startsWith',
  'notContains',
  'notEquals',
  'notIsEmpty',
  'greater',
  'lessThan',
]);

/**
 * The numeric assertElementContent operators and their Playwright matcher methods.
 * greater maps to toBeGreaterThan, lessThan to toBeLessThan. Membership here (not in
 * renderPositiveContentMatcher) routes a step
 * through the distinct numeric-parse expect.poll shape rather than the locator-text
 * matcher shape.
 */
const NUMERIC_ASSERTION_METHODS: Record<string, string> = {
  greater: 'toBeGreaterThan',
  lessThan: 'toBeLessThan',
};

/**
 * The two inline comment lines that document the negative-assertion polarity
 * decision. Pinning a negative to the primary candidate keeps an unrelated fallback
 * element from satisfying the negation by accident (the pass-if-any trap). Datadog's
 * multiLocator negative-resolution is undocumented and unexercised in the observed
 * exports, so pinning prevents a false green and is the settled choice: the ambiguity
 * is unsettleable, not an inference to be implemented. No em-dashes.
 */
const NEGATIVE_POLARITY_COMMENT =
  '    // Negative assertion pinned to the primary candidate only: an unrelated fallback element must never satisfy it by accident.\n' +
  '    // Datadog\'s multiLocator negative-resolution is undocumented and unexercised in the captured exports, so pinning is the only choice that cannot manufacture a false green.';

/**
 * The double-brace-with-word predicate used to decide whether a raw value carries a
 * Datadog {{ VAR }} reference. Identical to the generatePressKey hasVariable regex so
 * the whole generator uses one variable-detection rule.
 */
const CONTENT_VALUE_HAS_VARIABLE = /\{\{\s*\w+\s*\}\}/;

/**
 * The emitted-source snippet that regex-escapes a runtime string, appended to a
 * runtime value before it is fed to new RegExp. Two consumers share this ONE const so
 * the escape idiom can never drift: (1) the startsWith variable branch in
 * renderStartsWithMatcherArg below, and (2) generateAssertCurrentUrl's variable
 * branches. The $& replacement backreferences the matched metacharacter and prefixes
 * a backslash, so a hostile runtime value cannot act as regex metacharacters. Built
 * with string escapes only, never a raw control byte.
 */
const INLINE_REGEX_ESCAPE = ".replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')";

/**
 * Render the string matcher ARGUMENT for a content assertion value. This is the
 * single choke point deciding plain-vs-variable emission for the quote-delimited
 * string matchers (contains / equals / notContains / notEquals):
 *   - No {{ VAR }}: a double-quoted escapeString literal (the byte-stable form the
 *     golden and matcher-stability guarantees depend on).
 *   - {{ VAR }} present: a backtick template of convertVariables(escapeTemplateLiteral)
 *     so the variable resolves to process.env at runtime.
 */
function renderStringMatcherArg(value: string, localVarNames?: ReadonlySet<string>): string {
  if (CONTENT_VALUE_HAS_VARIABLE.test(value)) {
    return `\`${convertVariables(escapeTemplateLiteral(value), localVarNames)}\``;
  }
  return `"${escapeString(value)}"`;
}

/**
 * Render the anchored-prefix RegExp matcher ARGUMENT for the startsWith value. The
 * single choke point for startsWith emission:
 *   - No {{ VAR }}: new RegExp("^<escapeRegex value>"), the byte-stable form.
 *   - {{ VAR }} present: new RegExp('^' + `<template>`.replace(...)) where the
 *     runtime value is regex-escaped via the shared INLINE_REGEX_ESCAPE idiom so a
 *     hostile runtime value cannot inject regex metacharacters.
 */
function renderStartsWithMatcherArg(value: string, localVarNames?: ReadonlySet<string>): string {
  if (CONTENT_VALUE_HAS_VARIABLE.test(value)) {
    return `new RegExp('^' + \`${convertVariables(escapeTemplateLiteral(value), localVarNames)}\`${INLINE_REGEX_ESCAPE})`;
  }
  return `new RegExp(${JSON.stringify('^' + escapeRegex(value))})`;
}

/**
 * Render the positive assertElementContent matcher call for a resolved locator
 * token. The matcher STRINGS are the byte-stable form for contains / equals /
 * startsWith when the value carries no {{ VAR }};
 * when it does, the value flows through convertVariables (renderStringMatcherArg /
 * renderStartsWithMatcherArg) so it resolves to process.env at runtime. Only the
 * receiving locator token and an optional trailing option object (for the
 * per-candidate timeout in the helper callback) vary otherwise. optionsExpr is
 * appended as a trailing matcher argument when provided (the timeout-forwarding
 * path), and omitted for the direct/soft paths.
 */
function renderPositiveContentMatcher(tokenExpr: string, check: string, value: string, expectFn: string, optionsExpr: string, localVarNames?: ReadonlySet<string>): string {
  const opt = optionsExpr ? `, ${optionsExpr}` : '';
  switch (check) {
    case 'equals':
      return `${expectFn}(${tokenExpr}).toHaveText(${renderStringMatcherArg(value, localVarNames)}${opt})`;
    case 'startsWith':
      return `${expectFn}(${tokenExpr}).toHaveText(${renderStartsWithMatcherArg(value, localVarNames)}${opt})`;
    case 'notIsEmpty':
      // notIsEmpty emits the POSITIVE non-whitespace matcher toHaveText(/\S/).
      // assertionPolarity classifies notIsEmpty positive (an existence claim), so this
      // rides the assertOnFirstMatch self-heal chain and is never inverted. The
      // positive /\S/ form self-heals and cannot false-green on whitespace-only text.
      // notIsEmpty ignores params.value. The regex literal is written with a string
      // escape (\\S), never a raw control byte.
      return `${expectFn}(${tokenExpr}).toHaveText(/\\S/${opt})`;
    case 'contains':
    default:
      return `${expectFn}(${tokenExpr}).toContainText(${renderStringMatcherArg(value, localVarNames)}${opt})`;
  }
}

/**
 * Render the NEGATIVE assertElementContent matcher call for a resolved locator token.
 * This is the single choke point for negative matcher strings so the notContains and
 * notEquals emission never drifts apart:
 *   - notContains -> .not.toContainText("<escaped value>")  (containment negation)
 *   - notEquals   -> .not.toHaveText("<escaped value>")     (native pinned negative)
 * The matcher is ALWAYS a native negation (.not.*); a negative intent is never
 * inverted into a positive and never commented out for the implemented set. Negatives
 * pin to the primary candidate expression at the call site (they never ride the
 * pass-if-any chain), so this helper takes a single receiver token.
 */
function renderNegativeContentMatcher(tokenExpr: string, check: string, value: string, expectFn: string, localVarNames?: ReadonlySet<string>): string {
  // The value argument routes through the same renderStringMatcherArg choke point as
  // the positives: a plain value stays a byte-identical double-quoted literal; a
  // {{ VAR }} value becomes a convertVariables backtick template.
  const arg = renderStringMatcherArg(value, localVarNames);
  if (check === 'notEquals') {
    return `${expectFn}(${tokenExpr}).not.toHaveText(${arg})`;
  }
  // notContains (and any other negative operator routed here) keeps the byte-stable
  // containment negation.
  return `${expectFn}(${tokenExpr}).not.toContainText(${arg})`;
}

/**
 * Render the numeric threshold expression for the greater / lessThan matchers. A
 * finite numeric literal emits its canonical numeric
 * form (String(Number(value))) so a plain "1" becomes the bare literal 1. A
 * non-numeric or variable threshold is emitted as Number(`<resolved value>`), where
 * the value routes through convertVariables so a {{ VAR }} threshold resolves to
 * process.env at runtime; a garbage literal ("many") then yields Number("many") ==
 * NaN, and every NaN comparison is false, so the poll never passes and the failure
 * surfaces loudly at timeout. This never emits a bare unquoted garbage token that
 * would be a runtime ReferenceError.
 */
function renderNumericThreshold(value: string, localVarNames?: ReadonlySet<string>): string {
  const n = Number(value);
  if (Number.isFinite(n) && value.trim() !== '') {
    return String(n);
  }
  return `Number(\`${convertVariables(escapeTemplateLiteral(value), localVarNames)}\`)`;
}

/**
 * Render a numeric assertElementContent matcher (greater / lessThan) as an
 * expect.poll (non-soft) or one-shot expect.soft (soft) call over a Number()-parsed
 * innerText read of the receiver. expect.poll restores auto-retry (poll available
 * since Playwright 1.21) and re-reads innerText each attempt; expect.poll has no soft
 * variant, so the soft path uses a one-shot expect.soft(Number(await ...)) that
 * records instead of throwing. NaN comparisons are always false, so non-numeric
 * element text fails loud at timeout and never false-greens.
 *
 * @param receiverExpr - the locator expression whose innerText is parsed (el for the
 *   per-candidate helper callback, or a page-locator expression for single/soft).
 * @param method - toBeGreaterThan or toBeLessThan.
 * @param threshold - the pre-rendered numeric threshold expression.
 * @param mode - 'poll' (retrying, non-soft), 'poll-timeout' (retrying inside the
 *   assertOnFirstMatch callback, forwards { timeout }), or 'soft' (one-shot record).
 */
function renderNumericMatcher(receiverExpr: string, method: string, threshold: string, mode: 'poll' | 'poll-timeout' | 'soft'): string {
  const read = `Number(await ${receiverExpr}.innerText())`;
  if (mode === 'soft') {
    return `expect.soft(${read}).${method}(${threshold})`;
  }
  const pollOpts = mode === 'poll-timeout' ? ', { timeout }' : '';
  return `expect.poll(async () => ${read}${pollOpts}).${method}(${threshold})`;
}

export function generateAssertElementPresent(step: BrowserStep, ctx: StepFlagContext): string {
  const expectFn = step.allowFailure ? 'expect.soft' : 'expect';
  // assertElementPresent is always positive (an existence claim). Datadog "present"
  // means the element is connected to the Document (in-DOM), so a present-but-hidden
  // element must PASS. The matcher therefore asserts DOM attachment, not on-screen
  // visibility (an on-screen-visibility matcher would false-fail on hidden-but-present
  // elements). Soft assertions use the locator-level firstMatch result because a soft
  // expectation records instead of throwing and so cannot drive per-candidate retry;
  // a non-soft multi-candidate assertion self-heals per candidate via
  // assertOnFirstMatch; a single candidate keeps the direct byte-stable shape.
  return withLocator(step, ctx, (chain) => {
    if (step.allowFailure) {
      const softComment = chain.isMulti
        ? '    // Soft assertion: expect.soft records instead of throwing, so per-candidate retry cannot apply; use the locator-level firstMatch result.\n'
        : '';
      return `${softComment}    await ${expectFn}(${chain.locatorExpr}).toBeAttached();`;
    }
    if (chain.isMulti) {
      return `    await assertOnFirstMatch(page, ${chain.factoryExpr}, async (el, timeout) => { await expect(el).toBeAttached({ timeout }); });`;
    }
    return `    await expect(${chain.primaryExpr}).toBeAttached();`;
  });
}

export function generateAssertElementContent(step: BrowserStep, ctx: StepFlagContext): string {
  const value = step.params?.value || '';
  const check = step.params?.check || 'contains';
  const expectFn = step.allowFailure ? 'expect.soft' : 'expect';
  const polarity = assertionPolarity(step);
  const implemented = IMPLEMENTED_ASSERTION_CHECKS.has(check);

  return withLocator(step, ctx, (chain) => {
    // An unimplemented operator (an unknown check) is surfaced with the
    // assertion-operator-unknown flag rather than silently emitting a
    // possibly-inverted matcher.
    let unknownMarker = '';
    if (!implemented) {
      unknownMarker =
        ctx.collector.emitFlag(
          {
            reason: 'assertion-operator-unknown',
            publicId: ctx.publicId,
            stepIndex: ctx.stepIndex,
            message: `assertElementContent check "${check}" has no implemented matcher, so the assertion is surfaced for review instead of emitted with a possibly wrong polarity.`,
          },
          describeDatadogStep(step),
        ) + '\n';

      if (polarity === 'negative') {
        // Defensive seam: every operator currently in NEGATIVE_ASSERTION_CHECKS has an
        // implemented native matcher, so this branch is unreachable for today's set. It
        // stays in place to guard FUTURE NEGATIVE_ASSERTION_CHECKS growth: a negative
        // operator added there without a matcher in renderNegativeContentMatcher would
        // land here and be commented out rather than silently emitting a
        // positively-phrased line. Never emit a live positive matcher for a negative
        // intent.
        return `${unknownMarker}    // await ${expectFn}(${chain.primaryExpr}).not.toContainText(/* ${check} unimplemented negative operator */);`;
      }
      // Polarity-positive unknown: keep today's default contains emission below the
      // marker so a loud, self-healing positive still runs (a wrong positive fails
      // loudly, never a false green). Route it through the positive shape below.
    }

    if (polarity === 'negative') {
      // Negative assertions NEVER ride the pass-if-any chain: pin to the
      // highest-priority (primary) candidate only, so an unrelated fallback element
      // can never satisfy the negation by accident. When multiple candidates were
      // available, the discarded fallbacks are surfaced with negative-assertion-degraded.
      let degradeMarker = '';
      if (chain.isMulti) {
        const discarded = chain.candidates.length - 1;
        degradeMarker =
          ctx.collector.emitFlag(
            {
              reason: 'negative-assertion-degraded',
              publicId: ctx.publicId,
              stepIndex: ctx.stepIndex,
              message: `Negative assertion pinned to the primary candidate; ${discarded} fallback candidate(s) were discarded so a fallback element cannot satisfy the negation by accident. Datadog's multiLocator negative-resolution is undocumented and unexercised in the captured exports; pinning is the safe choice.`,
            },
            describeDatadogStep(step),
          ) + '\n';
      }
      // notContains and notEquals are both implemented native negatives.
      // renderNegativeContentMatcher is the single choke point that selects the matcher
      // by check value (notContains -> .not.toContainText, notEquals ->
      // .not.toHaveText), so the two negative operators can never drift apart.
      const negMatcher = `    await ${renderNegativeContentMatcher(chain.primaryExpr, check, value, expectFn, ctx.localVarNames)};`;
      return `${degradeMarker}${NEGATIVE_POLARITY_COMMENT}\n${negMatcher}`;
    }

    // Numeric operators (greater / lessThan). These do NOT fit the locator-text
    // matcher shape: the value is parsed out of innerText with Number() and compared,
    // so NaN (non-numeric text or a garbage threshold) is always false and fails loud
    // at timeout, never a false green. expect.poll restores auto-retry over the
    // one-shot form; expect.poll has no soft variant so the soft path records via a
    // one-shot expect.soft. This branch sits BEFORE the generic positive paths below
    // because its matcher shape is distinct.
    const numericMethod = NUMERIC_ASSERTION_METHODS[check];
    if (numericMethod !== undefined) {
      const threshold = renderNumericThreshold(value, ctx.localVarNames);
      if (step.allowFailure) {
        const softComment = chain.isMulti
          ? '    // Soft assertion: expect.soft records instead of throwing, so per-candidate retry cannot apply; use the locator-level firstMatch result.\n'
          : '';
        return `${unknownMarker}${softComment}    await ${renderNumericMatcher(chain.locatorExpr, numericMethod, threshold, 'soft')};`;
      }
      if (chain.isMulti) {
        const matcher = renderNumericMatcher('el', numericMethod, threshold, 'poll-timeout');
        return `${unknownMarker}    await assertOnFirstMatch(page, ${chain.factoryExpr}, async (el, timeout) => { await ${matcher}; });`;
      }
      return `${unknownMarker}    await ${renderNumericMatcher(chain.primaryExpr, numericMethod, threshold, 'poll')};`;
    }

    // Positive assertions. A soft assertion uses the locator-level firstMatch result
    // (it records instead of throwing, so it cannot drive per-candidate retry).
    if (step.allowFailure) {
      const softComment = chain.isMulti
        ? '    // Soft assertion: expect.soft records instead of throwing, so per-candidate retry cannot apply; use the locator-level firstMatch result.\n'
        : '';
      return `${unknownMarker}${softComment}    await ${renderPositiveContentMatcher(chain.locatorExpr, check, value, expectFn, '', ctx.localVarNames)};`;
    }

    // A non-soft multi-candidate positive self-heals per candidate via
    // assertOnFirstMatch, forwarding the per-attempt timeout to the matcher.
    if (chain.isMulti) {
      const matcher = renderPositiveContentMatcher('el', check, value, 'expect', '{ timeout }', ctx.localVarNames);
      return `${unknownMarker}    await assertOnFirstMatch(page, ${chain.factoryExpr}, async (el, timeout) => { await ${matcher}; });`;
    }

    // A single-candidate positive keeps today's direct byte-stable emission.
    return `${unknownMarker}    await ${renderPositiveContentMatcher(chain.primaryExpr, check, value, expectFn, '', ctx.localVarNames)};`;
  });
}

export function generateAssertPageContains(step: BrowserStep): string {
  const value = step.params?.value || '';
  const expectFn = step.allowFailure ? 'expect.soft' : 'expect';
  return `    await ${expectFn}(page.locator("body")).toContainText("${escapeString(value)}");`;
}

/**
 * Emit a Datadog assertPageLacks step. The negative analog of
 * generateAssertPageContains: assertPageLacks carries params.value only (a text),
 * so it is a NEGATIVE page-content check, not a DOM-attachment check. Without this
 * dispatch case the step would fall through the generateStepCodeDefault default and
 * be silently dropped as unsupported-step-type; it emits a live .not.toContainText
 * assertion on the body locator. The value emission is variable-aware through the
 * shared renderStringMatcherArg choke point (the same conditional idiom as the
 * content assertions): a plain value stays a byte-identical double-quoted escapeString
 * literal; a {{ VAR }} value becomes a convertVariables backtick template so it
 * resolves to process.env at runtime.
 */
export function generateAssertPageLacks(step: BrowserStep, localVarNames?: ReadonlySet<string>): string {
  const value = step.params?.value || '';
  const expectFn = step.allowFailure ? 'expect.soft' : 'expect';
  return `    await ${expectFn}(page.locator("body")).not.toContainText(${renderStringMatcherArg(value, localVarNames)});`;
}

export function generateAssertCurrentUrl(step: BrowserStep, localVarNames?: ReadonlySet<string>): string {
  const value = step.params?.value || '';
  const check = step.params?.check || 'contains';
  const expectFn = step.allowFailure ? 'expect.soft' : 'expect';
  // Resolve a Datadog {{ VAR }} in the URL value to process.env at runtime, using the
  // SAME hasVariable predicate the content assertions use (CONTENT_VALUE_HAS_VARIABLE),
  // so the whole generator shares one variable rule. A value with no variable keeps
  // the byte-stable emission. The three RegExp branches runtime-escape the resolved
  // value via the shared INLINE_REGEX_ESCAPE snippet: a hostile runtime value must not
  // act as regex metacharacters. equals is a plain string argument, so it needs no
  // regex escape.
  const hasVariable = CONTENT_VALUE_HAS_VARIABLE.test(value);
  if (hasVariable) {
    const template = `\`${convertVariables(escapeTemplateLiteral(value), localVarNames)}\``;
    switch (check) {
      case 'equals':
        return `    await ${expectFn}(page).toHaveURL(${template});`;
      case 'startsWith':
        // The caret is prepended with string concatenation OUTSIDE the escaped
        // runtime value so the anchor is a literal regex caret, not an escaped one.
        return `    await ${expectFn}(page).toHaveURL(new RegExp('^' + ${template}${INLINE_REGEX_ESCAPE}));`;
      case 'contains':
      default:
        return `    await ${expectFn}(page).toHaveURL(new RegExp(${template}${INLINE_REGEX_ESCAPE}));`;
    }
  }
  switch (check) {
    case 'contains':
      return `    await ${expectFn}(page).toHaveURL(new RegExp(${JSON.stringify(escapeRegex(value))}));`;
    case 'equals':
      return `    await ${expectFn}(page).toHaveURL("${escapeString(value)}");`;
    case 'startsWith':
      return `    await ${expectFn}(page).toHaveURL(new RegExp(${JSON.stringify('^' + escapeRegex(value))}));`;
    default:
      return `    await ${expectFn}(page).toHaveURL(new RegExp(${JSON.stringify(escapeRegex(value))}));`;
  }
}

export function generateRunApiTest(step: BrowserStep, ctx?: StepFlagContext): string {
  // Per-spec counter box: shared through ctx so a second runApiTest in the same
  // spec (or an inlined substep) continues the numbering (apiResponse, apiResponse2,
  // ...). A direct call with no ctx derives a throwaway box and starts fresh.
  const apiResponse = ctx?.apiResponse ?? { counter: 0 };
  apiResponse.counter++;
  const request = step.params?.request?.config?.request || {};
  const options = step.params?.request?.options || {};
  const method = (request.method || 'GET').toLowerCase();
  const url = request.url || '';
  const convertedUrl = convertVariables(escapeTemplateLiteral(url), ctx?.localVarNames);
  const varName = apiResponse.counter === 1 ? 'apiResponse' : `apiResponse${apiResponse.counter}`;

  // Build request options (headers, body, auth)
  const fetchOptions: string[] = [];

  // Headers
  const headers: Record<string, string> = { ...(request.headers || {}) };
  if (request.basicAuth?.username) {
    const user = convertVariables(escapeTemplateLiteral(request.basicAuth.username), ctx?.localVarNames);
    const pass = request.basicAuth.password
      ? convertVariables(escapeTemplateLiteral(request.basicAuth.password), ctx?.localVarNames)
      : '';
    headers['Authorization'] = `\${Buffer.from(\`${user}:${pass}\`).toString('base64')}`;
  }
  if (Object.keys(headers).length > 0) {
    const headerEntries = Object.entries(headers).map(([k, v]) => {
      if (k === 'Authorization') return `        'Authorization': \`Basic ${v}\``;
      return `        '${k}': \`${convertVariables(escapeTemplateLiteral(v), ctx?.localVarNames)}\``;
    });
    fetchOptions.push(`      headers: {\n${headerEntries.join(',\n')}\n      }`);
  }

  // Body
  if (request.body) {
    const convertedBody = convertVariables(escapeTemplateLiteral(request.body), ctx?.localVarNames);
    fetchOptions.push(`      data: \`${convertedBody}\``);
  }

  let code = `    // Embedded API test\n`;
  if (fetchOptions.length > 0) {
    code += `    const ${varName} = await page.request.${method}(\`${convertedUrl}\`, {\n${fetchOptions.join(',\n')}\n    });\n`;
  } else {
    code += `    const ${varName} = await page.request.${method}(\`${convertedUrl}\`);\n`;
  }
  code += `    await expect(${varName}).toBeOK();`;

  // Extract values from response
  const extractValues = options.extract_values || [];
  if (extractValues.length > 0) {
    const hasJsonPath = extractValues.some(e => e.parser.type === 'json_path');
    const hasRegex = extractValues.some(e => e.parser.type === 'regex');

    if (hasJsonPath) {
      code += `\n    const ${varName}Json = await ${varName}.json();`;
    }
    if (hasRegex) {
      code += `\n    const ${varName}Text = await ${varName}.text();`;
    }

    for (const ev of extractValues) {
      // Register as local variable so subsequent steps (including inlined substeps)
      // reference it directly as ${name}. A no-op when the set is absent (a direct
      // call with no ctx), which only affects LATER steps, never this call's output.
      ctx?.localVarNames?.add(ev.name);

      if (ev.parser.type === 'json_path') {
        // Convert JSONPath like $.items[0].id to JS property access
        const jsPath = ev.parser.value.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '[$1]');
        code += `\n    const ${ev.name} = ${varName}Json.${jsPath};`;
      } else if (ev.parser.type === 'regex') {
        // Extraction convention: take capture group 1 if the pattern defines
        // one, else the full match, else empty string. The g flag is stripped
        // because a global regex changes String.match() semantics (it returns
        // full matches only, so index 1 would be the second full match).
        const { source, flags } = parseDatadogRegex(ev.parser.value);
        const extractionFlags = flags.replace('g', '');
        const regexExpr = extractionFlags
          ? `new RegExp(${JSON.stringify(source)}, ${JSON.stringify(extractionFlags)})`
          : `new RegExp(${JSON.stringify(source)})`;
        code += `\n    const ${ev.name} = (m => m?.[1] ?? m?.[0] ?? '')(${varName}Text.match(${regexExpr}));`;
      }
    }
  }

  return code;
}

/** Dispatch to the right generator (non-iframe path). */
export function generateStepCodeDefault(step: BrowserStep, ctx: StepFlagContext): string {
  switch (step.type) {
    case 'goToUrl':              return generateGoToUrl(step, ctx.localVarNames);
    case 'typeText':             return generateTypeText(step, ctx);
    case 'click':                return generateClick(step, ctx);
    case 'hover':                return generateHover(step, ctx);
    case 'pressKey':             return generatePressKey(step, ctx);
    case 'selectOption':         return generateSelectOption(step, ctx);
    case 'wait':                 return generateWait(step, ctx);
    case 'refresh':              return generateRefresh(step);
    case 'scroll':               return generateScroll(step);
    case 'assertElementPresent': return generateAssertElementPresent(step, ctx);
    case 'assertElementContent': return generateAssertElementContent(step, ctx);
    case 'assertPageContains':   return generateAssertPageContains(step);
    case 'assertPageLacks':      return generateAssertPageLacks(step, ctx.localVarNames);
    case 'assertCurrentUrl':     return generateAssertCurrentUrl(step, ctx.localVarNames);
    case 'runApiTest':           return generateRunApiTest(step, ctx);
    case 'playSubTest':          return generatePlaySubTest(step, ctx);
    default:
      // Structured replacement for a free-text unsupported-step comment. The returned
      // marker carries the preserved DD step and is the branch's entire output: it
      // emits no runnable code, exactly like the comment it replaced. No deactivates
      // field (deactivation is scoped strictly to the zero-candidate
      // locator-unresolvable case).
      return ctx.collector.emitFlag(
        {
          reason: 'unsupported-step-type',
          publicId: ctx.publicId,
          stepIndex: ctx.stepIndex,
          message: `Unsupported Datadog step type "${step.type}"; manual conversion required.`,
        },
        describeDatadogStep(step),
      );
  }
}

// ---------------------------------------------------------------------------
// Iframe-aware step code (folded into the single firstMatch chain)
// ---------------------------------------------------------------------------

/**
 * The page step types whose action or assertion cannot be pinned to the owning
 * frame deterministically at generation time: assertCurrentUrl reads the top-level
 * page URL, and runApiTest issues a request through page.request. For these the
 * emission runs at PAGE scope by design, which we surface in the provenance comment
 * rather than pretending a frame scope we cannot derive from the export.
 */
const PAGE_SCOPE_IFRAME_STEP_TYPES = new Set(['assertCurrentUrl', 'runApiTest']);

/**
 * Emit an iframe-classified step. TOTAL: returns a non-null string for EVERY step
 * type, unknowns included, so no step can silently fall through to main-page scope.
 *
 * There is no separate self-healing mechanism. This function builds an
 * iframe-provenance comment and then delegates the emission to
 * generateStepCodeDefault. The firstMatch chain that default emission produces for
 * element steps already probes the main page THEN every page.frames() frame, so an
 * iframe element step and a main-page element step share ONE mechanism. Page-level
 * steps emit their normal page-scope statement. No auto-waiting frame lookup is
 * emitted anywhere, so a zero-iframe page cannot hang.
 *
 * The dispatch is total because generateStepCodeDefault is total (its default branch
 * fires the unsupported-step-type flag), so the returned string is always the
 * provenance comment plus exactly one default emission, never null.
 *
 * For assertCurrentUrl and runApiTest the comment additionally states that the
 * assertion or request runs at page scope by design, because the owning frame
 * cannot be known deterministically at generation time (surfaced, not silent).
 *
 * ctx is threaded so the iframe path shares the same emit seam as the default path;
 * any flag (locator-unresolvable, unsupported-step-type, key-unmapped, ...) fires
 * exactly once through generateStepCodeDefault, never double-emitted here.
 */
export function generateIframeStepCode(step: BrowserStep, ctx: StepFlagContext): string {
  // The provenance comment reuses the historical "May be inside an iframe" slot,
  // now stating that firstMatch searches the main page then all frames. Built on a
  // SINGLE line: describeDatadogStep is deliberately NOT interpolated here (a
  // hostile step name could carry a newline), so the comment can never split into
  // a runnable line. The step identity already appears in the
  // Step-N comment generateStepCode prepends and, for flagged steps, in the marker.
  let provenance = `    // May be inside an iframe: firstMatch searches the main page then all frames.`;
  if (PAGE_SCOPE_IFRAME_STEP_TYPES.has(step.type)) {
    provenance += `\n    // This step runs at page scope by design: the owning frame cannot be determined deterministically from the export.`;
  }

  return `${provenance}\n${generateStepCodeDefault(step, ctx)}`;
}

// ---------------------------------------------------------------------------
// Full step code (picks iframe or default path)
// ---------------------------------------------------------------------------

export function generateStepCode(
  step: BrowserStep,
  stepIndex: number,
  isIframe: boolean,
  usedVarNames: Set<string>,
  flagCtx: StepFlagContext,
): string {
  const stepComment = `    // Step ${stepIndex + 1}: ${step.name || step.type}`;

  // Locator-residue detection: the ONE wiring point, covering BOTH the default and
  // the iframe emission paths (each step renders through exactly one, so this cannot
  // double-emit). We re-resolve extractLocator here at the wrapper level because it
  // is pure and cheap, and because the marker cannot be returned from
  // generateLocatorCode (callers embed its expression inside larger await statements)
  // nor from generateIframeStepCode (which bypasses generateLocatorCode entirely).
  // Only the six locator-consuming step types are inspected; a null locator is the
  // zero-candidate case owned by withLocator, so the predicate takes non-null locators
  // only. Detection ONLY: the step's emitted code is untouched and stays
  // byte-identical; the flag never sets deactivates (a degraded or garbage candidate
  // stays ACTIVE and flagged; deactivation is the zero-signal slice).
  // extractLocator's selection logic is never modified here.
  let residueMarker = '';
  if (LOCATOR_CONSUMING_STEP_TYPES.has(step.type)) {
    // extractLocator returns an ordered Locator[]. Run residue detection on the
    // PRIMARY candidate only when the array is non-empty: the primary candidate is
    // the one that names the chain, so residue on deliberately weak lower rungs is
    // expected and is covered by the weak-fallback-chain flag, not here. An empty
    // array is the zero-candidate case owned by withLocator (the deactivate-and-flag
    // path). candidates[0] is live by construction (index 0 is never demoted: a stale
    // rung is only marked provenance-only when a stabler sibling precedes it), so this
    // consumes the same live primary the emitted chain leads with, unchanged.
    const candidates = extractLocator(step.params?.element);
    const locator = candidates[0];
    if (locator) {
      const residue = detectLocatorResidue(locator);
      if (residue) {
        // Truncate the value to 120 chars and JSON.stringify it so any quote,
        // backslash, or newline in a DD-derived value is quoted safely in the
        // message; formatInlineMarker then routes the whole message through
        // escapeString, so a hostile value cannot break out of the single-line
        // comment. describeDatadogStep is passed RAW (never pre-escaped) per the
        // one-choke-point escaping discipline.
        const truncated = locator.value.length > 120 ? `${locator.value.slice(0, 120)}...` : locator.value;
        residueMarker =
          flagCtx.collector.emitFlag(
            {
              reason: residue.reason,
              publicId: flagCtx.publicId,
              stepIndex: flagCtx.stepIndex,
              message: `Locator is likely unstable residue (${residue.detail}); emitted live for review but may never match. Resolved ${locator.type} locator: ${JSON.stringify(truncated)}.`,
            },
            describeDatadogStep(step),
          ) + '\n';
      }
    }
  }

  if (isIframe) {
    // generateIframeStepCode is TOTAL (returns a string for every step type), so the
    // iframe branch returns unconditionally: there is no null fall-through to
    // main-page scope.
    return `${stepComment}\n${residueMarker}${generateIframeStepCode(step, flagCtx)}`;
  }

  return `${stepComment}\n${residueMarker}${generateStepCodeDefault(step, flagCtx)}`;
}

// ---------------------------------------------------------------------------
// Spec file generation
// ---------------------------------------------------------------------------

export function generateSpecFile(
  test: BrowserTest,
  collector: FlagCollector,
  subtests?: ReadonlyMap<string, BrowserTest>,
): { spec: string; hasIframes: boolean; iframeStepCount: number; hasMultiCandidate: boolean; usesHelpers: boolean; secretKeys: string[]; pwEngines: string[] } {
  const { name, steps, config } = test;
  const testName = escapeString(name);
  const startUrl = config?.request?.url;
  const setCookie = config?.setCookie;
  const localVariables = (config?.variables || []).filter(v => v.type === 'text' && v.pattern);
  const stepsArray = steps || [];

  // Per-spec state (threaded through each StepFlagContext below, never module-level).
  // localVarNames is seeded from the text-pattern local variables so their names
  // interpolate as ${name}; runApiTest extract_values add more names mid-spec, visible
  // to every later step and inlined substep because the single Set instance is shared.
  // apiResponse is the per-spec API-response counter box (apiResponse, apiResponse2, ...).
  const localVarNames = new Set(localVariables.map(v => v.name));
  const apiResponse = { counter: 0 };

  // Analyze steps for iframe usage
  const iframeMap = analyzeStepsForIframes(startUrl, stepsArray);
  const hasIframes = iframeMap.size > 0;

  // Log iframe detections
  for (const [stepIdx, ctx] of iframeMap) {
    console.log(`  iframe: "${name}" step ${stepIdx + 1} → ${extractIframeSrcPath(ctx.iframeSrc)}`);
  }

  // Check if we need to prepend a goto for the start URL
  const firstStepIsGoTo = stepsArray.length > 0 && stepsArray[0].type === 'goToUrl';
  const needsStartUrlGoto = startUrl && !firstStepIsGoTo;

  // --- Generate test body first so subtest imports are discovered ---
  let body = '';

  if (setCookie) {
    const cookies = setCookie.split(';').map(c => c.trim()).filter(Boolean);
    const domain = startUrl ? new URL(startUrl).hostname : 'localhost';
    body += `    // Set cookies from Datadog config\n`;
    body += `    await page.context().addCookies([\n`;
    for (const cookie of cookies) {
      // A Set-Cookie string carries the cookie name=value plus attribute tokens
      // (Secure, HttpOnly, Path=, Expires=, Domain=, SameSite=,
      // Max-Age, Priority). Filter those attribute tokens so they stop becoming
      // bogus cookie entries. The predicate is anchored at the token start and
      // requires the token to be exactly the attribute name or the attribute name
      // followed by '=', so a real cookie whose name merely starts with one of
      // these (e.g. path2) still passes. Mechanical filter: no flag, no marker.
      if (isCookieAttributeToken(cookie)) continue;

      const eqIdx = cookie.indexOf('=');
      // No-name=value guard: skip any token whose first '=' index is less than 1
      // (covers both no-equals junk and empty-name tokens like "=oops").
      if (eqIdx < 1) continue;

      const cookieName = cookie.substring(0, eqIdx);
      const cookieValue = cookie.substring(eqIdx + 1);
      body += `      { name: "${escapeString(cookieName)}", value: "${escapeString(cookieValue)}", domain: "${domain}", path: "/" },\n`;
    }
    body += `    ]);\n\n`;
  }

  if (localVariables.length > 0) {
    body += `    // Local variables (generated per run)\n`;
    for (const v of localVariables) {
      // Collect any moment token outside the implemented table. The const still
      // emits (runnable, literal passthrough); the tokens are surfaced as ONE flag
      // per affected variable (not per token, noise budget). Token text is pattern
      // text, not a secret, so naming it in the message is correct.
      const unknownTokens: string[] = [];
      const jsExpr = convertPatternToJs(v.pattern, unknownTokens);
      if (unknownTokens.length > 0) {
        const marker = collector.emitFlag({
          reason: 'date-token-unknown',
          publicId: test.public_id,
          stepIndex: null,
          message:
            `Local variable "${v.name}" uses date() moment token(s) outside the implemented table: ` +
            `${unknownTokens.join(', ')}. These tokens render literally, so the date output will not ` +
            `match Datadog until the pattern is adjusted.`,
        });
        body += `${marker}\n`;
      }
      body += `    const ${v.name} = ${jsExpr};\n`;
    }
    body += '\n';
  }

  if (needsStartUrlGoto) {
    const convertedUrl = convertVariables(escapeTemplateLiteral(startUrl), localVarNames);
    body += `    // Navigate to start URL\n`;
    body += `    await page.goto(\`${convertedUrl}\`);\n`;
    if (stepsArray.length > 0) body += '\n';
  }

  const usedVarNames = new Set<string>();

  // Per-spec secret-routing state. `used` is seeded with EVERY config-variable name
  // visible on the test so a derived password key can never collide with an existing
  // env-var name and silently rebind the fill to an unrelated value; the ladder then
  // falls to tier-2 on such a seed collision. Both the `variables` and the
  // (defensively read) `configVariables` arrays on test.config are seeded when
  // present. `routed` accumulates the derived keys in step order; it is returned and
  // written into _manifest.json for step 08. Threaded into each StepFlagContext beside
  // usedVarNames.
  const configForSeed = (config ?? {}) as {
    variables?: Array<{ name?: string }>;
    configVariables?: Array<{ name?: string }>;
  };
  const secretKeysState = { used: new Set<string>(), routed: [] as string[] };
  for (const v of configForSeed.variables ?? []) {
    if (v?.name) secretKeysState.used.add(v.name);
  }
  for (const v of configForSeed.configVariables ?? []) {
    if (v?.name) secretKeysState.used.add(v.name);
  }

  // The test-level navigation timeout (seconds) is the settle-budget fallback for any
  // step with no per-step timeout. Threaded into every per-step ctx (and inherited by
  // inlined substeps via generatePlaySubTest, which copies it onto the substep ctx),
  // so the derived firstMatch budget is uniform across the spec.
  const navTimeoutSec = test.options?.initialNavigationTimeout;

  for (let i = 0; i < stepsArray.length; i++) {
    const flagCtx: StepFlagContext = { collector, publicId: test.public_id, stepIndex: i, usedVarNames, secretKeys: secretKeysState, navTimeoutSec, localVarNames, apiResponse, subtests };
    const step = stepsArray[i];
    body += generateStepCode(step, i, iframeMap.has(i), usedVarNames, flagCtx);
    if (i < stepsArray.length - 1) body += '\n\n';
  }

  // Zero-assertion (spec-level): a generated spec that runs no assertion is flagged
  // exactly once so a triager knows the migrated check verifies nothing. Authoring a
  // meaningful assertion is an intent judgment the tool must never make, so we detect
  // and flag, never invent one. The scan runs on the assembled BODY only (before
  // header assembly, so test.setTimeout / page.on / the header never count) and strips
  // every line whose trimmed form starts with '//' (step comments, MIGRATION-FLAG
  // markers, preserved DD-step lines, and steps commented out by the zero-candidate
  // path are not runtime assertions). Any surviving expect( or expect.soft( counts,
  // including
  // runApiTest's toBeOK form. Scan BEFORE splicing the marker so the logic is
  // order-independent (the marker is a comment either way). The marker carries no
  // ddStepText and stepIndex null (there is no single originating step); it is
  // spliced at the top of the body so it is the first thing a triager sees. This
  // flag never deactivates: an assertion-free check still runs its steps.
  const executableBody = body
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  if (!/\bexpect(\.soft)?\s*\(/.test(executableBody)) {
    const marker = collector.emitFlag({
      reason: 'zero-assertion',
      publicId: test.public_id,
      stepIndex: null,
      message:
        'This spec contains no runtime assertion; the migrated check verifies nothing. Authoring a meaningful assertion is an intent judgment left to the developer (the tool never auto-invents one).',
    });
    body = stepsArray.length > 0 ? `${marker}\n\n${body}` : `${marker}\n${body}`;
  }

  // --- Now build the full spec with imports ---
  // Derive the helpers import from ACTUAL use, not from iframe presence alone. Scan
  // the comment-stripped executable body (reusing the zero-assertion idiom) for each
  // co-located helpers symbol, then import exactly the symbols the body references.
  // The iframe path is folded into the single firstMatch chain, so firstMatch (and
  // its assertion analogue) are the only helper symbols a spec can reference: an
  // iframe spec imports firstMatch when its element steps emit chains, and a spec
  // whose iframe steps are all non-element imports nothing. A new helper is wired in
  // by adding its symbol to this list.
  const executableForImports = body
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const HELPER_SYMBOLS = ['firstMatch', 'assertOnFirstMatch'] as const;
  const referencedHelpers: string[] = HELPER_SYMBOLS.filter((sym) =>
    new RegExp(`\\b${sym}\\b`).test(executableForImports),
  );
  const usesHelpers = referencedHelpers.length > 0;

  // hasMultiCandidate: "at least one step emitted a firstMatch / assertOnFirstMatch
  // chain into the executable body." Derived from the comment-stripped executable body, NOT
  // from a second, independent extractLocator length scan, so the manifest field, the src/08
  // reviewMultiSelector tag, and the src/12 Self-Healing Locator Chains report can never
  // disagree with what the spec body actually contains. The assertion-polarity path pins
  // a NEGATIVE assertion (soft OR hard) to the primary candidate and emits no chain, so a
  // check whose only multi-candidate step is a negative assertion is correctly false here (no
  // false reviewMultiSelector tag, no over-claimed report entry). A soft POSITIVE assertion
  // rides the locator-level firstMatch chain and stays true, so the field tracks emitted-chain
  // reality rather than polarity. A dedicated regex (not an alias of usesHelpers) so a future
  // non-chain helper symbol added to HELPER_SYMBOLS cannot skew this field.
  const hasMultiCandidate = /\b(firstMatch|assertOnFirstMatch)\b/.test(executableForImports);

  // --- Derive the Playwright engine set and emit the check-level flags ---
  //
  // This is the one canonical decision seam: the engine set is decided here on the
  // FlagCollector seam generateSpecFile already carries, and the same decision rides
  // the existing _manifest.json files[] channel to step 08 (branch BrowserCheck vs
  // PlaywrightCheck) and step 12 (report), exactly like hasMultiCandidate and
  // secretKeys. No second flag path is ever added to src/08.
  //
  // These three flags are CHECK-LEVEL (stepIndex null), so the inline marker string
  // that emitFlag returns is deliberately discarded: they do not annotate a spec step.
  // Their four real surfaces are exports/migration-flags.json, the step-12 report
  // section, the reviewMigrationFlag construct tag src/08 appends for any flagged
  // publicId, and the provenance header of the companion playwright.config.ts. The
  // spec BODY is never touched: Playwright spec code is browser-agnostic, so the
  // engine set influences nothing here.
  const derivation = deriveEnginesFromDeviceIds(test.options?.device_ids);

  if (derivation.unmappedDeviceIds.length > 0) {
    const plural = derivation.unmappedDeviceIds.length === 1 ? 'y' : 'ies';
    collector.emitFlag({
      reason: 'pwcs-device-unmapped',
      publicId: test.public_id,
      stepIndex: null,
      message: `device_ids entr${plural} not mappable to a Playwright engine and ignored for browser routing: ${derivation.unmappedDeviceIds.join(', ')}`,
    });
  }

  if (derivation.mappedDeviceIds.length > derivation.engines.length) {
    // The dedupe is surfaced on EVERY declared-vs-distinct reduction, including
    // BrowserCheck-bound collapses (for example chrome + edge to one chromium engine),
    // so the count reduction is always visible. The Edge sentence is appended only when
    // a declared profile's family is edge (the lowercased head before the first dot).
    const hasEdge = derivation.mappedDeviceIds.some((id) => deviceFamily(id) === 'edge');
    const edgeNote = hasEdge ? ' Edge is Chromium-based and runs under the chromium project.' : '';
    collector.emitFlag({
      reason: 'pwcs-engines-deduped',
      publicId: test.public_id,
      stepIndex: null,
      message: `Datadog declared ${derivation.mappedDeviceIds.length} browser device profiles (${derivation.mappedDeviceIds.join(', ')}); deduplicated to ${derivation.engines.length} distinct Playwright engine project(s) (${derivation.engines.join(', ')}).${edgeNote}`,
    });
  }

  if (derivation.engines.length > 1 && hasPrivateLocations(test)) {
    collector.emitFlag({
      reason: 'pwcs-private-location-agent-version',
      publicId: test.public_id,
      stepIndex: null,
      message: `Multi-browser Playwright Check Suite routed to private location(s). Playwright Check Suites require Checkly Agent 6.0.3 or newer; a minimum container size of 2 CPU cores and 4 GB RAM is recommended. Verify the deployed agent before relying on this check.`,
    });
  }

  const pwEngines = derivation.engines;

  // Type-aware import (readability Option C): when the executable body references
  // the CandidateFactory alias (a hoisted multi-candidate factory const), append
  // the type symbol to the SAME ../helpers import line rather than emitting a
  // second import. By construction a hoisted const only exists alongside a
  // firstMatch / assertOnFirstMatch statement, so usesHelpers is already true here
  // and a type-only import can never occur; the helpers.ts write gate (keyed on
  // usesHelpers) is therefore unaffected.
  if (/\bCandidateFactory\b/.test(executableForImports)) {
    referencedHelpers.push('type CandidateFactory');
  }

  let spec = `import { test, expect } from "@playwright/test";\n`;
  if (usesHelpers) {
    spec += `import { ${referencedHelpers.join(', ')} } from "../helpers";\n`;
  }

  // Preserve the Datadog browser certificate-ignore option. Emit a file-scope
  // test.use only for an explicit true, so the default page/context
  // fixtures skip TLS verification for this spec. Absent, null, and false emit
  // nothing (Checkly/Playwright default verifies certificates).
  if (test.options?.ignoreServerCertificateError === true) {
    spec += `\ntest.use({ ignoreHTTPSErrors: true });\n`;
  }

  spec += `
test.describe("${testName}", () => {
  test("${testName}", async ({ page }) => {
    test.setTimeout(120_000);
    page.on('request', (request) => {
      if (request.isNavigationRequest()) {
        console.log('Navigation request:', request.url());
      }
    });
`;

  spec += body;

  spec += `
  });
});
`;

  return { spec, hasIframes, iframeStepCount: iframeMap.size, hasMultiCandidate, usesHelpers, secretKeys: secretKeysState.routed, pwEngines };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Batch generation
// ---------------------------------------------------------------------------

export async function generateSpecsForTests(
  tests: BrowserTest[],
  outputDir: string,
  locationType: string,
  collector: FlagCollector,
  subtests?: ReadonlyMap<string, BrowserTest>,
): Promise<GenerationResult> {
  let successCount = 0;
  let errorCount = 0;
  let iframeTestCount = 0;
  let iframeStepCount = 0;
  let helperImportTestCount = 0;
  const generatedFiles: GeneratedFile[] = [];

  for (const test of tests) {
    try {
      const variableContent = extractVariableContent(test);
      trackVariablesFromMultiple(test.name, variableContent);

      const { spec, hasIframes, iframeStepCount: testIframeSteps, hasMultiCandidate, usesHelpers, secretKeys, pwEngines } =
        generateSpecFile(test, collector, subtests);
      const filename = `${sanitizeFilename(test.name, test.public_id)}.spec.ts`;
      const filepath = path.join(outputDir, filename);

      if (hasIframes) {
        iframeTestCount++;
        iframeStepCount += testIframeSteps;
      }
      if (usesHelpers) helperImportTestCount++;

      await writeFile(filepath, spec, 'utf-8');
      successCount++;
      generatedFiles.push({
        logicalId: test.public_id,
        name: test.name,
        filename,
        stepCount: test.steps?.length || 0,
        hasIframes,
        hasMultiCandidate,
        secretKeys,
        pwEngines,
      });
    } catch (err) {
      console.error(`  Error generating ${test.public_id}: ${(err as Error).message}`);
      errorCount++;
    }
  }

  if (generatedFiles.length > 0) {
    const manifest = {
      generatedAt: new Date().toISOString(),
      outputDir,
      locationType,
      files: generatedFiles,
    };
    await writeFile(
      path.join(outputDir, '_manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    );
  }

  return { successCount, errorCount, iframeTestCount, iframeStepCount, helperImportTestCount };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const outputRoot = await getOutputRoot();
  const exportsDir = await getExportsDir();
  const INPUT_FILE = `${exportsDir}/browser-tests.json`;
  const OUTPUT_BASE = `${outputRoot}/tests/browser`;
  const OUTPUT_DIR_PUBLIC = `${OUTPUT_BASE}/public`;
  const OUTPUT_DIR_PRIVATE = `${OUTPUT_BASE}/private`;

  console.log('='.repeat(60));
  console.log('Browser Test Playwright Spec Generator');
  console.log('='.repeat(60));

  await loadExistingVariableUsage();

  if (!existsSync(INPUT_FILE)) {
    console.log(`\nSkipping: Input file not found: ${INPUT_FILE}`);
    console.log('No browser tests to process. Run "npm run export" first if you have browser tests.');
    return;
  }

  console.log(`\nReading: ${INPUT_FILE}`);
  const data = JSON.parse(await readFile(INPUT_FILE, 'utf-8')) as { tests: BrowserTest[]; subtests?: BrowserTest[] };
  const tests = data.tests || [];
  const subtestList = data.subtests || [];
  console.log(`Found ${tests.length} browser tests to process`);
  if (subtestList.length > 0) {
    console.log(`Found ${subtestList.length} subtest(s) to generate as helpers`);
  }

  // Build the per-run subtest map for inline resolution, threaded into
  // generateSpecFile via StepFlagContext.subtests (never a module-level binding).
  const subtests = new Map<string, BrowserTest>();
  for (const sub of subtestList) {
    subtests.set(sub.public_id, sub);
  }

  const publicTests = tests.filter(t => !hasPrivateLocations(t));
  const privateTests = tests.filter(t => hasPrivateLocations(t));
  console.log(`  - Public location tests: ${publicTests.length}`);
  console.log(`  - Private location tests: ${privateTests.length}`);

  if (!existsSync(OUTPUT_DIR_PUBLIC)) await mkdir(OUTPUT_DIR_PUBLIC, { recursive: true });
  if (!existsSync(OUTPUT_DIR_PRIVATE)) await mkdir(OUTPUT_DIR_PRIVATE, { recursive: true });
  console.log(`\nCreated directories: ${OUTPUT_DIR_PUBLIC}, ${OUTPUT_DIR_PRIVATE}`);

  // One per-run FlagCollector, shared across both location passes so public and
  // private aggregate into a single migration-flags.json and stay in sync. Never
  // a module-level binding (the repo forbids new module-level mutable state).
  const collector = new FlagCollector();

  console.log('\nGenerating public location specs...');
  const publicResult = await generateSpecsForTests(publicTests, OUTPUT_DIR_PUBLIC, 'public', collector, subtests);

  console.log('\nGenerating private location specs...');
  const privateResult = await generateSpecsForTests(privateTests, OUTPUT_DIR_PRIVATE, 'private', collector, subtests);

  // Write the aggregated migration flags artifact, unconditionally, mirroring the
  // _manifest.json write style. A clean run writes empty arrays: that distinguishes a
  // zero-gap run from step 07 never having run, and guarantees the report and the
  // construct-tag/deactivation steps a present file after any step-07 run. exportsDir
  // is already resolved via getExportsDir() at the top of main(); never hardcode the
  // exports path.
  const flagsFile = buildMigrationFlagsFile(collector);
  const flagsPath = path.join(exportsDir, 'migration-flags.json');
  await writeFile(flagsPath, JSON.stringify(flagsFile, null, 2), 'utf-8');
  console.log(`\nWritten migration flags: ${flagsFile.flags.length} flag(s) -> ${flagsPath}`);

  // Write the shared helpers file whenever ANY generated spec (public or private)
  // references the firstMatch helper symbol (multi-candidate chains, including
  // iframe-classified element steps now folded into the same chain). This gate
  // replaces the former iframe-count-only condition, so a corpus with multi-candidate
  // steps but zero iframes still gets helpers.ts. Both passes flow through the same
  // generateSpecsForTests logic (no branch divergence).
  const totalIframeTests = publicResult.iframeTestCount + privateResult.iframeTestCount;
  const totalHelperImportTests = publicResult.helperImportTestCount + privateResult.helperImportTestCount;
  if (totalHelperImportTests > 0) {
    const helpersPath = path.join(OUTPUT_BASE, 'helpers.ts');
    await writeFile(helpersPath, SHARED_HELPERS_SOURCE, 'utf-8');
    console.log(`\nWritten shared helpers: ${helpersPath} (${totalHelperImportTests} spec(s) reference a helper)`);
  }

  console.log('\nWriting variable usage report...');
  await writeVariableUsageReport();

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Generation Summary');
  console.log('='.repeat(60));
  console.log(`  Public specs generated: ${publicResult.successCount} → ${OUTPUT_DIR_PUBLIC}`);
  console.log(`  Private specs generated: ${privateResult.successCount} → ${OUTPUT_DIR_PRIVATE}`);
  console.log(`  Errors: ${publicResult.errorCount + privateResult.errorCount}`);

  const totalIframeSteps = publicResult.iframeStepCount + privateResult.iframeStepCount;
  if (totalIframeTests > 0) {
    console.log(`  Iframe handling: ${totalIframeTests} tests, ${totalIframeSteps} steps`);
  }

  console.log('\nNext: Run "npm run generate:browser-checks" to create BrowserCheck constructs');
  console.log('Done!');
}

// ESM main-guard: only run if this file is the direct entry point
const __filename = fileURLToPath(import.meta.url);
if (typeof process.argv[1] === 'string' && path.resolve(__filename) === path.resolve(process.argv[1])) {
  main().catch(err => {
    console.error('Error:', (err as Error).message);
    process.exit(1);
  });
}
