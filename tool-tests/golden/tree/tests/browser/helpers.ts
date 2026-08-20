import { test, type Page, type Frame, type Locator } from "@playwright/test";

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
  const summary = `${LOCATOR_EXHAUSTION_TOKEN}: no locator matched after ${tried.length} candidate probe(s)`;
  await test.step(summary, async () => {
    console.error(`[${LOCATOR_EXHAUSTION_TOKEN}] tried candidates: ${tried.join(" | ")}`);
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
    const summary = `${LOCATOR_EXHAUSTION_TOKEN}: no candidate satisfied the assertion after ${tried.length} probe(s)`;
    await test.step(summary, async () => {
      console.error(`[${LOCATOR_EXHAUSTION_TOKEN}] assertion probed candidates: ${tried.join(" | ")}`);
    }, { box: true });
  }
  const finalCandidate = attempts[attempts.length - 1];
  await assertion(finalCandidate);
}
