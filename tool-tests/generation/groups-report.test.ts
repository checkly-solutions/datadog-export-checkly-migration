/**
 * Generation tests for the group templates (step 11) and the report
 * generators (step 12) (VAL-01, D-04).
 *
 * Deliberately a smoke-level pin for step 12: its emission logic largely
 * lives inside main() and stays there per D-17; deeper report coverage
 * belongs to the phase that next touches src/12. Inputs are minimal
 * in-memory synthetic objects (Pattern 5 invented values only); no fixture
 * file needed. Structural assertions only, never snapshots (D-03); no
 * subprocess, no file writes (D-04).
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PRIVATE_GROUP, PUBLIC_GROUP } from '../../src/11-generate-groups.ts';
import { generateMappingCsv, generateMarkdownReport } from '../../src/12-generate-migration-report.ts';
import { uniqueLogicalId } from '../../src/shared/utils.ts';

describe('step 11 group templates: safe-by-default asserted, never changed', () => {
  it('PRIVATE_GROUP contains the CheckGroupV2 constructor with its logical id', () => {
    assert.ok(PRIVATE_GROUP.includes('new CheckGroupV2('), 'must instantiate CheckGroupV2');
    assert.ok(PRIVATE_GROUP.includes('"datadog-migrated-private-checks"'), 'private logical id must appear');
  });

  it('PRIVATE_GROUP is activated: false', () => {
    assert.ok(PRIVATE_GROUP.includes('activated: false'), 'private group must stay deactivated by default');
  });

  it('PUBLIC_GROUP contains the CheckGroupV2 constructor with its logical id', () => {
    assert.ok(PUBLIC_GROUP.includes('new CheckGroupV2('), 'must instantiate CheckGroupV2');
    assert.ok(PUBLIC_GROUP.includes('"datadog-migrated-public-checks"'), 'public logical id must appear');
  });

  it('PUBLIC_GROUP is activated: false', () => {
    assert.ok(PUBLIC_GROUP.includes('activated: false'), 'public group must stay deactivated by default');
  });
});

describe('step 12 generateMappingCsv: smoke pin', () => {
  const CSV_HEADER =
    'datadog_public_id,datadog_name,checkly_logical_id,checkly_uuid,check_type,location_type,dd_locations,checkly_locations,filename';

  // Minimal synthetic ApiChecksFile (invented values per Pattern 5).
  const apiChecks: Parameters<typeof generateMappingCsv>[0] = {
    convertedAt: '2026-01-01T00:00:00.000Z',
    source: { exportedAt: '2026-01-01T00:00:00.000Z', site: 'datadoghq.com' },
    summary: { total: 1, converted: 1, successful: 1, failed: 0, skippedMultiStep: 0, skippedNonHttp: 0 },
    skippedNonHttpTests: {},
    privateLocationsFound: [],
    checks: [
      {
        logicalId: 'syn-201-abc',
        name: 'Unit Mapping API',
        locations: ['us-east-1'],
        privateLocations: [],
        originalLocations: ['aws:us-east-1'],
        tags: ['env:synthetic'],
      },
    ],
  };

  it('starts with the header row', () => {
    const csv = generateMappingCsv(apiChecks, null, null, null, new Set(), new Set());
    assert.ok(csv.startsWith(CSV_HEADER), 'first line must be the column header row');
  });

  it('contains one data row per mapping entry carrying the synthetic public_id', () => {
    const csv = generateMappingCsv(apiChecks, null, null, null, new Set(), new Set());
    const rows = csv.trimEnd().split('\n');
    assert.strictEqual(rows.length, 2, 'header plus exactly one data row');
    assert.ok(rows[1].startsWith('syn-201-abc,'), 'data row must start with the Datadog public_id');
    assert.ok(
      rows[1].includes('api-unit-mapping-api-syn-201-abc'),
      'data row must carry the uniqueLogicalId with the public_id tail (the inline check.logicalId IS the Datadog public_id)',
    );
    assert.ok(rows[1].includes('FILL_AFTER_DEPLOY'), 'checkly_uuid must be the post-deploy placeholder');
  });

  it('emits header-only output when every input is empty', () => {
    const csv = generateMappingCsv(null, null, null, null, new Set(), new Set());
    assert.strictEqual(csv, CSV_HEADER + '\n', 'no inputs must yield the header row only');
  });
});

/**
 * Per-type CSV parity (DEPLOY-07, D-02, D-05). Every one of the five row types
 * must carry a checkly_logical_id computed by the SAME uniqueLogicalId helper the
 * construct emit sites use. Comparing against the imported helper (not a hardcoded
 * string) is the point: it proves the CSV writer and the emit sites share one
 * formula and can never drift. All values are invented per Pattern 5.
 */
