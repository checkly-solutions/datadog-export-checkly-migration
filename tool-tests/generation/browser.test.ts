/**
 * Generation tests for the browser pipeline seam.
 *
 * Calls the exported generateSpecFile from step 07 (aliased to
 * generateBrowserSpec, since step 05 exports the same name) and
 * generateBrowserCheckCode from step 08 directly. Step 07's generateSpecFile
 * returns an object ({ spec, hasIframes, iframeStepCount }); tests destructure
 * it and assert on the spec property. No subprocess, no file writes;
 * structural assertions only, never snapshots.
 *
 * Fixture note: browser fixtures place steps at the test TOP level because
 * src/07 destructures test.steps (characterization from).
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  generateSpecFile as generateBrowserSpec,
  generateAssertElementContent,
  generateAssertCurrentUrl,
  generateElementVarName,
  generateIframeStepCode,
  generateRunApiTest,
  generateClick,
  generateStepCodeDefault,
  generateWait,
  generatePressKey,
  buildMigrationFlagsFile,
  detectLocatorResidue,
  type StepFlagContext,
} from '../../src/07-generate-browser-specs.ts';
import { generateBrowserCheckCode } from '../../src/08-generate-browser-constructs.ts';
import { FlagCollector } from '../../src/shared/migration-flags.ts';

type Step07 = Parameters<typeof generateAssertElementContent>[0];

/**
 * Fresh per-step flag context. Threaded through every emit-site generator,
 * mirroring the usedVarNames precedent. Spread overrides to vary publicId /
 * stepIndex per case (invented, synthetic values only).
 */
function mkCtx(overrides: Partial<StepFlagContext> = {}): StepFlagContext {
  return { collector: new FlagCollector(), publicId: 'syn-000-tst', stepIndex: 0, ...overrides };
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const browserFixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'unit', 'browser-test.json'), 'utf-8')
);

const browserRegexFixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'unit', 'browser-regex-test.json'), 'utf-8')
);

/**
 * generateBrowserCheckCode calls filterAndRemapTags, which reads
 * DD_TAGS_EXCLUDE, DD_TAGS_EXCLUDE_ALL, and DD_TAGS_REMAP at call time.
 * Snapshot and clear all three before the tests and restore them exactly
 * afterwards.
 */
const DD_TAG_VARS = ['DD_TAGS_EXCLUDE', 'DD_TAGS_EXCLUDE_ALL', 'DD_TAGS_REMAP'] as const;
let savedTagEnv: Record<string, string | undefined> = {};

before(() => {
  savedTagEnv = {};
  for (const name of DD_TAG_VARS) {
    savedTagEnv[name] = process.env[name];
    delete process.env[name];
  }
});

after(() => {
  for (const name of DD_TAG_VARS) {
    if (savedTagEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = savedTagEnv[name];
    }
  }
});

describe('step 07 generateSpecFile: browser spec baseline', () => {
  it('returns an object whose spec contains the Playwright test wrapper', () => {
    const { spec } = generateBrowserSpec(browserFixture, new FlagCollector());
    assert.ok(spec.includes('import { test, expect } from "@playwright/test"'), 'must import playwright test');
    assert.ok(spec.includes('test.describe("Unit Browser Flow"'), 'describe block must carry the test name');
    assert.ok(spec.includes('async ({ page })'), 'browser specs use the page fixture');
  });

  it('navigates to the example.com start URL via the goToUrl step', () => {
    const { spec } = generateBrowserSpec(browserFixture, new FlagCollector());
    assert.ok(spec.includes('// Step 1: Open login page'), 'step 1 comment must appear');
    assert.ok(spec.includes('await page.goto(`https://app.example.com/login`);'), 'goto must target the fixture URL');
  });

  it('emits the typed step as a locator fill', () => {
    const { spec } = generateBrowserSpec(browserFixture, new FlagCollector());
    assert.ok(spec.includes('// Step 2: Type username'), 'step 2 comment must appear');
    assert.ok(
      spec.includes('await page.locator("#username").fill(`user@example.com`);'),
      'typeText must become a locator fill derived from targetOuterHTML'
    );
  });

  it('emits the clicked step (multi-candidate firstMatch chain) and the page-contains assertion', () => {
    const { spec } = generateBrowserSpec(browserFixture, new FlagCollector());
    // the <button id="submit">Sign in</button> now resolves
    // to an ORDERED multi-candidate chain (role-scoped getByRole first, the demoted
    // id rung as fallback), emitted through the firstMatch spine so the click
    // regenerates Datadog's self-healing behavior. The role rung leads the chain
    // (strong), so no weak-fallback-chain flag fires.
    // Readability Option C: the multi-candidate factory is hoisted to a named
    // CandidateFactory const (one candidate per line with provenance comments) and
    // the action references it by name. The candidate EXPRESSIONS are unchanged.
    assert.ok(
      spec.includes('const step3ClickSignIn: CandidateFactory = (root) => [\n')
        && spec.includes('root.getByRole("button", { name: "Sign in" }), // role')
        && spec.includes('root.locator("#submit"), // id'),
      'the button click step must hoist the role-led factory const with per-line provenance comments'
    );
    assert.ok(
      spec.includes('await (await firstMatch(page, step3ClickSignIn)).click();'),
      'the click must reference the hoisted factory const by name'
    );
    assert.ok(
      spec.includes('await expect(page.locator("body")).toContainText("Welcome");'),
      'assertPageContains must become a body toContainText assertion'
    );
  });

  it('reports no iframes for a plain fixture', () => {
    const { hasIframes, iframeStepCount } = generateBrowserSpec(browserFixture, new FlagCollector());
    assert.strictEqual(hasIframes, false, 'plain fixture must not trigger iframe handling');
    assert.strictEqual(iframeStepCount, 0, 'no step should be flagged as iframe');
  });
});

describe('step 07 generateAssertElementContent: escaped regex emission', () => {
  const totalElement = { targetOuterHTML: '<span id="total">Total: $42.50 (net)</span>' };

  it('startsWith emits a web-first locator toHaveText with a caret-anchored escaped pattern', () => {
    const step: Step07 = {
      name: 'Assert total',
      type: 'assertElementContent',
      params: { check: 'startsWith', value: 'Total: $42.50 (net)', element: totalElement },
    };
    assert.equal(
      generateAssertElementContent(step, mkCtx()),
      '    await expect(page.locator("#total")).toHaveText(new RegExp("^Total: \\\\$42\\\\.50 \\\\(net\\\\)"));'
    );
  });

  it('contains and equals keep their pre-change string-form emissions byte-identical', () => {
    const containsStep: Step07 = {
      name: 'Assert total',
      type: 'assertElementContent',
      params: { check: 'contains', value: 'Total: $42.50 (net)', element: totalElement },
    };
    assert.equal(
      generateAssertElementContent(containsStep, mkCtx()),
      '    await expect(page.locator("#total")).toContainText("Total: $42.50 (net)");'
    );
    const equalsStep: Step07 = {
      name: 'Assert total',
      type: 'assertElementContent',
      params: { check: 'equals', value: 'Total: $42.50 (net)', element: totalElement },
    };
    assert.equal(
      generateAssertElementContent(equalsStep, mkCtx()),
      '    await expect(page.locator("#total")).toHaveText("Total: $42.50 (net)");'
    );
  });

  it('allowFailure true on a startsWith step emits expect.soft instead of expect', () => {
    const step: Step07 = {
      name: 'Assert total',
      type: 'assertElementContent',
      params: { check: 'startsWith', value: 'Total: $1', element: totalElement },
      allowFailure: true,
    };
    const line = generateAssertElementContent(step, mkCtx());
    assert.ok(line.startsWith('    await expect.soft(page.locator("#total"))'), 'soft assertion must use expect.soft');
    assert.ok(line.includes('toHaveText(new RegExp("^Total: \\\\$1"))'), 'soft path keeps the constructor emission');
  });
});

describe('step 07 generateAssertCurrentUrl: constructor-form URL patterns', () => {
  it('contains with a slash-bearing value emits an escaped constructor-form toHaveURL', () => {
    const step: Step07 = {
      name: 'Assert URL',
      type: 'assertCurrentUrl',
      params: { check: 'contains', value: 'app.example.com/checkout/step-1' },
    };
    assert.equal(
      generateAssertCurrentUrl(step),
      '    await expect(page).toHaveURL(new RegExp("app\\\\.example\\\\.com/checkout/step-1"));'
    );
  });

  it('startsWith is caret-prefixed, equals stays string form, unknown check matches contains', () => {
    const startsWithStep: Step07 = {
      name: 'Assert URL',
      type: 'assertCurrentUrl',
      params: { check: 'startsWith', value: 'app.example.com/checkout' },
    };
    assert.equal(
      generateAssertCurrentUrl(startsWithStep),
      '    await expect(page).toHaveURL(new RegExp("^app\\\\.example\\\\.com/checkout"));'
    );
    const equalsStep: Step07 = {
      name: 'Assert URL',
      type: 'assertCurrentUrl',
      params: { check: 'equals', value: 'app.example.com/checkout/step-1' },
    };
    assert.equal(
      generateAssertCurrentUrl(equalsStep),
      '    await expect(page).toHaveURL("app.example.com/checkout/step-1");'
    );
    const unknownStep: Step07 = {
      name: 'Assert URL',
      type: 'assertCurrentUrl',
      params: { check: 'someFutureCheck', value: 'app.example.com/checkout/step-1' },
    };
    assert.equal(
      generateAssertCurrentUrl(unknownStep),
      '    await expect(page).toHaveURL(new RegExp("app\\\\.example\\\\.com/checkout/step-1"));'
    );
  });
});

