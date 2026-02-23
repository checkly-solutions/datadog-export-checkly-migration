/**
 * Checks Datadog test status and deactivates failing tests in generated Checkly constructs.
 *
 * This script:
 * 1. Reads exported test data to collect public_id → monitor_id mappings
 * 2. Fetches synthetic monitor statuses via monitor search API (type:synthetics filter)
 * 3. Classifies tests: Alert or No Data = deactivate, OK = leave active
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
import { getOutputRoot, getExportsDir } from './shared/output-config.ts';

// Configuration
const DD_API_KEY = process.env.DD_API_KEY;
const DD_APP_KEY = process.env.DD_APP_KEY;
const DD_SITE = process.env.DD_SITE || 'datadoghq.com';
const DD_CHECK_STATUS = process.env.DD_CHECK_STATUS;
const BASE_URL = `https://api.${DD_SITE}/api/v1`;

let EXPORTS_DIR = '';
let CHECKS_BASE = '';
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
    privateLocations?: string[];
  }>;
}

interface MonitorSearchResult {
  id: number;
  status: string;
}

interface MonitorSearchResponse {
  monitors: MonitorSearchResult[];
  metadata: {
    total_count: number;
    page: number;
    per_page: number;
    page_count: number;
  };
}

interface TestStatusEntry {
  publicId: string;
  name: string;
  monitorId: number | null;
  overallState: string;
  isDeactivated: boolean;
  locationType: 'public' | 'private';
  fetchedAt: string;
}

interface StatusCounts {
  total: number;
  passing: number;
  failing: number;
  noData: number;
  unknown: number;
  deactivated: number;
}

interface TestStatusReport {
  fetchedAt: string;
  site: string;
  summary: StatusCounts;
  publicSummary: StatusCounts;
  privateSummary: StatusCounts;
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
 * Fetch synthetic monitor statuses using the monitor search API.
 * Uses GET /api/v1/monitor/search?query=type:synthetics which correctly
 * filters to only synthetic monitors (~1400 vs 19k+ total monitors).
 */
async function fetchSyntheticMonitorStatuses(): Promise<Map<number, string>> {
  console.log('\nFetching synthetic monitor statuses from Datadog...');
  const monitorMap = new Map<number, string>();
  let page = 0;
  let totalCount = 0;

  while (true) {
    console.log(`  Fetching monitor search page ${page}...`);
    const data = await apiRequestWithRetry<MonitorSearchResponse>(
      `/monitor/search?query=type:synthetics&per_page=${PAGE_SIZE}&page=${page}`
    );

    if (!data.monitors || data.monitors.length === 0) {
      break;
    }

    totalCount = data.metadata.total_count;

    for (const monitor of data.monitors) {
      monitorMap.set(monitor.id, monitor.status || 'Unknown');
    }

    if ((page + 1) * PAGE_SIZE >= totalCount) {
      break;
    }
    page++;
  }

  console.log(`  Fetched ${monitorMap.size} synthetic monitors (of ${totalCount} total)`);
  return monitorMap;
}

/**
 * Read exported test files and collect public_id → monitor_id mappings
 */
interface TestMapping {
  publicId: string;
  name: string;
  monitorId: number | null;
  locationType: 'public' | 'private';
}

