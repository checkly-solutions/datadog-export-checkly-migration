/**
 * Generation tests for the step-12 `## Migration Flags` report section (FLAG-03).
 *
 * Pins that generateMarkdownReport renders a `## Migration Flags` section grouped
 * by reason code (mirroring the `## Promoted Checks` idiom) when the report's
 * migrationFlags array is populated, renders no heading when it is empty or
 * absent (null-tolerant), numbers steps one-based for humans, omits the step
 * suffix for spec-level flags (stepIndex null), caps display at 25 with an
 * overflow line, and carries the D-04 reviewMigrationFlag tag copy plus the
 * greppable `// MIGRATION-FLAG:` action literal.
 *
 * The migrationFlags records are typed from the 07-01 cross-phase contract
 * (src/shared/migration-flags.ts), binding the report surface and the emitter at
 * the type level so they cannot drift.
 *
 * Structural assertions on returned strings only, never snapshots; no subprocess,
 * no file writes. Inputs are minimal in-memory synthetic objects (invented values
 * only per the Testing SOP: syn- publicIds, tool-authored messages, fixed
 * timestamps). No DD_TAGS_* mutation: this file imports no generator that calls
 * filterAndRemapTags, so it needs no save/restore hooks.
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateMarkdownReport } from '../../src/12-generate-migration-report.ts';
import type { MigrationFlag } from '../../src/shared/migration-flags.ts';

// A minimal MigrationReport carrying only the fields generateMarkdownReport
// requires, plus the new migrationFlags array under test. Returns any because
// MigrationReport is module-local to src/12. Fixed ISO timestamps; the tests
// never assert on rendered date lines (toLocaleString is locale-dependent).
// A multi-selector check record as the report carries it (derived in src/12
// main() from the browser manifests' hasMultiCandidate field). Kept minimal:
// publicId, name, locationType.
interface MultiSelectorCheck {
  publicId: string;
  name: string;
  locationType: 'public' | 'private';
}

function makeReport(
  migrationFlags: MigrationFlag[] | undefined,
  multiSelector?: { count: number; checks: MultiSelectorCheck[] },
): any {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    source: { exportedAt: '2026-01-01T00:00:00.000Z', site: 'datadoghq.com' },
    summary: { totalDatadogTests: 1, totalChecklyChecks: 1, conversionRate: '100%' },
    converted: {
      apiChecks: { public: 0, private: 0, total: 0 },
      browserChecks: { public: 1, private: 0, total: 1 },
      multiStepChecks: { public: 0, private: 0, total: 0 },
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
    promotions: [],
    migrationFlags,
    multiSelector,
    nextSteps: [],
  };
}

describe('step 12 Migration Flags section: reason-grouped, sourced from migration-flags.json', () => {
  it('renders the section grouped by reason with per-reason counts and every publicId', () => {
    const md = generateMarkdownReport(makeReport([
      { reason: 'locator-unresolvable', publicId: 'syn-flag-000', stepIndex: 2, message: 'zero candidate locator', deactivates: true },
      { reason: 'locator-unresolvable', publicId: 'syn-flag-001', stepIndex: 2, message: 'zero candidate locator', deactivates: true },
      { reason: 'wait-value-invalid', publicId: 'syn-flag-002', stepIndex: 0, message: 'wait value missing' },
    ]));
    assert.ok(md.includes('## Migration Flags'), 'section heading must appear');
    assert.ok(md.includes('### locator-unresolvable (2)'), 'locator-unresolvable subsection with count 2 must appear');
    assert.ok(md.includes('### wait-value-invalid (1)'), 'wait-value-invalid subsection with count 1 must appear');
    assert.ok(md.includes('syn-flag-000'), 'first flag publicId must appear');
    assert.ok(md.includes('syn-flag-001'), 'second flag publicId must appear');
    assert.ok(md.includes('syn-flag-002'), 'third flag publicId must appear');

    // 1-based numbering: stepIndex 0 renders as 'step 1' on the wait flag's line.
    const line = md.split('\n').find(l => l.includes('syn-flag-002'));
    assert.ok(line, 'the wait flag bullet line must exist');
    assert.ok(line!.includes('step 1'), 'stepIndex 0 must render as "step 1" (1-based)');
  });

  it('renders a spec-level flag (stepIndex null) without a step suffix', () => {
    const md = generateMarkdownReport(makeReport([
      { reason: 'zero-assertion', publicId: 'syn-flag-010', stepIndex: null, message: 'generated spec has no expect call' },
    ]));
    const line = md.split('\n').find(l => l.includes('syn-flag-010'));
    assert.ok(line, 'the zero-assertion flag bullet line must exist');
    assert.ok(!line!.includes('step'), 'a spec-level (stepIndex null) flag must carry no step suffix');
  });

  it('renders no section when migrationFlags is an empty array', () => {
    const md = generateMarkdownReport(makeReport([]));
    assert.ok(!md.includes('## Migration Flags'), 'no heading when migrationFlags is empty');
  });

  it('renders no section when migrationFlags is absent', () => {
    const md = generateMarkdownReport(makeReport(undefined));
    assert.ok(!md.includes('## Migration Flags'), 'no heading when migrationFlags is undefined');
  });

  it('caps a reason group at 25 bullets with a migration-flags.json overflow line', () => {
    const flags: MigrationFlag[] = [];
    for (let i = 0; i < 30; i++) {
      const id = `syn-flag-${String(i).padStart(3, '0')}`;
      flags.push({ reason: 'xpath-positional', publicId: id, stepIndex: 1, message: 'only positional xpath available' });
    }
    const md = generateMarkdownReport(makeReport(flags));
    const bulletLines = md.split('\n').filter(l => /^- `syn-flag-\d{3}`/.test(l));
    assert.equal(bulletLines.length, 25, 'exactly 25 flag bullets render when a group has 30');
    assert.ok(md.includes('and 5 more (see migration-flags.json)'), 'overflow line names the JSON artifact and the extra count');
  });

  it('names the reviewMigrationFlag tag and the greppable // MIGRATION-FLAG: literal in the copy', () => {
    const md = generateMarkdownReport(makeReport([
      { reason: 'unsupported-step-type', publicId: 'syn-flag-020', stepIndex: 3, message: 'unrecognized step type' },
    ]));
    assert.ok(md.includes('reviewMigrationFlag'), 'the section copy names the reviewMigrationFlag tag (D-04)');
    assert.ok(md.includes('// MIGRATION-FLAG:'), 'the action copy names the greppable inline marker literal (D-03)');
  });

  it('renders a weak-fallback-chain flag as its own Migration Flags subsection through the existing grouping (no src/12 change)', () => {
    const md = generateMarkdownReport(makeReport([
      { reason: 'weak-fallback-chain', publicId: 'syn-flag-030', stepIndex: 1, message: 'only structural fallbacks available' },
    ]));
    assert.ok(md.includes('## Migration Flags'), 'the Migration Flags section renders');
    assert.ok(md.includes('### weak-fallback-chain (1)'), 'a new Phase 8 reason code auto-appears as its own subsection with count');
    assert.ok(md.includes('syn-flag-030'), 'the flagged publicId appears under its reason subsection');
  });
});

describe('step 12 Self-Healing Locator Chains section: D-06 multi-selector review surface', () => {
  it('renders the section with the affected count, the reviewMultiSelector tag, and the MIGRATION-LOCATOR-EXHAUSTION token when checks carry the field', () => {
    const md = generateMarkdownReport(makeReport(undefined, {
      count: 2,
      checks: [
        { publicId: 'syn-ms-001', name: 'Login flow', locationType: 'public' },
        { publicId: 'syn-ms-002', name: 'Checkout flow', locationType: 'private' },
      ],
    }));
    assert.ok(md.includes('## Self-Healing Locator Chains'), 'the section heading must appear');
    assert.ok(md.includes('**2 check(s)**'), 'the bold affected-count sentence must appear');
    assert.ok(md.includes('reviewMultiSelector'), 'the section names the reviewMultiSelector tag (D-06)');
    assert.ok(md.includes('MIGRATION-LOCATOR-EXHAUSTION'), 'the section names the runtime exhaustion token');
    assert.ok(md.includes('syn-ms-001'), 'the first affected publicId must appear');
    assert.ok(md.includes('syn-ms-002'), 'the second affected publicId must appear');
    // The section stays after the Migration Flags heading position when both are present.
  });

  it('renders no section when multiSelector count is zero', () => {
    const md = generateMarkdownReport(makeReport(undefined, { count: 0, checks: [] }));
    assert.ok(!md.includes('## Self-Healing Locator Chains'), 'no heading when zero checks are affected');
  });

  it('renders no section when multiSelector is absent (null-tolerant)', () => {
    const md = generateMarkdownReport(makeReport(undefined, undefined));
    assert.ok(!md.includes('## Self-Healing Locator Chains'), 'no heading when the field is undefined');
  });

  it('caps the affected check list at 25 with an and-more line', () => {
    const checks: MultiSelectorCheck[] = [];
    for (let i = 0; i < 30; i++) {
      checks.push({ publicId: `syn-ms-${String(i).padStart(3, '0')}`, name: `Flow ${i}`, locationType: 'public' });
    }
    const md = generateMarkdownReport(makeReport(undefined, { count: 30, checks }));
    const bulletLines = md.split('\n').filter(l => /^- `syn-ms-\d{3}`/.test(l));
    assert.equal(bulletLines.length, 25, 'exactly 25 check bullets render when 30 are affected');
    assert.ok(md.includes('and 5 more'), 'the overflow line names the extra count');
  });

  it('adds a recommendations line naming the reviewMultiSelector tag when the count is positive', () => {
    const md = generateMarkdownReport(makeReport(undefined, {
      count: 1,
      checks: [{ publicId: 'syn-ms-010', name: 'Search flow', locationType: 'public' }],
    }));
    // The Action blockquote inside the section names the verify-and-remove guidance.
    assert.ok(
      md.includes('reviewMultiSelector') && /verify|remove the/i.test(md),
      'a positive count yields review guidance naming the tag',
    );
  });
});