describe('step 07 generateAssertCurrentUrl: resolves {{ VAR }} to process.env on all four branches', () => {
  // A URL value carrying a Datadog variable reference. Without variable resolution
  // the four branches would emit the literal double-brace text (a URL that can never
  // match); the variable resolves to process.env at runtime, and the three
  // RegExp branches runtime-escape the resolved value so a hostile runtime value
  // cannot act as regex metacharacters (shared INLINE_REGEX_ESCAPE idiom).
  const VARIABLE_URL = 'https://example.com/{{ URL_VAR }}/dash';

  it('contains resolves the variable to a runtime-escaped RegExp with no literal double-brace', () => {
    const step: Step07 = {
      name: 'Assert URL',
      type: 'assertCurrentUrl',
      params: { check: 'contains', value: VARIABLE_URL },
    };
    const out = generateAssertCurrentUrl(step);
    assert.ok(out.includes('toHaveURL(new RegExp('), 'contains-with-variable must emit a constructor-form RegExp');
    assert.ok(out.includes('.replace('), 'the resolved runtime value must be regex-escaped at runtime');
    assert.ok(out.includes('process.env.URL_VAR'), 'the variable must resolve to process.env.URL_VAR');
    assert.ok(!out.includes('{{'), 'no literal double-brace variable text may remain');
  });

  it('equals resolves the variable as a backtick template string argument to toHaveURL', () => {
    const step: Step07 = {
      name: 'Assert URL',
      type: 'assertCurrentUrl',
      params: { check: 'equals', value: VARIABLE_URL },
    };
    const out = generateAssertCurrentUrl(step);
    assert.ok(
      out.includes('toHaveURL(`https://example.com/${process.env.URL_VAR}/dash`)'),
      'equals-with-variable must pass a backtick template with process.env to toHaveURL'
    );
    assert.ok(!out.includes('{{'), 'no literal double-brace variable text may remain');
  });

  it('startsWith resolves the variable to a caret-anchored runtime-escaped RegExp', () => {
    const step: Step07 = {
      name: 'Assert URL',
      type: 'assertCurrentUrl',
      params: { check: 'startsWith', value: VARIABLE_URL },
    };
    const out = generateAssertCurrentUrl(step);
    assert.ok(out.includes("toHaveURL(new RegExp('^' + `"), 'startsWith-with-variable must anchor with a leading caret outside the escaped runtime value');
    assert.ok(out.includes('process.env.URL_VAR'), 'the variable must resolve to process.env.URL_VAR');
    assert.ok(out.includes('.replace('), 'the resolved runtime value must be regex-escaped at runtime');
    assert.ok(!out.includes('{{'), 'no literal double-brace variable text may remain');
  });

  it('default (unknown check) falls back to the contains-shape runtime-escaped RegExp with the variable resolved', () => {
    const step: Step07 = {
      name: 'Assert URL',
      type: 'assertCurrentUrl',
      params: { check: 'someFutureCheck', value: VARIABLE_URL },
    };
    const out = generateAssertCurrentUrl(step);
    assert.ok(out.includes('toHaveURL(new RegExp('), 'default-with-variable must emit the contains-shape constructor RegExp');
    assert.ok(out.includes('process.env.URL_VAR'), 'the variable must resolve to process.env.URL_VAR');
    assert.ok(out.includes('.replace('), 'the resolved runtime value must be regex-escaped at runtime');
    assert.ok(!out.includes('{{'), 'no literal double-brace variable text may remain');
  });
});

describe('step 07 assertPageLacks: negative page-content dispatch', () => {
  // Without the dedicated dispatch case an assertPageLacks step falls through the
  // default and records an unsupported-step-type flag (silently dropped, no
  // assertion). With the dispatch case it emits a live negative body-content
  // assertion (.not.toContainText) and records zero flags. assertPageLacks carries
  // params.value only (a text), so
  // it is the negative of page-content, NOT of element presence.

  it('dispatches to a live not.toContainText body assertion and records zero flags', () => {
    const step: Step07 = {
      name: 'Assert gone',
      type: 'assertPageLacks',
      params: { value: 'Session expired' },
    } as Step07;
    const ctx = mkCtx();
    const out = generateStepCodeDefault(step, ctx);
    assert.ok(
      out.includes('await expect(page.locator("body")).not.toContainText("Session expired");'),
      'assertPageLacks must emit a live negative body-content assertion'
    );
    assert.equal(ctx.collector.flags.length, 0, 'no flag may be recorded for a now-supported step');
    assert.ok(!out.includes('MIGRATION-FLAG'), 'no unsupported-step-type marker may appear');
  });

  it('allowFailure true emits the same shape under expect.soft', () => {
    const step: Step07 = {
      name: 'Assert gone soft',
      type: 'assertPageLacks',
      allowFailure: true,
      params: { value: 'Error banner' },
    } as Step07;
    const ctx = mkCtx();
    const out = generateStepCodeDefault(step, ctx);
    assert.ok(
      out.includes('await expect.soft(page.locator("body")).not.toContainText("Error banner");'),
      'a soft assertPageLacks must use expect.soft in the same negative shape'
    );
    assert.equal(ctx.collector.flags.length, 0, 'no flag may be recorded for a soft supported step');
  });

  it('a {{ VAR }} value resolves to a process.env backtick template (same idiom as content assertions)', () => {
    const step: Step07 = {
      name: 'Assert token gone',
      type: 'assertPageLacks',
      params: { value: 'token {{ SESSION_TOKEN }}' },
    } as Step07;
    const ctx = mkCtx();
    const out = generateStepCodeDefault(step, ctx);
    assert.ok(
      out.includes('not.toContainText(`token ${process.env.SESSION_TOKEN}`)'),
      'a variable value must emit a convertVariables backtick template'
    );
    assert.ok(!out.includes('{{'), 'no literal double-brace variable text may remain');
    assert.equal(ctx.collector.flags.length, 0, 'a variable-bearing supported step records no flag');
  });
});

describe('step 07 generateIframeStepCode: startsWith case in sync with default path', () => {
  it('assertElementContent startsWith emits the identical constructor-form toHaveText as the default path (folded)', () => {
    const step: Step07 = {
      name: 'Assert total starts',
      type: 'assertElementContent',
      params: {
        check: 'startsWith',
        value: 'Total: $1',
        element: { targetOuterHTML: '<span id="total">Total: $1</span>' },
      },
    };
    // Plan 08-04: the iframe path is folded into the single firstMatch chain, so it
    // now delegates to generateStepCodeDefault and emits the direct page.locator
    // assertion (single-candidate id), not a findInFrame element const.
    const code = generateIframeStepCode(step, mkCtx());
    assert.ok(
      code.includes('await expect(page.locator("#total")).toHaveText(new RegExp("^Total: \\\\$1"));'),
      'iframe startsWith must use the identical constructor emission as the default path'
    );
    assert.ok(!code.includes('findInFrame'), 'the folded iframe path must not reference the retired findInFrame helper');
  });
});

/**
 * element variable names must be valid TS identifiers.
 *
 * A Datadog step named "3DotsToEdit menu" becomes the camelCase base
 * "3dotstoeditMenu"; before the fix it would have emitted a `const 3dotstoeditMenu
 * = ...` declaration (a bundle-time SyntaxError). generateElementVarName routes its
 * return through the canonical sanitizeIdentifier (fixed in), so the
 * digit-leading base is guarded to "_3dotstoeditMenu". These first cases pin that
 * guard directly.
 *
 * Note: generateIframeStepCode no longer emits an element const at all
 * (the iframe path is folded into the single firstMatch chain), so the const-shape
 * assertions below now confirm the folded emission delegates to the default path
 * and declares NO const, while generateElementVarName keeps its own guard coverage.
 */
describe('step 07 generateElementVarName / generateIframeStepCode: digit-leading identifier guard', () => {
  it('guards a digit-leading step name with a leading underscore', () => {
    const step: Step07 = { name: '3DotsToEdit menu', type: 'click' };
    assert.equal(
      generateElementVarName(step),
      '_3dotstoeditMenu',
      'a digit-leading camelCase base must be underscore-guarded into a valid identifier'
    );
  });

  it('leaves a readable letter-leading camelCase name unchanged', () => {
    const step: Step07 = { name: 'Click on div Recent Reports', type: 'click' };
    assert.equal(
      generateElementVarName(step),
      'divRecentReports',
      'a valid letter-leading camelCase name must pass through the guard untouched'
    );
  });

  it('generateIframeStepCode (folded) emits the direct default statement and declares no element const', () => {
    const step: Step07 = {
      name: '3DotsToEdit menu',
      type: 'click',
      // An id-only <div> resolves to a single candidate (no derivable role/text), so
      // the folded path emits the direct page.locator click rather than a chain.
      params: { element: { targetOuterHTML: '<div id="edit-menu"></div>' } },
    };
    const code = generateIframeStepCode(step, mkCtx());
    // Folded: single-candidate id emits the direct page.locator click, no const.
    assert.ok(code.includes('await page.locator("#edit-menu").click();'), 'the folded iframe click must emit the direct default statement');
    assert.doesNotMatch(code, /const\s+/, 'the folded iframe path must declare no element const (no findInFrame assignment)');
    assert.ok(!code.includes('findInFrame'), 'the folded iframe path must not reference findInFrame');
  });

  it('repeated folded iframe emissions are stable and declare no digit-leading const', () => {
    const step: Step07 = {
      name: '3DotsToEdit menu',
      type: 'click',
      params: { element: { targetOuterHTML: '<div id="edit-menu"></div>' } },
    };
    const first = generateIframeStepCode(step, mkCtx());
    const second = generateIframeStepCode(step, mkCtx());
    // The folded path is stateless per call (no var-name counter), so repeated
    // emissions for the same step are byte-identical.
    assert.equal(first, second, 'repeated folded iframe emissions for the same step must be identical');
    assert.doesNotMatch(second, /const\s+\d/, 'no emission may declare a digit-leading identifier const');
  });
});

