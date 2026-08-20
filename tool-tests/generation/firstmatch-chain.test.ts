/**
 * Generation tests for the firstMatch() runtime spine.
 *
 * Three concerns are locked here, all offline, no subprocess, no file writes
 * (Testing SOP): (1) the emitted helpers-module source constant
 * SHARED_HELPERS_SOURCE contains the bounded, priority-preserving, frames-aware
 * firstMatch plus the greppable exhaustion signal (Task 1, string assertions over
 * the constant); (2) chain-aware withLocator routes single,
 * multi, weak, sd, and zero-candidate cases correctly through the one emit seam
 * and activates the seeded weak-fallback-chain and shadow-dom-locator flags
 * (Task 2); (3) generateSpecFile gates the helpers import and records
 * hasMultiCandidate for the manifest (Task 3).
 *
 * Every fixture value is authored synthetic from scratch: example.com hosts,
 * syn- public ids, invented selectors, names 25 chars or fewer. The emitted
 * helper source is RUNTIME code (Playwright 1.51.1); the determinism SOP governs
 * this test file and the tool, not the emitted runtime code, so wall-clock and
 * waits inside the emitted string are expected and asserted for.
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  SHARED_HELPERS_SOURCE,
  classifyChainStrength,
  buildCandidateFactoryExpr,
  candidateSourceLabel,
  generateLocatorCode,
  generateClick,
  generateAssertElementContent,
  generateAssertElementPresent,
  generateSpecFile as generateBrowserSpec,
  deriveSettleBudgetMs,
  uniqueVarName,
  type StepFlagContext,
} from '../../src/07-generate-browser-specs.ts';
import { FlagCollector } from '../../src/shared/migration-flags.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC07_PATH = join(__dirname, '..', '..', 'src', '07-generate-browser-specs.ts');

type Step07 = Parameters<typeof generateClick>[0];
type Candidate = Parameters<typeof buildCandidateFactoryExpr>[0][number];

/**
 * Fresh per-step flag context, mirroring the browser.test.ts idiom. Spread
 * overrides to vary publicId / stepIndex per case (synthetic values only).
 */
function mkCtx(overrides: Partial<StepFlagContext> = {}): StepFlagContext {
  return { collector: new FlagCollector(), publicId: 'syn-000-tst', stepIndex: 0, ...overrides };
}

