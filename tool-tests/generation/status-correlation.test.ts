/**
 * Generation/behavior tests for the status-correlation seam.
 *
 * Chains the exported convertTest (step 02) into generateApiCheckCode (step 04)
 * to build a real emitted `.check.ts` source, then drives the pure
 * classifyStatus + applyOutcomeToSource seam over that source and asserts on the
 * returned string. All assertions are structural (key lines present or absent),
 * never full-string snapshots. No subprocess, no file writes.
 *
 * The mutation seam under test is pure (applyOutcomeToSource takes a string and
 * returns a string), which is why 10a's dotenv-polluted, unexported
 * deactivateCheckFile is not imported here.
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convertTest } from '../../src/02-convert-datadog-api-to-json.ts';
import { generateApiCheckCode } from '../../src/04-generate-api-check-constructs-from-json.ts';
import { classifyStatus, applyOutcomeToSource } from '../../src/shared/status-decision.ts';
import { projectDatadogStatusTests } from '../../src/12-generate-migration-report.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): any {
  return JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', 'unit', name), 'utf-8')
  );
}

const liveFixture = loadFixture('api-test-live-nodata.json');
const pausedFixture = loadFixture('api-test-private-paused.json');
const absentFixture = loadFixture('api-test-absent-status.json');

/**
 * generateApiCheckCode calls filterAndRemapTags, which reads DD_TAGS_EXCLUDE,
 * DD_TAGS_EXCLUDE_ALL, and DD_TAGS_REMAP at call time. Snapshot and clear all
 * three before the tests and restore them exactly afterwards so tag assertions
 * are stable on any machine and the tag-append case cannot leak DD_TAGS_EXCLUDE
 * into other tests or the developer shell.
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

describe('status-correlation: applyOutcomeToSource over emitted check source', () => {
  it('live + No Data keeps activated: true and gains reviewNoDataInDatadog', () => {
    const source = generateApiCheckCode(convertTest(liveFixture));
    assert.match(source, /activated:\s*true/, 'step 04 must emit activated: true for a live test');

    const out = applyOutcomeToSource(source, classifyStatus('No Data', 'live'));
    assert.match(out, /activated:\s*true/, 'the review-active case must not flip activated');
    assert.ok(out.includes('reviewNoDataInDatadog'), 'review tag must be appended');
    assert.ok(!out.includes('"noDataInDatadog"'), 'the plain noDataInDatadog tag must not be present');
  });

  it('paused + No Data flips activated: false and gains noDataInDatadog', () => {
    const source = generateApiCheckCode(convertTest(pausedFixture));
    const out = applyOutcomeToSource(source, classifyStatus('No Data', 'paused'));
    assert.match(out, /activated:\s*false/, 'paused No Data must deactivate');
    assert.ok(out.includes('noDataInDatadog'), 'noDataInDatadog tag must be appended');
  });

  it('absent-status + No Data flips activated: false and gains reviewNoDataInDatadog', () => {
    // The absent fixture omits the `status` key, so classifyStatus receives an
    // undefined config status: safe-by-default deactivation plus the review tag.
    const source = generateApiCheckCode(convertTest(absentFixture));
    const out = applyOutcomeToSource(source, classifyStatus('No Data', undefined));
    assert.match(out, /activated:\s*false/, 'absent-status No Data must deactivate');
    assert.ok(out.includes('reviewNoDataInDatadog'), 'reviewNoDataInDatadog tag must be appended');
    assert.ok(
      !out.includes('"noDataInDatadog"'),
      'the plain noDataInDatadog tag must not be present for the absent-status branch',
    );
  });

  it('flip gate flips activated: false when outcome.deactivate is true', () => {
    const source = generateApiCheckCode(convertTest(liveFixture));
    assert.match(source, /activated:\s*true/, 'baseline live source is activated: true');

    const out = applyOutcomeToSource(source, {
      deactivate: true,
      tag: 'failingInDatadog',
      isReview: false,
    });
    assert.match(out, /activated:\s*false/, 'the flip must run when outcome.deactivate is true');
    assert.ok(out.includes('failingInDatadog'), 'failingInDatadog tag must be appended');
  });

  it('review tag survives DD_TAGS_EXCLUDE because it is appended after step 04 filtering', () => {
    process.env.DD_TAGS_EXCLUDE = 'reviewNoDataInDatadog';
    try {
      const source = generateApiCheckCode(convertTest(liveFixture));
      assert.ok(
        !source.includes('reviewNoDataInDatadog'),
        'step 04 output must not carry the review tag (it is never a user tag)'
      );

      const out = applyOutcomeToSource(source, classifyStatus('No Data', 'live'));
      assert.ok(
        out.includes('reviewNoDataInDatadog'),
        'the review tag must be present after applyOutcomeToSource despite DD_TAGS_EXCLUDE'
      );
    } finally {
      delete process.env.DD_TAGS_EXCLUDE;
    }
  });
});

describe('status-correlation: step-12 projection categorizes a deactivated absent-status check as deactivated, not left active', () => {
  // Three dd-test-status rows covering the three No Data outcomes plus a
  // baseline. Only the fields projectDatadogStatusTests reads are meaningful;
  // the rest are synthetic (Pattern 5 invented values).
  const tests = [
    {
      // absent-status: deactivated AND review-tagged. Must land in the
      // deactivated list only, never under "left active for review".
      publicId: 'syn-105-abs',
      name: 'Absent Status Check',
      monitorId: 2105,
      overallState: 'No Data',
      isDeactivated: true,
      tag: 'reviewNoDataInDatadog',
      locationType: 'public' as const,
      fetchedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      // live No Data: left active, review-tagged. The only row that
      // belongs under "left active for review".
      publicId: 'syn-104-liv',
      name: 'Live No Data Check',
      monitorId: 2104,
      overallState: 'No Data',
      isDeactivated: false,
      tag: 'reviewNoDataInDatadog',
      locationType: 'public' as const,
      fetchedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      // paused No Data: deactivated, plain tag.
      publicId: 'syn-106-pau',
      name: 'Paused No Data Check',
      monitorId: 2106,
      overallState: 'No Data',
      isDeactivated: true,
      tag: 'noDataInDatadog',
      locationType: 'private' as const,
      fetchedAt: '2026-01-01T00:00:00.000Z',
    },
  ];

  it('excludes the deactivated absent-status check from reviewTests (left active)', () => {
    const { reviewTests } = projectDatadogStatusTests(tests);
    const absent = reviewTests.find(t => t.publicId === 'syn-105-abs');
    assert.equal(
      absent,
      undefined,
      'a deactivated reviewNoDataInDatadog check must NOT be rendered as left active for review',
    );
    // Only the genuinely-live case remains in the review list.
    assert.equal(reviewTests.length, 1, 'only the live No Data check is left active for review');
    assert.equal(reviewTests[0].publicId, 'syn-104-liv');
  });

  it('lists the deactivated absent-status check under deactivatedTests carrying its true tag', () => {
    const { deactivatedTests } = projectDatadogStatusTests(tests);
    const absent = deactivatedTests.find(t => t.publicId === 'syn-105-abs');
    assert.ok(absent, 'the deactivated absent-status check must appear in the deactivated list');
    assert.equal(absent!.reason, 'No Data');
    assert.equal(
      absent!.tag,
      'reviewNoDataInDatadog',
      'the deactivated list must carry the true tag so the No Data heading can group by it',
    );
    // The live check must never be double-listed as deactivated.
    assert.ok(
      !deactivatedTests.some(t => t.publicId === 'syn-104-liv'),
      'the live No Data check must not appear in the deactivated list',
    );
  });
});
