/**
 * multi-selector review tag tests.
 *
 * Pins the src/08 half of the self-healing locator chain review surface: the
 * `reviewMultiSelector` construct tag is emitted for every BrowserCheck whose
 * spec resolved a multi-candidate firstMatch chain (manifest field
 * hasMultiCandidate true), appended AFTER filterAndRemapTags in the same
 * diagnostic slot as the iframe tag and migration_check_id so DD_TAGS_EXCLUDE,
 * DD_TAGS_EXCLUDE_ALL, and DD_TAGS_REMAP can never strip it. The tag is a
 * fixed literal set in generated MaC code, never API-applied.
 *
 * The tag is a review surface only: it NEVER touches the activated value. A live
 * multi-candidate check stays activated: true; a deactivated
 * multi-candidate check emits activated: false via the existing flagState path
 * alone (deactivation remains exclusively the zero-candidate slice).
 *
 * Driven entirely by synthetic in-memory data (invented values only: syn- public
 * ids, example.com family, names 25 chars or fewer, env:synthetic tags). No
 * network, no wall-clock, no randomness, no file writes at runtime. The three
 * DD_TAGS_* variables are snapshot / cleared / restored in before / after hooks
 * because generateBrowserCheckCode calls filterAndRemapTags at call time
 * (migration-flag-constructs.test.ts idiom).
 *
 * CHECKLY_ACCOUNT_NAME is set as the FIRST statement, before any src import, so
 * no import chain can reach the interactive account-name prompt.
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateBrowserCheckCode } from '../../src/08-generate-browser-constructs.ts';
import { generateSpecFile as generateBrowserSpec } from '../../src/07-generate-browser-specs.ts';
import { FlagCollector } from '../../src/shared/migration-flags.ts';

/**
 * BrowserTest is file-local to src/08. Derive the exact input shape from the
 * exported generator's first parameter (migration-flag-constructs.test.ts idiom).
 */
type BrowserTestInput = Parameters<typeof generateBrowserCheckCode>[0];

const SPEC_FILENAME = 'syn-browser-flow.spec.ts';

/**
 * Build a synthetic live BrowserTest. The private variant carries a non-empty
 * privateLocations array so both the public and the private branch of the one
 * shared function are exercised.
 */
function mkTest(overrides: Partial<BrowserTestInput> = {}): BrowserTestInput {
  const base = {
    public_id: 'syn-aaa-111',
    name: 'Synthetic flow',
    status: 'live',
    tags: ['env:synthetic'],
    locations: ['us-east-1'],
    privateLocations: [] as string[],
    originalLocations: ['aws:us-east-1'],
    options: { tick_every: 900 },
    config: {},
  };
  return { ...base, ...overrides } as BrowserTestInput;
}

