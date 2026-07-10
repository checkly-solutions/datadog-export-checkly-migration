/**
 * Generation tests for the folded iframe emission path and the tightened SPA
 * classifier (Phase 8, plan 08-04).
 *
 * Task 1 (IFR-01 + IFR-03): the second self-healing mechanism is retired. The
 * legacy frame-scanning helper (findInFrame) is gone from the emitted helpers
 * module and from src/07; the selector-string bridge (extractLocatorSelector)
 * is deleted; and generateIframeStepCode is now TOTAL: it returns a non-null
 * string for every known step type plus unknown, emitting a provenance comment
 * followed by the same statement the default path emits (the firstMatch chain
 * already searches page.frames()), so an iframe-classified step and a
 * main-page step share ONE locator mechanism.
 *
 * Task 2 (IFR-02): analyzeStepsForIframes no longer misclassifies post-auth SPA
 * client navigation as an iframe boundary; it uses an interleaving signal against
 * the maintained current page context (not the stale start-url segment).
 *
 * Inputs are inline synthetic BrowserStep / BrowserTest objects with only
 * invented example.com values; no fixture change. Offline, deterministic, no
 * network, no wall-clock, no randomness.
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateIframeStepCode,
  generateStepCodeDefault,
  analyzeStepsForIframes,
  SHARED_HELPERS_SOURCE,
  generateSpecFile as generateBrowserSpec,
  type StepFlagContext,
} from '../../src/07-generate-browser-specs.ts';
import { FlagCollector } from '../../src/shared/migration-flags.ts';

type Step = Parameters<typeof generateStepCodeDefault>[0];

/** Fresh per-step flag context; mirrors the browser.test.ts idiom. */
function mkCtx(overrides: Partial<StepFlagContext> = {}): StepFlagContext {
  return { collector: new FlagCollector(), publicId: 'syn-000-tst', stepIndex: 0, ...overrides };
}

/** The iframe-provenance comment slot the folded emitter always prepends. */
const PROVENANCE_MARKER = '// May be inside an iframe';

// ---------------------------------------------------------------------------
// Task 1: dispatch totality (IFR-03): every step type returns a non-null string
// ---------------------------------------------------------------------------

describe('plan 08-04 Task 1 generateIframeStepCode: total dispatch (IFR-03)', () => {
  // A synthetic step for each known type plus an unknown type. Element-bearing
  // steps get a simple id locator so the folded emission resolves a candidate.
  const withElement = { targetOuterHTML: '<input id="user">' };
  const cases: Array<{ type: string; step: Step }> = [
    { type: 'goToUrl', step: { type: 'goToUrl', params: { value: 'https://app.example.com/home' } } },
    { type: 'typeText', step: { type: 'typeText', params: { value: 'hi', element: withElement } } },
    { type: 'click', step: { type: 'click', params: { element: withElement } } },
    { type: 'hover', step: { type: 'hover', params: { element: withElement } } },
    { type: 'pressKey', step: { type: 'pressKey', params: { value: 'Enter' } } },
    { type: 'selectOption', step: { type: 'selectOption', params: { value: 'a', element: withElement } } },
    { type: 'wait', step: { type: 'wait', params: { value: '3' } } },
    { type: 'refresh', step: { type: 'refresh' } },
    { type: 'scroll', step: { type: 'scroll', params: { x: 0, y: 200 } } },
    { type: 'assertElementPresent', step: { type: 'assertElementPresent', params: { element: withElement } } },
    { type: 'assertElementContent', step: { type: 'assertElementContent', params: { check: 'contains', value: 'X', element: withElement } } },
    { type: 'assertPageContains', step: { type: 'assertPageContains', params: { value: 'X' } } },
    { type: 'assertCurrentUrl', step: { type: 'assertCurrentUrl', params: { check: 'contains', value: '/home' } } },
    { type: 'runApiTest', step: { type: 'runApiTest', params: { request: { config: { request: { method: 'GET', url: 'https://api.example.com/v1/ping' } } } } } },
    { type: 'playSubTest', step: { type: 'playSubTest', params: { subtestPublicId: 'syn-sub-001' } } },
    { type: 'someUnknownFutureType', step: { type: 'someUnknownFutureType' } },
  ];

  it('iterates at least 15 step types plus an unknown and every return is a non-null, non-empty string', () => {
    assert.ok(cases.length >= 16, 'the totality case list must cover 15+ known types plus an unknown');
    for (const { type, step } of cases) {
      const out = generateIframeStepCode(step, mkCtx());
      assert.equal(typeof out, 'string', `generateIframeStepCode(${type}) must return a string, never null`);
      assert.ok((out as string).length > 0, `generateIframeStepCode(${type}) must return a non-empty string`);
    }
  });

  it('every emission begins with the iframe-provenance comment slot', () => {
    for (const { type, step } of cases) {
      const out = generateIframeStepCode(step, mkCtx()) as string;
      assert.ok(out.includes(PROVENANCE_MARKER), `generateIframeStepCode(${type}) must carry the iframe-provenance comment`);
    }
  });
});

