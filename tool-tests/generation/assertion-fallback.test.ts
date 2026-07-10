/**
 * Generation tests for the polarity-routed assertion emission (Phase 8, plan
 * 08-05, LOC-08 D-04/D-05). All offline, no subprocess, no file writes (Testing
 * SOP). Four concerns are locked here:
 *
 *   (1) SHARED_HELPERS_SOURCE gains assertOnFirstMatch: it reuses the one
 *       LOCATOR_EXHAUSTION_TOKEN const (no second literal), carries a named numeric
 *       per-attempt timeout const (PROBE_ASSERT_TIMEOUT_MS), forwards that timeout
 *       to the assertion callback, and contains no toPass call (Refinement 5: a
 *       defaulted toPass is an infinite timeout).
 *   (2) Positive assertions self-heal: a multi-candidate positive assertElementContent
 *       or assertElementPresent emits assertOnFirstMatch with a timeout-forwarding
 *       matcher callback; a single-candidate positive stays byte-stable and never
 *       references the helper (D-04 with bounded attempts).
 *   (3) Negative assertions never ride the pass-if-any chain: a multi-candidate
 *       notContains pins to the PRIMARY candidate expression only, carries the
 *       negative-assertion-degraded flag, and includes the settled FID-08 rationale
 *       comment (D-05/D-07a: Datadog's multiLocator negative-resolution is undocumented
 *       and unexercised in the captured exports, so pinning is the only choice that
 *       cannot manufacture a false green); a single-candidate negative emits no flag
 *       but still carries the polarity comment.
 *   (4) Soft (allowFailure) positive multi-candidate uses expect.soft over the
 *       locator-level firstMatch chain, never the assertion helper; unknown/
 *       unimplemented operators surface the assertion-operator-unknown flag.
 *
 * Every fixture value is authored synthetic: example.com family, syn- public ids,
 * invented selectors, names 25 chars or fewer. The emitted helper source is RUNTIME
 * code (Playwright 1.51.1); the determinism SOP governs this test file and the tool,
 * not the emitted runtime code, so the waits/timeouts inside the emitted string are
 * expected and asserted for.
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  SHARED_HELPERS_SOURCE,
  generateAssertElementContent,
  generateAssertElementPresent,
  generateSpecFile as generateBrowserSpec,
  type StepFlagContext,
} from '../../src/07-generate-browser-specs.ts';
import { FlagCollector } from '../../src/shared/migration-flags.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

type Step07 = Parameters<typeof generateAssertElementContent>[0];

function mkCtx(overrides: Partial<StepFlagContext> = {}): StepFlagContext {
  return { collector: new FlagCollector(), publicId: 'syn-000-tst', stepIndex: 0, ...overrides };
}

// A role + text + id element => three candidates, role-led => a STRONG
// multi-candidate chain.
const multiEl = {
  targetOuterHTML: '<button id="go">Sign in</button>',
  multiLocator: { co: JSON.stringify([{ text: 'Sign in', textType: 'directText' }]) },
};

// A textless input with only an id resolves to exactly one candidate.
const singleEl = { targetOuterHTML: '<input id="only">' };

// Snapshot/clear/restore DD_TAGS_* so the suite stays hermetic and
// order-independent alongside the sibling generation suites (threat T-01-14).
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
// (1) assertOnFirstMatch in the shared helpers source
// ---------------------------------------------------------------------------

describe('SHARED_HELPERS_SOURCE assertOnFirstMatch (D-04 self-heal, D-02 exhaustion reuse)', () => {
  const src = SHARED_HELPERS_SOURCE;

  it('exports an async assertOnFirstMatch(page, makeCandidates, assertion)', () => {
    assert.ok(
      /export\s+async\s+function\s+assertOnFirstMatch\s*\(/.test(src),
      'assertOnFirstMatch must be exported async',
    );
    assert.ok(
      /assertOnFirstMatch\s*\(\s*page\s*:\s*Page\s*,/.test(src),
      'first parameter must be page: Page',
    );
    assert.ok(/makeCandidates/.test(src), 'must take a makeCandidates factory');
    assert.ok(/assertion/.test(src), 'must take an assertion callback');
  });

  it('defines a named numeric per-attempt timeout const and forwards it to the assertion callback', () => {
    assert.ok(
      /const\s+PROBE_ASSERT_TIMEOUT_MS\s*=\s*2500\b/.test(src),
      'must define PROBE_ASSERT_TIMEOUT_MS as an explicit numeric const (2500)',
    );
    // The assertion callback is invoked with a timeout argument (the probe attempts
    // forward the named const; the final attempt forwards no timeout).
    assert.ok(
      /assertion\s*\(\s*\w+\s*,\s*PROBE_ASSERT_TIMEOUT_MS\s*\)/.test(src),
      'a probe attempt must call assertion(candidate, PROBE_ASSERT_TIMEOUT_MS)',
    );
  });

  it('reuses the single LOCATOR_EXHAUSTION_TOKEN const and never a second literal', () => {
    assert.ok(/LOCATOR_EXHAUSTION_TOKEN/.test(src), 'must reference the shared token const');
    // The literal "MIGRATION-LOCATOR-EXHAUSTION" appears exactly once: in the const
    // definition. Both firstMatch and assertOnFirstMatch reference the const, never
    // re-literal it (no drift).
    const literalCount = (src.match(/"MIGRATION-LOCATOR-EXHAUSTION"/g) || []).length;
    assert.equal(literalCount, 1, 'the raw exhaustion literal must appear exactly once (const definition only)');
  });

  it('contains no toPass call (Refinement 5: defaulted toPass is an infinite timeout)', () => {
    assert.ok(!/\.toPass\s*\(/.test(src), 'assertOnFirstMatch must never use toPass');
  });

  it('runs the final attempt uncaught with no timeout override so the native error surfaces', () => {
    // The helper calls the assertion with just the candidate (no second arg) for the
    // final, uncaught attempt.
    assert.ok(
      /assertion\s*\(\s*\w+\s*\)/.test(src),
      'a final attempt must call assertion(candidate) with no timeout override',
    );
  });
});

// ---------------------------------------------------------------------------
// (2) Positive self-heal: multi routes through the helper, single stays direct
// ---------------------------------------------------------------------------

describe('positive multi-candidate assertions self-heal via assertOnFirstMatch (D-04)', () => {
  it('a multi-candidate contains emits assertOnFirstMatch with a timeout-forwarding matcher callback', () => {
    const step: Step07 = {
      name: 'Assert txt',
      type: 'assertElementContent',
      params: { check: 'contains', value: 'Hello', element: multiEl },
    } as Step07;
    const out = generateAssertElementContent(step, mkCtx());
    assert.ok(/const\s+step1Txt:\s*CandidateFactory\s*=/.test(out), 'must hoist the candidate factory into a named const');
    assert.ok(/assertOnFirstMatch\(page, step1Txt,/.test(out), 'must call assertOnFirstMatch with the hoisted factory const by name');
    assert.ok(/async\s*\(\s*el\s*,\s*timeout\s*\)\s*=>/.test(out), 'the matcher callback must receive (el, timeout)');
    assert.ok(out.includes('.toContainText("Hello", { timeout })'), 'the matcher string is unchanged and forwards the timeout');
    assert.ok(!out.includes('.not.'), 'a positive contains must not be a negation');
  });

  it('a single-candidate contains stays byte-stable and never references the helper', () => {
    const step: Step07 = {
      name: 'Assert txt',
      type: 'assertElementContent',
      params: { check: 'contains', value: 'Hello', element: singleEl },
    } as Step07;
    const out = generateAssertElementContent(step, mkCtx());
    assert.ok(out.includes('await expect(page.locator("#only")).toContainText("Hello");'), 'single-candidate emission stays byte-stable');
    assert.ok(!out.includes('assertOnFirstMatch'), 'a single candidate must never reference the assertion helper');
    assert.ok(!out.includes('firstMatch'), 'a single candidate must never reference any firstMatch helper');
  });

  it('a multi-candidate assertElementPresent emits assertOnFirstMatch with the attached-state matcher (ASRT-06)', () => {
    const step: Step07 = { name: 'Assert seen', type: 'assertElementPresent', params: { element: multiEl } } as Step07;
    const out = generateAssertElementPresent(step, mkCtx());
    assert.ok(/const\s+step1Seen:\s*CandidateFactory\s*=/.test(out), 'must hoist the candidate factory into a named const');
    assert.ok(/assertOnFirstMatch\(page, step1Seen,/.test(out), 'must call assertOnFirstMatch with the hoisted factory const by name');
    assert.ok(/async\s*\(\s*el\s*,\s*timeout\s*\)\s*=>/.test(out), 'the matcher callback must receive (el, timeout)');
    assert.ok(out.includes('.toBeAttached({ timeout })'), 'the attached-state matcher is used and forwards the timeout (present-but-hidden passes)');
  });

  it('a single-candidate assertElementPresent emits attached-state presence (ASRT-06)', () => {
    const step: Step07 = { name: 'Assert seen', type: 'assertElementPresent', params: { element: singleEl } } as Step07;
    const out = generateAssertElementPresent(step, mkCtx());
    assert.ok(out.includes('await expect(page.locator("#only")).toBeAttached();'), 'single-candidate present emits attached-state presence');
    assert.ok(!out.includes('assertOnFirstMatch'), 'a single candidate must never reference the assertion helper');
  });

  it('the positive multi-candidate case emits no migration flag (D-06: a resolved chain stays active and unflagged)', () => {
    const ctx = mkCtx();
    const step: Step07 = {
      name: 'Assert txt',
      type: 'assertElementContent',
      params: { check: 'contains', value: 'Hello', element: multiEl },
    } as Step07;
    generateAssertElementContent(step, ctx);
    assert.equal(
      ctx.collector.flags.filter((f) => f.reason === 'negative-assertion-degraded' || f.reason === 'assertion-operator-unknown').length,
      0,
      'a positive resolved assertion emits no degrade or unknown-operator flag',
    );
  });
});

// ---------------------------------------------------------------------------
// (3) Negative assertions pin to the primary candidate and flag the degrade
// ---------------------------------------------------------------------------

describe('negative assertions never ride the pass-if-any chain (D-05 INVERT default)', () => {
  it('a multi-candidate notContains pins to the primary candidate expression, not the firstMatch chain', () => {
    const step: Step07 = {
      name: 'Assert not',
      type: 'assertElementContent',
      params: { check: 'notContains', value: 'Gone', element: multiEl },
    } as Step07;
    const out = generateAssertElementContent(step, mkCtx());
    // The primary candidate for multiEl is the role rung (getByRole button "Sign in").
    assert.ok(out.includes('.not.toContainText("Gone")'), 'the notContains matcher is preserved');
    assert.ok(
      out.includes('await expect(page.getByRole("button", { name: "Sign in" })).not.toContainText("Gone");'),
      'the negative must be pinned to the primary candidate direct expression',
    );
    assert.ok(!out.includes('assertOnFirstMatch'), 'a negative must never ride the pass-if-any assertion helper');
    assert.ok(!out.includes('firstMatch(page'), 'a negative must never ride the pass-if-any firstMatch chain');
  });

  it('a multi-candidate negative carries the negative-assertion-degraded flag naming the discarded count', () => {
    const ctx = mkCtx({ publicId: 'syn-501-neg', stepIndex: 4 });
    const step: Step07 = {
      name: 'Assert not',
      type: 'assertElementContent',
      params: { check: 'notContains', value: 'Gone', element: multiEl },
    } as Step07;
    generateAssertElementContent(step, ctx);
    const degraded = ctx.collector.flags.filter((f) => f.reason === 'negative-assertion-degraded');
    assert.equal(degraded.length, 1, 'exactly one negative-assertion-degraded flag');
    assert.ok(!degraded[0].deactivates, 'negative-assertion-degraded must NOT deactivate (D-06: degraded stays ACTIVE)');
    assert.equal(degraded[0].publicId, 'syn-501-neg');
    assert.equal(degraded[0].stepIndex, 4);
    // multiEl resolves to three candidates; two fallbacks are discarded.
    assert.ok(/\b2\b/.test(degraded[0].message), 'the message must name the discarded candidate count');
    // FID-08 (D-07a): the flag message states the settled disposition, not the retired
    // reasoned-inference hedge.
    assert.ok(/undocumented and unexercised/i.test(degraded[0].message), 'the message must state the settled undocumented-and-unexercised disposition');
    assert.ok(!/reasoned inference|reasoned default|INVERT|spot.check|pending a live/i.test(degraded[0].message), 'the message must carry no retired hedge token');
  });

  it('a multi-candidate negative includes the settled FID-08 rationale comment (undocumented and unexercised, false-green rationale)', () => {
    const step: Step07 = {
      name: 'Assert not',
      type: 'assertElementContent',
      params: { check: 'notContains', value: 'Gone', element: multiEl },
    } as Step07;
    const out = generateAssertElementContent(step, mkCtx());
    assert.ok(/\/\/.*primary candidate/i.test(out), 'a comment must state the negative is pinned to the primary candidate');
    assert.ok(/undocumented and unexercised/i.test(out), 'a comment must state the settled undocumented-and-unexercised disposition');
    assert.ok(/false green/i.test(out), 'a comment must state the false-green rationale (pinning cannot manufacture a false green)');
    assert.ok(!/reasoned inference|reasoned default|INVERT|spot.check|pending a live/i.test(out), 'no retired hedge token may remain in the emitted comment');
    assert.ok(!out.includes('—'), 'no em-dash in the emitted comments');
  });

  it('a single-candidate negative emits no flag but still carries the polarity comment', () => {
    const ctx = mkCtx();
    const step: Step07 = {
      name: 'Assert not',
      type: 'assertElementContent',
      params: { check: 'notContains', value: 'Gone', element: singleEl },
    } as Step07;
    const out = generateAssertElementContent(step, ctx);
    assert.equal(
      ctx.collector.flags.filter((f) => f.reason === 'negative-assertion-degraded').length,
      0,
      'a single-candidate negative has nothing to discard, so no degrade flag',
    );
    assert.ok(out.includes('await expect(page.locator("#only")).not.toContainText("Gone");'), 'single-candidate negative stays byte-stable');
    assert.ok(/\/\/.*primary candidate/i.test(out), 'the polarity comment is still present for a single-candidate negative');
  });
});

// ---------------------------------------------------------------------------
// (4) Soft assertions + unknown operators
// ---------------------------------------------------------------------------

describe('soft assertions use the locator-level firstMatch chain, never the helper', () => {
  it('a multi-candidate soft contains uses expect.soft over the locator-level chain and never assertOnFirstMatch', () => {
    const step: Step07 = {
      name: 'Assert soft',
      type: 'assertElementContent',
      allowFailure: true,
      params: { check: 'contains', value: 'Hello', element: multiEl },
    } as Step07;
    const out = generateAssertElementContent(step, mkCtx());
    // Soft assertions use the locator-level firstMatch chain over the hoisted const.
    assert.ok(/const\s+step1Soft:\s*CandidateFactory\s*=/.test(out), 'soft multi-candidate must hoist the factory const');
    assert.ok(/expect\.soft\(\(await firstMatch\(page, step1Soft\)\)/.test(out), 'soft must use expect.soft over the awaited firstMatch chain by const name');
    assert.ok(out.includes('.toContainText("Hello");'), 'the soft matcher string is unchanged (no timeout wrapping)');
    assert.ok(!out.includes('assertOnFirstMatch'), 'a soft assertion must never use the per-candidate helper');
    assert.ok(/\/\/.*soft/i.test(out), 'a comment must explain soft records instead of throwing');
  });

  it('a multi-candidate soft assertElementPresent uses expect.soft over the firstMatch chain', () => {
    const step: Step07 = {
      name: 'Assert soft',
      type: 'assertElementPresent',
      allowFailure: true,
      params: { element: multiEl },
    } as Step07;
    const out = generateAssertElementPresent(step, mkCtx());
    assert.ok(/const\s+step1Soft:\s*CandidateFactory\s*=/.test(out), 'soft present multi-candidate must hoist the factory const');
    assert.ok(/expect\.soft\(\(await firstMatch\(page, step1Soft\)\)/.test(out), 'soft present must use expect.soft over the firstMatch chain by const name');
    assert.ok(out.includes('.toBeAttached();'), 'the soft present matcher is attached-state (ASRT-06)');
    assert.ok(!out.includes('assertOnFirstMatch'), 'a soft present must never use the per-candidate helper');
  });
});

describe('unknown and unimplemented operators surface the assertion-operator-unknown flag', () => {
  it('an unknown check value (polarity-positive) emits the flag and keeps the default contains emission', () => {
    const ctx = mkCtx({ publicId: 'syn-600-unk', stepIndex: 7 });
    const step: Step07 = {
      name: 'Assert odd',
      type: 'assertElementContent',
      params: { check: 'someFutureOp', value: 'Hi', element: singleEl },
    } as Step07;
    const out = generateAssertElementContent(step, ctx);
    const unknown = ctx.collector.flags.filter((f) => f.reason === 'assertion-operator-unknown');
    assert.equal(unknown.length, 1, 'exactly one assertion-operator-unknown flag');
    assert.ok(!unknown[0].deactivates, 'assertion-operator-unknown must NOT deactivate');
    assert.ok(out.includes('.toContainText("Hi")'), 'a polarity-positive unknown keeps the default contains emission');
    assert.ok(!out.includes('.not.'), 'a polarity-positive unknown is not a negation');
  });

  it('notEquals is a live pinned native negative, NOT flagged and NOT commented out (Phase 9 ASRT-01 supersedes the Phase 8 seam)', () => {
    // Phase 8 flagged notEquals as unimplemented and commented its line out. Phase 9
    // (this plan) implements it as a native pinned negative, so it is now live code
    // and records NO assertion-operator-unknown flag.
    const ctx = mkCtx({ publicId: 'syn-601-ne', stepIndex: 2 });
    const step: Step07 = {
      name: 'Assert ne',
      type: 'assertElementContent',
      params: { check: 'notEquals', value: 'Gone', element: singleEl },
    } as Step07;
    const out = generateAssertElementContent(step, ctx);
    assert.equal(
      ctx.collector.flags.filter((f) => f.reason === 'assertion-operator-unknown').length,
      0,
      'notEquals is implemented in Phase 9, so no assertion-operator-unknown flag',
    );
    // A live, non-commented native negative matcher pinned to the primary candidate.
    assert.ok(
      out.includes('await expect(page.locator("#only")).not.toHaveText("Gone");'),
      'notEquals emits a live native .not.toHaveText pinned to the primary candidate',
    );
    const executable = out.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(/await\s+expect/.test(executable), 'the notEquals matcher line is live code, not a comment');
  });

  it('a hostile value (quote, backslash, newline) is escaped through the matcher string (T-8-01)', () => {
    const step: Step07 = {
      name: 'Assert x',
      type: 'assertElementContent',
      params: { check: 'contains', value: 'a"b\\c\nd', element: multiEl },
    } as Step07;
    const out = generateAssertElementContent(step, mkCtx());
    // The value flows through escapeString: quote, backslash, and newline are all
    // escaped so the emitted matcher string cannot break out of the literal.
    assert.ok(out.includes('a\\"b\\\\c\\nd'), 'the hostile value must be escaped through escapeString');
    assert.ok(!/\n\s*d"/.test(out.replace(/\\n/g, '')), 'no raw newline breaks the emitted matcher literal');
  });
});

// ---------------------------------------------------------------------------
// Task 2 (readability): absence gating — no unused CandidateFactory const/import
// ---------------------------------------------------------------------------

describe('CandidateFactory absence gating (no unused const, no unused type import)', () => {
  function mkTest(publicId: string, steps: unknown[]): Parameters<typeof generateBrowserSpec>[0] {
    return {
      public_id: publicId,
      name: 'Gate flow',
      locations: ['us-east-1'],
      privateLocations: [],
      originalLocations: ['aws:us-east-1'],
      config: { request: { url: 'https://app.example.com/home' } },
      steps,
    } as unknown as Parameters<typeof generateBrowserSpec>[0];
  }

  it('a spec with no multi-candidate step carries no CandidateFactory token anywhere', () => {
    // Single-candidate id click + a DOM assertion: no firstMatch chain, no factory.
    const { spec } = generateBrowserSpec(
      mkTest('syn-700-aaa', [
        { name: 'Click only', type: 'click', params: { element: { targetOuterHTML: '<input id="only">' } } },
        { name: 'Assert seen', type: 'assertPageContains', params: { value: 'Home' } },
      ]),
      new FlagCollector(),
    );
    assert.ok(!spec.includes('CandidateFactory'), 'no hoisted factory means no CandidateFactory token (no unused const or type import)');
    assert.ok(!spec.includes('from "../helpers"'), 'a chainless spec imports no helpers at all');
  });

  it('a negative-polarity multi-candidate assertion emits no const declaration and no CandidateFactory reference (D-05 pins to primary)', () => {
    // A multi-candidate notContains pins to the primary candidate only; the factory
    // is never referenced, so withLocator must NOT hoist an unused const.
    const step: Step07 = {
      name: 'Assert not',
      type: 'assertElementContent',
      params: { check: 'notContains', value: 'Gone', element: multiEl },
    } as Step07;
    const out = generateAssertElementContent(step, mkCtx());
    assert.ok(!/const\s+step\d+\w*:\s*CandidateFactory/.test(out), 'a negative multi-candidate assertion must not hoist an unused factory const');
    assert.ok(!out.includes('CandidateFactory'), 'the negative emission references no CandidateFactory at all');
    assert.ok(!out.includes('firstMatch'), 'a negative never rides the pass-if-any chain (D-05)');
  });

  it('a spec whose only multi-candidate step is a negative assertion imports no CandidateFactory type', () => {
    const { spec } = generateBrowserSpec(
      mkTest('syn-701-bbb', [
        {
          name: 'Assert not',
          type: 'assertElementContent',
          params: { check: 'notContains', value: 'Gone', element: multiEl },
        },
      ]),
      new FlagCollector(),
    );
    assert.ok(!spec.includes('type CandidateFactory'), 'a negative-only multi-candidate spec must not import the CandidateFactory type');
  });
});

// ---------------------------------------------------------------------------
// Phase 9, plan 09-02, Task 1: native negatives (notEquals) + positive notIsEmpty
// ---------------------------------------------------------------------------

describe('Phase 9 ASRT-01 notEquals native pinned negative (D-05, never inverted)', () => {
  it('single-candidate notEquals emits a live .not.toHaveText pinned to the primary, below the polarity comment, with no unknown flag', () => {
    const ctx = mkCtx({ publicId: 'syn-610-ne', stepIndex: 3 });
    const step: Step07 = {
      name: 'Assert ne',
      type: 'assertElementContent',
      params: { check: 'notEquals', value: 'Bad', element: singleEl },
    } as Step07;
    const out = generateAssertElementContent(step, ctx);
    assert.ok(
      out.includes('await expect(page.locator("#only")).not.toHaveText("Bad");'),
      'notEquals pins a native .not.toHaveText to the primary candidate expression',
    );
    assert.ok(/\/\/.*primary candidate/i.test(out), 'the negative-polarity comment is present');
    assert.equal(
      ctx.collector.flags.filter((f) => f.reason === 'assertion-operator-unknown').length,
      0,
      'notEquals records NO assertion-operator-unknown flag (it is implemented in Phase 9)',
    );
    // The matcher line is live (not commented out).
    const executable = out.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(/\.not\.toHaveText\("Bad"\)/.test(executable), 'the notEquals matcher is live code, not a comment');
  });

  it('multi-candidate notEquals pins to the primary (no firstMatch) and records exactly one negative-assertion-degraded naming the discarded count', () => {
    const ctx = mkCtx({ publicId: 'syn-611-ne', stepIndex: 5 });
    const step: Step07 = {
      name: 'Assert ne',
      type: 'assertElementContent',
      params: { check: 'notEquals', value: 'Bad', element: multiEl },
    } as Step07;
    const out = generateAssertElementContent(step, ctx);
    assert.ok(
      out.includes('await expect(page.getByRole("button", { name: "Sign in" })).not.toHaveText("Bad");'),
      'notEquals pins to the primary candidate (the role rung) with a native .not.toHaveText',
    );
    assert.ok(!out.includes('assertOnFirstMatch'), 'a negative never rides the pass-if-any assertion helper');
    assert.ok(!out.includes('firstMatch(page'), 'a negative never rides the pass-if-any firstMatch chain');
    const degraded = ctx.collector.flags.filter((f) => f.reason === 'negative-assertion-degraded');
    assert.equal(degraded.length, 1, 'exactly one negative-assertion-degraded flag');
    assert.ok(/\b2\b/.test(degraded[0].message), 'the message names the discarded candidate count (2)');
  });

  it('notEquals no-inversion proof: no positive toHaveText/toContainText call without a preceding .not. on the assertion line', () => {
    const step: Step07 = {
      name: 'Assert ne',
      type: 'assertElementContent',
      params: { check: 'notEquals', value: 'Bad', element: multiEl },
    } as Step07;
    const out = generateAssertElementContent(step, mkCtx());
    for (const line of out.split('\n')) {
      if (line.trim().startsWith('//')) continue;
      if (/\.toHaveText\(|\.toContainText\(/.test(line)) {
        assert.ok(/\.not\.(toHaveText|toContainText)\(/.test(line), `negative matcher line must carry .not.: ${line}`);
      }
    }
  });
});

describe('Phase 9 ASRT-01 notIsEmpty positive non-whitespace matcher (A1 resolution, no vacuous form)', () => {
  it('single-candidate notIsEmpty emits toHaveText(/\\S/) and records no flag', () => {
    const ctx = mkCtx({ publicId: 'syn-620-nie', stepIndex: 1 });
    const step: Step07 = {
      name: 'Assert nie',
      type: 'assertElementContent',
      params: { check: 'notIsEmpty', element: singleEl },
    } as Step07;
    const out = generateAssertElementContent(step, ctx);
    assert.ok(out.includes('toHaveText(/\\S/)'), 'notIsEmpty emits a positive non-whitespace regex matcher');
    assert.ok(!out.includes('.not.'), 'notIsEmpty is a POSITIVE existence claim, not a negation');
    assert.equal(
      ctx.collector.flags.filter((f) => f.reason === 'assertion-operator-unknown').length,
      0,
      'notIsEmpty is implemented, so no unknown-operator flag',
    );
  });

  it('multi-candidate notIsEmpty (non-soft) routes through assertOnFirstMatch with toHaveText(/\\S/, { timeout })', () => {
    const step: Step07 = {
      name: 'Assert nie',
      type: 'assertElementContent',
      params: { check: 'notIsEmpty', element: multiEl },
    } as Step07;
    const out = generateAssertElementContent(step, mkCtx());
    assert.ok(/assertOnFirstMatch\(page, step1\w*,/.test(out), 'multi-candidate notIsEmpty self-heals via assertOnFirstMatch');
    assert.ok(/async\s*\(\s*el\s*,\s*timeout\s*\)\s*=>/.test(out), 'the matcher callback receives (el, timeout)');
    assert.ok(out.includes('toHaveText(/\\S/, { timeout })'), 'the matcher forwards the per-attempt timeout');
  });

  it('soft notIsEmpty uses expect.soft over the locator-level chain with toHaveText(/\\S/)', () => {
    const step: Step07 = {
      name: 'Assert nie',
      type: 'assertElementContent',
      allowFailure: true,
      params: { check: 'notIsEmpty', element: multiEl },
    } as Step07;
    const out = generateAssertElementContent(step, mkCtx());
    assert.ok(/expect\.soft\(\(await firstMatch\(page, step1\w*\)\)/.test(out), 'soft notIsEmpty uses expect.soft over the firstMatch chain');
    assert.ok(out.includes('toHaveText(/\\S/)'), 'the soft notIsEmpty matcher is the non-whitespace regex (no timeout wrapping)');
  });

  it('notIsEmpty never emits a vacuous empty-string containment matcher', () => {
    for (const el of [singleEl, multiEl]) {
      const step: Step07 = {
        name: 'Assert nie',
        type: 'assertElementContent',
        params: { check: 'notIsEmpty', element: el },
      } as Step07;
      const out = generateAssertElementContent(step, mkCtx());
      assert.ok(!out.includes('toContainText("")'), 'no vacuous empty-string containment matcher is ever emitted');
    }
  });
});

describe('Phase 9 D-06 unknown-operator seam survives the expanded implemented set', () => {
  it('a genuinely unknown operator (matchesFuzzy) still records assertion-operator-unknown and keeps the loud default contains', () => {
    const ctx = mkCtx({ publicId: 'syn-630-unk', stepIndex: 0 });
    const step: Step07 = {
      name: 'Assert odd',
      type: 'assertElementContent',
      params: { check: 'matchesFuzzy', value: 'Hi', element: singleEl },
    } as Step07;
    const out = generateAssertElementContent(step, ctx);
    assert.equal(
      ctx.collector.flags.filter((f) => f.reason === 'assertion-operator-unknown').length,
      1,
      'a genuinely unknown operator still flags after the set expansion (D-06 seam intact)',
    );
    assert.ok(out.includes('.toContainText("Hi")'), 'a polarity-positive unknown keeps the loud default contains emission');
    assert.ok(!out.includes('.not.'), 'a polarity-positive unknown is not a negation');
  });
});

// ---------------------------------------------------------------------------
// Phase 9, plan 09-02, Task 2: numeric operators greater/lessThan (D-04, loud NaN)
// ---------------------------------------------------------------------------

describe('Phase 9 ASRT-01 numeric operators greater/lessThan via expect.poll (D-04, NaN fails loud)', () => {
  it('single-candidate greater (value "1", non-soft) emits a retrying Number()-parse expect.poll toBeGreaterThan', () => {
    const ctx = mkCtx({ publicId: 'syn-640-gt', stepIndex: 0 });
    const step: Step07 = {
      name: 'Assert gt',
      type: 'assertElementContent',
      params: { check: 'greater', value: '1', element: singleEl },
    } as Step07;
    const out = generateAssertElementContent(step, ctx);
    assert.ok(out.includes('await expect.poll(async () => Number(await '), 'greater uses expect.poll over a Number()-parsed innerText');
    assert.ok(out.includes('.innerText())).toBeGreaterThan(1);'), 'the matcher is toBeGreaterThan with the numeric threshold');
    assert.equal(
      ctx.collector.flags.filter((f) => f.reason === 'assertion-operator-unknown').length,
      0,
      'greater is implemented, so no assertion-operator-unknown flag',
    );
  });

  it('multi-candidate greater (non-soft) wraps the poll inside assertOnFirstMatch forwarding the per-attempt timeout', () => {
    const step: Step07 = {
      name: 'Assert gt',
      type: 'assertElementContent',
      params: { check: 'greater', value: '1', element: multiEl },
    } as Step07;
    const out = generateAssertElementContent(step, mkCtx());
    assert.ok(/assertOnFirstMatch\(page, step1\w*, async \(el, timeout\) =>/.test(out), 'greater multi self-heals via assertOnFirstMatch with (el, timeout)');
    assert.ok(out.includes('expect.poll(async () => Number(await el.innerText()), { timeout }).toBeGreaterThan(1);'), 'the poll forwards the per-attempt timeout into its options');
  });

  it('soft greater uses the one-shot expect.soft form (expect.poll has no soft variant)', () => {
    const step: Step07 = {
      name: 'Assert gt',
      type: 'assertElementContent',
      allowFailure: true,
      params: { check: 'greater', value: '1', element: singleEl },
    } as Step07;
    const out = generateAssertElementContent(step, mkCtx());
    assert.ok(out.includes('await expect.soft(Number(await '), 'soft greater uses the one-shot expect.soft(Number(...)) form');
    assert.ok(out.includes('.innerText())).toBeGreaterThan(1);'), 'the soft matcher is toBeGreaterThan');
    assert.ok(!out.includes('expect.poll'), 'soft greater does not use expect.poll (no soft poll variant)');
  });

  it('single-candidate lessThan emits toBeLessThan (defensive completeness, ASRT-01)', () => {
    const step: Step07 = {
      name: 'Assert lt',
      type: 'assertElementContent',
      params: { check: 'lessThan', value: '5', element: singleEl },
    } as Step07;
    const out = generateAssertElementContent(step, mkCtx());
    assert.ok(out.includes('.toBeLessThan(5);'), 'lessThan maps to toBeLessThan');
    assert.ok(out.includes('await expect.poll(async () => Number(await '), 'lessThan uses the same retrying Number()-parse poll');
  });

  it('a non-numeric literal threshold ("many") is wrapped in Number(...), never a bare unquoted garbage token', () => {
    const step: Step07 = {
      name: 'Assert gt',
      type: 'assertElementContent',
      params: { check: 'greater', value: 'many', element: singleEl },
    } as Step07;
    const out = generateAssertElementContent(step, mkCtx());
    // The threshold must appear as Number(`many`) (or similar wrapped form), never as
    // a bare toBeGreaterThan(many) which would be a ReferenceError at runtime.
    assert.ok(/toBeGreaterThan\(Number\(/.test(out), 'a non-numeric threshold is wrapped in Number(...)');
    assert.ok(!/toBeGreaterThan\(many\)/.test(out), 'never a bare unquoted garbage threshold token');
  });

  it('no assertion-operator-unknown flag is recorded for greater or lessThan steps', () => {
    for (const check of ['greater', 'lessThan']) {
      const ctx = mkCtx();
      const step: Step07 = {
        name: 'Assert n',
        type: 'assertElementContent',
        params: { check, value: '1', element: singleEl },
      } as Step07;
      generateAssertElementContent(step, ctx);
      assert.equal(
        ctx.collector.flags.filter((f) => f.reason === 'assertion-operator-unknown').length,
        0,
        `${check} is implemented and must not flag`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 9, plan 09-02, Task 3: ASRT-02 variable-aware content values
// ---------------------------------------------------------------------------

describe('Phase 9 ASRT-02 convertVariables wired into content-assert values (byte-stable when no variable)', () => {
  it('contains with {{ CONTENT_VAR }} emits a backtick template resolving process.env.CONTENT_VAR, no literal double-brace', () => {
    const step: Step07 = {
      name: 'Assert v',
      type: 'assertElementContent',
      params: { check: 'contains', value: '{{ CONTENT_VAR }}', element: singleEl },
    } as Step07;
    const out = generateAssertElementContent(step, mkCtx());
    assert.ok(out.includes('${process.env.CONTENT_VAR}'), 'the variable resolves to a process.env template expression');
    assert.ok(!out.includes('{{'), 'no literal double-brace variable reference survives in the output');
    assert.ok(/\.toContainText\(`[^`]*\$\{process\.env\.CONTENT_VAR\}[^`]*`\)/.test(out), 'contains emits the matcher argument as a backtick template');
  });

  it('equals with a variable carries the template through toHaveText', () => {
    const step: Step07 = {
      name: 'Assert v',
      type: 'assertElementContent',
      params: { check: 'equals', value: '{{ CONTENT_VAR }}', element: singleEl },
    } as Step07;
    const out = generateAssertElementContent(step, mkCtx());
    assert.ok(/\.toHaveText\(`[^`]*\$\{process\.env\.CONTENT_VAR\}[^`]*`\)/.test(out), 'equals emits toHaveText with a backtick template');
    assert.ok(!out.includes('{{'), 'no literal double-brace survives');
  });

  it('notEquals with a variable carries the template through .not.toHaveText', () => {
    const step: Step07 = {
      name: 'Assert v',
      type: 'assertElementContent',
      params: { check: 'notEquals', value: '{{ CONTENT_VAR }}', element: singleEl },
    } as Step07;
    const out = generateAssertElementContent(step, mkCtx());
    assert.ok(/\.not\.toHaveText\(`[^`]*\$\{process\.env\.CONTENT_VAR\}[^`]*`\)/.test(out), 'notEquals negative emission carries the template through .not.toHaveText');
    assert.ok(!out.includes('{{'), 'no literal double-brace survives');
  });

  it('notContains with a variable carries the template through .not.toContainText', () => {
    const step: Step07 = {
      name: 'Assert v',
      type: 'assertElementContent',
      params: { check: 'notContains', value: '{{ CONTENT_VAR }}', element: singleEl },
    } as Step07;
    const out = generateAssertElementContent(step, mkCtx());
    assert.ok(/\.not\.toContainText\(`[^`]*\$\{process\.env\.CONTENT_VAR\}[^`]*`\)/.test(out), 'notContains negative emission carries the template');
    assert.ok(!out.includes('{{'), 'no literal double-brace survives');
  });

  it('startsWith with a variable emits new RegExp with a runtime .replace escape over process.env (hostile value cannot inject regex metacharacters)', () => {
    const step: Step07 = {
      name: 'Assert v',
      type: 'assertElementContent',
      params: { check: 'startsWith', value: '{{ CONTENT_VAR }}', element: singleEl },
    } as Step07;
    const out = generateAssertElementContent(step, mkCtx());
    assert.ok(out.includes('new RegExp('), 'startsWith with a variable emits new RegExp(...)');
    assert.ok(out.includes('.replace('), 'the runtime value is regex-escaped via .replace(...)');
    assert.ok(out.includes('process.env.CONTENT_VAR'), 'the runtime value comes from process.env');
    assert.ok(!out.includes('{{'), 'no literal double-brace survives');
  });

  it('byte-stability: plain (no-variable) values across every operator emit exactly the pre-task strings', () => {
    const plainCases: Array<[string, string, string]> = [
      ['contains', 'Hello', 'await expect(page.locator("#only")).toContainText("Hello");'],
      ['equals', 'Hello', 'await expect(page.locator("#only")).toHaveText("Hello");'],
      ['startsWith', 'Hello', 'await expect(page.locator("#only")).toHaveText(new RegExp("^Hello"));'],
      ['notContains', 'Gone', 'await expect(page.locator("#only")).not.toContainText("Gone");'],
      ['notEquals', 'Gone', 'await expect(page.locator("#only")).not.toHaveText("Gone");'],
    ];
    for (const [check, value, expected] of plainCases) {
      const step: Step07 = {
        name: 'Assert p',
        type: 'assertElementContent',
        params: { check, value, element: singleEl },
      } as Step07;
      const out = generateAssertElementContent(step, mkCtx());
      assert.ok(out.includes(expected), `plain ${check} emission must stay byte-stable: expected ${expected}`);
      assert.ok(!out.includes('`'), `plain ${check} must never emit a backtick template`);
    }
  });
});

// ---------------------------------------------------------------------------
// FID-08 guard (Phase 9.5, plan 09.5-02, Task 3): the retired hedge tokens stay
// retired. This is the permanent anti-drift control for ROADMAP success
// criterion 8 (no shipped comment claims an unverified Datadog behavior). It
// walks every .ts file under src/ and src/shared/ and asserts that neither the
// uppercase inversion keyword nor the any-character spot-check pattern appears.
// Offline, no glob, no subprocess (Testing SOP): a deterministic readdirSync
// walk mirroring the second-account-generalization source-scan idiom.
//
// The two retired patterns are assembled from string parts via new RegExp so the
// guard file itself stays greppable-clean in reviews (tool-tests/ is outside the
// scanned scope, but building from parts avoids a self-match noise hit).
// ---------------------------------------------------------------------------

describe('FID-08 guard: retired hedge tokens stay retired (ROADMAP success criterion 8)', () => {
  const SRC_ROOT = join(__dirname, '..', '..', 'src');
  // Case-sensitive uppercase inversion keyword ("INVERT") and the any-character
  // spot-check pattern ("spot" + any char + "check"), built from parts.
  const RETIRED_PATTERNS: Array<{ label: string; re: RegExp }> = [
    { label: 'uppercase inversion keyword', re: new RegExp('INVER' + 'T') },
    { label: 'spot-check hedge', re: new RegExp('spot' + '.' + 'check', 'i') },
  ];

  /** Collect every .ts file directly under src/ and under src/shared/. */
  function collectSrcTsFiles(): string[] {
    const dirs = [SRC_ROOT, join(SRC_ROOT, 'shared')];
    const files: string[] = [];
    for (const dir of dirs) {
      for (const name of readdirSync(dir)) {
        if (name.endsWith('.ts')) files.push(join(dir, name));
      }
    }
    return files.sort();
  }

  it('walks every .ts file under src/ and src/shared/ and finds no retired hedge token', () => {
    const files = collectSrcTsFiles();
    assert.ok(files.length > 0, 'the src/ walk must find .ts files (guard is wired to a real tree)');
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      for (const { label, re } of RETIRED_PATTERNS) {
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            offenders.push(`${file}:${i + 1} (${label})`);
            break; // first match per pattern per file is enough to fail
          }
        }
      }
    }
    assert.equal(
      offenders.length,
      0,
      `no src/ file may carry a retired hedge token (FID-08); offenders: ${offenders.join(', ')}`,
    );
  });
});
