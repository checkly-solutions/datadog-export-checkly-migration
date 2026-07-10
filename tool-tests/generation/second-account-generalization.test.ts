/**
 * VAL-10 second-account generalization smoke test.
 *
 * The Phase 8 locator fixes were designed against the primary-account census
 * (panw-it, 355 element steps). This suite proves they GENERALIZE to the second
 * account's distinct shape census WITHOUT overfitting: the pipeline does not
 * crash and does not regress on the two account-2-only surfaces (multiLocator.sd
 * shadow-DOM steps and the co "alt" textType), and the three load-bearing census
 * facts that generalize across both accounts hold behaviorally (co text is
 * lowercase, no role candidate ever derives from multiLocator.ro, zero
 * getByTestId emissions on a corpus with no data-testid).
 *
 * Pass bar (locked, 08-07 plan / 08-VALIDATION): does not regress and does not
 * crash on the second-account shapes. Account-specific ratios (userLocator
 * prevalence, id/hash prefixes) are EXPECTED to differ and are NOT asserted.
 *
 * Fixture: tool-tests/fixtures/second-account-surrogate/browser-tests.json is
 * authored SYNTHETIC from scratch against the src/07 local interfaces. It models
 * the SHAPES of the second account (sd nested multiLocator, co alt textType, six
 * strategies with an @-predicated at and a translate()-wrapping ro carrying no
 * role attribute, a css userLocator with failTestOnCannotLocate). No value is
 * copied or adapted from the real export; the fixture-integrity denylist gate is
 * the backstop, synthetic authorship is the defense.
 *
 * Determinism SOP: no network, no wall-clock, no randomness, no subprocess, no
 * file writes. Each case drives the exported pure generators with a fresh
 * FlagCollector and asserts structurally on the returned strings/arrays.
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  extractLocator,
  generateSpecFile as generateBrowserSpec,
  type StepFlagContext,
} from '../../src/07-generate-browser-specs.ts';
import { FlagCollector } from '../../src/shared/migration-flags.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface CoEntry { text?: string; textType?: string; relation?: string; tagName?: string }
interface SurrogateStep {
  name?: string;
  type: string;
  params?: {
    value?: string;
    check?: string;
    element?: {
      targetOuterHTML?: string;
      userLocator?: { values?: Array<{ type?: string; value?: string }>; failTestOnCannotLocate?: boolean };
      multiLocator?: Record<string, unknown> & { co?: string; sd?: { co?: string } };
    };
  };
}
interface SurrogateTest {
  public_id: string;
  name: string;
  steps?: SurrogateStep[];
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'second-account-surrogate', 'browser-tests.json'), 'utf-8')
) as { tests: SurrogateTest[] };

const [testA, testB, testC] = fixture.tests;

/** Fresh per-run flag context for driving a single spec generation. */
function mkCollector(): FlagCollector {
  return new FlagCollector();
}

/** Find a named step within a surrogate test (throws if absent, so a fixture rename fails loud). */
function stepByName(test: SurrogateTest, name: string): SurrogateStep {
  const found = (test.steps || []).find((s) => s.name === name);
  assert.ok(found, `fixture ${test.public_id} is missing the "${name}" step (fixture drifted)`);
  return found as SurrogateStep;
}

/** Generate a spec and return its text plus the flags fired during generation. */
function generate(test: SurrogateTest): { spec: string; reasons: string[]; usesHelpers: boolean } {
  const collector = mkCollector();
  const result = generateBrowserSpec(test as unknown as Parameters<typeof generateBrowserSpec>[0], collector);
  const reasons = collector.toFile().flags.map((f) => f.reason);
  return { spec: result.spec, reasons, usesHelpers: result.usesHelpers };
}

/** Element type extractLocator accepts (mirrors src/07's local ElementLocator). */
type ElementArg = Parameters<typeof extractLocator>[0];

