/**
 * Checks Datadog test status and deactivates failing tests in generated Checkly constructs.
 *
 * This script:
 * 1. Reads exported test data to collect public_id → monitor_id mappings
 * 2. Bulk-fetches monitor statuses from Datadog API (paginated)
 * 3. Classifies tests: Alert = failing, everything else = not failing
 * 4. Writes exports/dd-test-status.json with full status report
 * 5. Modifies generated .check.ts files for failing tests:
 *    - Sets activated: false
 *    - Adds "failingInDatadog" tag
 *    - Adds a comment noting the override reason
 *
 * Opt-in via DD_CHECK_STATUS=true (default: disabled).
 * Only deactivates — never re-activates. Idempotent.
 *
 * Reads: exports/api-tests.json, exports/browser-tests.json, exports/multi-step-tests.json
 * Modifies: checkly-migrated/__checks__/{api,multi,browser}/{public,private}/*.check.ts
 * Writes: exports/dd-test-status.json
 */

import 'dotenv/config';
import { readFile, writeFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

// Configuration
const DD_API_KEY = process.env.DD_API_KEY;
const DD_APP_KEY = process.env.DD_APP_KEY;
const DD_SITE = process.env.DD_SITE || 'datadoghq.com';
const DD_CHECK_STATUS = process.env.DD_CHECK_STATUS;
const BASE_URL = `https://api.${DD_SITE}/api/v1`;

const EXPORTS_DIR = './exports';
const CHECKS_BASE = './checkly-migrated/__checks__';
const CHECK_TYPES = ['api', 'multi', 'browser'];
const LOCATION_TYPES = ['public', 'private'];

const MAX_RETRIES = 3;
const PAGE_SIZE = 1000;

// Types
interface ExportedTestFile {
  tests: Array<{
    public_id: string;
    name: string;
    monitor_id?: number;
    type?: string;
    subtype?: string;
    status?: string;
  }>;
}

interface DatadogMonitor {
  id: number;
  overall_state: string;
  name?: string;
  type?: string;
}

interface TestStatusEntry {
  publicId: string;
  name: string;
  monitorId: number | null;
  overallState: string;
  isFailing: boolean;
  fetchedAt: string;
}

interface TestStatusReport {
  fetchedAt: string;
  site: string;
  summary: {
    total: number;
    passing: number;
    failing: number;
    noData: number;
    fetchErrors: number;
  };
  tests: TestStatusEntry[];
}

// HTTP headers for Datadog API
function getHeaders(): Record<string, string> {
  return {
    'DD-API-KEY': DD_API_KEY!,
    'DD-APPLICATION-KEY': DD_APP_KEY!,
    'Content-Type': 'application/json',
  };
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * API request with retry and backoff for 429/5xx errors
 */
async function apiRequestWithRetry<T>(endpoint: string): Promise<T> {
  const url = `${BASE_URL}${endpoint}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      method: 'GET',
      headers: getHeaders(),
    });

    if (response.ok) {
      return response.json() as Promise<T>;
    }

    if (response.status === 403) {
      throw new Error(`403 Forbidden — missing monitors_read scope on the Datadog App Key`);
    }

    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
      const backoff = Math.pow(2, attempt) * 1000;
      console.log(`  Retrying in ${backoff / 1000}s (attempt ${attempt}/${MAX_RETRIES}, status ${response.status})...`);
      await sleep(backoff);
      continue;
    }

    const errorText = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  throw new Error(`API request failed after ${MAX_RETRIES} retries`);
}

/**
 * Fetch all monitors from Datadog with pagination
 */
async function fetchAllMonitors(): Promise<Map<number, string>> {
  console.log('\nFetching monitor statuses from Datadog...');
  const monitorMap = new Map<number, string>();
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    console.log(`  Fetching monitors page ${page}...`);
    const monitors = await apiRequestWithRetry<DatadogMonitor[]>(
      `/monitor?page_size=${PAGE_SIZE}&page=${page}`
    );

    if (!monitors || monitors.length === 0) {
      hasMore = false;
      break;
    }

    for (const monitor of monitors) {
      monitorMap.set(monitor.id, monitor.overall_state || 'Unknown');
    }

    if (monitors.length < PAGE_SIZE) {
      hasMore = false;
    } else {
      page++;
    }
  }

  console.log(`  Fetched ${monitorMap.size} total monitors`);
  return monitorMap;
}

/**
 * Read exported test files and collect public_id → monitor_id mappings
 */
async function collectTestMappings(): Promise<Array<{ publicId: string; name: string; monitorId: number | null }>> {
  const tests: Array<{ publicId: string; name: string; monitorId: number | null }> = [];
  const exportFiles = ['api-tests.json', 'browser-tests.json', 'multi-step-tests.json'];

  for (const filename of exportFiles) {
    const filepath = path.join(EXPORTS_DIR, filename);
    if (!existsSync(filepath)) {
      console.log(`  Skipping ${filename} (not found)`);
      continue;
    }

    try {
      const content = await readFile(filepath, 'utf-8');
      const data = JSON.parse(content) as ExportedTestFile;

      if (data.tests && Array.isArray(data.tests)) {
        for (const test of data.tests) {
          tests.push({
            publicId: test.public_id,
            name: test.name,
            monitorId: test.monitor_id ?? null,
          });
        }
        console.log(`  ${filename}: ${data.tests.length} tests`);
      }
    } catch (err) {
      console.warn(`  Warning: Could not parse ${filename}: ${(err as Error).message}`);
    }
  }

  return tests;
}

/**
 * Build the test status report by correlating test mappings with monitor statuses
 */
function buildStatusReport(
  testMappings: Array<{ publicId: string; name: string; monitorId: number | null }>,
  monitorMap: Map<number, string>
): TestStatusReport {
  const fetchedAt = new Date().toISOString();
  const tests: TestStatusEntry[] = [];
  let passing = 0;
  let failing = 0;
  let noData = 0;
  let fetchErrors = 0;

  for (const test of testMappings) {
    let overallState = 'Unknown';

    if (test.monitorId !== null) {
      const state = monitorMap.get(test.monitorId);
      if (state) {
        overallState = state;
      } else {
        fetchErrors++;
      }
    } else {
      fetchErrors++;
    }

    const isFailing = overallState === 'Alert';

    if (overallState === 'OK') {
      passing++;
    } else if (overallState === 'Alert') {
      failing++;
    } else if (overallState === 'No Data') {
      noData++;
    }

    tests.push({
      publicId: test.publicId,
      name: test.name,
      monitorId: test.monitorId,
      overallState,
      isFailing,
      fetchedAt,
    });
  }

  return {
    fetchedAt,
    site: DD_SITE,
    summary: {
      total: tests.length,
      passing,
      failing,
      noData,
      fetchErrors,
    },
    tests,
  };
}

/**
 * Modify a check file to deactivate it and add failingInDatadog tag
 */
async function deactivateCheckFile(filepath: string, publicId: string): Promise<boolean> {
  const content = await readFile(filepath, 'utf-8');

  // Idempotency: skip if already tagged
  if (content.includes('failingInDatadog')) {
    return false;
  }

  let newContent = content;

  // Only change activated: true → activated: false (don't touch already-false)
  newContent = newContent.replace(
    /activated:\s*true/,
    'activated: false'
  );

  // Add "failingInDatadog" tag to the tags array
  const tagsPattern = /tags:\s*\[([^\]]*)\]/;
  const tagsMatch = newContent.match(tagsPattern);

  if (tagsMatch) {
    const existingTags = tagsMatch[1].trim();
    let newTags: string;

    if (existingTags === '') {
      newTags = `tags: ["failingInDatadog"]`;
    } else {
      newTags = `tags: [${existingTags}, "failingInDatadog"]`;
    }

    newContent = newContent.replace(tagsPattern, newTags);
  }

  // Add comment after the "Migrated from Datadog" comment line
  const migratedCommentPattern = /(\/\/\s*Migrated from Datadog Synthetic:.*)/;
  const commentMatch = newContent.match(migratedCommentPattern);
  if (commentMatch) {
    newContent = newContent.replace(
      migratedCommentPattern,
      `$1\n// ⚠ Deactivated: This test was failing (Alert) in Datadog at migration time`
    );
  }

  if (newContent !== content) {
    await writeFile(filepath, newContent, 'utf-8');
    return true;
  }

  return false;
}