/**
 * generateBrowserCheckCode calls filterAndRemapTags, which reads DD_TAGS_EXCLUDE,
 * DD_TAGS_EXCLUDE_ALL, and DD_TAGS_REMAP at call time. Snapshot and clear all
 * three before the tests and restore them exactly afterwards (determinism rule).
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

describe('generateBrowserCheckCode: reviewMultiSelector tag', () => {
  it('Test 1: hasMultiCandidate true emits the reviewMultiSelector tag', () => {
    const out = generateBrowserCheckCode(mkTest(), SPEC_FILENAME, 'public', false, undefined, true);
    assert.ok(out.includes('reviewMultiSelector'), 'a multi-candidate check must carry the reviewMultiSelector tag');
  });

  it('Test 2: hasMultiCandidate false emits no reviewMultiSelector tag', () => {
    const out = generateBrowserCheckCode(mkTest(), SPEC_FILENAME, 'public', false, undefined, false);
    assert.ok(!out.includes('reviewMultiSelector'), 'a single-candidate check must not carry the tag');
  });

  it('Test 3: the trailing parameter is optional and defaults to no tag (call-compat)', () => {
    const out = generateBrowserCheckCode(mkTest(), SPEC_FILENAME, 'public', false);
    assert.ok(!out.includes('reviewMultiSelector'), 'omitting the parameter must not emit the tag');
  });

  it('Test 4: the private location branch also emits the tag (public/private sync)', () => {
    const privateTest = mkTest({
      locations: [],
      privateLocations: ['syn-private-loc-one'],
    });
    const out = generateBrowserCheckCode(privateTest, SPEC_FILENAME, 'private', false, undefined, true);
    assert.ok(out.includes('reviewMultiSelector'), 'the private branch must also carry the tag');
    assert.ok(out.includes('privateLocations:'), 'the private variant must emit a privateLocations line');
  });

  it('Test 5: DD_TAGS_EXCLUDE_ALL=true cannot strip reviewMultiSelector (appended after filterAndRemapTags)', () => {
    const prior = process.env.DD_TAGS_EXCLUDE_ALL;
    process.env.DD_TAGS_EXCLUDE_ALL = 'true';
    try {
      const out = generateBrowserCheckCode(mkTest(), SPEC_FILENAME, 'public', false, undefined, true);
      assert.ok(out.includes('reviewMultiSelector'), 'the review tag is appended after filterAndRemapTags and survives exclude-all');
    } finally {
      if (prior === undefined) {
        delete process.env.DD_TAGS_EXCLUDE_ALL;
      } else {
        process.env.DD_TAGS_EXCLUDE_ALL = prior;
      }
    }
  });

  it('Test 6: the tag never appears twice, even when already present in the source tags', () => {
    const out = generateBrowserCheckCode(
      mkTest({ tags: ['env:synthetic', 'reviewMultiSelector'] }),
      SPEC_FILENAME,
      'public',
      false,
      undefined,
      true,
    );
    const occurrences = out.split('reviewMultiSelector').length - 1;
    assert.equal(occurrences, 1, 'reviewMultiSelector must appear exactly once in the emitted tags array');
  });

  it('Test 7: the tag never changes activated for a live multi-candidate check', () => {
    const out = generateBrowserCheckCode(mkTest({ status: 'live' }), SPEC_FILENAME, 'public', false, undefined, true);
    assert.ok(out.includes('reviewMultiSelector'), 'a live multi-candidate check carries the tag');
    assert.ok(out.includes('activated: true'), 'the tag never activates or deactivates: a live check stays activated: true');
    assert.ok(!out.includes('activated: false'), 'the multi-selector tag must not force a live check off');
  });

  it('Test 8: a deactivated multi-candidate check emits activated: false via flagState only, still carrying both tags', () => {
    const flagState = {
      flaggedIds: new Set(['syn-aaa-111']),
      deactivatedIds: new Set(['syn-aaa-111']),
    };
    const out = generateBrowserCheckCode(
      mkTest({ public_id: 'syn-aaa-111', status: 'live' }),
      SPEC_FILENAME,
      'public',
      false,
      flagState,
      true,
    );
    assert.ok(out.includes('activated: false'), 'deactivation comes from the flagState path, not the multi-selector tag');
    assert.ok(!out.includes('activated: true'), 'the deactivated check must not remain active');
    assert.ok(out.includes('reviewMultiSelector'), 'the multi-selector review tag is still present on the deactivated check');
    assert.ok(out.includes('reviewMigrationFlag'), 'the review tag is present alongside it');
  });

  it('Test 9: a paused multi-candidate check with no flagState stays activated: false (Datadog status preserved)', () => {
    const out = generateBrowserCheckCode(mkTest({ status: 'paused' }), SPEC_FILENAME, 'public', false, undefined, true);
    assert.ok(out.includes('reviewMultiSelector'), 'a paused multi-candidate check still carries the review tag');
    assert.ok(out.includes('activated: false'), 'a paused check maps to activated: false regardless of the tag');
  });
});

/**
 * (todo 2026-07-09): hasMultiCandidate is the SOURCE of the
 * reviewMultiSelector tag (Tests 1-9 above) and of the step-12 Self-Healing Locator
 * Chains report entry. Both consumers already follow the manifest field faithfully;
 * the defect closed here is that the field itself over-claimed.
 *
 * derived hasMultiCandidate from a second, independent extractLocator length
 * scan inside the per-step loop (true whenever any locator-consuming step resolved two
 * or more candidates). But the assertion-polarity path emits NO firstMatch chain
 * for a HARD (non-soft) negative multi-candidate assertion: it pins to the PRIMARY
 * candidate. So a check whose only multi-candidate step was a hard-negative assertion
 * was falsely tagged reviewMultiSelector and over-claimed in the report, even though its
 * spec body contains no self-healing chain to point a reviewer at.
 *
 * The fix derives hasMultiCandidate from whether a firstMatch / assertOnFirstMatch chain
 * was ACTUALLY emitted into the comment-stripped executable body, so the manifest, the
 * tag, and the report copy become structurally unable to disagree with the spec body.
 *
 * The rejected simpler alternative (a blanket "skip negatives in the length scan") is
 * locked OUT here by the soft-POSITIVE control: a SOFT (allowFailure) positive still emits
 * a locator-level firstMatch chain, so the axis that decides hasMultiCandidate is NOT
 * polarity, it is whether a chain was emitted. Any scan-gate keyed on polarity would drift
 * from the body; the emitted-body derivation cannot.
 *
 * NOTE (verified against installed source): the premise that a SOFT negative
 * multi-candidate "DOES emit a locator-level firstMatch chain" is false against
 * generateAssertElementContent as installed. The negative-pins-to-primary rule is
 * evaluated BEFORE the soft branch, so a negative assertion (soft OR hard)
 * pins to the primary candidate and emits NO chain. A soft negative therefore correctly
 * reports hasMultiCandidate FALSE (its spec body has no self-healing chain to point a
 * reviewer at, so tagging it reviewMultiSelector would over-claim exactly as the hard
 * negative did). The soft-POSITIVE case below is the true anti-drift control.
 *
 * These cases drive generateSpecFile directly (the browser.test.ts / assertion-fallback
 * idiom), reading the returned hasMultiCandidate plus the emitted spec body. Every fixture
 * value is synthetic: syn- public ids, example.com family, names 25 chars or fewer.
 */
