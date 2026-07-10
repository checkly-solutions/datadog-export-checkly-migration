/**
 * Generation tests for the step-12 `## Playwright Check Suites (Multi-Browser)`
 * report section and its two gated static notes (PWCS-03, plan 10-04).
 *
 * Pins that generateMarkdownReport:
 *   - renders the Playwright Check Suites section when report.playwrightCheckSuites
 *     is populated, listing each check plus its declared-vs-distinct engine counts
 *     (D-04 coverage-reduction visibility) and the D-07 private-location Checkly
 *     Agent 6.0.3 caveat when hasPrivateLocationCaveat is true;
 *   - renders NO section when the count is 0 or the field is absent (null-tolerant,
 *     mirrors every other conditional section);
 *   - renders the PLAYWRIGHT_NATIVE entitlement note (D-09) and the @playwright/test
 *     devDependency note each exactly once, gated on count > 0, never per-check;
 *   - surfaces the three new pwcs-* reason codes (plan 10-01) through the EXISTING
 *     reason-grouped Migration Flags section with zero source change to that section;
 *   - leaves generateMappingCsv's check_type column at 'browser' for a PWCS check
 *     (csv has no PWCS awareness and needs none).
 *
 * Sources for the flag/caveat/entitlement copy asserted here:
 *   - D-04: declared browser device profiles vs. distinct Playwright engine projects
 *     (pwcs-engines-deduped, plan 10-01/10-02).
 *   - D-07: multi-browser PWCS routed to a private location requires Checkly Agent
 *     6.0.3 or newer (pwcs-private-location-agent-version, plan 10-02).
 *   - D-09: PlaywrightCheck requires the PLAYWRIGHT_NATIVE entitlement (10-CONTEXT.md).
 *   - @playwright/test ^1.61.1: pinned by plan 10-03 (checkly@8.13.0's own dev pin).
 *
 * All fixtures are authored synthetic from scratch against the code's own input
 * interfaces (per the Testing SOP): syn- publicIds, invented check names 25 chars
 * or fewer, no timestamps asserted (toLocaleString is locale-dependent). Structural
 * assertions on returned strings only; no subprocess, no file writes, no network,
 * no wall clock, no randomness. This file imports no generator that calls
 * filterAndRemapTags, so it needs no DD_TAGS_* save/restore hooks.
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateMarkdownReport, generateMappingCsv } from '../../src/12-generate-migration-report.ts';
import type { MigrationFlag } from '../../src/shared/migration-flags.ts';

// A single PWCS check entry as the report carries it (derived in src/12 main()
// from the browser manifests' pwEngines field cross-referenced against
// browser-tests.json). Kept minimal to the fields the section renders.
interface PwcsCheck {
  publicId: string;
  name: string;
  locationType: 'public' | 'private';
  declaredBrowserCount: number;
  distinctEngineCount: number;
  hasPrivateLocationCaveat: boolean;
}

// Minimal MigrationReport carrying only the fields generateMarkdownReport reads,
// plus the playwrightCheckSuites / migrationFlags fields under test. Returns any
// because MigrationReport is module-local to src/12. Fixed ISO timestamps; the
// tests never assert on rendered date lines.
function makeReport(overrides: Record<string, unknown> = {}): any {
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
    nextSteps: [],
    ...overrides,
  };
}

describe('step 12 Playwright Check Suites (Multi-Browser) section', () => {
  it('renders the section with the check and its declared-vs-distinct counts (D-04) when present', () => {
    const checks: PwcsCheck[] = [{
      publicId: 'syn-601-pws',
      name: 'PWCS Report Test',
      locationType: 'public',
      declaredBrowserCount: 3,
      distinctEngineCount: 2,
      hasPrivateLocationCaveat: false,
    }];
    const md = generateMarkdownReport(makeReport({ playwrightCheckSuites: { count: 1, checks } }));
    assert.ok(md.includes('## Playwright Check Suites (Multi-Browser)'), 'section heading must appear');
    assert.ok(md.includes('syn-601-pws'), 'the PWCS check publicId must appear as a bullet');
    // D-04 visibility: both the declared browser count and the distinct engine count are surfaced.
    const line = md.split('\n').find(l => l.includes('syn-601-pws'));
    assert.ok(line, 'the PWCS check bullet line must exist');
    assert.ok(line!.includes('3'), 'the declared browser count (3) must appear on the bullet');
    assert.ok(line!.includes('2'), 'the distinct engine count (2) must appear on the bullet');
  });

  it('renders NO section when count is 0 (null-tolerant)', () => {
    const md = generateMarkdownReport(makeReport({ playwrightCheckSuites: { count: 0, checks: [] } }));
    assert.doesNotMatch(md, /## Playwright Check Suites \(Multi-Browser\)/, 'no heading when count is 0');
  });

  it('renders NO section when the field is absent (null-tolerant)', () => {
    const md = generateMarkdownReport(makeReport({ playwrightCheckSuites: undefined }));
    assert.doesNotMatch(md, /## Playwright Check Suites \(Multi-Browser\)/, 'no heading when field is undefined');
  });

  it('renders the D-07 private-location Agent 6.0.3 caveat only for a caveated check', () => {
    const withCaveat: PwcsCheck[] = [{
      publicId: 'syn-602-pwp',
      name: 'PWCS Private Test',
      locationType: 'private',
      declaredBrowserCount: 2,
      distinctEngineCount: 2,
      hasPrivateLocationCaveat: true,
    }];
    const mdWith = generateMarkdownReport(makeReport({ playwrightCheckSuites: { count: 1, checks: withCaveat } }));
    assert.ok(mdWith.includes('6.0.3'), 'the Checkly Agent version 6.0.3 must appear when hasPrivateLocationCaveat is true');

    const noCaveat: PwcsCheck[] = [{
      publicId: 'syn-603-pwq',
      name: 'PWCS Public Test',
      locationType: 'public',
      declaredBrowserCount: 2,
      distinctEngineCount: 2,
      hasPrivateLocationCaveat: false,
    }];
    const mdWithout = generateMarkdownReport(makeReport({ playwrightCheckSuites: { count: 1, checks: noCaveat } }));
    // The syn-603-pwq bullet (and its adjacent line) must carry no 6.0.3 caveat.
    const idx = mdWithout.split('\n').findIndex(l => l.includes('syn-603-pwq'));
    assert.ok(idx >= 0, 'the non-caveated check bullet must exist');
    const bulletBlock = mdWithout.split('\n').slice(idx, idx + 2).join('\n');
    assert.ok(!bulletBlock.includes('6.0.3'), 'a non-caveated check must not carry the 6.0.3 caveat on its bullet/continuation');
  });

  it('renders the PLAYWRIGHT_NATIVE entitlement note (D-09) only when count > 0', () => {
    const checks: PwcsCheck[] = [{
      publicId: 'syn-604-pwn',
      name: 'PWCS Entitlement Test',
      locationType: 'public',
      declaredBrowserCount: 2,
      distinctEngineCount: 2,
      hasPrivateLocationCaveat: false,
    }];
    const mdPresent = generateMarkdownReport(makeReport({ playwrightCheckSuites: { count: 1, checks } }));
    assert.ok(mdPresent.includes('PLAYWRIGHT_NATIVE'), 'the PLAYWRIGHT_NATIVE note renders when count > 0');

    const mdZero = generateMarkdownReport(makeReport({ playwrightCheckSuites: { count: 0, checks: [] } }));
    assert.ok(!mdZero.includes('PLAYWRIGHT_NATIVE'), 'the PLAYWRIGHT_NATIVE note does not render when count is 0');

    const mdAbsent = generateMarkdownReport(makeReport({ playwrightCheckSuites: undefined }));
    assert.ok(!mdAbsent.includes('PLAYWRIGHT_NATIVE'), 'the PLAYWRIGHT_NATIVE note does not render when the field is absent');
  });

  it('renders the @playwright/test devDependency note (npm install before test/deploy) only when count > 0', () => {
    const checks: PwcsCheck[] = [{
      publicId: 'syn-605-pwd',
      name: 'PWCS DevDep Test',
      locationType: 'public',
      declaredBrowserCount: 2,
      distinctEngineCount: 2,
      hasPrivateLocationCaveat: false,
    }];
    const mdPresent = generateMarkdownReport(makeReport({ playwrightCheckSuites: { count: 1, checks } }));
    assert.ok(mdPresent.includes('@playwright/test'), 'the @playwright/test note renders when count > 0');
    assert.ok(/npm install/i.test(mdPresent), 'the note tells the customer to run npm install in the generated project');

    const mdZero = generateMarkdownReport(makeReport({ playwrightCheckSuites: { count: 0, checks: [] } }));
    assert.ok(!mdZero.includes('@playwright/test'), 'the @playwright/test note does not render when count is 0');

    const mdAbsent = generateMarkdownReport(makeReport({ playwrightCheckSuites: undefined }));
    assert.ok(!mdAbsent.includes('@playwright/test'), 'the @playwright/test note does not render when the field is absent');
  });

  it('surfaces a pwcs-engines-deduped flag through the EXISTING Migration Flags section with no code change', () => {
    // This exercises pre-existing reason-grouped code (a locked non-regression proof
    // that the three new PWCS reason codes generalize through the untouched section).
    const flags: MigrationFlag[] = [{
      reason: 'pwcs-engines-deduped',
      publicId: 'syn-601-pws',
      stepIndex: null,
      message: 'Datadog declared 3 browser device profiles; deduplicated to 2 distinct Playwright engine project(s).',
    }];
    const md = generateMarkdownReport(makeReport({ migrationFlags: flags }));
    assert.ok(md.includes('## Migration Flags'), 'the existing Migration Flags section renders');
    assert.ok(md.includes('### pwcs-engines-deduped (1)'), 'the new reason code auto-appears as its own subsection with count');
    assert.ok(md.includes('syn-601-pws'), 'the flagged publicId appears under its reason subsection');
    assert.ok(md.includes('deduplicated to 2 distinct'), 'the flag message text appears in the bullet');
  });

  it('leaves generateMappingCsv check_type at "browser" for a PWCS-emitted browser test', () => {
    const browserTests: any = {
      exportedAt: '2026-01-01T00:00:00.000Z',
      site: 'datadoghq.com',
      count: 1,
      tests: [{
        public_id: 'syn-601-pws',
        name: 'PWCS Report Test',
        locations: ['us-east-1'],
        privateLocations: [],
        originalLocations: ['aws:us-east-1'],
      }],
    };
    const csv = generateMappingCsv(null, null, browserTests, null, new Set<string>(), new Set<string>());
    const row = csv.split('\n').find(l => l.startsWith('syn-601-pws,'));
    assert.ok(row, 'the browser test emits a mapping CSV row');
    // Columns: datadog_public_id,datadog_name,checkly_logical_id,checkly_uuid,check_type,...
    const checkType = row!.split(',')[4];
    assert.equal(checkType, 'browser', 'check_type stays "browser" for a PWCS check (no new "pwcs" type)');
  });
});