/**
 * Scan check directories and deactivate failing tests
 */
async function deactivateFailingTests(
  failingPublicIds: Set<string>
): Promise<{ modified: number; skipped: number; errors: number }> {
  let modified = 0;
  let skipped = 0;
  let errors = 0;

  for (const checkType of CHECK_TYPES) {
    for (const locationType of LOCATION_TYPES) {
      const dirPath = path.join(CHECKS_BASE, checkType, locationType);

      if (!existsSync(dirPath)) {
        continue;
      }

      const files = await readdir(dirPath);
      const checkFiles = files.filter(f => f.endsWith('.check.ts'));

      for (const file of checkFiles) {
        const filepath = path.join(dirPath, file);
        try {
          const content = await readFile(filepath, 'utf-8');

          // Extract public_id from the "Migrated from Datadog Synthetic: {public_id}" comment
          const idMatch = content.match(/Migrated from Datadog Synthetic:\s*(\S+)/);
          if (!idMatch) {
            continue;
          }

          const publicId = idMatch[1];
          if (!failingPublicIds.has(publicId)) {
            continue;
          }

          const wasModified = await deactivateCheckFile(filepath, publicId);
          if (wasModified) {
            modified++;
            console.log(`  Deactivated: ${file} (${publicId})`);
          } else {
            skipped++;
          }
        } catch (err) {
          console.error(`  Error processing ${file}: ${(err as Error).message}`);
          errors++;
        }
      }
    }
  }

  return { modified, skipped, errors };
}