describe('generateSpecFile: hasMultiCandidate is emitted-chain reality', () => {
  type SpecTestInput = Parameters<typeof generateBrowserSpec>[0];

  function mkSpecTest(publicId: string, steps: unknown[]): SpecTestInput {
    return {
      public_id: publicId,
      name: 'Chain reality flow',
      locations: ['us-east-1'],
      privateLocations: [],
      originalLocations: ['aws:us-east-1'],
      config: { request: { url: 'https://app.example.com/home' } },
      steps,
    } as unknown as SpecTestInput;
  }

  // A role + text + id element resolves to multiple candidates (the assertion-fallback
  // multiEl shape): the primary rung is getByRole button "Sign in".
  const multiEl = {
    targetOuterHTML: '<button id="go">Sign in</button>',
    multiLocator: { co: JSON.stringify([{ text: 'Sign in', textType: 'directText' }]) },
  };
  // A textless input with only an id resolves to exactly one candidate: no chain.
  const singleEl = { targetOuterHTML: '<input id="only">' };

  // Strip comment lines the same way the derivation and the zero-assertion / helpers-import
  // scans do, so an assertion pinned to the primary but carrying "primary candidate" /
  // "reasoned inference" comment lines cannot be mistaken for an emitted chain.
  function executableLines(spec: string): string {
    return spec
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
  }

  it('a hard-negative-only multi-candidate check reports hasMultiCandidate FALSE', () => {
    // The ONLY multi-candidate step is a non-soft notContains assertElementContent. The
    // path pins it to the primary candidate and emits NO firstMatch chain, so the
    // manifest field must be false: neither reviewMultiSelector nor a report entry.
    const hardNegStep = {
      name: 'Assert gone',
      type: 'assertElementContent',
      params: { check: 'notContains', value: 'Gone', element: multiEl },
    };
    const result = generateBrowserSpec(mkSpecTest('syn-700-hn', [hardNegStep]), new FlagCollector());
    assert.equal(
      result.hasMultiCandidate,
      false,
      'a hard-negative-only multi-candidate check emits no firstMatch chain, so hasMultiCandidate must be false',
    );
    const exec = executableLines(result.spec);
    assert.ok(!/\bfirstMatch\b/.test(exec), 'the executable body must contain no firstMatch chain');
    assert.ok(!/\bassertOnFirstMatch\b/.test(exec), 'the executable body must contain no assertOnFirstMatch chain');
  });

  it('a soft-POSITIVE multi-candidate check reports hasMultiCandidate TRUE (locks the rejected blanket-negative-skip out)', () => {
    // A SOFT positive multi-candidate assertElementContent rides the locator-level firstMatch
    // chain (expect.soft over the awaited firstMatch), so a real chain IS emitted. This is the
    // true anti-drift control: it proves the derivation tracks emitted-chain reality, not
    // polarity. A blanket "skip negatives" scan-gate would still pass this case, but the
    // emitted-body derivation is what makes the field structurally honest for every seam.
    const softPosStep = {
      name: 'Assert seen soft',
      type: 'assertElementContent',
      allowFailure: true,
      params: { check: 'contains', value: 'Hello', element: multiEl },
    };
    const result = generateBrowserSpec(mkSpecTest('syn-701-sp', [softPosStep]), new FlagCollector());
    assert.equal(
      result.hasMultiCandidate,
      true,
      'a soft positive rides the locator-level firstMatch chain, so hasMultiCandidate must be true',
    );
    assert.ok(/\bfirstMatch\b/.test(executableLines(result.spec)), 'the soft positive must emit a firstMatch chain into the executable body');
  });

  it('a soft-NEGATIVE multi-candidate check reports hasMultiCandidate FALSE (negatives pin to primary, soft or hard)', () => {
    // verified against installed source: the negative-pins-to-primary rule is
    // evaluated before the soft branch, so a soft negative pins to the primary
    // candidate and emits NO chain (usesHelpers false). Its spec body has no self-healing
    // chain, so hasMultiCandidate must be FALSE, exactly like the hard negative. This
    // corrects the todo/plan premise that a soft negative rides the chain.
    const softNegStep = {
      name: 'Assert gone soft',
      type: 'assertElementContent',
      allowFailure: true,
      params: { check: 'notContains', value: 'Gone', element: multiEl },
    };
    const result = generateBrowserSpec(mkSpecTest('syn-701-sn', [softNegStep]), new FlagCollector());
    assert.equal(
      result.hasMultiCandidate,
      false,
      'a soft negative pins to the primary candidate and emits no chain, so hasMultiCandidate must be false',
    );
    const exec = executableLines(result.spec);
    assert.ok(!/\bfirstMatch\b/.test(exec), 'the soft-negative executable body must contain no firstMatch chain');
    assert.ok(!/\bassertOnFirstMatch\b/.test(exec), 'the soft-negative executable body must contain no assertOnFirstMatch chain');
  });

  it('a positive multi-candidate check reports hasMultiCandidate TRUE (unchanged behavior)', () => {
    // A multi-candidate positive assertion self-heals via assertOnFirstMatch: a real chain.
    const posStep = {
      name: 'Assert seen',
      type: 'assertElementContent',
      params: { check: 'contains', value: 'Hello', element: multiEl },
    };
    const result = generateBrowserSpec(mkSpecTest('syn-702-pos', [posStep]), new FlagCollector());
    assert.equal(result.hasMultiCandidate, true, 'a positive multi-candidate assertion emits a chain, so hasMultiCandidate stays true');
    assert.ok(/\b(firstMatch|assertOnFirstMatch)\b/.test(executableLines(result.spec)), 'the positive multi-candidate must emit a chain');
  });

  it('a multi-candidate action (click) reports hasMultiCandidate TRUE (unchanged behavior)', () => {
    // A multi-candidate action emits the locator-level firstMatch chain, unchanged by.
    const clickStep = {
      name: 'Click go',
      type: 'click',
      params: { element: multiEl },
    };
    const result = generateBrowserSpec(mkSpecTest('syn-703-act', [clickStep]), new FlagCollector());
    assert.equal(result.hasMultiCandidate, true, 'a multi-candidate action emits a firstMatch chain, so hasMultiCandidate stays true');
    assert.ok(/\bfirstMatch\b/.test(executableLines(result.spec)), 'the multi-candidate action must emit a firstMatch chain');
  });

  it('a single-candidate-only check reports hasMultiCandidate FALSE (unchanged control)', () => {
    const singleClick = { name: 'Click only', type: 'click', params: { element: singleEl } };
    const result = generateBrowserSpec(mkSpecTest('syn-704-single', [singleClick]), new FlagCollector());
    assert.equal(result.hasMultiCandidate, false, 'a single-candidate corpus emits no chain, so hasMultiCandidate is false');
    assert.ok(!/\b(firstMatch|assertOnFirstMatch)\b/.test(executableLines(result.spec)), 'no chain in the executable body');
  });

  it('a zero-step check reports hasMultiCandidate FALSE (degenerate control)', () => {
    const result = generateBrowserSpec(mkSpecTest('syn-705-empty', []), new FlagCollector());
    assert.equal(result.hasMultiCandidate, false, 'a spec with no steps emits no chain');
  });

  it('the derivation scans the comment-stripped executable body: a commented reference cannot set the field', () => {
    // A hard-negative multi-candidate assertion emits comment lines that mention the
    // primary candidate and the reasoned-inference rationale, but never the firstMatch
    // token; even so, the derivation stripping comment lines is what guarantees a
    // commented-out chain (or any comment) can never falsely set the field. Assert the
    // field tracks the EXECUTABLE body only by confirming the hard-negative stays false
    // while its full spec text is scanned for the token only in executable lines.
    const hardNegStep = {
      name: 'Assert gone',
      type: 'assertElementContent',
      params: { check: 'notContains', value: 'Gone', element: multiEl },
    };
    const result = generateBrowserSpec(mkSpecTest('syn-706-cmt', [hardNegStep]), new FlagCollector());
    assert.equal(result.hasMultiCandidate, false, 'comment lines never set hasMultiCandidate');
    // Guard the premise: the derivation would flip if it scanned the raw spec including
    // comments AND a comment carried the token. Prove the executable body is chain-free.
    assert.ok(!/\bfirstMatch\b/.test(executableLines(result.spec)), 'no firstMatch in executable lines');
  });
});
