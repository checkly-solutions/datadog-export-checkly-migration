/**
 * Generates a comprehensive migration report from the Datadog to Checkly migration.
 *
 * Reads all exported and converted JSON files to produce:
 *   - exports/migration-report.json (machine-readable)
 *   - exports/migration-report.md (human-readable)
 *   - migration-mapping.csv (Datadog-to-Checkly ID mapping)
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
import { getOutputRoot, getExportsDir } from './shared/output-config.ts';
import { generateLogicalId, sanitizeFilename } from './shared/utils.ts';

let EXPORTS_DIR = '';
let CHECKLY_DIR = '';

// Input files - initialized in main() after CHECKLY_DIR is set
let FILES: {
  exportSummary: string;
  privateLocations: string;
  apiChecks: string;
  multiStepTests: string;
  browserTests: string;
  envVariables: string;
  secrets: string;
  variableUsage: string;
  ddTestStatus: string;
  missingSecretsReport: string;
  browserManifestPublic: string;
  browserManifestPrivate: string;
  multiManifestPublic: string;
  multiManifestPrivate: string;
};

// Output files - initialized in main() after CHECKLY_DIR is set
let OUTPUT_JSON = '';
let OUTPUT_MD = '';
let OUTPUT_CSV = '';

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
    locations?: string[];
    privateLocations?: string[];
    originalLocations?: string[];
    tags?: string[];
    hasCertificate?: boolean;
    request?: {
      certificate?: {
        key?: { filename?: string };
        cert?: { filename?: string };
      };
    };
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
    locations?: string[];
    privateLocations?: string[];
    originalLocations?: string[];
    tags?: string[];
    hasCertificate?: boolean;
    config?: {
      steps?: Array<{
        request?: {
          certificate?: {
            key?: { filename?: string };
            cert?: { filename?: string };
          };
        };
      }>;
    };
  }>;
}

interface BrowserTestsFile {
  exportedAt: string;
  site: string;
  count: number;
  tests: Array<{
    public_id: string;
    name: string;
    locations?: string[];
    privateLocations?: string[];
    originalLocations?: string[];
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

interface MissingSecretsReportFile {
  generatedAt: string;
  totalSecrets: number;
  secretsWithEmptyValues: number;
  checksAffected: number;
  filesModified: number;
  filesSkipped: number;
  errors: number;
  affectedChecks: Array<{
    checkName: string;
    missingSecrets: string[];
  }>;
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
  missingSecrets?: {
    checkedAt: string;
    checksAffected: number;
    filesModified: number;
    affectedChecks: Array<{
      checkName: string;
      missingSecrets: string[];
    }>;
  };
  checkLevelSecrets?: {
    totalEntries: number;
    uniqueChecks: number;
    entries: Array<{ checkName: string; key: string }>;
  };
  clientCertificates?: {
    totalChecks: number;
    checks: Array<{
      checkName: string;
      checkType: 'api' | 'multistep';
      publicId: string;
      certFiles: { key?: string; cert?: string };
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

  // Checks Deactivated Due to Missing Secrets
  if (report.missingSecrets && report.missingSecrets.checksAffected > 0) {
    const ms = report.missingSecrets;
    lines.push('## Checks Deactivated Due to Missing Secrets');
    lines.push('');
    lines.push(`**${ms.checksAffected} check(s)** were deactivated because they reference secret variables with empty values.`);
    lines.push(`These checks are tagged with \`missingSecretsFromDatadog\` and set to \`activated: false\`.`);
    lines.push('');
    lines.push('| Check | Missing Secrets |');
    lines.push('|-------|-----------------|');
    const display = ms.affectedChecks.slice(0, 25);
    for (const ac of display) {
      lines.push(`| ${ac.checkName} | \`${ac.missingSecrets.join('`, `')}\` |`);
    }
    if (ms.affectedChecks.length > 25) {
      lines.push(`| ... | ${ms.affectedChecks.length - 25} more (see missing-secrets-report.json) |`);
    }
    lines.push('');
    lines.push('> **Action:** Fill in secret values in `variables/secrets.json`, then remove the `missingSecretsFromDatadog` tag and set `activated: true` to re-enable these checks.');
    lines.push('');
  }

  // Check-Level Secrets Requiring Manual Values (D-06)
  if (report.checkLevelSecrets && report.checkLevelSecrets.totalEntries > 0) {
    const cls = report.checkLevelSecrets;
    lines.push('## Check-Level Secrets Requiring Manual Values');
    lines.push('');
    lines.push(`**${cls.totalEntries} secret(s)** across **${cls.uniqueChecks} check(s)** were migrated from Datadog \`configVariables\` with \`secure: true\`.`);
    lines.push('These need values filled in within the generated \`.check.ts\` files or via \`variables/secrets.json\` \`checkLevel\` entries.');
    lines.push('');
    lines.push('| Check | Secret Key |');
    lines.push('|-------|------------|');
    const display = cls.entries.slice(0, 25);
    for (const entry of display) {
      lines.push(`| ${entry.checkName} | \`${entry.key}\` |`);
    }
    if (cls.entries.length > 25) {
      lines.push(`| ... | ${cls.entries.length - 25} more (see secrets.json checkLevel) |`);
    }
    lines.push('');
    lines.push('> **Action:** Fill in secret values in `variables/secrets.json` under the `checkLevel` section. The operator opens one file to see all secrets needing values.');
    lines.push('');
  }

  // Checks Requiring Client Certificates (mTLS)
  if (report.clientCertificates && report.clientCertificates.totalChecks > 0) {
    const cc = report.clientCertificates;
    lines.push('## Checks Requiring Client Certificates (mTLS)');
    lines.push('');
    lines.push(`**${cc.totalChecks} check(s)** require client certificates for mutual TLS authentication.`);
    lines.push(`These checks are tagged with \`requiresClientCertificate\` and set to \`activated: false\`.`);
    lines.push('');
    lines.push('| Check | Type | Key File | Cert File |');
    lines.push('|-------|------|----------|-----------|');
    const display = cc.checks.slice(0, 25);
    for (const c of display) {
      lines.push(`| ${c.checkName} | ${c.checkType} | \`${c.certFiles.key || 'N/A'}\` | \`${c.certFiles.cert || 'N/A'}\` |`);
    }
    if (cc.checks.length > 25) {
      lines.push(`| ... | | | ${cc.checks.length - 25} more (see migration-report.json) |`);
    }
    lines.push('');
    lines.push('> **Action:** Upload your client certificate key and cert files to Checkly and configure them on each affected check. Then remove the `requiresClientCertificate` tag and set `activated: true` to enable these checks.');
    lines.push('');
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
    lines.push(`**Edit:** \`${CHECKLY_DIR}/variables/secrets.json\``);
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
  lines.push(`After filling in secret values, run from \`${CHECKLY_DIR}/\`:`);
  lines.push('');
  lines.push('```bash');
  lines.push('npm run create-variables');
  lines.push('```');
  lines.push('');

  lines.push('### 4. Configure Alert Channels');
  lines.push('');
  lines.push(`**Edit:** \`${CHECKLY_DIR}/default_resources/alertChannels.ts\``);
  lines.push('');
  lines.push('Configure your alert channels (Email, Slack, PagerDuty, etc.) before deployment.');
  lines.push('');

  lines.push('### 5. Test the Migration');
  lines.push('');
  lines.push(`Run from \`${CHECKLY_DIR}/\`:`);
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
  lines.push(`Run from \`${CHECKLY_DIR}/\`:`);
  lines.push('');
  lines.push('```bash');
  lines.push('# Deploy public checks first');
  lines.push('npm run deploy:public');
  lines.push('');
  lines.push('# Deploy private checks after creating private locations');
  lines.push('npm run deploy:private');
  lines.push('```');
  lines.push('');

  lines.push('### 7. Backfill Checkly UUIDs');
  lines.push('');
  lines.push('After deploying, populate the `checkly_uuid` column in `migration-mapping.csv`:');
  lines.push('');
  lines.push('```bash');
  lines.push('npm run update-mapping');
  lines.push('```');
  lines.push('');
  lines.push('This matches deployed checks by their `migration_check_id` tag and writes the Checkly UUID into the CSV for downstream tooling and dashboards.');
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
        lines.push(`> See \`${CHECKLY_DIR}/exports/variable-usage.json\` for complete usage details.`);
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
 * Escape a CSV field value. Wraps in double quotes if the value contains
 * commas, double quotes, or newlines. Internal double quotes are doubled.
 */
