/**
 * Generation tests for the promotion marker tag (step 06) and the promotion
 * report section (step 12).
 *
 * Part A pins that generateMultiStepCheckCode appends the promotedFromApiCheck
 * marker tag for a promoted test (and only for a promoted test), and that the
 * marker survives a DD_TAGS_EXCLUDE that would match it (append-after-filtering,
 * threat). Part B pins that generateMarkdownReport renders a Promoted
 * Checks section grouped by reason when promotions is populated, and renders no
 * heading when it is empty.
 *
 * Structural assertions on returned strings only, never snapshots; no
 * subprocess, no file writes. Inputs are minimal in-memory synthetic
 * objects (Pattern 5 invented values only).
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateMultiStepCheckCode } from '../../src/06-generate-multi-step-constructs.ts';
import { generateMarkdownReport } from '../../src/12-generate-migration-report.ts';

/**
 * generateMultiStepCheckCode calls filterAndRemapTags, which reads
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

// A minimal promoted single-step test (invented values only). The step 06
// generator reads public_id, name, tags, options, locations, privateLocations,
// status and config; _promotionReason marks it as promoted.
function makePromotedTest(): any {
  return {
    public_id: 'syn-reg-body-000',
    name: 'Reg Body Promote',
    status: 'live',
    tags: ['env:synthetic', 'team:synth'],
    locations: ['us-east-1'],
    privateLocations: [],
    originalLocations: ['aws:us-east-1'],
    options: { tick_every: 300, retry: { count: 2, interval: 300 } },
    config: { steps: [{ request: {} }] },
    _promotionReason: 'regex',
  };
}

describe('step 06 marker tag: promotedFromApiCheck appended for promoted tests', () => {
  it('emits promotedFromApiCheck in the tags array when _promotionReason is present', () => {
    const code = generateMultiStepCheckCode(makePromotedTest(), 'reg-body-promote.spec.ts', 'public');
    assert.ok(code.includes('promotedFromApiCheck'), 'promoted check must carry the marker tag');
    assert.ok(code.includes('migration_check_id:syn-reg-body-000'), 'traceability tag must remain');
  });

  it('does not emit the marker tag when _promotionReason is absent', () => {
    const test = makePromotedTest();
    delete test._promotionReason;
    const code = generateMultiStepCheckCode(test, 'reg-body-promote.spec.ts', 'public');
    assert.ok(!code.includes('promotedFromApiCheck'), 'non-promoted check must not carry the marker tag');
  });

  it('marker survives DD_TAGS_EXCLUDE that matches it (append after filtering)', () => {
    process.env.DD_TAGS_EXCLUDE = 'promotedFromApiCheck';
    try {
      const code = generateMultiStepCheckCode(makePromotedTest(), 'reg-body-promote.spec.ts', 'public');
      assert.ok(code.includes('promotedFromApiCheck'), 'marker is appended after filtering, so it cannot be stripped');
    } finally {
      delete process.env.DD_TAGS_EXCLUDE;
    }
  });

  it('preserves frequency, activation and locations unchanged for a promoted check', () => {
    const code = generateMultiStepCheckCode(makePromotedTest(), 'reg-body-promote.spec.ts', 'public');
    assert.ok(code.includes('frequency: Frequency.EVERY_5M'), '300s maps to EVERY_5M');
    assert.ok(code.includes('activated: true'), 'live status preserves activation');
    assert.ok(code.includes('"us-east-1"'), 'locations preserved');
  });
});

// A minimal MigrationReport carrying only the fields generateMarkdownReport
// requires, plus the new promotions array under test.
function makeReport(promotions: Array<{ publicId: string; name: string; reason: string; locationType: string }>): any {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    source: { exportedAt: '2026-01-01T00:00:00.000Z', site: 'datadoghq.com' },
    summary: { totalDatadogTests: 2, totalChecklyChecks: 2, conversionRate: '100%' },
    converted: {
      apiChecks: { public: 0, private: 0, total: 0 },
      browserChecks: { public: 0, private: 0, total: 0 },
      multiStepChecks: { public: 2, private: 0, total: 2 },
      tcpMonitors: { public: 0, private: 0, total: 0 },
      dnsMonitors: { public: 0, private: 0, total: 0 },
    },
    notConverted: {
      nonHttpTests: { count: 0, byType: {} },
      failedConversions: { count: 0, tests: [] },
      skippedFromManifests: [],
    },
    variables: {
      total: 0,
      nonSecure: 0,
      secureNeedingValues: 0,
      secretKeys: [],
      usage: { totalReferenced: 0, byVariable: {} },
    },
    privateLocations: { count: 0, locations: [] },
    promotions,
    nextSteps: [],
  };
}

describe('step 12 Promoted Checks section: reason-grouped, sourced from _promotionReason', () => {
  it('renders the section and a regex subsection when promotions is populated', () => {
    const md = generateMarkdownReport(makeReport([
      { publicId: 'syn-reg-body-000', name: 'Reg Body Promote', reason: 'regex', locationType: 'public' },
      { publicId: 'syn-reg-hdr-001', name: 'Reg Header Promote', reason: 'regex', locationType: 'public' },
    ]));
    assert.ok(md.includes('## Promoted Checks'), 'section heading must appear');
    assert.ok(md.includes('### regex'), 'reason subsection must appear');
    assert.ok(md.includes('syn-reg-body-000'), 'first promoted publicId must appear');
    assert.ok(md.includes('syn-reg-hdr-001'), 'second promoted publicId must appear');
  });

  it('renders no section when promotions is empty', () => {
    const md = generateMarkdownReport(makeReport([]));
    assert.ok(!md.includes('## Promoted Checks'), 'no heading when promotions is empty');
    assert.ok(!md.includes('### regex'), 'no subsection when promotions is empty');
  });
});
