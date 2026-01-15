/**
 * Generates Checkly MultiStepCheck constructs from Datadog multi-step tests.
 *
 * Reads: exports/multi-step-tests.json (for metadata: tags, locations, frequency, etc.)
 * Reads: checkly/__checks__/multi-step/_manifest.json (for spec file mappings)
 * Outputs: checkly/__checks__/multi-step/*.check.ts
 *
 * Each MultiStepCheck construct references its corresponding .spec.ts file.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const INPUT_FILE = './exports/multi-step-tests.json';
const MANIFEST_FILE = './checkly-migrated/tests/multi/_manifest.json';
const OUTPUT_DIR = './checkly-migrated/__checks__/multi';
const SPECS_RELATIVE_PATH = '../../tests/multi'; // Relative path from __checks__/multi to tests/multi

// Datadog tick_every (seconds) to Checkly frequency mapping
const FREQUENCY_MAP = {
  60: 'EVERY_1M',
  120: 'EVERY_2M',
  300: 'EVERY_5M',
  600: 'EVERY_10M',
  900: 'EVERY_15M',
  1800: 'EVERY_30M',
  3600: 'EVERY_1H',
  7200: 'EVERY_2H',
  14400: 'EVERY_4H',
  21600: 'EVERY_6H',
  43200: 'EVERY_12H',
  86400: 'EVERY_24H',
};

// Common Datadog to Checkly location mapping
const LOCATION_MAP = {
  'aws:us-east-1': 'us-east-1',
  'aws:us-east-2': 'us-east-2',
  'aws:us-west-1': 'us-west-1',
  'aws:us-west-2': 'us-west-2',
  'aws:eu-central-1': 'eu-central-1',
  'aws:eu-west-1': 'eu-west-1',
  'aws:eu-west-2': 'eu-west-2',
  'aws:eu-west-3': 'eu-west-3',
  'aws:eu-north-1': 'eu-north-1',
  'aws:ap-northeast-1': 'ap-northeast-1',
  'aws:ap-northeast-2': 'ap-northeast-2',
  'aws:ap-southeast-1': 'ap-southeast-1',
  'aws:ap-southeast-2': 'ap-southeast-2',
  'aws:ap-south-1': 'ap-south-1',
  'aws:sa-east-1': 'sa-east-1',
  'aws:ca-central-1': 'ca-central-1',
};

/**
 * Sanitize a string to be a valid filename
 */
function sanitizeFilename(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
}

/**
 * Sanitize a string to be a valid TypeScript identifier
 */
function sanitizeIdentifier(str) {
  return str
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^(\d)/, '_$1')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Map Datadog tick_every to Checkly frequency
 */
function convertFrequency(tickEvery) {
  const frequencies = Object.keys(FREQUENCY_MAP).map(Number).sort((a, b) => a - b);

  for (const freq of frequencies) {
    if (tickEvery <= freq) {
      return FREQUENCY_MAP[freq];
    }
  }

  return FREQUENCY_MAP[tickEvery] || 'EVERY_10M';
}

/**
 * Separate locations into public and private
 */
function separateLocations(ddLocations) {
  const locations = [];
  const privateLocations = [];

  for (const loc of ddLocations || []) {
    if (loc.startsWith('pl:')) {
      privateLocations.push(loc);
    } else {
      const mapped = LOCATION_MAP[loc];
      if (mapped) {
        locations.push(mapped);
      } else {
        locations.push(loc);
      }
    }
  }

  return { locations, privateLocations };
}

/**
 * Generate RetryStrategyBuilder code
 */
function generateRetryStrategy(ddRetry) {
  if (!ddRetry || ddRetry.count === 0) {
    return 'RetryStrategyBuilder.noRetries()';
  }

  const intervalSeconds = Math.ceil((ddRetry.interval || 10000) / 1000);

  return `RetryStrategyBuilder.linearStrategy({
    baseBackoffSeconds: ${intervalSeconds},
    maxRetries: ${ddRetry.count || 2},
    maxDurationSeconds: 600,
    sameRegion: true,
  })`;
}

/**
 * Generate a MultiStepCheck construct for a test
 */