function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Generate migration-mapping.csv with Datadog-to-Checkly ID mapping.
 *
 * Columns: datadog_public_id, datadog_name, checkly_logical_id, checkly_uuid, check_type,
 *          location_type, dd_locations, checkly_locations, filename
 *
 * checkly_uuid is always FILL_AFTER_DEPLOY — run `npm run update-mapping` post-deploy to backfill.
 * dd_locations: semicolon-separated original Datadog location strings.
 * checkly_locations: semicolon-separated Checkly public + private location slugs.
 */
function generateMappingCsv(
  apiChecks: ApiChecksFile | null,
  multiStepTests: MultiStepTestsFile | null,
  browserTests: BrowserTestsFile | null,
): string {
  const rows: string[] = [
    'datadog_public_id,datadog_name,checkly_logical_id,checkly_uuid,check_type,location_type,dd_locations,checkly_locations,filename',
  ];

  // API checks
  if (apiChecks?.checks) {
    for (const check of apiChecks.checks) {
      if (check._conversionError) continue;
      const publicId = check.logicalId; // In API checks JSON, logicalId IS the Datadog public_id
      const checklyId = `api-${generateLogicalId(check.name)}`;
      const filename = `${sanitizeFilename(check.name)}.check.ts`;
      const locationType = check.privateLocations && check.privateLocations.length > 0 ? 'private' : 'public';
      const ddLocs = csvEscape((check.originalLocations || []).join(';'));
      const checklyLocs = csvEscape([...(check.locations || []), ...(check.privateLocations || [])].join(';'));
      rows.push(`${publicId},${csvEscape(check.name)},${checklyId},FILL_AFTER_DEPLOY,api,${locationType},${ddLocs},${checklyLocs},${filename}`);
    }
  }

  // Multi-step tests
  if (multiStepTests?.tests) {
    for (const test of multiStepTests.tests) {
      const checklyId = `multi-${generateLogicalId(test.name)}`;
      const filename = `${sanitizeFilename(test.name)}.check.ts`;
      const locationType = test.privateLocations && test.privateLocations.length > 0 ? 'private' : 'public';
      const ddLocs = csvEscape((test.originalLocations || []).join(';'));
      const checklyLocs = csvEscape([...(test.locations || []), ...(test.privateLocations || [])].join(';'));
      rows.push(`${test.public_id},${csvEscape(test.name)},${checklyId},FILL_AFTER_DEPLOY,multistep,${locationType},${ddLocs},${checklyLocs},${filename}`);
    }
  }

  // Browser tests
  if (browserTests?.tests) {
    for (const test of browserTests.tests) {
      const checklyId = `browser-${generateLogicalId(test.name)}`;
      const filename = `${sanitizeFilename(test.name)}.check.ts`;
      const locationType = test.privateLocations && test.privateLocations.length > 0 ? 'private' : 'public';
      const ddLocs = csvEscape((test.originalLocations || []).join(';'));
      const checklyLocs = csvEscape([...(test.locations || []), ...(test.privateLocations || [])].join(';'));
      rows.push(`${test.public_id},${csvEscape(test.name)},${checklyId},FILL_AFTER_DEPLOY,browser,${locationType},${ddLocs},${checklyLocs},${filename}`);
    }
  }

  return rows.join('\n') + '\n';
}

