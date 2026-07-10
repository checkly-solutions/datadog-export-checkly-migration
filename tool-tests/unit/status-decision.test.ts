/**
 * Unit truth-table matrix for classifyStatus (Phase 04, STAT-03).
 *
 * classifyStatus is a pure function of two inputs (the monitor/search state and
 * the test's exported config status) and reads no environment, so this file
 * needs no dotenv, no fixtures, and no DD_TAGS_* save/restore hooks. Every row
 * of the LOCKED D-04/D-06 truth table is pinned here with a structural
 * deepStrictEqual assertion (never a snapshot).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStatus } from '../../src/shared/status-decision.ts';

describe('classifyStatus: D-04/D-06 truth table', () => {
  it('No Data + live -> active, reviewNoDataInDatadog (STAT-01)', () => {
    assert.deepStrictEqual(classifyStatus('No Data', 'live'), {
      deactivate: false,
      tag: 'reviewNoDataInDatadog',
      isReview: true,
    });
  });

  it('No Data + paused -> deactivated, noDataInDatadog (STAT-02, unchanged)', () => {
    assert.deepStrictEqual(classifyStatus('No Data', 'paused'), {
      deactivate: true,
      tag: 'noDataInDatadog',
      isReview: false,
    });
  });

  it('No Data + absent -> deactivated, reviewNoDataInDatadog (D-06)', () => {
    assert.deepStrictEqual(classifyStatus('No Data', undefined), {
      deactivate: true,
      tag: 'reviewNoDataInDatadog',
      isReview: true,
    });
  });

  it('Alert + any config status -> deactivated, failingInDatadog (unchanged)', () => {
    const expected = { deactivate: true, tag: 'failingInDatadog', isReview: false };
    assert.deepStrictEqual(classifyStatus('Alert', 'live'), expected);
    assert.deepStrictEqual(classifyStatus('Alert', 'paused'), expected);
    assert.deepStrictEqual(classifyStatus('Alert', undefined), expected);
  });

  it('OK + any config status -> active, no tag (unchanged)', () => {
    const expected = { deactivate: false, tag: null, isReview: false };
    assert.deepStrictEqual(classifyStatus('OK', 'live'), expected);
    assert.deepStrictEqual(classifyStatus('OK', 'paused'), expected);
  });

  it('Unknown + any config status -> active, no tag (monitor-not-found path unchanged)', () => {
    const expected = { deactivate: false, tag: null, isReview: false };
    assert.deepStrictEqual(classifyStatus('Unknown', 'live'), expected);
    assert.deepStrictEqual(classifyStatus('Unknown', 'paused'), expected);
  });
});