describe('step 12 generateMappingCsv: per-type uniqueLogicalId parity', () => {
  // The CSV column index for checkly_logical_id (0-based): datadog_public_id,
  // datadog_name, checkly_logical_id, ...
  const LOGICAL_ID_COL = 2;

  // Return the checkly_logical_id cell of the single data row whose
  // datadog_public_id (column 0) equals publicId.
  const logicalIdFor = (csv: string, publicId: string): string => {
    const rows = csv.trimEnd().split('\n');
    const row = rows.find(r => r.startsWith(`${publicId},`));
    assert.ok(row, `a data row for ${publicId} must exist`);
    return (row as string).split(',')[LOGICAL_ID_COL];
  };

  const apiChecks: Parameters<typeof generateMappingCsv>[0] = {
    convertedAt: '2026-01-01T00:00:00.000Z',
    source: { exportedAt: '2026-01-01T00:00:00.000Z', site: 'datadoghq.com' },
    summary: { total: 1, converted: 1, successful: 1, failed: 0, skippedMultiStep: 0, skippedNonHttp: 0 },
    skippedNonHttpTests: {},
    privateLocationsFound: [],
    checks: [
      {
        logicalId: 'syn-201-abc',
        name: 'Parity API Check',
        locations: ['us-east-1'],
        privateLocations: [],
        originalLocations: ['aws:us-east-1'],
        tags: ['env:synthetic'],
      },
    ],
  };

  const multiStepTests: Parameters<typeof generateMappingCsv>[1] = {
    exportedAt: '2026-01-01T00:00:00.000Z',
    site: 'datadoghq.com',
    count: 1,
    tests: [
      {
        public_id: 'syn-202-def',
        name: 'Parity Multi Test',
        locations: ['us-east-1'],
        privateLocations: [],
        originalLocations: ['aws:us-east-1'],
      },
    ],
  };

  const browserTests: Parameters<typeof generateMappingCsv>[2] = {
    exportedAt: '2026-01-01T00:00:00.000Z',
    site: 'datadoghq.com',
    count: 1,
    tests: [
      {
        public_id: 'syn-203-ghi',
        name: 'Parity Browser Test',
        locations: ['us-east-1'],
        privateLocations: [],
        originalLocations: ['aws:us-east-1'],
      },
    ],
  };

  // Raw api-tests entries carrying tcp and dns subtypes. The CSV only emits a
  // tcp/dns row when the computed filename is present in the on-disk Set, so we
  // precompute those filenames and pass them in.
  const apiTestsRaw: Parameters<typeof generateMappingCsv>[3] = {
    exportedAt: '2026-01-01T00:00:00.000Z',
    site: 'datadoghq.com',
    count: 2,
    tests: [
      {
        public_id: 'syn-204-jkl',
        name: 'Parity TCP Monitor',
        subtype: 'tcp',
        locations: ['us-east-1'],
        privateLocations: [],
        originalLocations: ['aws:us-east-1'],
      },
      {
        public_id: 'syn-205-mno',
        name: 'Parity DNS Monitor',
        subtype: 'dns',
        locations: ['us-east-1'],
        privateLocations: [],
        originalLocations: ['aws:us-east-1'],
      },
    ],
  };

  // sanitizeFilename(name, publicId) now ALWAYS appends the dashed public_id tail
  // (DEPLOY-08 / D-07), so the on-disk gate keys on the slug + '-' + tail form.
  const tcpFilenames = new Set(['parity-tcp-monitor-syn-204-jkl.check.ts']);
  const dnsFilenames = new Set(['parity-dns-monitor-syn-205-mno.check.ts']);

  const csv = generateMappingCsv(
    apiChecks,
    multiStepTests,
    browserTests,
    apiTestsRaw,
    tcpFilenames,
    dnsFilenames,
  );

  it('api row logical id equals uniqueLogicalId("api", name, public_id)', () => {
    assert.strictEqual(
      logicalIdFor(csv, 'syn-201-abc'),
      uniqueLogicalId('api', 'Parity API Check', 'syn-201-abc'),
    );
  });

  it('multistep row logical id equals uniqueLogicalId("multi", name, public_id)', () => {
    assert.strictEqual(
      logicalIdFor(csv, 'syn-202-def'),
      uniqueLogicalId('multi', 'Parity Multi Test', 'syn-202-def'),
    );
  });

  it('browser row logical id equals uniqueLogicalId("browser", name, public_id)', () => {
    assert.strictEqual(
      logicalIdFor(csv, 'syn-203-ghi'),
      uniqueLogicalId('browser', 'Parity Browser Test', 'syn-203-ghi'),
    );
  });

  it('tcp row logical id equals uniqueLogicalId("tcp", name, public_id)', () => {
    assert.strictEqual(
      logicalIdFor(csv, 'syn-204-jkl'),
      uniqueLogicalId('tcp', 'Parity TCP Monitor', 'syn-204-jkl'),
    );
  });

  it('dns row logical id equals uniqueLogicalId("dns", name, public_id)', () => {
    assert.strictEqual(
      logicalIdFor(csv, 'syn-205-mno'),
      uniqueLogicalId('dns', 'Parity DNS Monitor', 'syn-205-mno'),
    );
  });
});

