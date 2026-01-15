/**
 * Filters api-tests.json to separate multi-step tests from single-step tests.
 *
 * Creates:
 *   - exports/multi-step-tests.json (tests with subtype: "multi")
 *   - Updates exports/api-tests.json (tests without subtype: "multi")
 */

import { readFile, writeFile } from 'fs/promises';
import path from 'path';

const EXPORTS_DIR = './exports';
const API_TESTS_FILE = path.join(EXPORTS_DIR, 'api-tests.json');
const MULTI_STEP_FILE = path.join(EXPORTS_DIR, 'multi-step-tests.json');

async function main() {
  console.log('Reading api-tests.json...');
  const data = JSON.parse(await readFile(API_TESTS_FILE, 'utf-8'));

  const multiStepTests = data.tests.filter(test => test.subtype === 'multi');
  const singleStepTests = data.tests.filter(test => test.subtype !== 'multi');

  console.log(`Total tests: ${data.tests.length}`);
  console.log(`Multi-step tests: ${multiStepTests.length}`);
  console.log(`Single-step tests: ${singleStepTests.length}`);

  // Write multi-step tests to new file
  const multiStepData = {
    exportedAt: data.exportedAt,
    site: data.site,
    count: multiStepTests.length,
    tests: multiStepTests,
  };

  await writeFile(MULTI_STEP_FILE, JSON.stringify(multiStepData, null, 2), 'utf-8');
  console.log(`\nWritten: ${MULTI_STEP_FILE}`);

  // Update api-tests.json with only single-step tests
  const updatedData = {
    exportedAt: data.exportedAt,
    site: data.site,
    count: singleStepTests.length,
    tests: singleStepTests,
  };

  await writeFile(API_TESTS_FILE, JSON.stringify(updatedData, null, 2), 'utf-8');
  console.log(`Updated: ${API_TESTS_FILE}`);

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