async function collectTestMappings(): Promise<TestMapping[]> {
  const tests: TestMapping[] = [];
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
          const hasPrivateLocations = test.privateLocations && test.privateLocations.length > 0;
          tests.push({
            publicId: test.public_id,
            name: test.name,
            monitorId: test.monitor_id ?? null,
            locationType: hasPrivateLocations ? 'private' : 'public',
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

function emptyCounts(): StatusCounts {
  return { total: 0, passing: 0, failing: 0, noData: 0, unknown: 0, deactivated: 0 };
}

function incrementCounts(counts: StatusCounts, overallState: string, isDeactivated: boolean): void {
  counts.total++;
  if (overallState === 'OK') counts.passing++;
  else if (overallState === 'Alert') counts.failing++;
  else if (overallState === 'No Data') counts.noData++;
  else counts.unknown++;
  if (isDeactivated) counts.deactivated++;
}

/**
 * Build the test status report by correlating test mappings with monitor statuses.
 * Both Alert and No Data states are treated as deactivated.
 */
function buildStatusReport(
  testMappings: TestMapping[],
  monitorMap: Map<number, string>
): TestStatusReport {
  const fetchedAt = new Date().toISOString();
  const tests: TestStatusEntry[] = [];
  const summary = emptyCounts();
  const publicSummary = emptyCounts();
  const privateSummary = emptyCounts();

  for (const test of testMappings) {
    let overallState = 'Unknown';

    if (test.monitorId !== null) {
      const state = monitorMap.get(test.monitorId);
      if (state) {
        overallState = state;
      }
    }

    // Deactivate both Alert (failing) and No Data (not running) tests
    const isDeactivated = overallState === 'Alert' || overallState === 'No Data';

    incrementCounts(summary, overallState, isDeactivated);
    incrementCounts(
      test.locationType === 'private' ? privateSummary : publicSummary,
      overallState,
      isDeactivated
    );

    tests.push({
      publicId: test.publicId,
      name: test.name,
      monitorId: test.monitorId,
      overallState,
      isDeactivated,
      locationType: test.locationType,
      fetchedAt,
    });
  }

  return {
    fetchedAt,
    site: DD_SITE,
    summary,
    publicSummary,
    privateSummary,
    tests,
  };
}

/**
 * Modify a check file to deactivate it and add the appropriate tag.
 * Alert → "failingInDatadog", No Data → "noDataInDatadog"
 */
async function deactivateCheckFile(filepath: string, publicId: string, overallState: string): Promise<boolean> {
  const content = await readFile(filepath, 'utf-8');

  const tag = overallState === 'Alert' ? 'failingInDatadog' : 'noDataInDatadog';

  // Idempotency: skip if already tagged with this specific tag
  if (content.includes(tag)) {
    return false;
  }

  let newContent = content;

  // Only change activated: true → activated: false (don't touch already-false)
  newContent = newContent.replace(
    /activated:\s*true/,
    'activated: false'
  );

  // Add tag to the tags array
  const tagsPattern = /tags:\s*\[([^\]]*)\]/;
  const tagsMatch = newContent.match(tagsPattern);

  if (tagsMatch) {
    const existingTags = tagsMatch[1].trim();
    let newTags: string;

    if (existingTags === '') {
      newTags = `tags: ["${tag}"]`;
    } else {
      newTags = `tags: [${existingTags}, "${tag}"]`;
    }

    newContent = newContent.replace(tagsPattern, newTags);
  }

  // Add comment after the "Migrated from Datadog" comment line
  const reason = overallState === 'Alert'
    ? 'This test was failing (Alert) in Datadog at migration time'
    : 'This test had no data (paused/not running) in Datadog at migration time';
  const migratedCommentPattern = /(\/\/\s*Migrated from Datadog Synthetic:.*)/;
  if (migratedCommentPattern.test(newContent)) {
    newContent = newContent.replace(
      migratedCommentPattern,
      `$1\n// Deactivated: ${reason}`
    );
  }

  if (newContent !== content) {
    await writeFile(filepath, newContent, 'utf-8');
    return true;
  }

  return false;
}

/**
 * Scan check directories and deactivate tests that are failing or have no data.
 * deactivateMap: publicId → overallState (Alert or No Data)
 */
async function deactivateTests(
  deactivateMap: Map<string, string>
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
          const overallState = deactivateMap.get(publicId);
          if (!overallState) {
            continue;
          }

          const wasModified = await deactivateCheckFile(filepath, publicId, overallState);
          if (wasModified) {
            modified++;
            const tag = overallState === 'Alert' ? 'failingInDatadog' : 'noDataInDatadog';
            console.log(`  Deactivated [${tag}]: ${locationType}/${file} (${publicId})`);
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
  const outputRoot = await getOutputRoot();
  EXPORTS_DIR = await getExportsDir();
  CHECKS_BASE = `${outputRoot}/__checks__`;

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

  // Step 2: Fetch synthetic monitor statuses from Datadog
  let monitorMap: Map<number, string>;
  try {
    monitorMap = await fetchSyntheticMonitorStatuses();
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

  // Print summary with public/private breakdown
  function printCounts(label: string, counts: StatusCounts): void {
    console.log(`\n${label}`);
    console.log('-'.repeat(40));
    console.log(`  Total:          ${counts.total}`);
    console.log(`  Passing (OK):   ${counts.passing}`);
    console.log(`  Failing (Alert):${counts.failing}`);
    console.log(`  No Data:        ${counts.noData}`);
    console.log(`  Unknown:        ${counts.unknown}`);
    console.log(`  To deactivate:  ${counts.deactivated}`);
  }

  printCounts('Status Summary (All)', report.summary);
  printCounts('Public Checks', report.publicSummary);
  printCounts('Private Checks', report.privateSummary);

  // Step 5: Deactivate failing and no-data tests in check files
  if (report.summary.deactivated === 0) {
    console.log('\nNo tests to deactivate — all checks are passing.');
  } else {
    console.log(`\nDeactivating ${report.summary.deactivated} test(s) in check files...`);
    console.log(`  (${report.summary.failing} failing + ${report.summary.noData} no data)`);

    // Build map of publicId → overallState for tests that need deactivation
    const deactivateMap = new Map<string, string>();
    for (const test of report.tests) {
      if (test.isDeactivated) {
        deactivateMap.set(test.publicId, test.overallState);
      }
    }

    if (!existsSync(CHECKS_BASE)) {
      console.log(`\nSkipping file modifications: ${CHECKS_BASE} not found.`);
      console.log('Run the migration scripts first to generate check files.');
    } else {
      const { modified, skipped, errors } = await deactivateTests(deactivateMap);

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

  if (report.summary.deactivated > 0) {
    console.log(`\n${report.summary.deactivated} test(s) deactivated:`);
    if (report.summary.failing > 0) {
      console.log(`  - ${report.summary.failing} failing (Alert) → tagged "failingInDatadog"`);
    }
    if (report.summary.noData > 0) {
      console.log(`  - ${report.summary.noData} no data (paused) → tagged "noDataInDatadog"`);
    }
    console.log('Review these after migration and re-activate once ready.');
  }
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