describe('step 12 generateMarkdownReport: smoke pin', () => {
  // Minimal synthetic MigrationReport (invented values per Pattern 5).
  const report: Parameters<typeof generateMarkdownReport>[0] = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    source: { exportedAt: '2026-01-01T00:00:00.000Z', site: 'datadoghq.com' },
    summary: { totalDatadogTests: 2, totalChecklyChecks: 2, conversionRate: '100%' },
    converted: {
      apiChecks: { public: 1, private: 0, total: 1 },
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
    nextSteps: ['Review generated checks'],
  };

  it('returns markdown with the report title', () => {
    const markdown = generateMarkdownReport(report);
    assert.ok(markdown.includes('# Datadog to Checkly Migration Report'), 'title heading must appear');
  });

  it('contains the top-level section headings', () => {
    const markdown = generateMarkdownReport(report);
    assert.ok(markdown.includes('## Summary'), 'Summary section must appear');
    assert.ok(markdown.includes('## What Was Migrated'), 'What Was Migrated section must appear');
    assert.ok(markdown.includes('## Action Required'), 'Action Required section must appear');
  });

  it('renders the converted counts into the migration table', () => {
    const markdown = generateMarkdownReport(report);
    assert.ok(markdown.includes('| API Checks | 1 | 0 | 1 |'), 'API check counts must render');
    assert.ok(markdown.includes('| Browser Checks | 1 | 0 | 1 |'), 'Browser check counts must render');
  });

  it('Phase 3: Conversion Notes records the redirect/TLS/cert emit convention (D-08)', () => {
    const markdown = generateMarkdownReport(report);
    assert.ok(
      markdown.includes('### Conversion Notes'),
      'the Conversion Notes subsection must be present',
    );
    assert.ok(
      markdown.includes('`followRedirects: false`'),
      'the convention bullet must name the followRedirects emit',
    );
    assert.ok(
      markdown.includes('`skipSSL: true`'),
      'the convention bullet must name the skipSSL emit',
    );
    assert.ok(
      markdown.includes('`ignoreHTTPSErrors: true`'),
      'the convention bullet must name the browser ignoreHTTPSErrors emit',
    );
    assert.ok(
      markdown.includes('Absent fields are omitted'),
      'the convention bullet must record the absent-is-omitted default-preservation rule',
    );
    assert.ok(
      !markdown.includes('—'),
      'the report copy must contain no em-dash character',
    );
  });
});

describe('step 12 review section: tag-keyed grouping', () => {
  // A DdStatusCounts-shaped scalar block; only the shape matters for rendering.
  const emptyCounts = {
    total: 0, passing: 0, failing: 0, noData: 0, unknown: 0, deactivated: 0,
  };

  // Minimal synthetic MigrationReport carrying a datadogStatus with two review
  // tags (Pattern 5 invented values only, no fixture file). The second tag is a
  // hypothetical future review tag; it must render with zero code change (D-09).
  const report: Parameters<typeof generateMarkdownReport>[0] = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    source: { exportedAt: '2026-01-01T00:00:00.000Z', site: 'datadoghq.com' },
    summary: { totalDatadogTests: 2, totalChecklyChecks: 2, conversionRate: '100%' },
    converted: {
      apiChecks: { public: 0, private: 0, total: 0 },
      browserChecks: { public: 0, private: 0, total: 0 },
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
    datadogStatus: {
      checkedAt: '2026-01-01T00:00:00.000Z',
      summary: emptyCounts,
      publicSummary: emptyCounts,
      privateSummary: emptyCounts,
      deactivatedTests: [],
      reviewTests: [
        {
          publicId: 'syn-301-abc',
          name: 'Review No Data Check',
          tag: 'reviewNoDataInDatadog',
          locationType: 'public',
        },
        {
          publicId: 'syn-302-def',
          name: 'Review Something Check',
          tag: 'reviewSomethingElse',
          locationType: 'private',
        },
      ],
    },
    nextSteps: ['Review generated checks'],
  };

  it('renders the top-level review section heading', () => {
    const markdown = generateMarkdownReport(report);
    assert.ok(
      markdown.includes('## Checks Left Active for Review'),
      'review section heading must appear when reviewTests is non-empty',
    );
  });

  it('renders a subsection for the reviewNoDataInDatadog tag with its check bullet', () => {
    const markdown = generateMarkdownReport(report);
    assert.ok(
      markdown.includes('### reviewNoDataInDatadog (1)'),
      'reviewNoDataInDatadog subsection must render keyed by the tag string',
    );
    assert.ok(
      markdown.includes('`syn-301-abc` [public]: Review No Data Check'),
      'the reviewNoDataInDatadog check bullet must render',
    );
  });

  it('auto-renders a second review tag as its own subsection with no code change (D-09)', () => {
    const markdown = generateMarkdownReport(report);
    assert.ok(
      markdown.includes('### reviewSomethingElse (1)'),
      'a hypothetical future review tag must appear as its own subsection, proving tag-keyed grouping',
    );
    assert.ok(
      markdown.includes('`syn-302-def` [private]: Review Something Check'),
      'the second review tag check bullet must render',
    );
  });
});
