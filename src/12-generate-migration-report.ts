/**
 * Generates a comprehensive migration report from the Datadog to Checkly migration.
 *
 * Reads all exported and converted JSON files to produce:
 *   - exports/migration-report.json (machine-readable)
 *   - exports/migration-report.md (human-readable)
 *
 * The report includes:
 *   - Summary of what was converted
 *   - What was NOT converted (and why)
 *   - Private locations that need to be created in Checkly
 *   - Environment variables that need values
 *   - Concrete next steps for the migration team
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const EXPORTS_DIR = './exports';
const CHECKLY_DIR = './checkly-migrated';

// Input files
const FILES = {
  exportSummary: path.join(EXPORTS_DIR, 'export-summary.json'),
  privateLocations: path.join(EXPORTS_DIR, 'private-locations.json'),
  apiChecks: path.join(EXPORTS_DIR, 'checkly-api-checks.json'),
  multiStepTests: path.join(EXPORTS_DIR, 'multi-step-tests.json'),
  browserTests: path.join(EXPORTS_DIR, 'browser-tests.json'),
  envVariables: path.join(CHECKLY_DIR, 'variables', 'env-variables.json'),
  secrets: path.join(CHECKLY_DIR, 'variables', 'secrets.json'),
  variableUsage: path.join(EXPORTS_DIR, 'variable-usage.json'),
  ddTestStatus: path.join(EXPORTS_DIR, 'dd-test-status.json'),
  browserManifestPublic: path.join(CHECKLY_DIR, 'tests', 'browser', 'public', '_manifest.json'),
  browserManifestPrivate: path.join(CHECKLY_DIR, 'tests', 'browser', 'private', '_manifest.json'),
  multiManifestPublic: path.join(CHECKLY_DIR, 'tests', 'multi', 'public', '_manifest.json'),
  multiManifestPrivate: path.join(CHECKLY_DIR, 'tests', 'multi', 'private', '_manifest.json'),
};

// Output files
const OUTPUT_JSON = path.join(EXPORTS_DIR, 'migration-report.json');
const OUTPUT_MD = path.join(EXPORTS_DIR, 'migration-report.md');

// Types for the input data
interface ExportSummary {
  exportedAt: string;
  site: string;
  summary: {
    apiTests: number;
    browserTests: number;
    globalVariables: number;
    privateLocations: number;
    publicLocations: number;
    unmappedLocations: number;
  };
}

interface PrivateLocation {
  datadogId: string;
  checklySlug: string;
  name?: string;
  usageCount: number;
  source: string;
}

interface PrivateLocationsFile {
  exportedAt: string;
  site: string;
  count: number;
  locations: PrivateLocation[];
}

interface ApiChecksFile {
  convertedAt: string;
  source: { exportedAt: string; site: string };
  summary: {
    total: number;
    converted: number;
    successful: number;
    failed: number;
    skippedMultiStep: number;
    skippedNonHttp: number;
  };
  skippedNonHttpTests: Record<string, Array<{ public_id: string; name: string }>>;
  privateLocationsFound: string[];
  checks: Array<{
    logicalId: string;
    name: string;
    privateLocations?: string[];
    _conversionError?: string;
  }>;
}

interface MultiStepTestsFile {
  exportedAt: string;
  site: string;
  count: number;
  tests: Array<{
    public_id: string;
    name: string;
    privateLocations?: string[];
  }>;
}

interface BrowserTestsFile {
  exportedAt: string;
  site: string;
  count: number;
  tests: Array<{
    public_id: string;
    name: string;
    privateLocations?: string[];
  }>;
}

interface Variable {
  key: string;
  value: string;
  locked: boolean;
}

interface VariableUsageEntry {
  usageCount: number;
  checks: string[];
}

interface VariableUsageFile {
  generatedAt: string;
  totalVariablesReferenced: number;
  variables: Record<string, VariableUsageEntry>;
}

interface Manifest {
  generatedAt: string;
  outputDir: string;
  locationType: string;
  files: Array<{ logicalId: string; name: string; filename: string }>;
  skipped?: Array<{ logicalId: string; name: string; reason?: string }>;
}

interface DdStatusCounts {
  total: number;
  passing: number;
  failing: number;
  noData: number;
  unknown: number;
  deactivated: number;
}

interface DdTestStatusFile {
  fetchedAt: string;
  site: string;
  summary: DdStatusCounts;
  publicSummary: DdStatusCounts;
  privateSummary: DdStatusCounts;
  tests: Array<{
    publicId: string;
    name: string;
    monitorId: number | null;
    overallState: string;
    isDeactivated: boolean;
    locationType: 'public' | 'private';
    fetchedAt: string;
  }>;
}

// Report structure
interface MigrationReport {
  generatedAt: string;
  source: {
    exportedAt: string;
    site: string;
  };
  summary: {
    totalDatadogTests: number;
    totalChecklyChecks: number;
    conversionRate: string;
  };
  converted: {
    apiChecks: { public: number; private: number; total: number };
    browserChecks: { public: number; private: number; total: number };
    multiStepChecks: { public: number; private: number; total: number };
  };
  notConverted: {
    nonHttpTests: {
      count: number;
      byType: Record<string, Array<{ publicId: string; name: string }>>;
    };
    failedConversions: {
      count: number;
      tests: Array<{ publicId: string; name: string; reason: string }>;
    };
    skippedFromManifests: Array<{ publicId: string; name: string; reason: string }>;
  };
  variables: {
    total: number;
    nonSecure: number;
    secureNeedingValues: number;
    secretKeys: string[];
    usage: {
      totalReferenced: number;
      byVariable: Record<string, { usageCount: number; checks: string[] }>;
    };
  };
  privateLocations: {
    count: number;
    locations: Array<{
      checklySlug: string;
      usageCount: number;
      datadogId: string;
    }>;
  };
  datadogStatus?: {
    checkedAt: string;
    summary: DdStatusCounts;
    publicSummary: DdStatusCounts;
    privateSummary: DdStatusCounts;
    deactivatedTests: Array<{
      publicId: string;
      name: string;
      reason: string;
      locationType: string;
    }>;
  };
  nextSteps: string[];
}

/**
 * Safely read and parse a JSON file, returning null if it doesn't exist
 */