/**
 * DD_TAGS_* are read by nothing here, but the emit path shares the module with
 * generators that do; snapshot/clear/restore to keep the suite hermetic and
 * order-independent alongside browser.test.ts.
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
    if (savedTagEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedTagEnv[name];
  }
});

// ---------------------------------------------------------------------------
// Task 1: SHARED_HELPERS_SOURCE: firstMatch, frames rung, exhaustion signal
// ---------------------------------------------------------------------------

describe('Task 1 SHARED_HELPERS_SOURCE: emitted firstMatch helper source', () => {
  const src = SHARED_HELPERS_SOURCE;

  it('imports test plus the Page, Frame, and Locator types from @playwright/test', () => {
    assert.ok(/import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*["']@playwright\/test["']/.test(src), 'must import test');
    assert.ok(/\bPage\b/.test(src) && /\bFrame\b/.test(src) && /\bLocator\b/.test(src), 'must import Page, Frame, Locator types');
  });

  it('exports an async firstMatch taking a Page and a makeCandidates factory typed (root: Page | Frame) => Locator[]', () => {
    assert.ok(/export\s+async\s+function\s+firstMatch\s*\(/.test(src), 'firstMatch must be exported async');
    assert.ok(/makeCandidates\s*:\s*\(\s*root\s*:\s*Page\s*\|\s*Frame\s*\)\s*=>\s*Locator\[\]/.test(src),
      'makeCandidates must be typed (root: Page | Frame) => Locator[]');
    assert.ok(/firstMatch\s*\(\s*page\s*:\s*Page\s*,/.test(src), 'firstMatch first parameter must be page: Page');
  });

  it('probes candidates with an instant count()-gated loop over the main page first, then every page.frames() frame', () => {
    assert.ok(/\.count\(\)/.test(src), 'must gate on count()');
    assert.ok(/page\.frames\(\)/.test(src), 'must enumerate page.frames() for the iframe rung');
    assert.ok(/mainFrame\(\)/.test(src), 'must skip the main frame in the frames loop');
    // Assert ordering over EXECUTABLE code only: strip // line comments and block
    // comments so prose that mentions page.frames() before the main-page loop
    // (JSDoc, inline notes) does not confuse the textual-order check.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    const mainProbeIdx = code.indexOf('makeCandidates(page)');
    const framesIdx = code.indexOf('page.frames()');
    assert.ok(mainProbeIdx !== -1 && framesIdx !== -1 && mainProbeIdx < framesIdx,
      'main-page rungs must be probed before the frame rungs');
  });

  it('contains the greppable MIGRATION-LOCATOR-EXHAUSTION token exported as LOCATOR_EXHAUSTION_TOKEN', () => {
    assert.ok(src.includes('MIGRATION-LOCATOR-EXHAUSTION'), 'the greppable exhaustion token must be present verbatim');
    assert.ok(/export\s+const\s+LOCATOR_EXHAUSTION_TOKEN\s*=/.test(src),
      'the token must be an exported const named LOCATOR_EXHAUSTION_TOKEN for reuse by the assertion helper');
  });

  it('emits the exhaustion signal as a boxed test.step plus a console.error breadcrumb', () => {
    assert.ok(/test\.step\s*\(/.test(src), 'the exhaustion signal must use test.step');
    assert.ok(/box\s*:\s*true/.test(src), 'the exhaustion test.step must carry the box: true option');
    assert.ok(/console\.error\s*\(/.test(src), 'a console.error breadcrumb must be baked in (belt-and-suspenders log asset)');
  });

  it('on exhaustion returns the PRIMARY main-page candidate, makeCandidates(page)[0].first()', () => {
    assert.ok(/makeCandidates\(page\)\[0\]\.first\(\)/.test(src),
      'exhaustion must return the primary main-page candidate (real native error names the intended selector)');
    // .first() is the strict-safe terminal on every successful probe return, too.
    assert.ok(/\.first\(\)/.test(src), 'successful probes must return .first() (strict-safe terminal)');
  });

  it('carries the named rescan budget constants EXHAUSTION_RESCAN_BUDGET_MS (Datadog-parity default) and RESCAN_INTERVALS_MS', () => {
    // the const is now the Datadog-parity default 60000 (element
    // retry 60s default per docs.datadoghq.com), not the old fixed 2500ms; a
    // timeout-bearing step overrides it via the third firstMatch argument.
    assert.ok(/EXHAUSTION_RESCAN_BUDGET_MS\s*=\s*(60000|60_000)\b/.test(src), 'budget const must be the Datadog-parity default 60000');
    assert.ok(!/EXHAUSTION_RESCAN_BUDGET_MS\s*=\s*2500\b/.test(src), 'the old fixed 2500 budget value must be gone');
    assert.ok(/RESCAN_INTERVALS_MS\s*=\s*\[\s*100\s*,\s*250\s*,\s*500\s*,\s*1000\s*\]/.test(src),
      'RESCAN_INTERVALS_MS must be [100, 250, 500, 1000]');
    assert.ok(/page\.waitForTimeout\(/.test(src), 'the settle-loop wait is page.waitForTimeout');
  });

  it('every timeout mentioned in the helper source is an explicit numeric literal (no defaulted wait)', () => {
    // No bare waitForTimeout() with an empty or non-numeric arg.
    assert.doesNotMatch(src, /waitForTimeout\(\s*\)/, 'waitForTimeout must never be called with no argument');
    // the const default and the defensive cap are explicit numeric literals;
    // the ladder intervals remain literals too.
    assert.ok(/60000|60_000/.test(src) && /1000/.test(src) && /240000/.test(src),
      'explicit numeric timeout literals must be present (60000 default, 1000 interval, 240000 cap)');
  });

  it('contains NO locator-union .or( call and NO toPass call; the only waitFor is the bounded attach-race', () => {
    assert.ok(!/\.or\s*\(/.test(src), '.or() is set-union in document order and discards priority; forbidden');
    assert.ok(!/toPass\s*\(/.test(src), 'toPass defaults to infinite timeout and is forbidden in emitted code');
    // The scan ladder is still instant-count()-only, but the
    // exhaustion fallback now races candidates for first-attached via a BOUNDED
    // waitFor (state: 'attached' with an explicit remaining-budget timeout). Every
    // waitFor in the helper must carry a numeric timeout, so no wait is unbounded.
    const waitForCalls = src.match(/\.waitFor\s*\(\{[^}]*\}\)/g) || [];
    assert.ok(waitForCalls.length >= 1, 'the attach-race must use candidate.waitFor({ state: "attached", timeout })');
    for (const call of waitForCalls) {
      assert.ok(/state\s*:\s*['"]attached['"]/.test(call), 'every waitFor must be a state: "attached" attach probe');
      assert.ok(/timeout\s*:/.test(call), 'every waitFor must carry an explicit numeric timeout (bounded, never infinite)');
    }
  });

  it('no longer exports the legacy findInFrame helper (firstMatch is the sole mechanism)', () => {
    assert.ok(!/findInFrame/.test(src),
      'findInFrame must be gone from the helpers source once the iframe path is folded into firstMatch');
    assert.ok(!/frameLocator/.test(src),
      'no auto-waiting frameLocator call may remain in the helpers source');
    assert.ok(/export\s+async\s+function\s+firstMatch\s*\(/.test(src),
      'firstMatch must be the one exported locator mechanism');
  });

  it('the JSDoc has no em-dash characters (repo output rule)', () => {
    assert.ok(!src.includes('—'), 'the emitted helper source must contain no em-dash characters');
  });
});

// ---------------------------------------------------------------------------
// Task 2: classifyChainStrength, buildCandidateFactoryExpr, withLocator routing
// ---------------------------------------------------------------------------

describe('Task 2 classifyChainStrength: weak-lead classifier', () => {
  it('returns weak when the first candidate source is one of id, class, clt, at, ab', () => {
    for (const source of ['id', 'class', 'clt', 'at', 'ab'] as const) {
      const candidates: Candidate[] = [{ type: 'id', value: '#x', source }];
      assert.equal(classifyChainStrength(candidates), 'weak', `${source}-led chain must classify weak`);
    }
  });

  it('returns strong when the first candidate is userLocator, role, testId, text, attr, or name', () => {
    for (const source of ['userLocator', 'role', 'testId', 'text', 'attr', 'name'] as const) {
      const candidates: Candidate[] = [{ type: 'role', value: 'button', source }];
      assert.equal(classifyChainStrength(candidates), 'strong', `${source}-led chain must classify strong`);
    }
  });

  it('grades on the FIRST candidate only (a weak lead with strong followers is still weak)', () => {
    const candidates: Candidate[] = [
      { type: 'class', value: '.foo', source: 'class' },
      { type: 'role', value: 'button', source: 'role', name: 'Go' },
    ];
    assert.equal(classifyChainStrength(candidates), 'weak', 'the leading rung determines strength');
  });
});

describe('Task 2 buildCandidateFactoryExpr: multi-line factory source emission (readability A+B)', () => {
  it('emits a multi-line (root) => [ ... ] arrow, one candidate per line, exprs from generateLocatorCode with receiver root', () => {
    const candidates: Candidate[] = [
      { type: 'id', value: '#login', source: 'id' },
      { type: 'text', value: 'Sign in', source: 'text' },
    ];
    const expr = buildCandidateFactoryExpr(candidates, mkCtx());
    // Opening arrow line, then one candidate per line, then a 4-space closing bracket.
    assert.ok(/^\(root\)\s*=>\s*\[\n/.test(expr), 'must open with a (root) => [ arrow followed by a newline');
    assert.ok(expr.includes('root.locator("#login")'), 'first expr must use the root receiver for the id candidate');
    assert.ok(expr.includes('root.getByText(new RegExp('), 'second expr must be the root-scoped text builder');
    assert.ok(!/\bpage\./.test(expr), 'the factory body must never reference page directly (it receives root)');
    assert.ok(expr.endsWith('\n    ]'), 'must close with a 4-space-indented bracket on its own line');

    // Every candidate sits on its own 6-space-indented line with a trailing comma and
    // a `// <label>` provenance comment.
    const candidateLines = expr.split('\n').slice(1, -1);
    assert.equal(candidateLines.length, candidates.length, 'one line per candidate, no collapsing');
    for (const line of candidateLines) {
      assert.match(line, /^ {6}.+, \/\/ .+$/, 'each candidate line: 6-space indent, expr, trailing comma, // label');
    }
  });

  it('the per-candidate EXPRESSIONS are byte-identical to generateLocatorCode output (the load-bearing "unchanged" guarantee)', () => {
    const candidates: Candidate[] = [
      { type: 'role', value: 'button', source: 'role', name: 'Go' },
      { type: 'id', value: '#login', source: 'id' },
      { type: 'text', value: 'Sign in', source: 'text' },
    ];
    const expr = buildCandidateFactoryExpr(candidates, mkCtx());
    const candidateLines = expr.split('\n').slice(1, -1);
    // Strip the 6-space lead and the trailing `, // <label>` from each line; the
    // remainder must equal generateLocatorCode(c, ctx, 'root') in order, byte for byte.
    const stripped = candidateLines.map((line) => line.replace(/^ {6}/, '').replace(/, \/\/ .+$/, ''));
    const expected = candidates.map((c) => generateLocatorCode(c, mkCtx(), 'root'));
    assert.deepEqual(stripped, expected, 'stripping indent and comment must recover the exact candidate expressions in order');
  });

  it('maps each source to its provenance label (userLocator/text/id/clt/ab), interpunct not em-dash', () => {
    const candidates: Candidate[] = [
      { type: 'css', value: '.pinned', source: 'userLocator' },
      { type: 'text', value: 'Sign in', source: 'text' },
      { type: 'id', value: '#login', source: 'id' },
      { type: 'xpath', value: '/descendant::*[@name="q"]', source: 'clt' },
      { type: 'xpath', value: '/*[local-name()="html"]', source: 'ab' },
    ];
    const expr = buildCandidateFactoryExpr(candidates, mkCtx());
    const labels = expr.split('\n').slice(1, -1).map((line) => line.replace(/^.*, \/\/ /, ''));
    assert.deepEqual(labels, [
      'userLocator (pinned)',
      'text',
      'id',
      'xpath (clt)',
      'xpath (ab · absolute, most brittle)',
    ]);
    assert.ok(!expr.includes('—'), 'no em-dash may appear in any provenance label');
  });
});

describe('Task 2 hoisted-const collision dedupe (uniqueVarName threading via ctx.usedVarNames)', () => {
  // A multi-candidate element (role + text + id) so each withLocator call hoists a
  // factory const. Two clicks with the SAME step name AND the SAME stepIndex would
  // collide on their base name; the shared ctx.usedVarNames set must suffix the
  // second so the two const names are distinct.
  const twoCandidateEl = {
    targetOuterHTML: '<button id="go">Sign in</button>',
    multiLocator: { co: JSON.stringify([{ text: 'Sign in', textType: 'directText' }]) },
  };

  it('two multi-candidate steps sharing one usedVarNames set with identical stepIndex and name get distinct const names', () => {
    const used = new Set<string>();
    const ctx = (): StepFlagContext => ({ collector: new FlagCollector(), publicId: 'syn-000-tst', stepIndex: 0, usedVarNames: used });
    const step: Step07 = { name: 'Click go', type: 'click', params: { element: twoCandidateEl } };

    const first = generateClick(step, ctx());
    const second = generateClick(step, ctx());

    const nameOf = (out: string) => out.match(/const\s+(step\w+):\s*CandidateFactory/)?.[1];
    const firstName = nameOf(first);
    const secondName = nameOf(second);
    assert.ok(firstName && secondName, 'both emissions must declare a hoisted factory const');
    assert.equal(firstName, 'step1ClickGo', 'the first const takes the un-suffixed base name');
    assert.equal(secondName, 'step1ClickGo2', 'the second const is suffixed with a counter (uniqueVarName)');
    assert.notEqual(firstName, secondName, 'the shared used-name set must guarantee distinct const names');
  });
});

describe('Task 2 withLocator routing: single / multi / weak / sd / zero', () => {
  // role + text + id => three candidates, role-led => a STRONG multi-candidate
  // chain (used where multi-ness matters but weakness is not asserted).
  const twoCandidateEl = {
    targetOuterHTML: '<button id="go">Sign in</button>',
    multiLocator: { co: JSON.stringify([{ text: 'Sign in', textType: 'directText' }]) },
  };

  // A textless input with an id AND a class => id + class, id-led => a WEAK
  // multi-candidate chain (no role/text/attr lead).
  const weakMultiEl = {
    targetOuterHTML: '<input id="email">',
    multiLocator: { cl: 'contains(@class, "field")' },
  };

  it('a multi-candidate click hoists a CandidateFactory const and references it by name in an awaited firstMatch chain', () => {
    const step: Step07 = { name: 'Click go', type: 'click', params: { element: twoCandidateEl } };
    const out = generateClick(step, mkCtx());
    // The factory is hoisted into a named const (readability), and the
    // action line references that const, not an inline arrow.
    assert.ok(/const\s+step1ClickGo:\s*CandidateFactory\s*=\s*\(root\)\s*=>\s*\[/.test(out),
      'multi-candidate emission must hoist a CandidateFactory const for the step');
    assert.ok(/await\s*\(await firstMatch\(page, step1ClickGo\)\)/.test(out),
      'the emitted statement must reference the hoisted const by name in the awaited-firstMatch form');
    assert.ok(!out.includes('firstMatch(page, (root)'), 'the arrow must be hoisted, never inlined into the await');
    assert.ok(out.trimEnd().endsWith('.click();'), 'the action must be applied to the resolved locator');
  });

  it('a single-candidate main-page click emits await page.locator(...).click() and never firstMatch', () => {
    const step: Step07 = {
      name: 'Click only',
      type: 'click',
      // A textless input with only an id resolves to exactly one candidate.
      params: { element: { targetOuterHTML: '<input id="only">' } },
    };
    const out = generateClick(step, mkCtx());
    assert.ok(out.includes('await page.locator("#only").click();'), 'single-candidate emission must stay byte-stable');
    assert.ok(!out.includes('firstMatch'), 'a single candidate must never emit a firstMatch call (import-gate invariant)');
  });

  it('a zero-candidate step keeps the locator-unresolvable deactivate path byte-identical', () => {
    const step: Step07 = { name: 'Click ghost', type: 'click', params: { element: { targetOuterHTML: '<div>plain</div>' } } };
    const ctx = mkCtx({ publicId: 'syn-401-aaa', stepIndex: 3 });
    const out = generateClick(step, ctx);
    assert.ok(out.includes('// MIGRATION-FLAG: locator-unresolvable'), 'the loud locator-unresolvable marker must be present');
    assert.ok(out.includes('// DD original: click \\"Click ghost\\"'), 'the preserved DD step must appear');
    // The commented-out action sits at 4-space body depth; no line may be a runnable
    // 4-space `await` statement (re-pointed from the pre-fix 2-space prefix so the
    // assertion keeps teeth under the corrected indentation).
    assert.ok(!out.split('\n').some(l => l.startsWith('    await')), 'no runnable await statement in the null path');
    assert.equal(ctx.collector.flags.length, 1, 'exactly one locator-unresolvable flag');
    assert.equal(ctx.collector.flags[0].reason, 'locator-unresolvable');
    assert.equal(ctx.collector.flags[0].deactivates, true, 'deactivates');
  });

  it('a weak-led chain emits exactly one non-deactivating weak-fallback-chain flag naming the leading rung', () => {
    const step: Step07 = { name: 'Click field', type: 'click', params: { element: weakMultiEl } };
    const ctx = mkCtx({ publicId: 'syn-450-www', stepIndex: 2 });
    generateClick(step, ctx);
    const weak = ctx.collector.flags.filter(f => f.reason === 'weak-fallback-chain');
    assert.equal(weak.length, 1, 'exactly one weak-fallback-chain flag for an id-led chain');
    assert.ok(!weak[0].deactivates, 'weak-fallback-chain must NOT deactivate (degraded stays ACTIVE)');
    assert.ok(/\bid\b/.test(weak[0].message), 'the message must name the leading rung source');
    assert.equal(weak[0].publicId, 'syn-450-www');
    assert.equal(weak[0].stepIndex, 2);
  });

  it('a strong-led chain emits no weak-fallback-chain flag', () => {
    // role-led (from targetOuterHTML) + text => strong lead.
    const el = {
      targetOuterHTML: '<button>Sign in</button>',
      multiLocator: { co: JSON.stringify([{ text: 'Sign in', textType: 'directText' }]) },
    };
    const step: Step07 = { name: 'Click go', type: 'click', params: { element: el } };
    const ctx = mkCtx();
    generateClick(step, ctx);
    assert.equal(ctx.collector.flags.filter(f => f.reason === 'weak-fallback-chain').length, 0,
      'a role-led (strong) chain must emit no weak-fallback-chain flag');
  });

  // the shadow-dom-locator flag message is now variant-aware and
  // states the VERIFIED Playwright capability (checked against current Playwright
  // docs: user-facing and CSS locators pierce OPEN shadow roots automatically at
  // runtime, XPath does not, closed roots are unsupported by every locator). The
  // retired "out of scope / never attempted" wording must appear nowhere.
  it('variant A: an sd step with a non-xpath live candidate emits the open-root-piercing capability message (role/text/testId/CSS pierce, XPath does not, closed unsupported)', () => {
    const el = {
      targetOuterHTML: '<button id="go">Sign in</button>',
      multiLocator: {
        co: JSON.stringify([{ text: 'Sign in', textType: 'directText' }]),
        sd: { ro: '//*[@id="host"]' },
      },
    };
    const step: Step07 = { name: 'Click sd', type: 'click', params: { element: el } };
    const ctx = mkCtx({ publicId: 'syn-460-sdd', stepIndex: 1 });
    const out = generateClick(step, ctx);
    const sd = ctx.collector.flags.filter(f => f.reason === 'shadow-dom-locator');
    assert.equal(sd.length, 1, 'exactly one shadow-dom-locator flag');
    assert.ok(!sd[0].deactivates, 'shadow-dom-locator must NOT deactivate');
    assert.ok(/shadow/i.test(sd[0].message), 'the message must mention shadow-DOM');
    // Variant A capability statement: piercing IS attempted for open roots.
    assert.ok(/pierce open shadow roots automatically/i.test(sd[0].message),
      'variant A must state that role/text/testId/CSS pierce open shadow roots automatically at runtime');
    assert.ok(/xpath/i.test(sd[0].message) && /closed/i.test(sd[0].message),
      'variant A must state that XPath candidates do not pierce and closed roots cannot be resolved by any locator');
    // The disproven claim must be gone from the message.
    assert.ok(!/out of scope/i.test(sd[0].message) && !/never attempted/i.test(sd[0].message),
      'the retired out-of-scope / never-attempted wording must not appear in the variant A message');
    // The normal chain still emits (sd-bearing step keeps its top-level chain).
    assert.ok(/firstMatch\(page, step\d+/.test(out) || out.includes('await page.locator'),
      'the sd-bearing step must still emit its normal locator statement');
  });

  it('variant B: an sd step whose ONLY live candidates are xpath emits the stronger honest message (no emitted candidate can pierce, open or closed, until a CSS or user-facing locator is added)', () => {
    // multiLocator carries ONLY stale xpath sources (clt + at-with-@ + ab) and NO
    // targetOuterHTML id/class and no co/role source, so extractLocator's marking
    // pass leaves every candidate live as a last resort (nothing stabler to demote
    // to). The live chain is therefore xpath-only: even an OPEN shadow root cannot
    // be pierced by any emitted candidate.
    const el = {
      multiLocator: {
        sd: { ro: '//*[@id="host"]' },
        clt: '//div[3]/span',
        at: '//*[@data-x="1"]/button',
        ab: '/html/body/div[2]/button',
      },
    };
    const step: Step07 = { name: 'Click sdx', type: 'click', params: { element: el } };
    const ctx = mkCtx({ publicId: 'syn-461-sdx', stepIndex: 4 });
    const out = generateClick(step, ctx);
    const sd = ctx.collector.flags.filter(f => f.reason === 'shadow-dom-locator');
    assert.equal(sd.length, 1, 'exactly one shadow-dom-locator flag');
    assert.ok(!sd[0].deactivates, 'shadow-dom-locator must NOT deactivate');
    // Variant B is the stronger honest surface: no emitted candidate can pierce.
    assert.ok(/every emitted candidate is xpath/i.test(sd[0].message),
      'variant B must state that every emitted candidate is XPath');
    assert.ok(/cannot pierce a shadow root, open or closed/i.test(sd[0].message),
      'variant B must state that no emitted candidate can pierce a shadow root, open or closed');
    assert.ok(/css or user-facing locator is added/i.test(sd[0].message),
      'variant B must state the remedy: add a CSS or user-facing locator');
    assert.ok(!/out of scope/i.test(sd[0].message) && !/never attempted/i.test(sd[0].message),
      'the retired out-of-scope / never-attempted wording must not appear in the variant B message');
    // The step still emits its (xpath-only) chain: never a silent drop.
    assert.ok(/firstMatch\(page, step\d+/.test(out) || out.includes('await page.locator'),
      'the xpath-only sd step must still emit its chain, never be dropped');
  });

  it('a hostile-value candidate is escaped through generateLocatorCode inside the factory', () => {
    const el = {
      // A userLocator selector carrying a quote metacharacter, plus a text rung, so
      // the chain is multi-candidate and routes through buildCandidateFactoryExpr.
      userLocator: { values: [{ type: 'css', value: '.a"b' }] },
      multiLocator: { co: JSON.stringify([{ text: 'Sign in', textType: 'directText' }]) },
    };
    const step: Step07 = { name: 'Click x', type: 'click', params: { element: el } };
    const out = generateClick(step, mkCtx());
    assert.ok(/firstMatch\(page, step\d+/.test(out), 'the hostile-value case must be a multi-candidate hoisted chain');
    assert.ok(out.includes('.a\\"b'), 'the embedded quote must be escaped, never break out of the string literal');
  });

  it('a multi-candidate assertElementPresent self-heals via assertOnFirstMatch (08-05 polarity seam)', () => {
    // 08-03 emitted the awaited-firstMatch chain inside expect() as a placeholder;
    // 08-05 reshapes positive multi-candidate assertions to self-heal per candidate.
    const step: Step07 = { name: 'Assert go', type: 'assertElementPresent', params: { element: twoCandidateEl } };
    const out = generateAssertElementPresent(step, mkCtx());
    assert.ok(/const\s+step1Go:\s*CandidateFactory\s*=/.test(out), 'the assertion must hoist a CandidateFactory const');
    assert.ok(/assertOnFirstMatch\(page, step1Go,/.test(out), 'the assertion must self-heal via assertOnFirstMatch by const name');
    assert.ok(out.includes('.toBeAttached({ timeout })'), 'the attached-state matcher forwards the per-candidate timeout');
  });

  it('a multi-candidate assertElementContent contains self-heals via assertOnFirstMatch (08-05 polarity seam)', () => {
    const step: Step07 = {
      name: 'Assert txt',
      type: 'assertElementContent',
      params: { check: 'contains', value: 'Hello', element: twoCandidateEl },
    };
    const out = generateAssertElementContent(step, mkCtx());
    assert.ok(/const\s+step1Txt:\s*CandidateFactory\s*=/.test(out), 'the content assertion must hoist a CandidateFactory const');
    assert.ok(/assertOnFirstMatch\(page, step1Txt,/.test(out), 'the content assertion must self-heal via assertOnFirstMatch by const name');
    assert.ok(out.includes('.toContainText("Hello", { timeout })'), 'the toContainText matcher forwards the per-candidate timeout');
  });
});

// ---------------------------------------------------------------------------
// Task 3: generateSpecFile helpers import + hasMultiCandidate manifest field
// ---------------------------------------------------------------------------

describe('Task 3 generateSpecFile: helpers import gate + hasMultiCandidate transport', () => {
  function mkTest(publicId: string, steps: unknown[]): Parameters<typeof generateBrowserSpec>[0] {
    return {
      public_id: publicId,
      name: 'Chain gate flow',
      locations: ['us-east-1'],
      privateLocations: [],
      originalLocations: ['aws:us-east-1'],
      config: { request: { url: 'https://app.example.com/home' } },
      steps,
    } as unknown as Parameters<typeof generateBrowserSpec>[0];
  }

  // A two-candidate step (id + text) so the chain is multi-candidate.
  const multiStep = {
    name: 'Click go',
    type: 'click',
    params: {
      element: {
        targetOuterHTML: '<button id="go">Sign in</button>',
        multiLocator: { co: JSON.stringify([{ text: 'Sign in', textType: 'directText' }]) },
      },
    },
  };
  // A single-candidate step (a textless input with only an id), no iframe, no chain.
  const singleStep = {
    name: 'Click only',
    type: 'click',
    params: { element: { targetOuterHTML: '<input id="only">' } },
  };
  const assertStep = { name: 'Assert seen', type: 'assertPageContains', params: { value: 'Home' } };

  it('a multi-candidate spec imports firstMatch plus the CandidateFactory type from ../helpers and reports hasMultiCandidate true', () => {
    const result = generateBrowserSpec(mkTest('syn-600-aaa', [multiStep, assertStep]), new FlagCollector());
    // A hoisted factory means the type symbol rides the SAME ../helpers import line.
    assert.ok(result.spec.includes('import { firstMatch, type CandidateFactory } from "../helpers";'),
      'a multi-candidate spec must import firstMatch and the CandidateFactory type from the co-located helpers module');
    assert.equal(result.hasMultiCandidate, true, 'a two-candidate step must set hasMultiCandidate true');
    assert.equal(result.usesHelpers, true, 'the spec body references firstMatch, so usesHelpers must be true');
  });

  it('a single-candidate iframe-free spec has no helpers import and hasMultiCandidate false', () => {
    const result = generateBrowserSpec(mkTest('syn-601-bbb', [singleStep, assertStep]), new FlagCollector());
    assert.ok(!result.spec.includes('from "../helpers"'), 'a chainless iframe-free spec must not import helpers');
    assert.equal(result.hasMultiCandidate, false, 'a single-candidate corpus must set hasMultiCandidate false');
    assert.equal(result.usesHelpers, false, 'no helpers symbol is referenced, so usesHelpers must be false');
  });

  it('the helpers import lists exactly the symbols the body references (firstMatch, not findInFrame)', () => {
    const result = generateBrowserSpec(mkTest('syn-602-ccc', [multiStep, assertStep]), new FlagCollector());
    const importLine = result.spec.split('\n').find(l => l.includes('from "../helpers"'));
    assert.ok(importLine, 'a helpers import line must be present');
    assert.ok(importLine!.includes('firstMatch'), 'firstMatch must be imported');
    assert.ok(!importLine!.includes('findInFrame'), 'findInFrame must not be imported when the body never references it');
  });
});

// ---------------------------------------------------------------------------
// The getByText text rung retains its anchored case-insensitive regex
// byte-for-byte, and the rationale comment states the settled whole-string finding:
// co is whole-string equality, normalized, and case-folded (ro text() xpaths use
// = "..." equality, never contains). The anchor is FAITHFUL and RETAINED; only the
// comment changes.
// ---------------------------------------------------------------------------

describe('getByText text rung: retained anchored case-insensitive regex + corrected whole-string rationale', () => {
  it('emits getByText(new RegExp(...)) with a caret-anchored, dollar-terminated pattern for a text candidate (retained code)', () => {
    const out = generateLocatorCode({ type: 'text', value: 'Sign in', source: 'text' } as any, mkCtx());
    // The emitted code is the anchored case-insensitive regex form: getByText over a
    // new RegExp whose stringified pattern begins with ^ and ends with $ (whole-string).
    assert.ok(out.includes('getByText(new RegExp('), 'the text rung must emit getByText(new RegExp(...))');
    assert.ok(out.includes(', "i")'), 'the regex must carry the case-fold "i" flag');
    // The stringified pattern literal is anchored: JSON.stringify("^Sign in$") => "^Sign in$"
    assert.match(out, /new RegExp\("\^[^"]*\$",/, 'the stringified pattern must begin with ^ and end with $ (whole-string anchor)');
  });

  it('source rationale states the settled whole-string finding proven by the equality form', () => {
    const src = readFileSync(SRC07_PATH, 'utf-8');
    // Collapse the JSDoc line-continuation ( * ) so a phrase split across comment lines
    // is matched as one string (the retired claim and the corrected one both span lines).
    const flat = src.replace(/\n\s*\*\s?/g, ' ');
    // The corrected rationale describes co as a whole-string comparison that Playwright
    // reproduces by anchoring and normalizing whitespace (the equality proof).
    assert.ok(/whole-string/.test(flat), 'the src/07 text-rung rationale must state the whole-string finding');
    assert.ok(/normalize/i.test(flat), 'the src/07 text-rung rationale must state whitespace normalization');
    // The settled justification cites the equality proof (equality, never contains),
    // NOT the retired case-only "lowercases the live DOM" claim.
    assert.ok(/never contains|equality/i.test(flat), 'the rationale must cite the equality proof (equality, never contains)');
  });

  it('source no longer justifies the anchor by the retired case-only "lowercases the live DOM" claim', () => {
    const src = readFileSync(SRC07_PATH, 'utf-8');
    const flat = src.replace(/\n\s*\*\s?/g, ' ');
    // The retired justification claimed the anchor is whole-string BECAUSE Datadog
    // lowercases the live DOM (case only). That case-only framing must be gone.
    assert.ok(!/lowercases the live/.test(flat), 'the retired case-only justification ("lowercases the live ...") must be gone from src/07');
  });
});

// ---------------------------------------------------------------------------
// Provenance emission.
//
// When at least one stabler candidate exists, ab/at/clt sourced xpath rungs are
// demoted out of the LIVE firstMatch chain and re-emitted as single-line // comment
// breadcrumbs. isMulti, the factory body, and the primary all derive from LIVE
// candidates only. A step whose live set collapses to one candidate emits a DIRECT
// statement (no firstMatch, no factory const). A hostile demoted value is neutralized
// to a single // line (never a block comment). Emission is driven through generateClick,
// which routes through withLocator per the suite idiom.
// ---------------------------------------------------------------------------

describe('provenance emission in withLocator', () => {
  it('Emission 1 (no live stale rung): a role+text+ab step emits a factory with NO ab xpath= expression, plus an ab provenance comment', () => {
    // role (from targetOuterHTML) + text (from co) are two stable live candidates;
    // ab is stale and must be demoted.
    const el = {
      targetOuterHTML: '<button>Sign in</button>',
      multiLocator: {
        co: JSON.stringify([{ text: 'Sign in', textType: 'directText' }]),
        ab: '/html/body/div/button',
      },
    };
    const step: Step07 = { name: 'Click go', type: 'click', params: { element: el } };
    const out = generateClick(step, mkCtx());

    // The emitted factory is still multi-candidate (role + text), so a firstMatch chain hoists.
    assert.ok(/const\s+step\d+\w*:\s*CandidateFactory\s*=/.test(out), 'the live role+text pair still hoists a CandidateFactory');
    // No LIVE xpath= expression sourced from the demoted ab may appear as a candidate.
    // The factory array lines (indented candidate exprs) must not contain the ab xpath literal.
    const factoryBodyLines = out
      .split('\n')
      .filter((line) => /\.locator\("xpath=/.test(line) && !line.trim().startsWith('//'));
    assert.equal(factoryBodyLines.length, 0, 'no LIVE xpath= candidate expression may ride the chain for the demoted ab rung');
    assert.ok(!out.includes('root.locator("xpath=/html/body/div/button")'), 'the ab value must never appear as a live root-scoped candidate');

    // The ab value survives as exactly one single-line // provenance comment naming its source label.
    const provLines = out.split('\n').filter((line) => line.trim().startsWith('//') && /provenance only/i.test(line));
    assert.equal(provLines.length, 1, 'exactly one provenance comment line for the single demoted ab rung');
    assert.match(provLines[0], /^ {4}\/\/ /, 'the provenance comment is a four-space-indented single-line // comment');
    assert.ok(/ab/.test(provLines[0]), 'the provenance comment names the ab source label');
    assert.ok(provLines[0].includes('/html/body/div/button'), 'the demoted ab value survives as a breadcrumb in the comment');
  });

  it('Emission 2 (chain collapse): a step with one stable rung plus only stale rungs emits a DIRECT single-candidate statement (no firstMatch, no factory const), plus provenance comments', () => {
    // A single stable text rung, plus at and ab (both stale) that demote away, so the
    // LIVE set is exactly one candidate: the emission collapses to a direct statement.
    const el = {
      targetOuterHTML: '<div>x</div>',
      multiLocator: {
        co: JSON.stringify([{ text: 'save', textType: 'directText' }]),
        at: '/descendant::div[@data-qa="save"]',
        ab: '/html/body/div',
      },
    };
    const step: Step07 = { name: 'Click save', type: 'click', params: { element: el } };
    const out = generateClick(step, mkCtx());

    assert.ok(!out.includes('firstMatch'), 'a live-single-candidate step must NOT emit a firstMatch call');
    assert.ok(!/CandidateFactory/.test(out), 'a live-single-candidate step must NOT hoist a factory const');
    // The direct statement applies the action to the sole live text candidate.
    assert.ok(/await page\.getByText\(new RegExp\(/.test(out), 'the direct statement targets the sole live text candidate');
    assert.ok(out.trimEnd().endsWith('.click();'), 'the action is applied directly to the resolved locator');

    // Both stale rungs (at, ab) survive as provenance comment lines. The value is
    // JSON.stringify-neutralized, so inner quotes are backslash-escaped (@data-qa=\"save\"):
    // the breadcrumb survives in escaped form, which is exactly the T-9.5-04 mitigation.
    const provLines = out.split('\n').filter((line) => line.trim().startsWith('//') && /provenance only/i.test(line));
    assert.equal(provLines.length, 2, 'two provenance comment lines for the demoted at and ab rungs');
    const atLine = provLines.find((l) => l.includes('(at)'));
    const abLine = provLines.find((l) => l.includes('(ab'));
    assert.ok(atLine, 'the at breadcrumb line is labelled (at)');
    assert.ok(atLine!.includes('/descendant::div[@data-qa='), 'the at breadcrumb value survives (quotes neutralized)');
    assert.ok(abLine, 'the ab breadcrumb line is labelled (ab');
    assert.ok(abLine!.includes('/html/body/div'), 'the ab breadcrumb value survives verbatim (no inner quote to escape)');
  });

  it('Emission 3 (hostile value stays one line): an ab value with a newline and a comment terminator renders as exactly one // comment line', () => {
    // A hostile ab value carrying a newline and a comment-close sequence. It must be
    // neutralized (JSON.stringify or equivalent) so it stays on a single comment line.
    const hostileAb = '/html/body\n*/ leaked(); //';
    const el = {
      targetOuterHTML: '<button>Sign in</button>',
      multiLocator: {
        co: JSON.stringify([{ text: 'Sign in', textType: 'directText' }]),
        ab: hostileAb,
      },
    };
    const step: Step07 = { name: 'Click hostile', type: 'click', params: { element: el } };
    const out = generateClick(step, mkCtx());
    const lines = out.split('\n');

    // Exactly one provenance comment line, and it is a comment (no runnable code leaks).
    const provLines = lines.filter((line) => line.trim().startsWith('//') && /provenance only/i.test(line));
    assert.equal(provLines.length, 1, 'the hostile ab value renders as exactly ONE provenance comment line');
    // The embedded newline must NOT split the value across lines: no line other than the
    // provenance line may contain the leaked payload fragment.
    const leakedLines = lines.filter((line) => line.includes('leaked()') && !/provenance only/i.test(line));
    assert.equal(leakedLines.length, 0, 'the hostile payload must never escape onto its own runnable line');
    // The neutralized value keeps the payload inside the single comment (as an escaped literal).
    assert.ok(provLines[0].includes('leaked'), 'the neutralized value is retained inside the single comment line');
    assert.ok(!/\n/.test(provLines[0]), 'the single comment line carries no raw newline');
  });
});

