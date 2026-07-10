/**
 * Unit tests for the assertionPolarity() classifier (Phase 8, plan 08-05, LOC-08).
 *
 * assertionPolarity is the whole cross-phase seam between this phase and Phase 9's
 * operator map: a PURE, TOTAL function returning only the two-value union
 * 'positive' | 'negative'. These tests lock the classification table plus totality
 * (the return is always one of the two values for any check string, so no odd
 * value ever silently falls through to an unhandled state).
 *
 * Positive: assertElementPresent (existence), and assertElementContent with
 * contains / equals / startsWith, plus notIsEmpty (non-emptiness is an existence
 * claim, not an absence trap). Negative: notContains / notEquals. Unknown and
 * missing checks classify positive: a wrong positive fails loudly at runtime, a
 * wrong negative is a false-green trap, so positive is the safe default. The flag
 * for unknown operators is emitted at the emission site (Task 2), never here; the
 * classifier stays pure with no collector and no step mutation.
 *
 * Every fixture value is synthetic: invented check strings, no customer data, no
 * network, no wall-clock, no randomness (Testing SOP).
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertionPolarity,
  type StepFlagContext,
} from '../../src/07-generate-browser-specs.ts';

// The classifier takes a BrowserStep; the type is not exported, so derive the
// parameter type from the exported function signature (the firstmatch-chain idiom).
type Step07 = Parameters<typeof assertionPolarity>[0];

// Silence the unused-import lint for StepFlagContext: it documents that the
// classifier does NOT take a context (purity), and keeps the import list aligned
// with the sibling suites for grep symmetry.
void (undefined as unknown as StepFlagContext);

function mkStep(type: string, check?: string): Step07 {
  const params = check === undefined ? {} : { check };
  return { name: 'Assert x', type, params } as Step07;
}

describe('assertionPolarity: positive classifications (LOC-08 part A)', () => {
  it('classifies assertElementPresent as positive (existence claim)', () => {
    assert.equal(assertionPolarity(mkStep('assertElementPresent')), 'positive');
  });

  it('classifies assertElementContent contains as positive', () => {
    assert.equal(assertionPolarity(mkStep('assertElementContent', 'contains')), 'positive');
  });

  it('classifies assertElementContent equals as positive', () => {
    assert.equal(assertionPolarity(mkStep('assertElementContent', 'equals')), 'positive');
  });

  it('classifies assertElementContent startsWith as positive', () => {
    assert.equal(assertionPolarity(mkStep('assertElementContent', 'startsWith')), 'positive');
  });

  it('classifies assertElementContent notIsEmpty as positive (non-emptiness is an existence claim)', () => {
    assert.equal(assertionPolarity(mkStep('assertElementContent', 'notIsEmpty')), 'positive');
  });
});

describe('assertionPolarity: negative classifications (LOC-08 part A)', () => {
  it('classifies assertElementContent notContains as negative', () => {
    assert.equal(assertionPolarity(mkStep('assertElementContent', 'notContains')), 'negative');
  });

  it('classifies assertElementContent notEquals as negative', () => {
    assert.equal(assertionPolarity(mkStep('assertElementContent', 'notEquals')), 'negative');
  });
});

describe('assertionPolarity: unknown and missing checks default positive (never silently mis-invert)', () => {
  it('classifies an unrecognized check string as positive', () => {
    assert.equal(assertionPolarity(mkStep('assertElementContent', 'someFutureOperator')), 'positive');
  });

  it('classifies a missing check as positive', () => {
    assert.equal(assertionPolarity(mkStep('assertElementContent')), 'positive');
  });

  it('classifies assertElementContent with an empty-string check as positive', () => {
    assert.equal(assertionPolarity(mkStep('assertElementContent', '')), 'positive');
  });
});

describe('assertionPolarity: totality sweep (pure, returns only the two-value union)', () => {
  it('always returns positive or negative for any odd check string', () => {
    const oddChecks = [
      'contains',
      'equals',
      'startsWith',
      'notIsEmpty',
      'notContains',
      'notEquals',
      'isEmpty',
      'matches',
      'doesNotMatch',
      'CONTAINS',
      'NotContains',
      'greaterThan',
      'lessThan',
      '   ',
      '\n',
      'not',
      'contains ',
      ' notContains',
      '123',
      'notContainsButWeird',
    ];
    for (const check of oddChecks) {
      const result = assertionPolarity(mkStep('assertElementContent', check));
      assert.ok(
        result === 'positive' || result === 'negative',
        `assertionPolarity(${JSON.stringify(check)}) returned ${JSON.stringify(result)}, not one of the two values`,
      );
    }
  });

  it('returns positive or negative for assertElementPresent regardless of an accidental check value', () => {
    const result = assertionPolarity(mkStep('assertElementPresent', 'notContains'));
    // assertElementPresent has no check semantics; the type alone drives it positive.
    assert.equal(result, 'positive');
  });
});
