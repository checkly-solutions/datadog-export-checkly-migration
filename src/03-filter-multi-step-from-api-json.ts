/**
 * Filters api-tests.json to separate multi-step tests from single-step tests.
 *
 * Creates:
 *   - exports/multi-step-tests.json (tests with subtype: "multi")
 *   - Updates exports/api-tests.json (tests without subtype: "multi")
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { getExportsDir } from './shared/output-config.ts';
import {
  shouldPromote,
  promoteApiTestToMultiStep,
  detectPromotionReasons,
} from './shared/promote-api-to-multistep.ts';
import type { DatadogTest as SharedDatadogTest } from './shared/types.ts';

let EXPORTS_DIR = '';
let API_TESTS_FILE = '';
let MULTI_STEP_FILE = '';

interface DatadogTest {
  public_id: string;
  name: string;
  subtype?: string;
  [key: string]: unknown;
}

interface ExportData {
  exportedAt: string;
  site: string;
  count: number;
  tests: DatadogTest[];
}

/**
 * Partition single-step API tests into those promoted off the ApiCheck path and
 * those kept as ApiChecks. A test that carries a regex assertion (shouldPromote)
 * is reshaped into a one-step multi-step test via promoteApiTestToMultiStep and
 * collected into `promoted`; every other test is collected into `keptApi`.
 *
 * Pure and side-effect-free so it can be unit-tested offline. Promoted tests
 * MUST be excluded from the rewritten api-tests.json or step 02 would emit a
 * duplicate (downgraded) ApiCheck alongside the promoted multi-step check.
 *
 * @param tests The single-step (non-multi) API tests to partition.
 * @returns { promoted, keptApi }: promoted multi-step tests and kept ApiCheck tests.
 */
export function partitionForPromotion(tests: DatadogTest[]): {
  promoted: DatadogTest[];
  keptApi: DatadogTest[];
} {
  const promoted: DatadogTest[] = [];
  const keptApi: DatadogTest[] = [];
  for (const test of tests) {
    const shared = test as unknown as SharedDatadogTest;
    if (shouldPromote(shared)) {
      promoted.push(
        promoteApiTestToMultiStep(shared, detectPromotionReasons(shared)) as unknown as DatadogTest,
      );
    } else {
      keptApi.push(test);
    }
  }
  return { promoted, keptApi };
}

async function main(): Promise<void> {
  EXPORTS_DIR = await getExportsDir();
  API_TESTS_FILE = path.join(EXPORTS_DIR, 'api-tests.json');
  MULTI_STEP_FILE = path.join(EXPORTS_DIR, 'multi-step-tests.json');

  console.log('Filtering multi-step tests from API tests...');

  // Check input file exists
  if (!existsSync(API_TESTS_FILE)) {
    console.log(`\nSkipping: Input file not found: ${API_TESTS_FILE}`);
    console.log('No API tests to filter. Run "npm run export" first if you have API tests.');
    return;
  }

  console.log('Reading api-tests.json...');
  const data = JSON.parse(await readFile(API_TESTS_FILE, 'utf-8')) as ExportData;

  const multiStepTests = data.tests.filter(test => test.subtype === 'multi');
  const singleStepTests = data.tests.filter(test => test.subtype !== 'multi');

  // Divert regex-bearing single-step API tests off the ApiCheck path and into
  // the multi-step file. Promoted tests are removed from the rewritten
  // api-tests.json so step 02 does not also emit a duplicate ApiCheck.
  const { promoted, keptApi } = partitionForPromotion(singleStepTests);

  console.log(`Total tests: ${data.tests.length}`);
  console.log(`Multi-step tests (native): ${multiStepTests.length}`);
  console.log(`Single-step tests: ${singleStepTests.length}`);
  console.log(`Promoted to multi-step (regex): ${promoted.length}`);
  console.log(`Kept as API tests: ${keptApi.length}`);

  // Write multi-step tests to new file: native multi tests plus promoted tests
  const allMultiStepTests = [...multiStepTests, ...promoted];
  const multiStepData: ExportData = {
    exportedAt: data.exportedAt,
    site: data.site,
    count: allMultiStepTests.length,
    tests: allMultiStepTests,
  };

  await writeFile(MULTI_STEP_FILE, JSON.stringify(multiStepData, null, 2), 'utf-8');
  console.log(`\nWritten: ${MULTI_STEP_FILE}`);

  // Update api-tests.json with only the kept (non-promoted) single-step tests
  const updatedData: ExportData = {
    exportedAt: data.exportedAt,
    site: data.site,
    count: keptApi.length,
    tests: keptApi,
  };

  await writeFile(API_TESTS_FILE, JSON.stringify(updatedData, null, 2), 'utf-8');
  console.log(`Updated: ${API_TESTS_FILE}`);

  console.log('\nDone!');
}

const __filename = fileURLToPath(import.meta.url);
if (typeof process.argv[1] === 'string' && path.resolve(__filename) === path.resolve(process.argv[1])) {
  main().catch(err => {
    console.error('Error:', (err as Error).message);
    process.exit(1);
  });
}