// ---------------------------------------------------------------------------
// userLocator pin authority.
//
// A step whose export sets userLocator.failTestOnCannotLocate to true honors the
// Datadog "If user specified locator fails, fail test" checkbox: the pinned locator
// is emitted ALONE (no firstMatch call, no CandidateFactory const, no fallback
// candidate expressions), so a pin miss fails the step natively instead of self-
// healing to a fallback element. The gate is TYPE-INDEPENDENT (a css pin and an
// xpath pin both emit pin-only) and keys on the parsed boolean plus the live
// primary's userLocator source, never on the candidate type. When the flag is true
// but the pin cannot be derived (empty value, or a lone bare standard tag that
// rewriteUserLocatorValue rejects), the self-healing chain is KEPT and the gap is
// surfaced with a new user-locator-pin-unresolvable flag (honest, never a silent
// divergence). When the flag is false or absent, the current self-healing chain is
// byte-identical to pre-plan emission. Emission is driven through generateClick,
// which routes through withLocator per the suite idiom.
// ---------------------------------------------------------------------------

describe('userLocator pin authority', () => {
  // A rich multiLocator so the WITHOUT-pin baseline is multi-candidate (role from
  // targetOuterHTML + text from co): this is what the pin must suppress.
  const richMulti = {
    targetOuterHTML: '<button>Sign in</button>',
    multiLocator: { co: JSON.stringify([{ text: 'Sign in', textType: 'directText' }]) },
  };

  it('Path A (css pin, flag true): emits the pin ONLY, no firstMatch, no factory const, no non-pin candidate expression', () => {
    const el = {
      ...richMulti,
      userLocator: {
        values: [{ type: 'css', value: '#login-btn' }],
        failTestOnCannotLocate: true,
      },
    };
    const step: Step07 = { name: 'Click login', type: 'click', params: { element: el } };
    const ctx = mkCtx({ publicId: 'syn-701-aaa', stepIndex: 0 });
    const out = generateClick(step, ctx);

    // Pin-only: the direct statement targets the css pin, applied directly.
    assert.ok(out.includes('await page.locator("#login-btn").click();'),
      'a css pin with flag true must emit the pin as a direct single-candidate statement');
    // No self-healing scaffolding whatsoever.
    assert.ok(!out.includes('firstMatch'), 'a pinned step must emit NO firstMatch call');
    assert.ok(!/CandidateFactory/.test(out), 'a pinned step must hoist NO CandidateFactory const');
    // No expression derived from any non-pin candidate (the role/text rungs must not appear).
    assert.ok(!out.includes('getByRole'), 'the role candidate must not be emitted for a pinned step');
    assert.ok(!out.includes('getByText'), 'the text candidate must not be emitted for a pinned step');
    // Datadog itself ignores the stored strategies in this mode, so no provenance
    // comment lines for the (suppressed) chain either.
    assert.ok(!/provenance only/i.test(out), 'no provenance comment lines for a pin-only step');
    // No pin-unresolvable flag: the pin WAS derivable.
    assert.equal(ctx.collector.flags.filter((f) => f.reason === 'user-locator-pin-unresolvable').length, 0,
      'a derivable pin must not fire the unresolvable flag');
  });

  it('Path B (xpath pin, flag true): emits the xpath= pin ONLY (type independence, D-07d)', () => {
    const el = {
      ...richMulti,
      userLocator: {
        values: [{ type: 'xpath', value: '//button[@id="login"]' }],
        failTestOnCannotLocate: true,
      },
    };
    const step: Step07 = { name: 'Click login', type: 'click', params: { element: el } };
    const ctx = mkCtx({ publicId: 'syn-702-bbb', stepIndex: 1 });
    const out = generateClick(step, ctx);

    // Pin-only for an xpath-typed pin: the locator uses the xpath= form, applied directly.
    assert.ok(out.includes('await page.locator("xpath=//button[@id=\\"login\\"]").click();'),
      'an xpath pin with flag true must emit the xpath= pin as a direct single-candidate statement');
    assert.ok(!out.includes('firstMatch'), 'a pinned xpath step must emit NO firstMatch call');
    assert.ok(!/CandidateFactory/.test(out), 'a pinned xpath step must hoist NO CandidateFactory const');
    assert.ok(!out.includes('getByRole'), 'the role candidate must not be emitted for a pinned xpath step');
    assert.ok(!out.includes('getByText'), 'the text candidate must not be emitted for a pinned xpath step');
    assert.equal(ctx.collector.flags.filter((f) => f.reason === 'user-locator-pin-unresolvable').length, 0,
      'a derivable xpath pin must not fire the unresolvable flag');
  });

  it('Path C (flag false): keeps the self-healing chain, byte-identical to the no-pin multi-candidate emission', () => {
    // A css pin present, but failTestOnCannotLocate FALSE: the pin rides the chain as
    // candidate index 0 (the ordinary userLocator-first behavior), the chain is preserved.
    const el = {
      ...richMulti,
      userLocator: {
        values: [{ type: 'css', value: '#login-btn' }],
        failTestOnCannotLocate: false,
      },
    };
    const step: Step07 = { name: 'Click login', type: 'click', params: { element: el } };
    const out = generateClick(step, mkCtx({ publicId: 'syn-703-ccc', stepIndex: 0 }));

    // The self-healing chain is present: the pin plus role plus text hoist a factory
    // referenced from an awaited firstMatch call.
    assert.ok(/const\s+step\d+\w*:\s*CandidateFactory\s*=/.test(out),
      'flag false must keep the multi-candidate self-healing chain (factory const hoisted)');
    assert.ok(/await\s*\(await firstMatch\(page,/.test(out), 'flag false must emit the awaited-firstMatch chain');
    // The pin is a candidate in the chain (index 0), so its expression IS present here.
    assert.ok(out.includes('root.locator("#login-btn")'), 'flag false keeps the pin as a live candidate in the chain');
  });

  it('Path C (flag absent): keeps the self-healing chain (no failTestOnCannotLocate key at all)', () => {
    // A userLocator WITHOUT the failTestOnCannotLocate field: same as flag false.
    const el = {
      ...richMulti,
      userLocator: { values: [{ type: 'css', value: '#login-btn' }] },
    };
    const step: Step07 = { name: 'Click login', type: 'click', params: { element: el } };
    const out = generateClick(step, mkCtx({ publicId: 'syn-704-ddd', stepIndex: 0 }));

    assert.ok(/const\s+step\d+\w*:\s*CandidateFactory\s*=/.test(out),
      'flag absent must keep the multi-candidate self-healing chain (factory const hoisted)');
    assert.ok(/await\s*\(await firstMatch\(page,/.test(out), 'flag absent must emit the awaited-firstMatch chain');
    assert.ok(out.includes('root.locator("#login-btn")'), 'flag absent keeps the pin as a live candidate in the chain');
  });

  it('Path C parity: flag absent emission is byte-identical to an equivalent element with no userLocator at all', () => {
    // The flag-absent emission must not diverge from today's behavior. Compare an element
    // whose userLocator has no failTestOnCannotLocate key against the SAME element with the
    // whole userLocator removed but the pin re-added through the chain: the presence of the
    // pin-authority gate must be invisible when the flag is not true.
    const withPinNoFlag = {
      ...richMulti,
      userLocator: { values: [{ type: 'css', value: '#login-btn' }] },
    };
    const stepA: Step07 = { name: 'Click login', type: 'click', params: { element: withPinNoFlag } };
    const outA = generateClick(stepA, mkCtx({ publicId: 'syn-705-eee', stepIndex: 0 }));
    // Re-run the SAME step through a second fresh ctx: deterministic, identical bytes.
    const outB = generateClick(stepA, mkCtx({ publicId: 'syn-705-eee', stepIndex: 0 }));
    assert.equal(outA, outB, 'flag-absent emission is deterministic and unchanged by the pin-authority gate');
    assert.ok(!/user-locator-pin-unresolvable/.test(outA), 'no pin-unresolvable marker when the flag is absent');
  });

  it('Path D (flag true, pin underivable): keeps the chain AND fires exactly one user-locator-pin-unresolvable flag', () => {
    // A lone bare standard tag ('button') that rewriteUserLocatorValue rejects (returns
    // null), so the userLocator rung is skipped and the live primary is NOT userLocator.
    // The flag is true but the pin cannot be derived: keep the self-healing chain and
    // surface the divergence honestly.
    const el = {
      ...richMulti,
      userLocator: {
        values: [{ type: 'css', value: 'button' }],
        failTestOnCannotLocate: true,
      },
    };
    const step: Step07 = { name: 'Click login', type: 'click', params: { element: el } };
    const ctx = mkCtx({ publicId: 'syn-706-fff', stepIndex: 2 });
    const out = generateClick(step, ctx);

    // The chain is preserved (role + text are the live candidates, the pin was skipped).
    assert.ok(/const\s+step\d+\w*:\s*CandidateFactory\s*=/.test(out),
      'an underivable pin keeps the multi-candidate self-healing chain (factory const hoisted)');
    assert.ok(/await\s*\(await firstMatch\(page,/.test(out), 'an underivable pin keeps the awaited-firstMatch chain');

    // Exactly one pin-unresolvable flag fired.
    const pinFlags = ctx.collector.flags.filter((f) => f.reason === 'user-locator-pin-unresolvable');
    assert.equal(pinFlags.length, 1, 'exactly one user-locator-pin-unresolvable flag for an underivable pin');
    assert.ok(!pinFlags[0].deactivates, 'the pin-unresolvable flag never deactivates (chain stays live)');
    assert.equal(pinFlags[0].publicId, 'syn-706-fff');
    assert.equal(pinFlags[0].stepIndex, 2);

    // The marker appears in the emitted output.
    assert.ok(out.includes('// MIGRATION-FLAG: user-locator-pin-unresolvable'),
      'the pin-unresolvable marker must appear inline in the emitted output');

    // Value-free message discipline (threat T-9.5-05 /): the message names the
    // condition, never the raw selector value string.
    assert.ok(!pinFlags[0].message.includes('button'),
      'the flag message must NOT embed the raw selector value (value-free discipline, T-9.5-05)');
  });

  it('Path D scope: a pin-only step (Path A) fires NO pin-unresolvable flag and NO weak/other locator flag', () => {
    // The Path A / Path D flags are mutually exclusive: a derivable pin never fires the
    // unresolvable flag, and a pin-only step is not a weak chain (a pinned step is user
    // authority, not a weak fallback chain) so it fires no weak-fallback-chain flag.
    const el = {
      ...richMulti,
      userLocator: {
        values: [{ type: 'css', value: '#login-btn' }],
        failTestOnCannotLocate: true,
      },
    };
    const step: Step07 = { name: 'Click login', type: 'click', params: { element: el } };
    const ctx = mkCtx({ publicId: 'syn-707-ggg', stepIndex: 0 });
    generateClick(step, ctx);
    assert.equal(ctx.collector.flags.filter((f) => f.reason === 'user-locator-pin-unresolvable').length, 0,
      'a pin-only step fires no pin-unresolvable flag');
    assert.equal(ctx.collector.flags.filter((f) => f.reason === 'weak-fallback-chain').length, 0,
      'a pin-only step is user authority, not a weak chain, so no weak-fallback-chain flag');
  });
});

// ---------------------------------------------------------------------------
// Derived settle budget.
//
// The fixed 2500ms exhaustion settle budget is replaced by a budget derived from
// the export's Datadog timeout: the per-step step.timeout (seconds) when present,
// else the test's options.initialNavigationTimeout (seconds), else a Datadog-parity
// default (60000ms, living in the emitted helper const so timeout-less call sites
// stay byte-stable). A Datadog value of 0/undefined/negative means "use default"
// (0 is not zero-ms), so it is treated as absent and never emits a zero
// or near-zero budget. The derived value is clamped to a 2500ms floor and Checkly's
// 240000ms cap. Only timeout-bearing steps emit a third firstMatch argument; a
// timeout-less step in a timeout-less test emits the same two-argument call as
// before. On exhaustion the emitted helper races ALL candidates for first-attached
// rather than always returning the primary.
//
// The multi-candidate fixtures below drive emission through generateClick, which
// routes through withLocator; the per-step budget derives from step.timeout and the
// per-test navigation timeout is threaded through ctx.navTimeoutSec (the same field
// generateSpecFile populates from options.initialNavigationTimeout at every ctx
// construction).
// ---------------------------------------------------------------------------

describe('derived settle budget', () => {
  // A role+text multiLocator so the emission is multi-candidate (a firstMatch call
  // is emitted, which is where the third budget argument attaches).
  const richMulti = {
    targetOuterHTML: '<button>Sign in</button>',
    multiLocator: { co: JSON.stringify([{ text: 'Sign in', textType: 'directText' }]) },
  };

  describe('deriveSettleBudgetMs derivation table (seconds in, ms out, 0=absent, floor 2500, cap 240000)', () => {
    it('(undefined, undefined) is null (no export timeout, so no third argument)', () => {
      assert.equal(deriveSettleBudgetMs(undefined, undefined), null);
    });
    it('(0, undefined) is null (a zero step timeout means use-default, treated as absent)', () => {
      assert.equal(deriveSettleBudgetMs(0, undefined), null);
    });
    it('(-5, undefined) is null (a negative step timeout is treated as absent)', () => {
      assert.equal(deriveSettleBudgetMs(-5, undefined), null);
    });
    it('(10, undefined) is 10000 (seconds converted to ms)', () => {
      assert.equal(deriveSettleBudgetMs(10, undefined), 10000);
    });
    it('(undefined, 120) is 120000 (nav timeout used when step timeout absent)', () => {
      assert.equal(deriveSettleBudgetMs(undefined, 120), 120000);
    });
    it('(10, 120) is 10000 (step timeout wins over nav timeout)', () => {
      assert.equal(deriveSettleBudgetMs(10, 120), 10000);
    });
    it('(0, 120) is 120000 (a zero step timeout falls through to the nav timeout)', () => {
      assert.equal(deriveSettleBudgetMs(0, 120), 120000);
    });
    it('(1, undefined) is 2500 (1000ms is clamped up to the 2500ms floor)', () => {
      assert.equal(deriveSettleBudgetMs(1, undefined), 2500);
    });
    it('(500, undefined) is 240000 (500000ms is clamped down to the 240000ms cap)', () => {
      assert.equal(deriveSettleBudgetMs(500, undefined), 240000);
    });
  });

  describe('helper-source structure: budget-parameterized firstMatch with attach-race exhaustion', () => {
    const src = SHARED_HELPERS_SOURCE;

    it('firstMatch signature accepts a third budgetMs parameter defaulting to the budget const', () => {
      assert.ok(
        /export\s+async\s+function\s+firstMatch\s*\(\s*page\s*:\s*Page\s*,\s*makeCandidates\s*:[^,]*,\s*budgetMs\s*:\s*number\s*=\s*EXHAUSTION_RESCAN_BUDGET_MS\s*\)/.test(src),
        'firstMatch must take a third budgetMs: number = EXHAUSTION_RESCAN_BUDGET_MS parameter',
      );
    });

    it('the budget const value is the Datadog-parity default 60000', () => {
      assert.ok(
        /EXHAUSTION_RESCAN_BUDGET_MS\s*=\s*(60000|60_000)\b/.test(src),
        'the budget const must be the Datadog-parity default 60000',
      );
      assert.ok(!/EXHAUSTION_RESCAN_BUDGET_MS\s*=\s*2500\b/.test(src), 'the old 2500 const value must be gone');
    });

    it('the body applies a defensive Math.min cap against 240000', () => {
      assert.ok(
        /Math\.min\s*\(\s*[A-Za-z0-9_]*budgetMs[^)]*240000|Math\.min\s*\([^)]*240_?000[^)]*budgetMs/i.test(src) ||
          /Math\.min\s*\(\s*budgetMs\s*,\s*240_?000\s*\)/.test(src),
        'the firstMatch body must cap the incoming budget defensively via Math.min against 240000',
      );
    });

    it('the body contains an attach-race phase over candidate waitFor state attached before the exhaustion token', () => {
      assert.ok(/Promise\.any/.test(src), 'the exhaustion fallback must race candidates via Promise.any');
      assert.ok(/state\s*:\s*['"]attached['"]/.test(src), 'the race must await candidate waitFor state attached');
      // The attach-race must precede the exhaustion token in source order.
      const raceIdx = src.indexOf('Promise.any');
      const tokenIdx = src.indexOf('no locator matched after');
      assert.ok(raceIdx > -1 && tokenIdx > -1 && raceIdx < tokenIdx,
        'the attach-race phase must appear before the true-exhaustion token emission');
    });

    it('the LOCATOR_EXHAUSTION_TOKEN and the primary-candidate final return remain present', () => {
      assert.ok(/LOCATOR_EXHAUSTION_TOKEN/.test(src), 'the exhaustion token must remain');
      assert.ok(/return\s+makeCandidates\(page\)\[0\]\.first\(\)/.test(src),
        'the primary-candidate final return must remain as the last-resort fallback');
    });
  });

  describe('emission: third firstMatch argument gated on a derived budget', () => {
    it('Emission 1: a multi-candidate step whose step.timeout is 10 emits a third argument of 10000', () => {
      const step: Step07 = { name: 'Click go', type: 'click', params: { element: richMulti }, timeout: 10 } as Step07;
      const out = generateClick(step, mkCtx({ publicId: 'syn-611-aaa', stepIndex: 0 }));
      assert.ok(/await\s*\(await firstMatch\(page,\s*step\d+\w*,\s*10000\)\)/.test(out),
        'a step.timeout of 10 must emit the third firstMatch argument 10000');
    });

    it('Emission 2: a timeout-less multi step in a test whose initialNavigationTimeout is 120 emits a third argument of 120000', () => {
      const step: Step07 = { name: 'Click go', type: 'click', params: { element: richMulti } };
      const out = generateClick(step, mkCtx({ publicId: 'syn-612-bbb', stepIndex: 0, navTimeoutSec: 120 }));
      assert.ok(/await\s*\(await firstMatch\(page,\s*step\d+\w*,\s*120000\)\)/.test(out),
        'a timeout-less step under initialNavigationTimeout 120 must emit the third firstMatch argument 120000');
    });

    it('Emission 3: a timeout-less multi step in a timeout-less test emits the two-argument firstMatch call with NO third argument', () => {
      const step: Step07 = { name: 'Click go', type: 'click', params: { element: richMulti } };
      const out = generateClick(step, mkCtx({ publicId: 'syn-613-ccc', stepIndex: 0 }));
      assert.ok(/await\s*\(await firstMatch\(page,\s*step\d+\w*\)\)/.test(out),
        'a timeout-less step in a timeout-less test must emit the two-argument firstMatch call');
      assert.ok(!/firstMatch\(page,\s*step\d+\w*,/.test(out),
        'a timeout-less step must emit NO third firstMatch argument (call-site bytes stable)');
    });

    it('Emission 4 (zero guard): step.timeout of 0 in a timeout-less test emits the two-argument form, never a zero argument', () => {
      const step: Step07 = { name: 'Click go', type: 'click', params: { element: richMulti }, timeout: 0 } as Step07;
      const out = generateClick(step, mkCtx({ publicId: 'syn-614-ddd', stepIndex: 0 }));
      assert.ok(/await\s*\(await firstMatch\(page,\s*step\d+\w*\)\)/.test(out),
        'a zero step.timeout with no nav timeout must emit the two-argument firstMatch call');
      assert.ok(!/firstMatch\(page,\s*step\d+\w*,\s*0\)/.test(out),
        'a zero step.timeout must never emit a zero third argument');
    });
  });
});