async function readJsonFile<T>(filepath: string): Promise<T | null> {
  if (!existsSync(filepath)) {
    return null;
  }
  try {
    const content = await readFile(filepath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (err) {
    console.warn(`  Warning: Could not parse ${filepath}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Generate the markdown report
 */
function generateMarkdownReport(report: MigrationReport): string {
  const lines: string[] = [];

  lines.push('# Datadog to Checkly Migration Report');
  lines.push('');
  lines.push(`**Generated:** ${new Date(report.generatedAt).toLocaleString()}`);
  lines.push(`**Source:** ${report.source.site}`);
  lines.push(`**Export Date:** ${new Date(report.source.exportedAt).toLocaleString()}`);
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Datadog Synthetics:** ${report.summary.totalDatadogTests.toLocaleString()}`);
  lines.push(`- **Checkly Checks Created:** ${report.summary.totalChecklyChecks.toLocaleString()}`);
  lines.push(`- **Conversion Rate:** ${report.summary.conversionRate}`);
  lines.push('');

  // What was migrated
  lines.push('## What Was Migrated');
  lines.push('');
  lines.push('| Check Type | Public | Private | Total |');
  lines.push('|------------|--------|---------|-------|');
  lines.push(`| API Checks | ${report.converted.apiChecks.public} | ${report.converted.apiChecks.private} | ${report.converted.apiChecks.total} |`);
  lines.push(`| Browser Checks | ${report.converted.browserChecks.public} | ${report.converted.browserChecks.private} | ${report.converted.browserChecks.total} |`);
  lines.push(`| Multi-Step Checks | ${report.converted.multiStepChecks.public} | ${report.converted.multiStepChecks.private} | ${report.converted.multiStepChecks.total} |`);
  lines.push('');

  // What was NOT migrated
  if (report.notConverted.nonHttpTests.count > 0 || report.notConverted.failedConversions.count > 0) {
    lines.push('## What Was NOT Migrated');
    lines.push('');

    if (report.notConverted.nonHttpTests.count > 0) {
      lines.push(`### Non-HTTP Tests (${report.notConverted.nonHttpTests.count} tests)`);
      lines.push('');
      lines.push('Checkly does not support TCP/DNS/ICMP/SSL tests. These were skipped:');
      lines.push('');
      for (const [type, tests] of Object.entries(report.notConverted.nonHttpTests.byType)) {
        lines.push(`#### ${type.toUpperCase()} (${tests.length})`);
        lines.push('');
        for (const test of tests) {
          lines.push(`- \`${test.publicId}\` — ${test.name}`);
        }
        lines.push('');
      }
    }

    if (report.notConverted.failedConversions.count > 0) {
      lines.push(`### Failed Conversions (${report.notConverted.failedConversions.count} tests)`);
      lines.push('');
      lines.push('These tests could not be converted:');
      lines.push('');
      for (const test of report.notConverted.failedConversions.tests) {
        lines.push(`- \`${test.publicId}\` — ${test.name} (**${test.reason}**)`);
      }
      lines.push('');
      lines.push('> **Note:** Tests with unsupported HTTP methods (like OPTIONS) are skipped entirely.');
      lines.push('> Tests with JavaScript assertions are converted but without those assertions - review and add equivalent Playwright assertions manually.');
      lines.push('');
    }

    if (report.notConverted.skippedFromManifests.length > 0) {
      lines.push(`### Skipped Multi-Step/Browser Tests (${report.notConverted.skippedFromManifests.length} tests)`);
      lines.push('');
      lines.push('These tests were skipped during spec generation:');
      lines.push('');
      for (const test of report.notConverted.skippedFromManifests) {
        lines.push(`- \`${test.publicId}\` — ${test.name} (**${test.reason}**)`);
      }
      lines.push('');
    }
  }

  // Datadog Test Status at Migration Time
  if (report.datadogStatus) {
    const ds = report.datadogStatus;
    lines.push('## Datadog Test Status at Migration Time');
    lines.push('');
    lines.push(`**Checked at:** ${new Date(ds.checkedAt).toLocaleString()}`);
    lines.push('');
    lines.push('| Status | Public | Private | Total |');
    lines.push('|--------|--------|---------|-------|');
    lines.push(`| Passing (OK) | ${ds.publicSummary.passing} | ${ds.privateSummary.passing} | ${ds.summary.passing} |`);
    lines.push(`| Failing (Alert) | ${ds.publicSummary.failing} | ${ds.privateSummary.failing} | ${ds.summary.failing} |`);
    lines.push(`| No Data | ${ds.publicSummary.noData} | ${ds.privateSummary.noData} | ${ds.summary.noData} |`);
    lines.push(`| Unknown | ${ds.publicSummary.unknown} | ${ds.privateSummary.unknown} | ${ds.summary.unknown} |`);
    lines.push(`| **Total** | **${ds.publicSummary.total}** | **${ds.privateSummary.total}** | **${ds.summary.total}** |`);
    lines.push(`| **Deactivated** | **${ds.publicSummary.deactivated}** | **${ds.privateSummary.deactivated}** | **${ds.summary.deactivated}** |`);
    lines.push('');

    if (ds.deactivatedTests.length > 0) {
      const failingTests = ds.deactivatedTests.filter(t => t.reason === 'Alert');
      const noDataTests = ds.deactivatedTests.filter(t => t.reason === 'No Data');

      if (failingTests.length > 0) {
        lines.push(`### Failing Tests (${failingTests.length} — tagged \`failingInDatadog\`)`);
        lines.push('');
        const display = failingTests.slice(0, 25);
        for (const test of display) {
          lines.push(`- \`${test.publicId}\` [${test.locationType}] — ${test.name}`);
        }
        if (failingTests.length > 25) {
          lines.push(`- ... and ${failingTests.length - 25} more`);
        }
        lines.push('');
      }

      if (noDataTests.length > 0) {
        lines.push(`### No Data Tests (${noDataTests.length} — tagged \`noDataInDatadog\`)`);
        lines.push('');
        const display = noDataTests.slice(0, 25);
        for (const test of display) {
          lines.push(`- \`${test.publicId}\` [${test.locationType}] — ${test.name}`);
        }
        if (noDataTests.length > 25) {
          lines.push(`- ... and ${noDataTests.length - 25} more (see dd-test-status.json)`);
        }
        lines.push('');
      }

      lines.push('> **Action:** Review deactivated checks. Fix failing tests or re-activate paused tests as needed.');
      lines.push('');
    }
  }

  // Action Required
  lines.push('---');
  lines.push('');
  lines.push('## Action Required');
  lines.push('');

  // Private locations
  if (report.privateLocations.count > 0) {
    lines.push(`### 1. Create Private Locations in Checkly (${report.privateLocations.count} locations)`);
    lines.push('');
    lines.push('Create these private locations in Checkly with the **exact slugs** shown below.');
    lines.push('The generated checks already reference these slugs.');
    lines.push('');
    lines.push('| Checkly Slug (to create) | Checks Using It | Original Datadog ID |');
    lines.push('|--------------------------|-----------------|---------------------|');
    for (const loc of report.privateLocations.locations) {
      const truncatedId = loc.datadogId.length > 50
        ? loc.datadogId.substring(0, 47) + '...'
        : loc.datadogId;
      lines.push(`| \`${loc.checklySlug}\` | ${loc.usageCount} | ${truncatedId} |`);
    }
    lines.push('');
  }

  // Secret variables
  if (report.variables.secureNeedingValues > 0) {
    lines.push(`### 2. Fill in Secret Values (${report.variables.secureNeedingValues} variables)`);
    lines.push('');
    lines.push('Secure variables were exported without values (Datadog does not expose them).');
    lines.push('');
    lines.push('**Edit:** `checkly-migrated/variables/secrets.json`');
    lines.push('');

    // Show secrets with usage counts, sorted by priority (most used first)
    const secretsWithUsage = report.variables.secretKeys.map(key => ({
      key,
      usageCount: report.variables.usage.byVariable[key]?.usageCount || 0,
    })).sort((a, b) => b.usageCount - a.usageCount);

    const usedSecrets = secretsWithUsage.filter(s => s.usageCount > 0);
    const unusedSecrets = secretsWithUsage.filter(s => s.usageCount === 0);

    if (usedSecrets.length > 0) {
      lines.push('**Priority secrets** (used by checks - fill these first):');
      lines.push('');
      lines.push('| Variable | Checks Using It |');
      lines.push('|----------|-----------------|');
      // Show top 15 used secrets
      const displayUsedSecrets = usedSecrets.slice(0, 15);
      for (const secret of displayUsedSecrets) {
        lines.push(`| \`${secret.key}\` | ${secret.usageCount} |`);
      }
      if (usedSecrets.length > 15) {
        lines.push(`| ... | ${usedSecrets.length - 15} more in secrets.json |`);
      }
      lines.push('');
    }

    if (unusedSecrets.length > 0) {
      lines.push(`**Unused secrets** (${unusedSecrets.length} variables not referenced by any check):`);
      lines.push('');
      // Show first 5 unused, then summarize
      const displayUnused = unusedSecrets.slice(0, 5);
      for (const secret of displayUnused) {
        lines.push(`- \`${secret.key}\``);
      }
      if (unusedSecrets.length > 5) {
        lines.push(`- ... and ${unusedSecrets.length - 5} more`);
      }
      lines.push('');
      lines.push('> These may be legacy variables or used by tests that were not converted.');
      lines.push('');
    }
  }

  // Next steps
  lines.push('### 3. Import Variables to Checkly');
  lines.push('');
  lines.push('After filling in secret values:');
  lines.push('');
  lines.push('```bash');
  lines.push('npm run create:variables');
  lines.push('```');
  lines.push('');

  lines.push('### 4. Configure Alert Channels');
  lines.push('');
  lines.push('**Edit:** `checkly-migrated/default_resources/alertChannels.ts`');
  lines.push('');
  lines.push('Configure your alert channels (Email, Slack, PagerDuty, etc.) before deployment.');
  lines.push('');

  lines.push('### 5. Test the Migration');
  lines.push('');
  lines.push('```bash');
  lines.push('# Test public location checks');
  lines.push('npm run test:public');
  lines.push('');
  lines.push('# Test private location checks (after creating private locations)');
  lines.push('npm run test:private');
  lines.push('```');
  lines.push('');

  lines.push('### 6. Deploy to Checkly');
  lines.push('');
  lines.push('```bash');
  lines.push('# Deploy public checks first');
  lines.push('npm run deploy:public');
  lines.push('');
  lines.push('# Deploy private checks after creating private locations');
  lines.push('npm run deploy:private');
  lines.push('```');
  lines.push('');

  // Variable Usage Summary
  if (report.variables.usage.totalReferenced > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Environment Variable Usage');
    lines.push('');
    lines.push(`**${report.variables.usage.totalReferenced} unique variables** are referenced across all checks.`);
    lines.push('');

    // Sort all variables by usage count
    const allVarsWithUsage = Object.entries(report.variables.usage.byVariable)
      .map(([key, usage]) => ({ key, ...usage }))
      .sort((a, b) => b.usageCount - a.usageCount);

    if (allVarsWithUsage.length > 0) {
      lines.push('### Most Used Variables');
      lines.push('');
      lines.push('| Variable | Checks | Example Checks |');
      lines.push('|----------|--------|----------------|');

      // Show top 10 most used
      const topVars = allVarsWithUsage.slice(0, 10);
      for (const v of topVars) {
        const exampleChecks = v.checks.slice(0, 2).join(', ');
        const moreCount = v.checks.length > 2 ? ` (+${v.checks.length - 2} more)` : '';
        lines.push(`| \`${v.key}\` | ${v.usageCount} | ${exampleChecks}${moreCount} |`);
      }
      lines.push('');

      if (allVarsWithUsage.length > 10) {
        lines.push(`> See \`exports/variable-usage.json\` for complete usage details.`);
        lines.push('');
      }
    }
  }

  // Notes
  lines.push('---');
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('### Conversion Notes');
  lines.push('- Browser test element locators may need manual review for accuracy');
  lines.push('- Multi-step test variable extraction between steps may need adjustment');
  lines.push('- Check groups are created but set to `activated: false` by default');
  lines.push('- Individual checks preserve their Datadog status: `paused` monitors become `activated: false`');
  lines.push('');
  lines.push('### Unsupported Features');
  lines.push('The following Datadog features cannot be automatically migrated:');
  lines.push('');
  lines.push('| Feature | Reason |');
  lines.push('|---------|--------|');
  lines.push('| TCP/DNS/SSL/ICMP tests | Checkly doesn\'t have direct equivalents |');
  lines.push('| OPTIONS HTTP method | Checkly supports: GET, POST, PUT, HEAD, DELETE, PATCH |');
  lines.push('| JavaScript assertions | Custom JS assertions must be manually converted to Playwright |');
  lines.push('| Multi-step wait steps | Steps with `subtype: wait` are not supported |');
  lines.push('');

  return lines.join('\n');
}

/**
 * Main function
 */
async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Migration Report Generator');
  console.log('='.repeat(60));

  // Read all input files
  console.log('\nReading input files...');

  const exportSummary = await readJsonFile<ExportSummary>(FILES.exportSummary);
  const privateLocationsFile = await readJsonFile<PrivateLocationsFile>(FILES.privateLocations);
  const apiChecks = await readJsonFile<ApiChecksFile>(FILES.apiChecks);
  const multiStepTests = await readJsonFile<MultiStepTestsFile>(FILES.multiStepTests);
  const browserTests = await readJsonFile<BrowserTestsFile>(FILES.browserTests);
  const envVariables = await readJsonFile<Variable[]>(FILES.envVariables);
  const secrets = await readJsonFile<Variable[]>(FILES.secrets);
  const variableUsage = await readJsonFile<VariableUsageFile>(FILES.variableUsage);
  const browserManifestPublic = await readJsonFile<Manifest>(FILES.browserManifestPublic);
  const browserManifestPrivate = await readJsonFile<Manifest>(FILES.browserManifestPrivate);
  const multiManifestPublic = await readJsonFile<Manifest>(FILES.multiManifestPublic);
  const multiManifestPrivate = await readJsonFile<Manifest>(FILES.multiManifestPrivate);
  const ddTestStatus = await readJsonFile<DdTestStatusFile>(FILES.ddTestStatus);

  if (!exportSummary) {
    console.error('\nError: export-summary.json not found. Run the export first.');
    process.exit(1);
  }

  console.log('  - export-summary.json: found');
  console.log(`  - private-locations.json: ${privateLocationsFile ? 'found' : 'not found'}`);
  console.log(`  - checkly-api-checks.json: ${apiChecks ? 'found' : 'not found'}`);
  console.log(`  - multi-step-tests.json: ${multiStepTests ? 'found' : 'not found'}`);
  console.log(`  - browser-tests.json: ${browserTests ? 'found' : 'not found'}`);
  console.log(`  - env-variables.json: ${envVariables ? 'found' : 'not found'}`);
  console.log(`  - secrets.json: ${secrets ? 'found' : 'not found'}`);
  console.log(`  - variable-usage.json: ${variableUsage ? 'found' : 'not found'}`);
  console.log(`  - dd-test-status.json: ${ddTestStatus ? 'found' : 'not found'}`);

  // Calculate counts
  const apiPublicCount = apiChecks?.checks.filter(c =>
    !c._conversionError && (!c.privateLocations || c.privateLocations.length === 0)
  ).length || 0;
  const apiPrivateCount = apiChecks?.checks.filter(c =>
    !c._conversionError && c.privateLocations && c.privateLocations.length > 0
  ).length || 0;

  const browserPublicCount = browserManifestPublic?.files.length || 0;
  const browserPrivateCount = browserManifestPrivate?.files.length || 0;

  const multiPublicCount = multiManifestPublic?.files.length || 0;
  const multiPrivateCount = multiManifestPrivate?.files.length || 0;

  const totalChecklyChecks =
    apiPublicCount + apiPrivateCount +
    browserPublicCount + browserPrivateCount +
    multiPublicCount + multiPrivateCount;

  const totalDatadogTests = exportSummary.summary.apiTests + exportSummary.summary.browserTests;

  // Collect non-HTTP tests with names, grouped by type
  const nonHttpByType: Record<string, Array<{ publicId: string; name: string }>> = {};
  if (apiChecks?.skippedNonHttpTests) {
    for (const [type, tests] of Object.entries(apiChecks.skippedNonHttpTests)) {
      nonHttpByType[type] = tests.map(t => ({ publicId: t.public_id, name: t.name }));
    }
  }
  const nonHttpTotal = Object.values(nonHttpByType).reduce((sum, tests) => sum + tests.length, 0);

  // Collect failed conversions with names and reasons
  const failedChecks = apiChecks?.checks.filter(c => c._conversionError) || [];
  const failedTests: Array<{ publicId: string; name: string; reason: string }> = [];
  for (const check of failedChecks) {
    const error = check._conversionError || 'Unknown error';
    let reason: string;
    if (error.includes('Unsupported HTTP method')) {
      const methodMatch = error.match(/method: (\w+)/);
      reason = methodMatch ? `Unsupported HTTP method: ${methodMatch[1]}` : 'Unsupported HTTP method';
    } else if (error.includes('JavaScript')) {
      reason = 'JavaScript assertions not supported';
    } else {
      reason = error.length > 60 ? error.substring(0, 57) + '...' : error;
    }
    failedTests.push({ publicId: check.logicalId, name: check.name, reason });
  }

  // Collect skipped tests from manifests (multi-step and browser)
  const skippedFromManifests: Array<{ publicId: string; name: string; reason: string }> = [];
  const manifests = [browserManifestPublic, browserManifestPrivate, multiManifestPublic, multiManifestPrivate];
  for (const manifest of manifests) {
    if (manifest?.skipped) {
      for (const s of manifest.skipped) {
        skippedFromManifests.push({
          publicId: s.logicalId,
          name: s.name,
          reason: s.reason || 'Incompatible step types',
        });
      }
    }
  }

  // Build the report
  const report: MigrationReport = {
    generatedAt: new Date().toISOString(),
    source: {
      exportedAt: exportSummary.exportedAt,
      site: exportSummary.site,
    },
    summary: {
      totalDatadogTests,
      totalChecklyChecks,
      conversionRate: totalDatadogTests > 0
        ? `${Math.round((totalChecklyChecks / totalDatadogTests) * 100)}%`
        : '0%',
    },
    converted: {
      apiChecks: {
        public: apiPublicCount,
        private: apiPrivateCount,
        total: apiPublicCount + apiPrivateCount,
      },
      browserChecks: {
        public: browserPublicCount,
        private: browserPrivateCount,
        total: browserPublicCount + browserPrivateCount,
      },
      multiStepChecks: {
        public: multiPublicCount,
        private: multiPrivateCount,
        total: multiPublicCount + multiPrivateCount,
      },
    },
    notConverted: {
      nonHttpTests: {
        count: nonHttpTotal,
        byType: nonHttpByType,
      },
      failedConversions: {
        count: failedTests.length,
        tests: failedTests,
      },
      skippedFromManifests,
    },
    variables: {
      total: (envVariables?.length || 0) + (secrets?.length || 0),
      nonSecure: envVariables?.length || 0,
      secureNeedingValues: secrets?.length || 0,
      secretKeys: secrets?.map(s => s.key) || [],
      usage: {
        totalReferenced: variableUsage?.totalVariablesReferenced || 0,
        byVariable: variableUsage?.variables || {},
      },
    },
    privateLocations: {
      count: privateLocationsFile?.locations.length || 0,
      locations: (privateLocationsFile?.locations || []).map(loc => ({
        checklySlug: loc.checklySlug,
        usageCount: loc.usageCount,
        datadogId: loc.datadogId,
      })),
    },
    datadogStatus: ddTestStatus ? {
      checkedAt: ddTestStatus.fetchedAt,
      summary: ddTestStatus.summary,
      publicSummary: ddTestStatus.publicSummary,
      privateSummary: ddTestStatus.privateSummary,
      deactivatedTests: ddTestStatus.tests
        .filter(t => t.isDeactivated)
        .map(t => ({
          publicId: t.publicId,
          name: t.name,
          reason: t.overallState,
          locationType: t.locationType,
        })),
    } : undefined,
    nextSteps: [
      privateLocationsFile && privateLocationsFile.locations.length > 0
        ? `Create ${privateLocationsFile.locations.length} private location(s) in Checkly with the slugs shown in the report`
        : null,
      secrets && secrets.length > 0
        ? `Fill in values for ${secrets.length} secret variable(s) in checkly-migrated/variables/secrets.json`
        : null,
      ddTestStatus && ddTestStatus.summary.deactivated > 0
        ? `Review ${ddTestStatus.summary.deactivated} deactivated check(s) tagged "failingInDatadog" or "noDataInDatadog"`
        : null,
      'Run "npm run create:variables" to import variables to Checkly',
      'Configure alert channels in checkly-migrated/default_resources/alertChannels.ts',
      'Run "npm run test:public" to validate public checks',
      privateLocationsFile && privateLocationsFile.locations.length > 0
        ? 'Run "npm run test:private" to validate private checks (after creating private locations)'
        : null,
      'Run "npm run deploy:public" to deploy public checks',
      privateLocationsFile && privateLocationsFile.locations.length > 0
        ? 'Run "npm run deploy:private" to deploy private checks'
        : null,
    ].filter((step): step is string => step !== null),
  };

  // Generate outputs
  console.log('\nGenerating reports...');

  // JSON report
  await writeFile(OUTPUT_JSON, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`  Written: ${OUTPUT_JSON}`);

  // Markdown report
  const markdown = generateMarkdownReport(report);
  await writeFile(OUTPUT_MD, markdown, 'utf-8');
  console.log(`  Written: ${OUTPUT_MD}`);

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('Migration Report Summary');
  console.log('='.repeat(60));
  console.log(`  Datadog tests: ${report.summary.totalDatadogTests}`);
  console.log(`  Checkly checks: ${report.summary.totalChecklyChecks}`);
  console.log(`  Conversion rate: ${report.summary.conversionRate}`);
  console.log(`  Private locations to create: ${report.privateLocations.count}`);
  console.log(`  Secrets needing values: ${report.variables.secureNeedingValues}`);
  console.log(`  Variables referenced in checks: ${report.variables.usage.totalReferenced}`);

  if (report.notConverted.nonHttpTests.count > 0) {
    console.log(`  Non-HTTP tests skipped: ${report.notConverted.nonHttpTests.count}`);
  }

  if (report.datadogStatus) {
    console.log(`  Datadog tests failing: ${report.datadogStatus.summary.failing}`);
    console.log(`  Datadog tests no data: ${report.datadogStatus.summary.noData}`);
    console.log(`  Total checks deactivated: ${report.datadogStatus.deactivatedTests.length}`);
  }

  console.log('\nView the full report:');
  console.log(`  - ${OUTPUT_MD} (human-readable)`);
  console.log(`  - ${OUTPUT_JSON} (machine-readable)`);

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