/**
 * Main function
 */
async function main(): Promise<void> {
  CHECKLY_DIR = await getOutputRoot();
  EXPORTS_DIR = await getExportsDir();
  OUTPUT_JSON = path.join(CHECKLY_DIR, 'migration-report.json');
  OUTPUT_MD = path.join(CHECKLY_DIR, 'migration-report.md');
  OUTPUT_CSV = path.join(CHECKLY_DIR, 'migration-mapping.csv');
  FILES = {
    exportSummary: path.join(EXPORTS_DIR, 'export-summary.json'),
    privateLocations: path.join(EXPORTS_DIR, 'private-locations.json'),
    apiChecks: path.join(EXPORTS_DIR, 'checkly-api-checks.json'),
    multiStepTests: path.join(EXPORTS_DIR, 'multi-step-tests.json'),
    browserTests: path.join(EXPORTS_DIR, 'browser-tests.json'),
    envVariables: path.join(CHECKLY_DIR, 'variables', 'env-variables.json'),
    secrets: path.join(CHECKLY_DIR, 'variables', 'secrets.json'),
    variableUsage: path.join(EXPORTS_DIR, 'variable-usage.json'),
    ddTestStatus: path.join(EXPORTS_DIR, 'dd-test-status.json'),
    missingSecretsReport: path.join(EXPORTS_DIR, 'missing-secrets-report.json'),
    browserManifestPublic: path.join(CHECKLY_DIR, 'tests', 'browser', 'public', '_manifest.json'),
    browserManifestPrivate: path.join(CHECKLY_DIR, 'tests', 'browser', 'private', '_manifest.json'),
    multiManifestPublic: path.join(CHECKLY_DIR, 'tests', 'multi', 'public', '_manifest.json'),
    multiManifestPrivate: path.join(CHECKLY_DIR, 'tests', 'multi', 'private', '_manifest.json'),
  };

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
  const secretsRaw = await readJsonFile<Variable[] | { global: Variable[]; checkLevel: Array<{ checkName: string; key: string; value: string; locked: boolean }> }>(FILES.secrets);
  // Normalize: extract global secrets for backward compat
  const secrets = secretsRaw ? (Array.isArray(secretsRaw) ? secretsRaw : secretsRaw.global || []) : null;
  const checkLevelSecrets = secretsRaw && !Array.isArray(secretsRaw) ? secretsRaw.checkLevel || [] : [];
  const variableUsage = await readJsonFile<VariableUsageFile>(FILES.variableUsage);
  const browserManifestPublic = await readJsonFile<Manifest>(FILES.browserManifestPublic);
  const browserManifestPrivate = await readJsonFile<Manifest>(FILES.browserManifestPrivate);
  const multiManifestPublic = await readJsonFile<Manifest>(FILES.multiManifestPublic);
  const multiManifestPrivate = await readJsonFile<Manifest>(FILES.multiManifestPrivate);
  const ddTestStatus = await readJsonFile<DdTestStatusFile>(FILES.ddTestStatus);
  const missingSecretsReport = await readJsonFile<MissingSecretsReportFile>(FILES.missingSecretsReport);

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
  console.log(`  - missing-secrets-report.json: ${missingSecretsReport ? 'found' : 'not found'}`);

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

  // Collect checks requiring client certificates (mTLS)
  const certChecks: Array<{
    checkName: string;
    checkType: 'api' | 'multistep';
    publicId: string;
    certFiles: { key?: string; cert?: string };
  }> = [];

  // From API checks
  if (apiChecks?.checks) {
    for (const check of apiChecks.checks) {
      if (check.hasCertificate || check.tags?.includes('requiresClientCertificate')) {
        certChecks.push({
          checkName: check.name,
          checkType: 'api',
          publicId: check.logicalId,
          certFiles: {
            key: check.request?.certificate?.key?.filename,
            cert: check.request?.certificate?.cert?.filename,
          },
        });
      }
    }
  }

  // From multi-step tests
  if (multiStepTests?.tests) {
    for (const test of multiStepTests.tests) {
      if (test.hasCertificate || test.tags?.includes('requiresClientCertificate')) {
        const keyFiles: string[] = [];
        const certFileNames: string[] = [];
        for (const step of (test.config?.steps || [])) {
          if (step.request?.certificate?.key?.filename && !keyFiles.includes(step.request.certificate.key.filename)) {
            keyFiles.push(step.request.certificate.key.filename);
          }
          if (step.request?.certificate?.cert?.filename && !certFileNames.includes(step.request.certificate.cert.filename)) {
            certFileNames.push(step.request.certificate.cert.filename);
          }
        }
        certChecks.push({
          checkName: test.name,
          checkType: 'multistep',
          publicId: test.public_id,
          certFiles: {
            key: keyFiles.join(', ') || undefined,
            cert: certFileNames.join(', ') || undefined,
          },
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
    missingSecrets: missingSecretsReport && missingSecretsReport.checksAffected > 0 ? {
      checkedAt: missingSecretsReport.generatedAt,
      checksAffected: missingSecretsReport.checksAffected,
      filesModified: missingSecretsReport.filesModified,
      affectedChecks: missingSecretsReport.affectedChecks,
    } : undefined,
    checkLevelSecrets: checkLevelSecrets.length > 0 ? {
      totalEntries: checkLevelSecrets.length,
      uniqueChecks: new Set(checkLevelSecrets.map(s => s.checkName)).size,
      entries: checkLevelSecrets.map(s => ({ checkName: s.checkName, key: s.key })),
    } : undefined,
    clientCertificates: certChecks.length > 0 ? {
      totalChecks: certChecks.length,
      checks: certChecks,
    } : undefined,
    nextSteps: [
      privateLocationsFile && privateLocationsFile.locations.length > 0
        ? `Create ${privateLocationsFile.locations.length} private location(s) in Checkly with the slugs shown in the report`
        : null,
      secrets && secrets.length > 0
        ? `Fill in values for ${secrets.length} secret variable(s) in ${CHECKLY_DIR}/variables/secrets.json`
        : null,
      ddTestStatus && ddTestStatus.summary.deactivated > 0
        ? `Review ${ddTestStatus.summary.deactivated} deactivated check(s) tagged "failingInDatadog" or "noDataInDatadog"`
        : null,
      missingSecretsReport && missingSecretsReport.checksAffected > 0
        ? `Fill in secret values in ${CHECKLY_DIR}/variables/secrets.json and remove "missingSecretsFromDatadog" tag from ${missingSecretsReport.checksAffected} deactivated check(s)`
        : null,
      checkLevelSecrets.length > 0
        ? `Fill in values for ${checkLevelSecrets.length} check-level secret(s) in ${CHECKLY_DIR}/variables/secrets.json under the "checkLevel" section`
        : null,
      certChecks.length > 0
        ? `Upload client certificates for ${certChecks.length} check(s) tagged "requiresClientCertificate", configure mTLS on each check, then remove the tag and set activated: true`
        : null,
      `Review checks tagged "datadogBasicAuthWeb" — these used web/form-based auth in Datadog and may need converting to browser or multi-step checks`,
      `Run "cd ${CHECKLY_DIR} && npm run create-variables" to import variables to Checkly`,
      `Configure alert channels in ${CHECKLY_DIR}/default_resources/alertChannels.ts`,
      `Run "cd ${CHECKLY_DIR} && npm run test:public" to validate public checks`,
      privateLocationsFile && privateLocationsFile.locations.length > 0
        ? `Run "cd ${CHECKLY_DIR} && npm run test:private" to validate private checks (after creating private locations)`
        : null,
      `Run "cd ${CHECKLY_DIR} && npm run deploy:public" to deploy public checks`,
      privateLocationsFile && privateLocationsFile.locations.length > 0
        ? `Run "cd ${CHECKLY_DIR} && npm run deploy:private" to deploy private checks`
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

  // CSV mapping
  const csv = generateMappingCsv(apiChecks, multiStepTests, browserTests);
  await writeFile(OUTPUT_CSV, csv, 'utf-8');
  console.log(`  Written: ${OUTPUT_CSV}`);

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

  if (report.missingSecrets) {
    console.log(`  Checks deactivated (missing secrets): ${report.missingSecrets.checksAffected}`);
  }

  if (report.checkLevelSecrets) {
    console.log(`  Check-level secrets: ${report.checkLevelSecrets.totalEntries} across ${report.checkLevelSecrets.uniqueChecks} check(s)`);
  }

  if (certChecks.length > 0) {
    console.log(`  Client certificate checks: ${certChecks.length}`);
  }

  console.log('\nView the full report:');
  console.log(`  - ${OUTPUT_MD} (human-readable)`);
  console.log(`  - ${OUTPUT_JSON} (machine-readable)`);
  console.log(`  - ${OUTPUT_CSV} (ID mapping)`);

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