function generateMultiStepCheckCode(test, specFilename) {
  const { public_id, name, tags, options } = test;
  const { locations, privateLocations } = separateLocations(test.locations);

  const logicalId = public_id;
  const frequency = convertFrequency(options?.tick_every || 300);
  const retryStrategy = generateRetryStrategy(options?.retry);
  const activated = test.status === 'live';

  const code = `import {
  Frequency,
  MultiStepCheck,
  RetryStrategyBuilder,
} from "checkly/constructs";

new MultiStepCheck("${logicalId}", {
  name: "${name.replace(/"/g, '\\"')}",
  tags: ${JSON.stringify(tags || [])},
  code: {
    entrypoint: "${SPECS_RELATIVE_PATH}/${specFilename}",
  },
  frequency: Frequency.${frequency},
  locations: ${JSON.stringify(locations)},${privateLocations.length > 0 ? `\n  privateLocations: ${JSON.stringify(privateLocations)},` : ''}
  activated: ${activated},
  muted: false,
  retryStrategy: ${retryStrategy},
  runParallel: true,
});
`;

  return code;
}

/**
 * Generate an index file that imports all checks
 */
function generateIndexFile(files) {
  const imports = files.map(f => {
    // Use the already-generated filename (without .ts extension)
    const checkFilename = f.filename.replace('.ts', '');
    return `import "./${checkFilename}";`;
  });

  // Also import spec files indirectly through checks
  return `/**
 * Auto-generated index file for all Multi-Step checks
 * Generated from Datadog export
 */

${imports.join('\n')}
`;
}

/**
 * Main generation function
 */
async function main() {
  console.log('='.repeat(60));
  console.log('MultiStepCheck Construct Generator');
  console.log('='.repeat(60));

  // Check input files exist
  if (!existsSync(INPUT_FILE)) {
    console.error(`Error: Input file not found: ${INPUT_FILE}`);
    console.error('Run "npm run filter-multi" first to separate multi-step tests.');
    process.exit(1);
  }

  if (!existsSync(MANIFEST_FILE)) {
    console.error(`Error: Manifest file not found: ${MANIFEST_FILE}`);
    console.error('Run "npm run generate:multi-specs" first to generate spec files.');
    process.exit(1);
  }

  // Read inputs
  console.log(`\nReading: ${INPUT_FILE}`);
  const data = JSON.parse(await readFile(INPUT_FILE, 'utf-8'));

  console.log(`Reading: ${MANIFEST_FILE}`);
  const manifest = JSON.parse(await readFile(MANIFEST_FILE, 'utf-8'));

  // Create a map of public_id to spec filename
  const specFileMap = new Map();
  for (const file of manifest.files) {
    specFileMap.set(file.logicalId, file.filename);
  }

  const tests = data.tests || [];
  console.log(`Found ${tests.length} multi-step tests`);
  console.log(`Found ${manifest.files.length} generated spec files`);

  // Create output directory
  if (!existsSync(OUTPUT_DIR)) {
    await mkdir(OUTPUT_DIR, { recursive: true });
    console.log(`Created directory: ${OUTPUT_DIR}`);
  }

  // Generate construct files
  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  const generatedFiles = [];

  for (const test of tests) {
    const specFilename = specFileMap.get(test.public_id);

    if (!specFilename) {
      console.log(`  Skipping ${test.public_id}: no spec file found`);
      skippedCount++;
      continue;
    }

    try {
      const code = generateMultiStepCheckCode(test, specFilename);
      const filename = `${sanitizeFilename(test.name)}.check.ts`;
      const filepath = path.join(OUTPUT_DIR, filename);

      await writeFile(filepath, code, 'utf-8');
      successCount++;
      generatedFiles.push({
        logicalId: test.public_id,
        name: test.name,
        filename,
      });
    } catch (err) {
      console.error(`  Error generating ${test.public_id}: ${err.message}`);
      errorCount++;
    }
  }

  // Generate index file
  const indexCode = generateIndexFile(generatedFiles);
  await writeFile(path.join(OUTPUT_DIR, 'index.ts'), indexCode, 'utf-8');

  // Collect private locations for summary
  const allPrivateLocations = [...new Set(
    tests.flatMap(t => (t.locations || []).filter(l => l.startsWith('pl:')))
  )];

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Generation Summary');
  console.log('='.repeat(60));
  console.log(`  Check files generated: ${successCount}`);
  console.log(`  Skipped (no spec): ${skippedCount}`);
  console.log(`  Errors: ${errorCount}`);
  console.log(`  Output directory: ${OUTPUT_DIR}`);

  if (allPrivateLocations.length > 0) {
    console.log('\nPrivate locations found (need mapping in Checkly):');
    allPrivateLocations.forEach(loc => console.log(`  - ${loc}`));
  }

  console.log('\nNext steps:');
  console.log('  1. Review generated files in', OUTPUT_DIR);
  console.log('  2. Map private locations to Checkly PrivateLocation constructs');
  console.log('  3. Run "npx checkly test" to validate');
  console.log('  4. Run "npx checkly deploy" to deploy');

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
