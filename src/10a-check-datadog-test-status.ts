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
import { fileURLToPath } from 'node:url';
import { getOutputRoot, getExportsDir } from './shared/output-config.ts';
import { classifyStatus, applyOutcomeToSource, type StatusOutcome } from './shared/status-decision.ts';

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
    status?: string;
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
  tag: string | null;
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
  configStatus?: string;
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
            configStatus: test.status,
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

    // Classify the outcome from the two locked signals: the monitor/search
    // state and the test's exported config status (the status truth table).
    // A live-in-Datadog test mislabeled No Data stays active with a review tag;
    // a genuinely paused No Data test still deactivates.
    const outcome = classifyStatus(overallState, test.configStatus);
    const isDeactivated = outcome.deactivate;

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
      tag: outcome.tag,
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
 * Apply a status outcome to a check file: read it, run the pure
 * applyOutcomeToSource transform, and write only if the content changed.
 *
 * All mutation logic (the per-tag idempotency guard, the activated flip gated
 * on outcome.deactivate, the post-filter tags-array append, and the diagnostic
 * comment) lives in the tested applyOutcomeToSource. The activated: true ->
 * false flip runs ONLY when outcome.deactivate is true, so a live-but-mislabeled
 * No Data check gains its reviewNoDataInDatadog tag without ever being
 * deactivated.
 */
async function deactivateCheckFile(filepath: string, outcome: StatusOutcome): Promise<boolean> {
  const content = await readFile(filepath, 'utf-8');
  const newContent = applyOutcomeToSource(content, outcome);

  if (newContent !== content) {
    await writeFile(filepath, newContent, 'utf-8');
    return true;
  }

  return false;
}

/**
 * Scan check directories and apply status outcomes to the matching check files.
 * outcomeMap: publicId -> StatusOutcome (every entry with a non-null tag, i.e.
 * both deactivations and the review-active case). The scan is uniform across
 * every check type and location (api/multi/browser x public/private) because
 * the classify + apply logic is type-agnostic.
 */
async function deactivateTests(
  outcomeMap: Map<string, StatusOutcome>
): Promise<{ deactivated: number; reviewed: number; skipped: number; errors: number }> {
  let deactivated = 0;
  let reviewed = 0;
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
          const outcome = outcomeMap.get(publicId);
          if (!outcome) {
            continue;
          }

          const wasModified = await deactivateCheckFile(filepath, outcome);
          if (wasModified) {
            if (outcome.deactivate) {
              deactivated++;
              console.log(`  Deactivated [${outcome.tag}]: ${locationType}/${file} (${publicId})`);
            } else {
              reviewed++;
              console.log(`  Left active for review [${outcome.tag}]: ${locationType}/${file} (${publicId})`);
            }
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

  return { deactivated, reviewed, skipped, errors };
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

  // Step 5: Apply status outcomes to check files. This covers BOTH deactivations
  // (Alert, or No Data with a paused/absent config status) and the review-active
  // case (No Data on a live test), keyed on every entry that carries a tag. The
  // review-active case has deactivate:false, so it gets its review tag appended
  // without flipping activated.
  const outcomeMap = new Map<string, StatusOutcome>();
  let reviewActiveCount = 0;
  for (const test of report.tests) {
    if (test.tag !== null) {
      outcomeMap.set(test.publicId, {
        deactivate: test.isDeactivated,
        tag: test.tag,
        isReview: test.tag.startsWith('review'),
      });
      if (!test.isDeactivated) {
        reviewActiveCount++;
      }
    }
  }

  if (outcomeMap.size === 0) {
    console.log('\nNo status changes to apply. All checks are passing.');
  } else {
    console.log(`\nApplying status outcomes to ${outcomeMap.size} check file(s)...`);
    console.log(`  (${report.summary.deactivated} to deactivate, ${reviewActiveCount} left active for review)`);

    if (!existsSync(CHECKS_BASE)) {
      console.log(`\nSkipping file modifications: ${CHECKS_BASE} not found.`);
      console.log('Run the migration scripts first to generate check files.');
    } else {
      const { deactivated, reviewed, skipped, errors } = await deactivateTests(outcomeMap);

      console.log('\n' + '-'.repeat(40));
      console.log('File Modification Summary');
      console.log('-'.repeat(40));
      console.log(`  Files deactivated: ${deactivated}`);
      console.log(`  Files left active for review: ${reviewed}`);
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
      console.log(`  - ${report.summary.failing} failing (Alert), tagged "failingInDatadog"`);
    }
    const noDataDeactivated = report.tests.filter(
      t => t.isDeactivated && t.tag === 'noDataInDatadog'
    ).length;
    const reviewDeactivated = report.tests.filter(
      t => t.isDeactivated && t.tag === 'reviewNoDataInDatadog'
    ).length;
    if (noDataDeactivated > 0) {
      console.log(`  - ${noDataDeactivated} no data (paused), tagged "noDataInDatadog"`);
    }
    if (reviewDeactivated > 0) {
      console.log(`  - ${reviewDeactivated} no data (absent/unknown config status), tagged "reviewNoDataInDatadog"`);
    }
    console.log('Review these after migration and re-activate once ready.');
  }

  if (reviewActiveCount > 0) {
    console.log(`\n${reviewActiveCount} test(s) left active for review, tagged "reviewNoDataInDatadog":`);
    console.log('  Live in Datadog but monitor/search reported No Data. Verify recent run health in Datadog before relying on them.');
  }
}

// ESM main-guard: only run if this file is the direct entry point
const __filename = fileURLToPath(import.meta.url);
if (typeof process.argv[1] === 'string' && path.resolve(__filename) === path.resolve(process.argv[1])) {
  main().catch(err => {
    console.error('Error:', (err as Error).message);
    process.exit(1);
  });
}