describe('VAL-10 second-account generalization: no crash, no regress on second-account shapes', () => {
  it('no-crash bar: every surrogate test generates a spec without throwing', () => {
    for (const test of fixture.tests) {
      assert.doesNotThrow(
        () => generateBrowserSpec(test as unknown as Parameters<typeof generateBrowserSpec>[0], mkCollector()),
        `generateSpecFile threw for ${test.public_id}; second-account shapes must never crash the pipeline`
      );
    }
  });

  it('flag-not-drop: Test B sd step records exactly one shadow-dom-locator flag AND still emits a live chain', () => {
    const collector = mkCollector();
    const result = generateBrowserSpec(testB as unknown as Parameters<typeof generateBrowserSpec>[0], collector);
    const sdFlags = collector.toFile().flags.filter((f) => f.reason === 'shadow-dom-locator');
    assert.equal(sdFlags.length, 1, 'a single sd-bearing step must record exactly one shadow-dom-locator flag (flag, never silent drop)');
    // The sd step must still emit a LIVE locator chain: the shadow host is flagged,
    // but its top-level strategies still produce a firstMatch chain. The chain is
    // multi-candidate, so the spec imports and calls firstMatch.
    assert.ok(result.usesHelpers, 'the sd step still emits a live multi-candidate chain, so the spec references firstMatch');
    assert.ok(result.spec.includes('firstMatch('), 'the sd step must still emit a live firstMatch chain, not be dropped');
    // FID-06 (D-06): the flag message states the verified Playwright capability, not
    // the retired out-of-scope claim. Test B's sd step has non-xpath live candidates,
    // so it is a variant-A open-root-piercing message.
    assert.ok(
      /pierce open shadow roots automatically/i.test(sdFlags[0].message),
      'the sd flag must state that role/text/testId/CSS pierce open shadow roots automatically at runtime (FID-06 variant A)',
    );
    assert.ok(
      !/out of scope/i.test(sdFlags[0].message) && !/never attempted/i.test(sdFlags[0].message),
      'the retired out-of-scope / never-attempted wording must not appear in the sd flag message',
    );
  });

  it('alt-usable: Test A alt-only co step yields a text candidate whose value is the alt text', () => {
    const altStep = stepByName(testA, 'Assert logo image');
    const candidates = extractLocator(altStep.params?.element as ElementArg);
    const textCand = candidates.find((c) => c.source === 'text');
    assert.ok(textCand, 'the alt-only co step must yield a text candidate (alt is a usable text source)');
    assert.equal(textCand!.value, 'brand logo', 'the text candidate value must be the alt text verbatim');
  });

  it('zero-data-testid fact: no emitted spec contains a getByTestId call', () => {
    for (const test of fixture.tests) {
      const { spec } = generate(test);
      assert.ok(
        !spec.includes('getByTestId'),
        `${test.public_id} emitted a getByTestId call on a corpus with no data-testid; the census fact regressed`
      );
    }
  });

  it('ro-is-never-a-role fact: extractLocator on Test A ro-bearing steps yields no role-sourced candidate', () => {
    const clickStep = stepByName(testA, 'Click sign in');
    const candidates = extractLocator(clickStep.params?.element as ElementArg);
    assert.ok(candidates.length > 0, 'the ro-bearing step must still yield candidates (no crash, no empty drop)');
    assert.ok(
      !candidates.some((c) => c.source === 'role'),
      'a translate()-wrapping ro with no role attribute must never derive a role candidate (ro encodes zero real ARIA roles)'
    );
  });

  it('lowercase-co fact (fixture invariant): every co text entry in the fixture is lowercase', () => {
    const offenders: string[] = [];
    const scanCo = (raw: string | undefined, where: string): void => {
      if (!raw) return;
      let entries: CoEntry[];
      try {
        entries = JSON.parse(raw) as CoEntry[];
      } catch {
        assert.fail(`co at ${where} is not valid JSON; the fixture is malformed`);
        return;
      }
      for (const entry of entries) {
        if (entry.text && /[A-Z]/.test(entry.text)) offenders.push(`${where}: "${entry.text}"`);
      }
    };
    for (const test of fixture.tests) {
      for (const step of test.steps || []) {
        const ml = step.params?.element?.multiLocator;
        scanCo(ml?.co, `${test.public_id}/${step.name}`);
        scanCo(ml?.sd?.co, `${test.public_id}/${step.name}/sd`);
      }
    }
    assert.equal(offenders.length, 0, `co text must be 100% lowercase (census fact); offenders: ${offenders.join(', ')}`);
  });

  it('userLocator-first: Test C userLocator candidate is index 0 with the rewritten class-list selector', () => {
    const clickStep = stepByName(testC, 'Click saved card');
    const candidates = extractLocator(clickStep.params?.element as ElementArg);
    assert.ok(candidates.length > 0, 'the userLocator step must yield candidates');
    assert.equal(candidates[0].source, 'userLocator', 'a human-pinned userLocator must sit at index 0 (read first)');
    assert.equal(candidates[0].value, '.btn.primary.large', 'the space-separated class list must be rewritten to a dotted selector');
  });

  it('rejection-survivability: Test C dynamic-id step chain has no id candidate but keeps the ab rung, no crash', () => {
    const typeStep = stepByName(testC, 'Type into dynamic id');
    const candidates = extractLocator(typeStep.params?.element as ElementArg);
    assert.ok(
      !candidates.some((c) => c.source === 'id'),
      'a dynamic id (input<N>) must be rejected, never emitted as a candidate'
    );
    assert.ok(
      candidates.some((c) => c.source === 'ab'),
      'the ab fallback rung must survive so the step still emits (rejection is not a crash)'
    );
  });
});