/**
 * Main function
 */
async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Check Datadog Test Status');
  console.log('='.repeat(60));

  // Check opt-in
  if (!DD_CHECK_STATUS || DD_CHECK_STATUS.toLowerCase() !== 'true') {
    console.log('\nSkipping: DD_CHECK_STATUS is not set to "true".');
    console.log('Set DD_CHECK_STATUS=true in your .env to enable Datadog test status checking.');
    return;
  }

  // Check API keys
  if (!DD_API_KEY || !DD_APP_KEY) {
    console.log('\nSkipping: DD_API_KEY and DD_APP_KEY are required for status checking.');
    return;
  }

  console.log(`\nSite: ${DD_SITE}`);

  // Step 1: Collect test → monitor_id mappings from export files
  console.log('\nCollecting test mappings from export files...');
  const testMappings = await collectTestMappings();

  if (testMappings.length === 0) {
    console.log('\nNo tests found in export files. Run the export first.');
    return;
  }

  console.log(`\nFound ${testMappings.length} total tests`);

  // Step 2: Fetch monitor statuses from Datadog
  let monitorMap: Map<number, string>;
  try {
    monitorMap = await fetchAllMonitors();
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('403')) {
      console.error(`\nError: ${msg}`);
      console.log('Skipping status check — ensure your App Key has monitors_read scope.');
      return;
    }
    throw err;
  }

  // Step 3: Build status report
  console.log('\nCorrelating test statuses...');
  const report = buildStatusReport(testMappings, monitorMap);

  // Step 4: Write status report
  const outputPath = path.join(EXPORTS_DIR, 'dd-test-status.json');
  await writeFile(outputPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\nWritten: ${outputPath}`);

  // Print summary
  console.log('\n' + '-'.repeat(40));
  console.log('Status Summary');
  console.log('-'.repeat(40));
  console.log(`  Total tests:    ${report.summary.total}`);
  console.log(`  Passing (OK):   ${report.summary.passing}`);
  console.log(`  Failing (Alert):${report.summary.failing}`);
  console.log(`  No Data:        ${report.summary.noData}`);
  console.log(`  Unknown/Error:  ${report.summary.fetchErrors}`);

  // Step 5: Deactivate failing tests in check files
  if (report.summary.failing === 0) {
    console.log('\nNo failing tests found — no check files to modify.');
  } else {
    console.log(`\nDeactivating ${report.summary.failing} failing test(s) in check files...`);

    const failingIds = new Set(
      report.tests.filter(t => t.isFailing).map(t => t.publicId)
    );

    if (!existsSync(CHECKS_BASE)) {
      console.log(`\nSkipping file modifications: ${CHECKS_BASE} not found.`);
      console.log('Run the migration scripts first to generate check files.');
    } else {
      const { modified, skipped, errors } = await deactivateFailingTests(failingIds);

      console.log('\n' + '-'.repeat(40));
      console.log('File Modification Summary');
      console.log('-'.repeat(40));
      console.log(`  Files deactivated: ${modified}`);
      console.log(`  Files skipped (already tagged): ${skipped}`);
      console.log(`  Errors: ${errors}`);
    }
  }

  // Final summary
  console.log('\n' + '='.repeat(60));
  console.log('Done!');
  console.log('='.repeat(60));

  if (report.summary.failing > 0) {
    console.log(`\n${report.summary.failing} test(s) were failing in Datadog.`);
    console.log('These checks have been deactivated and tagged with "failingInDatadog".');
    console.log('Review them after migration and re-activate once the underlying issues are fixed.');
  }
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