describe('step 07 generateRunApiTest: unified regex extraction convention', () => {
  function runApiStep(extractValues: Array<{ name: string; parser: { type: string; value: string } }>): Step07 {
    return {
      name: 'Fetch OTP',
      type: 'runApiTest',
      params: {
        request: {
          config: { request: { method: 'GET', url: 'https://api.example.com/v1/otp' } },
          options: { extract_values: extractValues },
        },
      },
    } as Step07;
  }

  it('slash-wrapped g-flagged parser emits a flagless constructor with the unified arrow convention', () => {
    const code = generateRunApiTest(
      runApiStep([{ name: 'OTP_CODE', parser: { type: 'regex', value: '/\\b\\d{6}\\b/g' } }])
    );
    assert.ok(
      code.includes('new RegExp("\\\\b\\\\d{6}\\\\b"))'),
      'g flag must be stripped and no flags argument emitted'
    );
    assert.ok(
      code.includes("(m => m?.[1] ?? m?.[0] ?? '')"),
      'extraction must use the unified arrow-function convention'
    );
  });

  it('bare capture-group parser emits the same unified convention', () => {
    const code = generateRunApiTest(
      runApiStep([{ name: 'REF_CODE', parser: { type: 'regex', value: 'ref=(\\d{4})' } }])
    );
    assert.ok(code.includes('new RegExp("ref=(\\\\d{4})")'), 'bare pattern must embed verbatim');
    assert.ok(
      code.includes("(m => m?.[1] ?? m?.[0] ?? '')"),
      'bare shape must share the same unified convention'
    );
  });

  it('combined g and i flags strip g and preserve i via JSON.stringify', () => {
    const code = generateRunApiTest(
      runApiStep([{ name: 'OTP_CODE', parser: { type: 'regex', value: '/\\b\\d{6}\\b/gi' } }])
    );
    assert.ok(
      code.includes('new RegExp("\\\\b\\\\d{6}\\\\b", "i")'),
      'i flag must survive as a JSON.stringify second argument'
    );
  });

  it('extraction lines reference the possibly-suffixed response text variable', () => {
    const code = generateRunApiTest(
      runApiStep([{ name: 'OTP_CODE', parser: { type: 'regex', value: '/\\b\\d{6}\\b/g' } }])
    );
    assert.match(
      code,
      /const OTP_CODE = \(m => m\?\.\[1\] \?\? m\?\.\[0\] \?\? ''\)\(apiResponse\d*Text\.match\(/,
      'extraction must apply the arrow convention over the response text match'
    );
  });
});

describe('step 07 generateSpecFile: regex escaping end to end', () => {
  it('emits the escaped caret-anchored toHaveText and never the nullable text-content call', () => {
    const { spec } = generateBrowserSpec(browserRegexFixture, new FlagCollector());
    assert.ok(
      spec.includes('toHaveText(new RegExp("^Total: \\\\$42\\\\.50 \\\\(net\\\\)"))'),
      'metacharacter literal must be escaped and caret-anchored'
    );
    assert.ok(
      !spec.includes('.textContent()'),
      'the nullable text-content call form must be gone'
    );
  });

  it('emits the constructor-form toHaveURL with slashes intact and no slash-delimited literal', () => {
    const { spec } = generateBrowserSpec(browserRegexFixture, new FlagCollector());
    assert.ok(
      spec.includes('toHaveURL(new RegExp("app\\\\.example\\\\.com/checkout/step-1"))'),
      'URL assertion must be constructor form with escaped dots'
    );
    assert.ok(
      !spec.includes('toHaveURL(/'),
      'no slash-delimited regex literal may follow toHaveURL'
    );
  });

  it('emits the unified extraction convention once per parser with g stripped', () => {
    const { spec } = generateBrowserSpec(browserRegexFixture, new FlagCollector());
    const conventionCount = spec.split("(m => m?.[1] ?? m?.[0] ?? '')").length - 1;
    assert.equal(conventionCount, 2, 'both parsers must share the unified convention');
    assert.ok(
      spec.includes('new RegExp("\\\\b\\\\d{6}\\\\b"))'),
      'slash-wrapped g-flagged parser must emit flagless constructor form'
    );
    assert.ok(
      spec.includes('new RegExp("ref=(\\\\d{4})")'),
      'bare capture-group parser must embed verbatim'
    );
  });
});

describe('step 08 generateBrowserCheckCode: construct baseline', () => {
  const specFilename = 'unit-browser-flow.spec.ts';

  it('emits a BrowserCheck constructor call with the public_id-tailed logical id', () => {
    const output = generateBrowserCheckCode(browserFixture, specFilename, 'public', false);
    assert.ok(
      output.includes('new BrowserCheck("browser-unit-browser-flow-syn-106-pqr", {'),
      'logical id must be uniqueLogicalId(browser, name, public_id): fixture name slug plus its public_id'
    );
  });

  it('references the spec filename in the code entrypoint', () => {
    const output = generateBrowserCheckCode(browserFixture, specFilename, 'public', false);
    assert.ok(
      output.includes('entrypoint: "../../../tests/browser/public/unit-browser-flow.spec.ts"'),
      'entrypoint must point at the spec file under the locationType directory'
    );
  });

  it('appends the migration_check_id traceability tag and preserves live activation', () => {
    const output = generateBrowserCheckCode(browserFixture, specFilename, 'public', false);
    assert.ok(output.includes('migration_check_id:syn-106-pqr'), 'traceability tag must carry the public_id');
    assert.ok(output.includes('activated: true,'), 'live status must map to activated: true');
  });

  it('does not add the iframe tag when hasIframes is false', () => {
    const output = generateBrowserCheckCode(browserFixture, specFilename, 'public', false);
    assert.ok(!output.includes('"iframe"'), 'iframe tag must be absent for non-iframe specs');
  });
});

/**
 * the browser construct
 * emit site is the literal anchor of all three deploy blockers.
 *
 * two same-named browser tests currently share the logical id
 * "browser-<name-slug>" and abort `npx checkly test` with the duplicate-resource
 * diagnostic. The fix tails the public_id (uniqueLogicalId), so distinct
 * public_ids yield distinct logical ids.
 *
 * the name line uses a quotes-only inline escape today, so a backslash
 * or newline in the Datadog test name escapes out of the emitted string literal.
 * The fix routes the name through the canonical escapeString.
 *
 * the locations array is emitted via raw JSON.stringify(locations),
 * the one emit site that never called the deduping normalizer. The fix routes it
 * through normalizePublicChecklyLocations; privateLocations must stay untouched.
 *
 * All variants are built by spread-cloning the loaded fixture with synthetic-only
 * overrides (syn- ids, names 25 chars or fewer). The fixture JSON is never edited.
 */
describe('step 08 generateBrowserCheckCode: deploy-blocking emit hardening', () => {
  const specFilename = 'unit-browser-flow.spec.ts';

  it('two same-named tests with distinct public_ids emit distinct logical ids', () => {
    const first = { ...browserFixture, public_id: 'syn-106-pqr' };
    const second = { ...browserFixture, public_id: 'syn-206-tuv' };
    const firstOut = generateBrowserCheckCode(first, specFilename, 'public', false);
    const secondOut = generateBrowserCheckCode(second, specFilename, 'public', false);

    const idOf = (out: string) => out.match(/new BrowserCheck\("([^"]+)"/)?.[1];
    const firstId = idOf(firstOut);
    const secondId = idOf(secondOut);
    assert.ok(firstId && secondId, 'both emissions must declare a BrowserCheck logical id');
    assert.notEqual(firstId, secondId, 'same-named tests must not collide on logical id');
    assert.equal(firstId, 'browser-unit-browser-flow-syn-106-pqr');
    assert.equal(secondId, 'browser-unit-browser-flow-syn-206-tuv');
  });

  it('a name with a backslash and a newline emits a fully escaped literal', () => {
    // JSON-encoded synthetic name (25 chars or fewer): "a\b\nc"
    const clone = { ...browserFixture, name: 'a\\b\nc' };
    const output = generateBrowserCheckCode(clone, specFilename, 'public', false);

    const nameLine = output.split('\n').find(l => l.trimStart().startsWith('name:'));
    assert.ok(nameLine, 'the emitted construct must have a name line');
    assert.ok(nameLine!.includes('\\\\'), 'the literal backslash must emit as an escaped backslash sequence');
    assert.ok(nameLine!.includes('\\n'), 'the literal newline must emit as an escaped \\n sequence');
    assert.ok(!nameLine!.includes('\n', 'name:'.length), 'no raw newline may sit inside the name string literal');
  });

  it('deduplicates the public locations array through the shared normalizer', () => {
    const clone = {
      ...browserFixture,
      locations: ['aws:us-east-1', 'us-east-1'],
      privateLocations: [],
    };
    const output = generateBrowserCheckCode(clone, specFilename, 'public', false);

    const locLine = output.split('\n').find(l => l.trimStart().startsWith('locations:'));
    assert.ok(locLine, 'the emitted construct must have a locations line');
    const occurrences = locLine!.split('"us-east-1"').length - 1;
    assert.equal(occurrences, 1, 'aws:us-east-1 and us-east-1 must collapse to a single us-east-1');
    assert.ok(!locLine!.includes('aws:'), 'the aws: prefix must be stripped by the normalizer');
  });

  it('leaves the privateLocations array byte-for-byte unchanged (public/private sync guard)', () => {
    const privateSlugs = ['syn-private-loc-one', 'syn-private-loc-two'];
    const clone = {
      ...browserFixture,
      locations: [],
      privateLocations: privateSlugs,
    };
    const output = generateBrowserCheckCode(clone, specFilename, 'public', false);

    const privLine = output.split('\n').find(l => l.trimStart().startsWith('privateLocations:'));
    assert.ok(privLine, 'a non-empty privateLocations array must emit a privateLocations line');
    assert.ok(
      privLine!.includes(JSON.stringify(privateSlugs)),
      'private slugs must pass through untouched; the public normalizer must never rewrite them'
    );
  });
});

describe('browser certificate-ignore fidelity', () => {
  it('synthetic true: emits file-scope test.use ignoreHTTPSErrors before test.describe', () => {
    const fixture = structuredClone(browserFixture);
    fixture.options.ignoreServerCertificateError = true;
    const { spec } = generateBrowserSpec(fixture, new FlagCollector());

    assert.ok(
      spec.includes('test.use({ ignoreHTTPSErrors: true });'),
      'an explicit ignoreServerCertificateError true must emit the file-scope test.use line'
    );

    const useIndex = spec.indexOf('test.use({ ignoreHTTPSErrors: true });');
    const describeIndex = spec.indexOf('test.describe(');
    assert.ok(describeIndex !== -1, 'the spec must contain a test.describe block');
    assert.ok(
      useIndex < describeIndex,
      'test.use must sit at file scope, before test.describe, never inside its body'
    );
  });

  it('absent baseline: the unmutated fixture emits no test.use and no ignoreHTTPSErrors text', () => {
    const { spec } = generateBrowserSpec(browserFixture, new FlagCollector());
    assert.ok(!spec.includes('ignoreHTTPSErrors'), 'absent option must not emit ignoreHTTPSErrors');
    assert.ok(!spec.includes('test.use('), 'absent option must not emit any test.use line');
  });

  it('false: an explicit ignoreServerCertificateError false emits no ignoreHTTPSErrors text', () => {
    const fixture = structuredClone(browserFixture);
    fixture.options.ignoreServerCertificateError = false;
    const { spec } = generateBrowserSpec(fixture, new FlagCollector());
    assert.ok(!spec.includes('ignoreHTTPSErrors'), 'false must not emit ignoreHTTPSErrors');
    assert.ok(!spec.includes('test.use('), 'false must not emit any test.use line');
  });
});

/**
 * spec side: a zero-signal locator step must emit a
 * loud inline MIGRATION-FLAG marker with the preserved DD step and a commented-out
 * action, record a deactivating flag, and never emit a runnable statement or a
 * Playwright test.skip. The unsupported-step-type dispatch default must emit a
 * structured, non-deactivating flag. All inputs are inline synthetic steps
 * (invented values, names 25 chars or fewer, syn- ids).
 */
describe('step 07 locator-unresolvable: zero-candidate spec-side emit', () => {
  it('Test 1 (unit): generateClick on a zero-signal step emits the marker, preserved DD step, commented-out action, and records one deactivating flag', () => {
    const step: Step07 = {
      name: 'Click ghost',
      type: 'click',
      params: { element: { targetOuterHTML: '<div>plain</div>' } },
    };
    const ctx = mkCtx({ publicId: 'syn-401-aaa', stepIndex: 3 });
    const out = generateClick(step, ctx);

    assert.ok(out.includes('// MIGRATION-FLAG: locator-unresolvable'), 'the loud marker must be present');
    // Preserved DD step, using the label the shipped formatInlineMarker emits. The
    // step name's quotes route through escapeString, so they surface as \".
    assert.ok(out.includes('// DD original: click \\"Click ghost\\"'), 'the preserved DD step must appear on an adjacent comment line');
    // The intended action is commented out (four-space body depth, two slashes), never runnable.
    assert.ok(out.includes('    // ') && out.includes('.click()'), 'the intended click statement must be commented out');
    // Nothing runnable: no line is a 4-space `await` statement (re-pointed from the
    // pre-fix 2-space prefix so the assertion keeps teeth under the corrected indent).
    assert.ok(
      !out.split('\n').some(l => l.startsWith('    await')),
      'the null-locator path must not emit a runnable await statement'
    );
    // Exactly one flag, deactivating, correct attribution.
    assert.equal(ctx.collector.flags.length, 1, 'exactly one flag must be recorded');
    const flag = ctx.collector.flags[0];
    assert.equal(flag.reason, 'locator-unresolvable');
    assert.equal(flag.deactivates, true, 'the zero-candidate flag must deactivate');
    assert.equal(flag.publicId, 'syn-401-aaa', 'the flag must carry the ctx publicId');
    assert.equal(flag.stepIndex, 3, 'the flag must carry the ctx stepIndex');
  });

  it('Test 2 (end to end): a zero-signal step in a full spec emits the marker, no MANUAL placeholder, no test.skip, deactivates the check, and leaves baseline steps live', () => {
    const clone = structuredClone(browserFixture);
    clone.public_id = 'syn-402-bbb';
    clone.steps.push({
      name: 'Click ghost',
      type: 'click',
      params: { element: { targetOuterHTML: '<div>plain</div>' } },
    });
    const collector = new FlagCollector();
    const { spec } = generateBrowserSpec(clone, collector);

    assert.ok(spec.includes('// MIGRATION-FLAG: locator-unresolvable'), 'spec must carry the loud marker');
    assert.ok(!spec.includes('page.locator("/* MANUAL'), 'the executable manual-locator placeholder must be gone');
    assert.ok(!spec.includes('test.skip'), 'a flagged spec must never emit test.skip');
    assert.deepEqual(collector.deactivatedCheckIds(), ['syn-402-bbb'], 'the flagged check must be in the deactivated set');
    // Baseline steps still emit their live statements (the button click is now a
    // role-led firstMatch chain under, with the factory
    // hoisted into a named CandidateFactory const, readability).
    assert.ok(
      spec.includes('const step3ClickSignIn: CandidateFactory = (root) => [\n')
        && spec.includes('await (await firstMatch(page, step3ClickSignIn)).click();'),
      'untouched baseline steps must stay live'
    );
  });

  it('Test 3 (no false positives): the unmodified fixture records zero flags', () => {
    const collector = new FlagCollector();
    generateBrowserSpec(browserFixture, collector);
    assert.equal(collector.flags.length, 0, 'a clean fixture must record no flags');
  });

  it('Test 4 (unsupported-step-type): generateStepCodeDefault on an unknown type emits a structured non-deactivating flag, not the legacy TODO', () => {
    const step: Step07 = { name: 'Mystery action', type: 'mysteryStep' };
    const ctx = mkCtx({ publicId: 'syn-404-ddd', stepIndex: 1 });
    const out = generateStepCodeDefault(step, ctx);

    assert.ok(out.includes('// MIGRATION-FLAG: unsupported-step-type'), 'the structured marker must be present');
    assert.ok(!out.includes('TODO: Unsupported step type'), 'the legacy free-text TODO must be gone');
    assert.equal(ctx.collector.flags.length, 1, 'exactly one flag must be recorded');
    const flag = ctx.collector.flags[0];
    assert.equal(flag.reason, 'unsupported-step-type');
    assert.ok(!flag.deactivates, 'the unsupported-step-type flag must not deactivate');
  });

  it('Test 5 (per-run aggregation): one collector across two specs accumulates two flags with distinct publicIds', () => {
    const collector = new FlagCollector();

    const first = structuredClone(browserFixture);
    first.public_id = 'syn-501-eee';
    first.steps.push({ name: 'Click ghost', type: 'click', params: { element: { targetOuterHTML: '<div>a</div>' } } });

    const second = structuredClone(browserFixture);
    second.public_id = 'syn-502-fff';
    second.steps.push({ name: 'Click ghost', type: 'click', params: { element: { targetOuterHTML: '<div>b</div>' } } });

    generateBrowserSpec(first, collector);
    generateBrowserSpec(second, collector);

    assert.equal(collector.flags.length, 2, 'two zero-signal steps across two specs must record two flags');
    const ids = collector.flags.map(f => f.publicId).sort();
    assert.deepEqual(ids, ['syn-501-eee', 'syn-502-fff'], 'each flag must attribute to its own check');
  });
});

/**
 * buildMigrationFlagsFile assembles the deterministic MigrationFlagsFile that main()
 * serializes. No wall-clock, arrays present even when empty, both id sets recoverable
 * for step 08.
 */
describe('step 07 buildMigrationFlagsFile: deterministic aggregate shape', () => {
  it('Test 6 (builder shape): assembles both records, the deactivated set, the deduped flagged set, and carries no timestamp', () => {
    const collector = new FlagCollector();
    collector.emitFlag(
      { reason: 'locator-unresolvable', publicId: 'syn-111-aaa', stepIndex: 0, message: 'no locator', deactivates: true },
      'click "one"'
    );
    collector.emitFlag(
      { reason: 'unsupported-step-type', publicId: 'syn-222-bbb', stepIndex: 1, message: 'mystery type' },
      'mysteryStep "two"'
    );

    const file = buildMigrationFlagsFile(collector);
    assert.ok(Array.isArray(file.flags) && file.flags.length === 2, 'both records must be present');
    assert.equal(file.flags[0].reason, 'locator-unresolvable');
    assert.equal(file.flags[0].publicId, 'syn-111-aaa');
    assert.equal(file.flags[0].stepIndex, 0);
    assert.equal(file.flags[0].message, 'no locator');
    assert.equal(file.flags[1].reason, 'unsupported-step-type');
    assert.deepEqual(file.deactivatedCheckIds, ['syn-111-aaa'], 'only the deactivating flag joins the deactivated set');
    assert.deepEqual(file.flaggedCheckIds.sort(), ['syn-111-aaa', 'syn-222-bbb'], 'both ids in the flagged set, deduped');
    // No ISO-8601 timestamp anywhere in the serialized artifact.
    assert.doesNotMatch(
      JSON.stringify(file),
      /\d{4}-\d{2}-\d{2}T/,
      'the artifact must be wall-clock free (no ISO-8601 timestamp)'
    );
  });

  it('Test 7 (clean-run shape): a fresh collector yields the empty-file shape with every array empty', () => {
    const file = buildMigrationFlagsFile(new FlagCollector());
    assert.deepEqual(file.flags, [], 'flags must be empty on a zero-gap run');
    assert.deepEqual(file.flaggedCheckIds, [], 'flaggedCheckIds must be empty on a zero-gap run');
    assert.deepEqual(file.deactivatedCheckIds, [], 'deactivatedCheckIds must be empty on a zero-gap run');
  });
});

/**
 * detectLocatorResidue: the pure predicate over the RESOLVED locator value
 * classifies recording residue into a distinct reason code, first hit wins, at most
 * one residue flag per step. Every residue value below is authored synthetic from
 * scratch: invented class hashes,
 * invented xpath shapes, example.com hosts, syn- ids. [object Object] itself is a
 * universal JavaScript artifact, never customer data. The Locator interface is not
 * exported, so the predicate's param type is derived via Parameters<...>.
 */
type ResidueLocator = Parameters<typeof detectLocatorResidue>[0];

describe('step 07 detectLocatorResidue: residue predicate', () => {
  it('rule 1: an xpath value embedding [object Object] returns unconvertible-locator', () => {
    const loc: ResidueLocator = {
      type: 'xpath',
      value: '/descendant::*[@input="[object Object]"]/descendant::*[2]',
    };
    const hit = detectLocatorResidue(loc);
    assert.equal(hit?.reason, 'unconvertible-locator', 'the serialized-object xpath-literal form must flag');
  });

  it('rule 1: a text value ending with [object Object] returns unconvertible-locator (garbage-text form)', () => {
    const loc: ResidueLocator = { type: 'text', value: 'items 1/2[object Object]' };
    const hit = detectLocatorResidue(loc);
    assert.equal(hit?.reason, 'unconvertible-locator', 'the garbage-text serialized-object form must flag');
  });

  it('rule 2: an xpath anchored on SVG geometry (cx/cy) returns unconvertible-locator', () => {
    const loc: ResidueLocator = {
      type: 'xpath',
      value: '/descendant::*[@cx="12.5"]/descendant::*[@cy="8.0"]',
    };
    const hit = detectLocatorResidue(loc);
    assert.equal(hit?.reason, 'unconvertible-locator', 'the SVG-geometry xpath must flag');
  });

  it('rule 2: an xpath anchored on an SVG path d attribute returns unconvertible-locator', () => {
    const loc: ResidueLocator = { type: 'xpath', value: '/descendant::*[@d="M1 2L3 4"]' };
    const hit = detectLocatorResidue(loc);
    assert.equal(hit?.reason, 'unconvertible-locator', 'the SVG path-data xpath must flag');
  });

  it('rule 3: a class value led by a hashed CSS-in-JS token returns unconvertible-locator (.sc-, .css-, .awsui_)', () => {
    for (const value of ['.sc-abQrsT.zXcvBn', '.css-1a2b3c.helper', '.awsui_button_xy12z.active']) {
      const hit = detectLocatorResidue({ type: 'class', value });
      assert.equal(hit?.reason, 'unconvertible-locator', `hashed-class ${value} must flag`);
    }
  });

  it('rule 4: an attribute-free positional xpath (local-name/index only) returns xpath-positional', () => {
    const loc: ResidueLocator = {
      type: 'xpath',
      value: '/*[local-name()="div"][2]/*[local-name()="span"][1]',
    };
    const hit = detectLocatorResidue(loc);
    assert.equal(hit?.reason, 'xpath-positional', 'a purely structural xpath must flag positional');
  });

  it('precedence: an attribute-free structural xpath that ALSO contains [object Object] flags unconvertible-locator (rule 1 wins)', () => {
    const loc: ResidueLocator = {
      type: 'xpath',
      value: '/*[local-name()="div"][2]/*[local-name()="span" and .="[object Object]"]',
    };
    const hit = detectLocatorResidue(loc);
    assert.equal(hit?.reason, 'unconvertible-locator', 'rule 1 (serialized-object) must win over rule 4 (positional)');
  });

  it('negatives: attribute-anchored xpath, id, plain text, semantic-led class, and text()-predicated xpath all return null', () => {
    // The majority export shape: a descendant selection anchored on a real attribute.
    assert.equal(
      detectLocatorResidue({ type: 'xpath', value: '/descendant::*[@name="q"][1]' }),
      null,
      'an attribute-anchored descendant xpath must NOT flag (noise guard)'
    );
    assert.equal(detectLocatorResidue({ type: 'id', value: '#username' }), null, 'an id locator must not flag');
    assert.equal(detectLocatorResidue({ type: 'text', value: 'Welcome' }), null, 'a plain text locator must not flag');
    assert.equal(
      detectLocatorResidue({ type: 'class', value: '.ant-btn.sc-abQrsT' }),
      null,
      'a class chain led by a semantic token must not flag (real leading signal)'
    );
    assert.equal(
      detectLocatorResidue({ type: 'xpath', value: '/descendant::*[text()="Submit"]' }),
      null,
      'an xpath with a text() predicate must not flag positional'
    );
  });
});

/**
 * seam integration: the single detection wiring point at the
 * generateStepCode seam covers BOTH the default and the iframe emission paths. A
 * residue-locator step records exactly one flag through the canonical collector
 * while its faithful locator statement still emits LIVE and unchanged (detection
 * only: residue stays active plus flagged, never commented out, never deactivated).
 * Inputs are inline synthetic BrowserTest objects.
 */
describe('step 07 residue seam wiring: residue detection through generateSpecFile', () => {
  it('a click step whose resolved locator embeds [object Object] records one unconvertible-locator flag and still emits the live statement', () => {
    const test = {
      public_id: 'syn-505-aaa',
      name: 'Residue click flow',
      locations: ['us-east-1'],
      privateLocations: [],
      originalLocations: ['aws:us-east-1'],
      config: { request: { url: 'https://app.example.com/home' } },
      steps: [
        {
          name: 'Assert seen',
          type: 'assertPageContains',
          params: { value: 'Home' },
        },
        {
          name: 'Click ghost',
          type: 'click',
          params: {
            element: {
              // Only an `at` (absolute xpath) candidate, embedding the artifact.
              multiLocator: { at: '/descendant::*[@aria-label="[object Object]"]/descendant::*[1]' },
            },
          },
        },
      ],
    };
    const collector = new FlagCollector();
    const { spec } = generateBrowserSpec(test as unknown as Parameters<typeof generateBrowserSpec>[0], collector);

    const residueFlags = collector.flags.filter(f => f.reason === 'unconvertible-locator');
    assert.equal(residueFlags.length, 1, 'exactly one unconvertible-locator flag must be recorded');
    assert.equal(residueFlags[0].publicId, 'syn-505-aaa', 'the flag must carry the test public_id');
    assert.equal(residueFlags[0].stepIndex, 1, 'the flag must carry the 0-based step index of the residue step');
    assert.ok(!residueFlags[0].deactivates, 'residue must NOT deactivate');
    assert.ok(spec.includes('// MIGRATION-FLAG: unconvertible-locator'), 'the loud inline marker must appear in the spec');
    assert.ok(spec.includes('// DD original: click \\"Click ghost\\"'), 'the preserved DD step must appear adjacent');
    // Detection only: the faithful locator statement still emits LIVE and unchanged.
    assert.ok(
      spec.includes('await page.locator("xpath=/descendant::*[@aria-label=\\"[object Object]\\"]/descendant::*[1]").click();'),
      'the live, unchanged locator statement must still emit (detection only, nothing commented out)'
    );
  });

  it('an assertElementPresent step routed down the IFRAME path with a residue locator records the flag too (no blind spot)', () => {
    const test = {
      public_id: 'syn-506-bbb',
      name: 'Iframe residue flow',
      locations: ['us-east-1'],
      privateLocations: [],
      originalLocations: ['aws:us-east-1'],
      config: { request: { url: 'https://app.example.com/home' } },
      steps: [
        {
          name: 'Open home',
          type: 'goToUrl',
          params: { value: 'https://app.example.com/home' },
        },
        {
          name: 'Assert widget',
          type: 'assertElementPresent',
          params: {
            // Cross-origin element.url routes this step down the iframe path. The
            // residue signal is an attribute-predicated `at` xpath embedding the
            // serialized-object artifact: a hashed-class-only element is REJECTED
            // upstream (it becomes a zero-candidate case, not a residue case), so
            // residue detection is exercised through an xpath candidate that survives
            // extraction and still flags.
            element: {
              url: 'https://widgets.example.com/embed/panel',
              multiLocator: { at: '/descendant::*[@aria-label="[object Object]"]/descendant::*[1]' },
            },
          },
        },
      ],
    };
    const collector = new FlagCollector();
    const { spec, hasIframes } = generateBrowserSpec(test as unknown as Parameters<typeof generateBrowserSpec>[0], collector);

    assert.ok(hasIframes, 'the cross-origin element must route through the iframe path');
    const residueFlags = collector.flags.filter(f => f.reason === 'unconvertible-locator');
    assert.equal(residueFlags.length, 1, 'the iframe path must not be a detection blind spot');
    assert.equal(residueFlags[0].stepIndex, 1, 'the iframe-path flag must carry the residue step index');
    assert.ok(spec.includes('// MIGRATION-FLAG: unconvertible-locator'), 'the marker must appear on the iframe-path step');
    // Plan 08-04: the iframe path is folded into the single firstMatch chain, so the
    // live statement is now the DIRECT default emission (single-candidate xpath),
    // not a findInFrame assignment. The residue is still detected and flagged.
    assert.ok(
      spec.includes('await expect(page.locator("xpath=/descendant::*[@aria-label=\\"[object Object]\\"]/descendant::*[1]")).toBeAttached();'),
      'the live folded locator statement must still emit (attached-state presence)'
    );
    assert.ok(!spec.includes('findInFrame'), 'the folded iframe spec must not reference the retired findInFrame helper');
    // The iframe-classified element step must carry its provenance comment.
    assert.ok(spec.includes('// May be inside an iframe'), 'the iframe step must carry the provenance comment');
  });

  it('a step with a clean id locator records zero residue flags', () => {
    const test = {
      public_id: 'syn-507-ccc',
      name: 'Clean click flow',
      locations: ['us-east-1'],
      privateLocations: [],
      originalLocations: ['aws:us-east-1'],
      config: { request: { url: 'https://app.example.com/home' } },
      steps: [
        {
          name: 'Click go',
          type: 'click',
          params: { element: { targetOuterHTML: '<button id="go">Go</button>' } },
        },
        {
          name: 'Assert done',
          type: 'assertPageContains',
          params: { value: 'Done' },
        },
      ],
    };
    const collector = new FlagCollector();
    generateBrowserSpec(test as unknown as Parameters<typeof generateBrowserSpec>[0], collector);
    const residueFlags = collector.flags.filter(
      f => f.reason === 'unconvertible-locator' || f.reason === 'xpath-positional'
    );
    assert.equal(residueFlags.length, 0, 'a clean id locator must record no residue flags');
  });
});

/**
 * zero-assertion (SC-4, spec-level): a generated spec containing
 * no runtime assertion records exactly ONE zero-assertion flag with stepIndex
 * strictly null. Any emitted expect( or expect.soft( counts as an assertion,
 * including runApiTest's toBeOK form; comment lines (commented-out flagged steps)
 * do not count. Inputs are inline synthetic BrowserTest objects (names 25 chars
 * or fewer, syn- ids, example.com URLs), driven through generateSpecFile with a
 * fresh collector per case.
 */
describe('step 07 zero-assertion: spec-level assertion-free flag', () => {
  function mkTest(publicId: string, steps: unknown[]): Parameters<typeof generateBrowserSpec>[0] {
    return {
      public_id: publicId,
      name: 'Zero assert flow',
      locations: ['us-east-1'],
      privateLocations: [],
      originalLocations: ['aws:us-east-1'],
      config: { request: { url: 'https://app.example.com/home' } },
      steps,
    } as unknown as Parameters<typeof generateBrowserSpec>[0];
  }

  it('Test 1 (fires): an assertion-free spec records exactly one zero-assertion flag with stepIndex null and a marker in the body', () => {
    const collector = new FlagCollector();
    const { spec } = generateBrowserSpec(
      mkTest('syn-520-aaa', [
        { name: 'Open home', type: 'goToUrl', params: { value: 'https://app.example.com/home' } },
        { name: 'Click go', type: 'click', params: { element: { targetOuterHTML: '<button id="go">Go</button>' } } },
        { name: 'Wait', type: 'wait', params: { value: '2' } },
      ]),
      collector,
    );
    const zeroFlags = collector.flags.filter(f => f.reason === 'zero-assertion');
    assert.equal(zeroFlags.length, 1, 'exactly one zero-assertion flag must be recorded');
    assert.strictEqual(zeroFlags[0].stepIndex, null, 'the zero-assertion flag must be spec-level (stepIndex strictly null)');
    assert.equal(zeroFlags[0].publicId, 'syn-520-aaa', 'the flag must carry the test public_id');
    assert.ok(!zeroFlags[0].deactivates, 'a zero-assertion flag must not deactivate');
    assert.ok(spec.includes('// MIGRATION-FLAG: zero-assertion'), 'the marker must appear in the spec body');
    // Spec-level marker renders with no step suffix.
    assert.ok(!/MIGRATION-FLAG: zero-assertion \(step/.test(spec), 'the spec-level marker must carry no (step N) suffix');
  });

  it('Test 2 (DOM assertion counts): a spec with an assertPageContains records no zero-assertion flag', () => {
    const collector = new FlagCollector();
    generateBrowserSpec(
      mkTest('syn-521-bbb', [
        { name: 'Open home', type: 'goToUrl', params: { value: 'https://app.example.com/home' } },
        { name: 'Assert seen', type: 'assertPageContains', params: { value: 'Home' } },
      ]),
      collector,
    );
    assert.equal(collector.flags.filter(f => f.reason === 'zero-assertion').length, 0, 'a DOM assertion must satisfy the scan');
  });

  it('Test 3 (toBeOK counts): a runApiTest-only spec records no zero-assertion flag', () => {
    const collector = new FlagCollector();
    generateBrowserSpec(
      mkTest('syn-522-ccc', [
        {
          name: 'Call api',
          type: 'runApiTest',
          params: { request: { config: { request: { method: 'GET', url: 'https://app.example.com/api/ping' } } } },
        },
      ]),
      collector,
    );
    assert.equal(
      collector.flags.filter(f => f.reason === 'zero-assertion').length,
      0,
      "runApiTest's toBeOK must count as an assertion (Open Question 3 resolution)"
    );
  });

  it('Test 4 (soft assertions count): a spec whose only assertion is expect.soft records no zero-assertion flag', () => {
    const collector = new FlagCollector();
    generateBrowserSpec(
      mkTest('syn-523-ddd', [
        {
          name: 'Soft assert',
          type: 'assertElementPresent',
          allowFailure: true,
          params: { element: { targetOuterHTML: '<div id="banner">hi</div>' } },
        },
      ]),
      collector,
    );
    assert.equal(
      collector.flags.filter(f => f.reason === 'zero-assertion').length,
      0,
      'expect.soft must count as an assertion (a naive literal substring test would miss it)'
    );
  });

  it('Test 5 (exactly one per spec): a five-step assertion-free spec records exactly one zero-assertion flag total', () => {
    const collector = new FlagCollector();
    generateBrowserSpec(
      mkTest('syn-524-eee', [
        { name: 'Open home', type: 'goToUrl', params: { value: 'https://app.example.com/home' } },
        { name: 'Click a', type: 'click', params: { element: { targetOuterHTML: '<button id="a">A</button>' } } },
        { name: 'Type b', type: 'typeText', params: { value: 'x', element: { targetOuterHTML: '<input id="b">' } } },
        { name: 'Hover c', type: 'hover', params: { element: { targetOuterHTML: '<div id="c">C</div>' } } },
        { name: 'Wait', type: 'wait', params: { value: '1' } },
      ]),
      collector,
    );
    assert.equal(
      collector.flags.filter(f => f.reason === 'zero-assertion').length,
      1,
      'a multi-step assertion-free spec records exactly one flag, never one per step'
    );
  });

  it('Test 6 (commented lines do not count): a spec whose only assertion step is zero-signal records BOTH the locator-unresolvable flag and the zero-assertion flag', () => {
    const collector = new FlagCollector();
    generateBrowserSpec(
      mkTest('syn-525-fff', [
        { name: 'Open home', type: 'goToUrl', params: { value: 'https://app.example.com/home' } },
        // Empty element object -> extractLocator returns null -> withLocator comments
        // the assertion out via the locator-unresolvable path. A commented-out expect
        // is not a runtime assertion, so the spec is still assertion-free.
        { name: 'Assert ghost', type: 'assertElementPresent', params: { element: {} } },
      ]),
      collector,
    );
    assert.equal(
      collector.flags.filter(f => f.reason === 'locator-unresolvable').length,
      1,
      "the locator-unresolvable path must fire for the zero-signal assertion step"
    );
    assert.equal(
      collector.flags.filter(f => f.reason === 'zero-assertion').length,
      1,
      'a commented-out expect is not a runtime assertion, so zero-assertion still fires'
    );
  });
});

/**
 * generateWait parse-hardening. The seconds-to-ms `* 1000` multiplier is CORRECT
 * (Datadog documents browser waits in seconds, max 300). A valid wait emits
 * `await page.waitForTimeout(<ms>);` with ZERO flags.
 * A missing, empty, non-numeric, zero/negative, or `> 300` value emits a
 * `wait-value-invalid` flag through the threaded collector, a loud MIGRATION-FLAG
 * marker, and a commented-out (non-executable) waitForTimeout line, never a
 * silently invented 1-second wait. Driven directly against generateWait with a
 * synthetic step and the collector-bearing StepFlagContext seam.
 */
describe('step 07 generateWait parse guard', () => {
  function waitStep(value?: unknown): Step07 {
    const params = value === undefined ? {} : { value };
    return { name: 'Pause', type: 'wait', params } as unknown as Step07;
  }

  it('Test 1 (valid string): value "5" emits waitForTimeout(5000) with zero flags', () => {
    const ctx = mkCtx({ publicId: 'syn-601-aaa', stepIndex: 0 });
    const out = generateWait(waitStep('5'), ctx);
    assert.equal(out, '    await page.waitForTimeout(5000);', 'the *1000 seconds-to-ms multiplier must stay');
    assert.equal(ctx.collector.flags.length, 0, 'a valid wait must record no flag');
  });

  it('Test 2 (valid JSON number): number 10 emits waitForTimeout(10000), no flag', () => {
    const ctx = mkCtx({ publicId: 'syn-602-bbb', stepIndex: 2 });
    const out = generateWait(waitStep(10), ctx);
    assert.equal(out, '    await page.waitForTimeout(10000);', 'a JSON-number value must be read directly');
    assert.equal(ctx.collector.flags.length, 0, 'a valid numeric wait must record no flag');
  });

  it('Test 3 (boundary valid): value "300" emits waitForTimeout(300000), no flag', () => {
    const ctx = mkCtx({ publicId: 'syn-603-ccc', stepIndex: 0 });
    const out = generateWait(waitStep('300'), ctx);
    assert.equal(out, '    await page.waitForTimeout(300000);', '300 is the inclusive ceiling and stays valid');
    assert.equal(ctx.collector.flags.length, 0, 'the boundary value 300 must record no flag');
  });

  it('Test 4 (missing): a wait step with no params.value flags wait-value-invalid, comments out the wait', () => {
    const ctx = mkCtx({ publicId: 'syn-604-ddd', stepIndex: 4 });
    const out = generateWait(waitStep(undefined), ctx);
    assert.equal(ctx.collector.flags.length, 1, 'a missing value must record exactly one flag');
    const flag = ctx.collector.flags[0];
    assert.equal(flag.reason, 'wait-value-invalid', 'the reason must be wait-value-invalid, not a unit code');
    assert.equal(flag.publicId, 'syn-604-ddd', 'the flag must carry the check public_id');
    assert.equal(flag.stepIndex, 4, 'the flag must carry the 0-based step index');
    assert.ok(!flag.deactivates, 'a wait-value-invalid flag must not deactivate');
    assert.ok(out.includes('// MIGRATION-FLAG: wait-value-invalid'), 'the loud marker must appear');
    assert.ok(/^\s*\/\/\s*await page\.waitForTimeout/m.test(out), 'the waitForTimeout line must be commented out');
    assert.ok(!/^\s*await page\.waitForTimeout/m.test(out), 'no ACTIVE waitForTimeout may be emitted for an invalid wait');
  });

  it('Test 5 (non-numeric): value "abc" flags wait-value-invalid with a commented-out wait line', () => {
    const ctx = mkCtx({ publicId: 'syn-605-eee', stepIndex: 1 });
    const out = generateWait(waitStep('abc'), ctx);
    assert.equal(ctx.collector.flags.length, 1, 'a non-numeric value must record exactly one flag');
    assert.equal(ctx.collector.flags[0].reason, 'wait-value-invalid', 'the reason must be wait-value-invalid');
    assert.ok(out.includes('// MIGRATION-FLAG: wait-value-invalid'), 'the loud marker must appear');
    assert.ok(!/^\s*await page\.waitForTimeout/m.test(out), 'no ACTIVE waitForTimeout may be emitted');
  });

  it('Test 6 (out of range): "301", numeric 400, and "0" each flag wait-value-invalid (range is 1..300)', () => {
    for (const bad of ['301', 400, '0']) {
      const ctx = mkCtx({ publicId: 'syn-606-fff', stepIndex: 0 });
      const out = generateWait(waitStep(bad), ctx);
      assert.equal(ctx.collector.flags.length, 1, `value ${JSON.stringify(bad)} must record exactly one flag`);
      assert.equal(ctx.collector.flags[0].reason, 'wait-value-invalid', `value ${JSON.stringify(bad)} must flag wait-value-invalid`);
      assert.ok(!/^\s*await page\.waitForTimeout/m.test(out), `value ${JSON.stringify(bad)} must not emit an active wait`);
    }
  });
});

/**
 * generatePressKey alias map plus key-unmapped flag. Known
 * Datadog key names are normalized to Playwright's KeyboardEvent.key set and
 * emitted via page.keyboard.press() (the press form for keys not aimed at an
 * element, matching Datadog pressKey semantics; verified against the Playwright
 * skill and live docs). The existing {{ VAR }}/hasVariable branch is preserved
 * byte-for-byte and never mapped or flagged. Already-valid names pass through;
 * F-keys and single printable characters pass through; an unmapped name records a
 * key-unmapped flag with the press line commented out, never an active raw press.
 */
describe('step 07 generatePressKey alias map', () => {
  function keyStep(value: string): Step07 {
    return { name: 'Press', type: 'pressKey', params: { value } } as unknown as Step07;
  }

  it('Test 1 (passthrough): "Enter" emits press("Enter") with no flag', () => {
    const ctx = mkCtx({ publicId: 'syn-620-aaa', stepIndex: 0 });
    const out = generatePressKey(keyStep('Enter'), ctx);
    assert.equal(out, '    await page.keyboard.press("Enter");', 'a valid name passes through unchanged');
    assert.equal(ctx.collector.flags.length, 0, 'a mapped/valid key must record no flag');
  });

  it('Test 2 (aliases): Esc/Del/Up/Return/Space map to Escape/Delete/ArrowUp/Enter/space', () => {
    const cases: Array<[string, string]> = [
      ['Esc', 'Escape'],
      ['Del', 'Delete'],
      ['Up', 'ArrowUp'],
      ['Return', 'Enter'],
      ['Space', ' '],
    ];
    for (const [alias, mapped] of cases) {
      const ctx = mkCtx({ publicId: 'syn-621-bbb', stepIndex: 0 });
      const out = generatePressKey(keyStep(alias), ctx);
      assert.equal(out, `    await page.keyboard.press("${mapped}");`, `${alias} must map to ${JSON.stringify(mapped)}`);
      assert.equal(ctx.collector.flags.length, 0, `${alias} is a known alias and must record no flag`);
    }
  });

  it('Test 3 (case normalization): "escape" and "ESC" both emit press("Escape")', () => {
    for (const alias of ['escape', 'ESC']) {
      const ctx = mkCtx({ publicId: 'syn-622-ccc', stepIndex: 0 });
      const out = generatePressKey(keyStep(alias), ctx);
      assert.equal(out, '    await page.keyboard.press("Escape");', `${alias} must normalize case-insensitively`);
      assert.equal(ctx.collector.flags.length, 0, `${alias} must record no flag`);
    }
  });

  it('Test 4 (F-keys and printable chars): "F5" emits press("F5"), "a" emits press("a") verbatim, no flag', () => {
    const ctxF = mkCtx({ publicId: 'syn-623-ddd', stepIndex: 0 });
    assert.equal(generatePressKey(keyStep('F5'), ctxF), '    await page.keyboard.press("F5");', 'F5 must pass through canonicalized');
    assert.equal(ctxF.collector.flags.length, 0, 'an F-key must record no flag');

    const ctxA = mkCtx({ publicId: 'syn-623-eee', stepIndex: 0 });
    assert.equal(generatePressKey(keyStep('a'), ctxA), '    await page.keyboard.press("a");', 'a single char passes through, case preserved');
    assert.equal(ctxA.collector.flags.length, 0, 'a single printable char must record no flag');
  });

  it('Test 5 (variable branch preserved): a {{ VAR }} key emits the template-literal form with no flag', () => {
    const ctx = mkCtx({ publicId: 'syn-624-fff', stepIndex: 0 });
    const out = generatePressKey(keyStep('{{ PRESS_KEY_VAR }}'), ctx);
    assert.ok(out.includes('await page.keyboard.press(`'), 'the hasVariable branch must emit the backtick template-literal press form');
    assert.equal(ctx.collector.flags.length, 0, 'a {{ VAR }} key must be neither mapped nor flagged');
  });

  it('Test 6 (unmapped): an unknown name records a key-unmapped flag and comments the press out', () => {
    const ctx = mkCtx({ publicId: 'syn-625-ggg', stepIndex: 3 });
    const out = generatePressKey(keyStep('Bananas'), ctx);
    assert.equal(ctx.collector.flags.length, 1, 'an unmapped key must record exactly one flag');
    const flag = ctx.collector.flags[0];
    assert.equal(flag.reason, 'key-unmapped', 'the reason must be key-unmapped');
    assert.equal(flag.publicId, 'syn-625-ggg', 'the flag must carry the check public_id');
    assert.equal(flag.stepIndex, 3, 'the flag must carry the 0-based step index');
    assert.ok(!flag.deactivates, 'a key-unmapped flag must not deactivate');
    assert.ok(out.includes('// MIGRATION-FLAG: key-unmapped'), 'the loud marker must appear');
    assert.ok(/^\s*\/\/\s*await page\.keyboard\.press/m.test(out), 'the press line must be commented out');
    assert.ok(out.includes('Bananas'), 'the commented press must carry the escaped raw name for the triager');
    assert.ok(!/^\s*await page\.keyboard\.press/m.test(out), 'no ACTIVE press of the raw name may be emitted');
  });
});

/**
 * cookie attribute-token filter in generateSpecFile's
 * setCookie loop. A Set-Cookie string carries the cookie's name=value plus
 * attribute tokens (Secure, HttpOnly, Path=, Expires=, Domain=, SameSite=,
 * Max-Age, Priority). Those attribute tokens must be filtered case-insensitively
 * (both bare and =-valued forms) so they stop becoming bogus addCookies entries,
 * and a token without a name=value shape must be skipped. This is a mechanical
 * filter: no flag, no marker. Driven through generateSpecFile with inline
 * synthetic BrowserTest objects (names 25 chars or fewer, syn- ids, invented
 * cookie values). Asserts on the emitted addCookies `name: "..."` entries.
 */
describe('step 07 cookie attribute-token filter', () => {
  function mkCookieTest(publicId: string, setCookie: string): Parameters<typeof generateBrowserSpec>[0] {
    return {
      public_id: publicId,
      name: 'Cookie flow',
      locations: ['us-east-1'],
      privateLocations: [],
      originalLocations: ['aws:us-east-1'],
      config: { request: { url: 'https://app.example.com/home' }, setCookie },
      steps: [
        { name: 'Open home', type: 'goToUrl', params: { value: 'https://app.example.com/home' } },
      ],
    } as unknown as Parameters<typeof generateBrowserSpec>[0];
  }

  function cookieNames(spec: string): string[] {
    return [...spec.matchAll(/\{ name: "([^"]*)", value:/g)].map(m => m[1]);
  }

  it('Test 1 (attribute stripping): a full Set-Cookie string emits exactly one cookie entry (sess)', () => {
    const collector = new FlagCollector();
    const { spec } = generateBrowserSpec(
      mkCookieTest('syn-630-aaa', 'sess=abc123; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600; Domain=app.example.com; Priority=High'),
      collector,
    );
    const names = cookieNames(spec);
    assert.deepEqual(names, ['sess'], 'only the real cookie survives; every attribute token is filtered');
    assert.ok(spec.includes('{ name: "sess", value: "abc123",'), 'the sess cookie keeps its value byte-identical');
    for (const attr of ['Secure', 'HttpOnly', 'Path', 'SameSite', 'Max-Age', 'Domain', 'Priority']) {
      assert.ok(!names.includes(attr), `${attr} must not become a cookie entry`);
    }
    // The cookie filter is mechanical: it emits no flag of its own. (The spec has
    // no assertion step, so the 07-05 spec-level zero-assertion scan fires; that
    // is unrelated to cookie parsing, so we assert no cookie/wait/key flag rather
    // than zero total flags.)
    assert.ok(
      !collector.flags.some(f => f.reason === 'wait-value-invalid' || f.reason === 'key-unmapped'),
      'the cookie filter path emits no flag (mechanical)',
    );
  });

  it('Test 2 (case-insensitive): lowercase secure and mixed-case HttpOnly/httponly are filtered equally', () => {
    const { spec } = generateBrowserSpec(
      mkCookieTest('syn-631-bbb', 'sess=abc; secure; HttpOnly; httponly'),
      new FlagCollector(),
    );
    assert.deepEqual(cookieNames(spec), ['sess'], 'attribute tokens filter regardless of case');
  });

  it('Test 3 (multiple real cookies preserved): "a=1; b=2; Secure" emits exactly two entries', () => {
    const { spec } = generateBrowserSpec(
      mkCookieTest('syn-632-ccc', 'a=1; b=2; Secure'),
      new FlagCollector(),
    );
    assert.deepEqual(cookieNames(spec), ['a', 'b'], 'both real cookies survive; only Secure is filtered');
  });

  it('Test 4 (no-name=value guard): a bare junk token and a leading-= token are skipped', () => {
    const { spec } = generateBrowserSpec(
      mkCookieTest('syn-633-ddd', 'sess=abc; junk; =oops'),
      new FlagCollector(),
    );
    const names = cookieNames(spec);
    assert.deepEqual(names, ['sess'], 'a no-equals token and an empty-name token are both skipped');
    assert.ok(!names.includes(''), 'no empty-name entry may be emitted');
    assert.ok(!names.includes('junk'), 'a no-equals junk token must not become a cookie');
  });

  it('Test 5 (token-level anchoring): a real cookie "pref=Secure" survives the filter', () => {
    const { spec } = generateBrowserSpec(
      mkCookieTest('syn-634-eee', 'pref=Secure; Secure'),
      new FlagCollector(),
    );
    const names = cookieNames(spec);
    assert.ok(names.includes('pref'), 'a cookie whose VALUE is Secure must survive; the predicate is token-level');
    assert.equal(names.length, 1, 'the bare Secure attribute token is still filtered, leaving only pref');
    assert.ok(spec.includes('{ name: "pref", value: "Secure",'), 'pref keeps its Secure value');
  });
});

/**
 * Readability fix (spec-readability-fix-handoff.md, quick 260709-vex): the
 * multi-locator readability contract locked end to end through generateSpecFile.
 * A hoisted CandidateFactory const, the awaited firstMatch reference by name, the
 * ../helpers import line carrying the type symbol, the 4-space body depth, and
 * content-byte safety (no injected indent inside a template literal). Inline
 * synthetic BrowserTest objects only (syn- ids, names 25 chars or fewer,
 * example.com hosts).
 */
describe('readability: multi-locator hoisting, indentation, and content-byte safety end to end', () => {
  function mkTest(publicId: string, steps: unknown[], extraConfig: Record<string, unknown> = {}): Parameters<typeof generateBrowserSpec>[0] {
    return {
      public_id: publicId,
      name: 'Readable flow',
      locations: ['us-east-1'],
      privateLocations: [],
      originalLocations: ['aws:us-east-1'],
      config: { request: { url: 'https://app.example.com/home' }, ...extraConfig },
      steps,
    } as unknown as Parameters<typeof generateBrowserSpec>[0];
  }

  // A two-candidate step (role + id) so the chain is multi-candidate and hoists.
  const multiClick = {
    name: 'Click go',
    type: 'click',
    params: {
      element: {
        targetOuterHTML: '<button id="go">Sign in</button>',
        multiLocator: { co: JSON.stringify([{ text: 'Sign in', textType: 'directText' }]) },
      },
    },
  };
  const assertStep = { name: 'Assert seen', type: 'assertPageContains', params: { value: 'Home' } };

  it('a multi-candidate spec hoists the const, references it by name, and carries the type on the ../helpers import line', () => {
    const { spec } = generateBrowserSpec(mkTest('syn-710-aaa', [multiClick, assertStep]), new FlagCollector());
    assert.ok(spec.includes('import { firstMatch, type CandidateFactory } from "../helpers";'),
      'the type symbol must ride the existing ../helpers import line');
    assert.ok(/const\s+step1ClickGo:\s*CandidateFactory\s*=\s*\(root\)\s*=>\s*\[/.test(spec),
      'the spec must declare the hoisted factory const with the CandidateFactory annotation');
    assert.ok(spec.includes('await (await firstMatch(page, step1ClickGo)).click();'),
      'the action line must reference the hoisted const by name');
    assert.ok(!spec.includes('firstMatch(page, (root)'), 'no inline arrow may sit inside an await');
  });

  it('spec body step comments sit at exactly four spaces, matching the describe/test nesting depth', () => {
    const { spec } = generateBrowserSpec(mkTest('syn-711-bbb', [multiClick, assertStep]), new FlagCollector());
    const stepComment = spec.split('\n').find((l) => l.includes('// Step 1: Click go'));
    assert.ok(stepComment, 'the step-1 comment must be present');
    assert.ok(/^ {4}\/\/ Step 1:/.test(stepComment!), 'the step comment must start with exactly four spaces');
    // Every candidate line inside the hoisted factory sits at six spaces.
    const candidateLine = spec.split('\n').find((l) => l.includes('root.getByRole('));
    assert.ok(candidateLine && /^ {6}root\./.test(candidateLine), 'candidate lines sit at six-space depth inside the const');
  });

  it('the cookies/addCookies and start-URL goto setup lines start with four spaces', () => {
    const { spec } = generateBrowserSpec(
      // No goToUrl first step, so the start URL emits a prepended goto; plus a cookie.
      mkTest('syn-712-ccc', [assertStep], { setCookie: 'sess=abc123; Secure' }),
      new FlagCollector(),
    );
    assert.ok(spec.includes('    await page.context().addCookies([\n'), 'the addCookies call must sit at four spaces');
    assert.ok(/^ {6}\{ name: "sess",/m.test(spec), 'each cookie entry sits at six-space depth');
    assert.ok(spec.includes('    await page.goto(`https://app.example.com/home`);'), 'the prepended start-URL goto sits at four spaces');
  });

  it('a typeText value containing an embedded newline emits that continuation line byte-identical (no injected indent inside the template literal)', () => {
    // The fill value carries a literal newline; escapeTemplateLiteral does not
    // escape newlines, so the emitted template literal legitimately spans two lines.
    // A whole-body reindent pass would inject leading whitespace into the second
    // line, mutating the runtime string content; the per-emitter indent contract
    // must leave the continuation line byte-identical.
    const { spec } = generateBrowserSpec(
      mkTest('syn-713-ddd', [
        { name: 'Type note', type: 'typeText', params: { value: 'line one\nline two', element: { targetOuterHTML: '<input id="note">' } } },
        assertStep,
      ]),
      new FlagCollector(),
    );
    assert.ok(spec.includes('.fill(`line one\nline two`);'), 'the embedded-newline continuation line must be byte-identical (no injected indent)');
    // Non-tautological anchor: the continuation line has NO leading whitespace.
    const lines = spec.split('\n');
    const contIdx = lines.findIndex((l) => l === 'line two`);');
    assert.ok(contIdx !== -1, 'the raw continuation line "line two`);" must exist with no leading indentation');
  });
});