// ---------------------------------------------------------------------------
// Task 1: element-step equivalence (iframe emission == default emission + comment)
// ---------------------------------------------------------------------------

describe('plan 08-04 Task 1 generateIframeStepCode: one mechanism (IFR-01)', () => {
  it('an iframe-classified multi-candidate click emits the SAME statement as the default path, modulo the provenance comment', () => {
    const step: Step = {
      name: 'Click ghost',
      type: 'click',
      params: {
        element: {
          // Two candidates (role + id) force a multi-candidate firstMatch chain,
          // proving the iframe path routes through the SAME chain, not findInFrame.
          targetOuterHTML: '<button id="edit-menu" aria-label="Edit">Edit</button>',
        },
      },
    };
    const defaultEmission = generateStepCodeDefault(step, mkCtx());
    const iframeEmission = generateIframeStepCode(step, mkCtx()) as string;

    // Strip the provenance comment line(s) from the iframe emission; the remainder
    // must equal the default-path emission byte for byte.
    const stripped = iframeEmission
      .split('\n')
      .filter((line) => !line.trim().startsWith(PROVENANCE_MARKER.trim()))
      .join('\n');
    assert.equal(stripped, defaultEmission, 'the iframe element-step emission must equal the default-path emission');
    assert.ok(/firstMatch\(page, step\d+/.test(iframeEmission), 'the iframe multi-candidate step must emit the hoisted firstMatch chain, not findInFrame');
  });

  it('a single-candidate iframe click emits the direct page.locator statement (never findInFrame)', () => {
    const step: Step = { name: 'Click edit', type: 'click', params: { element: { targetOuterHTML: '<div id="edit"></div>' } } };
    const iframeEmission = generateIframeStepCode(step, mkCtx()) as string;
    assert.ok(iframeEmission.includes('await page.locator("#edit").click();'), 'single-candidate iframe click must emit the direct statement');
    assert.ok(!iframeEmission.includes('findInFrame'), 'no iframe emission may reference the retired findInFrame helper');
  });
});

// ---------------------------------------------------------------------------
// Task 1: page-scope steps surface the design limitation (not silent)
// ---------------------------------------------------------------------------

describe('plan 08-04 Task 1 generateIframeStepCode: page-scope steps surface scope by design', () => {
  it('assertCurrentUrl inside an iframe context emits its default statement plus a page-scope disclosure comment', () => {
    const step: Step = { type: 'assertCurrentUrl', params: { check: 'contains', value: '/home' } };
    const out = generateIframeStepCode(step, mkCtx()) as string;
    const defaultEmission = generateStepCodeDefault(step, mkCtx());
    assert.ok(out.includes(defaultEmission), 'assertCurrentUrl must still emit its default page-scope statement');
    assert.ok(/page scope/i.test(out), 'assertCurrentUrl must disclose that it runs at page scope by design');
  });

  it('runApiTest inside an iframe context emits its default request plus a page-scope disclosure comment', () => {
    const step: Step = { type: 'runApiTest', params: { request: { config: { request: { method: 'GET', url: 'https://api.example.com/v1/ping' } } } } };
    const out = generateIframeStepCode(step, mkCtx()) as string;
    assert.ok(out.includes('page.request.get'), 'runApiTest must still emit its default request statement');
    assert.ok(/page scope/i.test(out), 'runApiTest must disclose that it runs at page scope by design');
  });

  it('a non-element page step (wait) inside an iframe context emits its default statement with the provenance comment', () => {
    const step: Step = { type: 'wait', params: { value: '3' } };
    const out = generateIframeStepCode(step, mkCtx()) as string;
    assert.ok(out.includes('await page.waitForTimeout(3000);'), 'wait must emit its default statement');
    assert.ok(out.includes(PROVENANCE_MARKER), 'wait must carry the provenance comment');
  });
});

// ---------------------------------------------------------------------------
// Task 1: unknown step type emits exactly one flag (no double emission)
// ---------------------------------------------------------------------------

describe('plan 08-04 Task 1 generateIframeStepCode: unknown type emits one flag', () => {
  it('an unknown step type records exactly one unsupported-step-type flag through the folded default path', () => {
    const step: Step = { name: 'Do something', type: 'someUnknownFutureType' };
    const ctx = mkCtx();
    const out = generateIframeStepCode(step, ctx) as string;
    const flags = ctx.collector.flags.filter((f) => f.reason === 'unsupported-step-type');
    assert.equal(flags.length, 1, 'exactly one unsupported-step-type flag must fire (no double emission)');
    assert.ok(out.includes('// MIGRATION-FLAG: unsupported-step-type'), 'the unsupported marker must appear in the emission');
    assert.ok(out.includes(PROVENANCE_MARKER), 'the unknown-type emission must still carry the provenance comment');
  });
});

// ---------------------------------------------------------------------------
// Task 1: negative assertions (legacy mechanism fully retired, IFR-01, T-8-04)
// ---------------------------------------------------------------------------

describe('plan 08-04 Task 1: the hang-capable frame API is gone (IFR-01, T-8-04)', () => {
  it('the emitted helpers source no longer exports findInFrame and contains no auto-waiting frameLocator call', () => {
    assert.ok(!/findInFrame/.test(SHARED_HELPERS_SOURCE), 'the helpers module must not export the retired findInFrame helper');
    assert.ok(!/frameLocator/.test(SHARED_HELPERS_SOURCE), 'the helpers module must contain no auto-waiting frameLocator call (the 120s-hang API)');
    assert.ok(/export\s+async\s+function\s+firstMatch\s*\(/.test(SHARED_HELPERS_SOURCE), 'firstMatch must remain the one exported locator mechanism');
  });

  it('a generated iframe spec references neither findInFrame nor frameLocator', () => {
    const test = {
      public_id: 'syn-804-frm',
      name: 'Iframe fold flow',
      locations: ['us-east-1'],
      privateLocations: [],
      originalLocations: ['aws:us-east-1'],
      config: { request: { url: 'https://app.example.com/home' } },
      steps: [
        { name: 'Open home', type: 'goToUrl', params: { value: 'https://app.example.com/home' } },
        {
          name: 'Click widget',
          type: 'click',
          params: {
            // Cross-origin element.url routes this step down the iframe path.
            element: {
              url: 'https://widgets.example.com/embed/panel',
              targetOuterHTML: '<button id="go" aria-label="Go">Go</button>',
            },
          },
        },
      ],
    };
    const { spec, hasIframes } = generateBrowserSpec(test as unknown as Parameters<typeof generateBrowserSpec>[0], new FlagCollector());
    assert.ok(hasIframes, 'the cross-origin element must route through the iframe path');
    assert.ok(!spec.includes('findInFrame'), 'the emitted iframe spec must not reference the retired findInFrame helper');
    assert.ok(!spec.includes('frameLocator'), 'the emitted iframe spec must not reference the auto-waiting frameLocator API');
    assert.ok(/firstMatch\(page, step\d+/.test(spec), 'the multi-candidate iframe step must emit the hoisted firstMatch chain');
    assert.ok(spec.includes(PROVENANCE_MARKER), 'the iframe step must carry its provenance comment');
  });

  it('threat T-8-01: a hostile provenance-bearing step with quote and newline characters emits a single-line-safe comment', () => {
    const step: Step = {
      name: 'Ghost "click"\ninjected',
      type: 'click',
      params: { element: { url: 'https://widgets.example.com/embed/panel', targetOuterHTML: '<div id="x"></div>' } },
    };
    const out = generateIframeStepCode(step, mkCtx()) as string;
    // The provenance comment lives on a single line; a raw newline from the step
    // name must never split the comment into a runnable line.
    const commentLines = out.split('\n').filter((l) => l.includes(PROVENANCE_MARKER));
    assert.equal(commentLines.length, 1, 'the provenance comment must occupy exactly one line');
  });
});

// ---------------------------------------------------------------------------
// Plan 09-03: both-paths parity for the new/changed assertion emitters. An
// iframe-classified assertPageLacks (ASRT-05) and assertElementPresent (ASRT-06)
// must emit the SAME assertion body as the main-page step (single dispatch, no
// second switch): the iframe emission equals the default emission modulo the
// provenance comment.
// ---------------------------------------------------------------------------

describe('plan 09-03 both-paths parity: assertPageLacks and assertElementPresent through the single dispatch', () => {
  it('an iframe-classified assertPageLacks emits the provenance comment plus the SAME not.toContainText body assertion (ASRT-05)', () => {
    const step: Step = { name: 'Assert gone', type: 'assertPageLacks', params: { value: 'Session expired' } };
    const defaultEmission = generateStepCodeDefault(step, mkCtx());
    const iframeEmission = generateIframeStepCode(step, mkCtx()) as string;
    assert.ok(iframeEmission.includes(PROVENANCE_MARKER), 'the iframe assertPageLacks must carry the provenance comment');
    assert.ok(
      iframeEmission.includes('await expect(page.locator("body")).not.toContainText("Session expired");'),
      'the iframe assertPageLacks must emit the same negative body assertion as the default path'
    );
    const stripped = iframeEmission
      .split('\n')
      .filter((line) => !line.trim().startsWith(PROVENANCE_MARKER.trim()))
      .join('\n');
    assert.equal(stripped, defaultEmission, 'the iframe assertPageLacks emission must equal the default-path emission');
  });

  it('an iframe-classified assertElementPresent emits the provenance comment plus toBeAttached (ASRT-06, single dispatch)', () => {
    const step: Step = { name: 'Assert widget', type: 'assertElementPresent', params: { element: { targetOuterHTML: '<div id="widget"></div>' } } };
    const defaultEmission = generateStepCodeDefault(step, mkCtx());
    const iframeEmission = generateIframeStepCode(step, mkCtx()) as string;
    assert.ok(iframeEmission.includes(PROVENANCE_MARKER), 'the iframe assertElementPresent must carry the provenance comment');
    assert.ok(
      iframeEmission.includes('await expect(page.locator("#widget")).toBeAttached();'),
      'the iframe assertElementPresent must emit attached-state presence, same as the default path'
    );
    const stripped = iframeEmission
      .split('\n')
      .filter((line) => !line.trim().startsWith(PROVENANCE_MARKER.trim()))
      .join('\n');
    assert.equal(stripped, defaultEmission, 'the iframe assertElementPresent emission must equal the default-path emission');
  });
});

// ---------------------------------------------------------------------------
// Task 2: tightened SPA-navigation classification (IFR-02)
// ---------------------------------------------------------------------------

describe('plan 08-04 Task 2 analyzeStepsForIframes: post-auth SPA navigation is not an iframe (IFR-02)', () => {
  const elStep = (url: string, name = 'act') => ({
    type: 'click',
    name,
    params: { element: { url, targetOuterHTML: '<div id="x"></div>' } },
  });

  it('navigation case: start on login segment, auth, then all steps on one NEW same-origin segment -> zero iframe entries', () => {
    const start = 'https://app.example.com/login/index';
    const steps = [
      { type: 'click', name: 'auth', params: { element: { url: 'https://login.example.com/authorize' } } },
      elStep('https://app.example.com/dashboard/overview', 's1'),
      elStep('https://app.example.com/dashboard/reports', 's2'),
      elStep('https://app.example.com/dashboard/settings', 's3'),
    ];
    const map = analyzeStepsForIframes(start, steps as unknown as Parameters<typeof analyzeStepsForIframes>[1]);
    assert.equal(map.size, 0, 'a post-auth SPA move to one new same-origin segment must NOT classify as iframe');
  });

  it('interleaving case: post-auth steps alternate main / divergent / main -> only the divergent step carries an iframe entry', () => {
    // The divergent segment ("admin") is deliberately NOT a known-iframe path
    // pattern (frames/embed/widget), so this exercises the rule-5 interleaving
    // classifier, not the rule-3 known-iframe shortcut.
    const start = 'https://app.example.com/login/index';
    const steps = [
      { type: 'click', name: 'auth', params: { element: { url: 'https://login.example.com/authorize' } } },
      elStep('https://app.example.com/dashboard/overview', 'main-a'),   // index 1: main context = dashboard
      elStep('https://app.example.com/admin/panel', 'divergent'),       // index 2: divergent segment (admin)
      elStep('https://app.example.com/dashboard/reports', 'main-b'),    // index 3: returns to dashboard (interleave)
    ];
    const map = analyzeStepsForIframes(start, steps as unknown as Parameters<typeof analyzeStepsForIframes>[1]);
    assert.ok(map.has(2), 'the divergent interleaved step must classify as iframe');
    assert.ok(!map.has(1), 'the first main-context step must not classify as iframe');
    assert.ok(!map.has(3), 'the returning main-context step must not classify as iframe');
  });

  it('known-iframe path patterns (frames/embed/widget path) still classify regardless of interleaving (precedence unchanged)', () => {
    const start = 'https://app.example.com/dashboard/home';
    const steps = [
      elStep('https://app.example.com/embed/chart', 'embedded'),
    ];
    const map = analyzeStepsForIframes(start, steps as unknown as Parameters<typeof analyzeStepsForIframes>[1]);
    assert.ok(map.has(0), 'a known /embed/ path must classify as iframe even with no interleaving');
  });

  it('cross-origin divergence still classifies as iframe (unchanged)', () => {
    const start = 'https://app.example.com/dashboard/home';
    const steps = [
      elStep('https://widgets.example.com/panel/main', 'cross'),
    ];
    const map = analyzeStepsForIframes(start, steps as unknown as Parameters<typeof analyzeStepsForIframes>[1]);
    assert.ok(map.has(0), 'a cross-origin element must still classify as iframe');
  });

  it('a goToUrl to the divergent segment before its element steps makes them plain navigation (no iframe entries)', () => {
    // "admin" is not a known-iframe path pattern, so classification is driven purely
    // by the goToUrl re-basing the context (rule-5/rule-6), not the rule-3 shortcut.
    const start = 'https://app.example.com/login/index';
    const steps = [
      { type: 'click', name: 'auth', params: { element: { url: 'https://login.example.com/authorize' } } },
      elStep('https://app.example.com/dashboard/overview', 'main-a'),
      { type: 'goToUrl', name: 'nav', params: { value: 'https://app.example.com/admin/panel' } },
      elStep('https://app.example.com/admin/detail', 'now-plain'),
    ];
    const map = analyzeStepsForIframes(start, steps as unknown as Parameters<typeof analyzeStepsForIframes>[1]);
    assert.equal(map.size, 0, 'an explicit goToUrl to the divergent segment must make its steps plain navigation');
  });
});

// ---------------------------------------------------------------------------
// Readability (quick 260709-vex): the iframe path hoists factories like the
// default path (one mechanism), so its multi-candidate emission carries the same
// named CandidateFactory const shape.
// ---------------------------------------------------------------------------

describe('readability: iframe multi-candidate step hoists a named CandidateFactory const', () => {
  it('a multi-candidate iframe click emits the hoisted const declaration plus an awaited firstMatch reference by name', () => {
    const step: Step = {
      name: 'Click widget',
      type: 'click',
      params: {
        element: {
          // role (from targetOuterHTML) + id => a multi-candidate chain that hoists.
          targetOuterHTML: '<button id="go" aria-label="Go">Go</button>',
        },
      },
    };
    const out = generateIframeStepCode(step, mkCtx()) as string;
    assert.ok(/const\s+step1ClickWidget:\s*CandidateFactory\s*=\s*\(root\)\s*=>\s*\[/.test(out),
      'the iframe multi-candidate step must hoist a CandidateFactory const');
    assert.ok(out.includes('await (await firstMatch(page, step1ClickWidget)).click();'),
      'the iframe action must reference the hoisted const by name');
    assert.ok(!out.includes('firstMatch(page, (root)'), 'the iframe path must not inline the arrow into the await');
    assert.ok(out.includes(PROVENANCE_MARKER), 'the iframe step still carries its provenance comment');
  });
});
