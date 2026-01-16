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
const MANIFEST_FILE_PUBLIC = './checkly-migrated/tests/multi/public/_manifest.json';
const MANIFEST_FILE_PRIVATE = './checkly-migrated/tests/multi/private/_manifest.json';
const OUTPUT_DIR_PUBLIC = './checkly-migrated/__checks__/multi/public';
const OUTPUT_DIR_PRIVATE = './checkly-migrated/__checks__/multi/private';
// Relative path from __checks__/multi/{public,private} to tests/multi/{public,private}
const SPECS_RELATIVE_PATH = '../../../tests/multi';

interface DatadogTest {
  public_id: string;
  name: string;
  // Pre-processed by step 01:
  locations: string[];           // Mapped public Checkly locations
  privateLocations: string[];    // Private location IDs (pl:xxx)
  originalLocations: string[];   // Original Datadog locations for reference
  status?: string;
  tags?: string[];
  options?: {
    tick_every?: number;
    retry?: {
      count?: number;
      interval?: number;
    };
  };
}

interface ManifestFile {
  logicalId: string;
  name: string;
  filename: string;
}

interface Manifest {
  generatedAt: string;
  outputDir: string;
  locationType: string;
  files: ManifestFile[];
}

interface GeneratedFile {
  logicalId: string;
  name: string;
  filename: string;
}

interface GenerationResult {
  successCount: number;
  errorCount: number;
  skippedCount: number;
}

// Datadog tick_every (seconds) to Checkly frequency mapping
const FREQUENCY_MAP: Record<number, string> = {
  60: 'EVERY_1M',
  120: 'EVERY_2M',
  300: 'EVERY_5M',
  600: 'EVERY_10M',
  900: 'EVERY_15M',
  1800: 'EVERY_30M',
  3600: 'EVERY_1H',
  7200: 'EVERY_2H',
  14400: 'EVERY_6H', // Checkly doesn't have EVERY_4H, using closest
  21600: 'EVERY_6H',
  43200: 'EVERY_12H',
  86400: 'EVERY_24H',
};

/**
 * Sanitize a string to be a valid filename
 */
function sanitizeFilename(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
}

/**
 * Generate a slug from the check name for use as logicalId
 */
function generateLogicalId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 64);
}

/**
 * Sanitize a string to be a valid TypeScript identifier
 */
function sanitizeIdentifier(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^(\d)/, '_$1')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Map Datadog tick_every to Checkly frequency
 */
function convertFrequency(tickEvery?: number): string {
  const tick = tickEvery || 300;
  const frequencies = Object.keys(FREQUENCY_MAP).map(Number).sort((a, b) => a - b);

  for (const freq of frequencies) {
    if (tick <= freq) {
      return FREQUENCY_MAP[freq];
    }
  }

  return FREQUENCY_MAP[tick] || 'EVERY_10M';
}

/**
 * Generate RetryStrategyBuilder code
 */
function generateRetryStrategy(ddRetry?: { count?: number; interval?: number }): string {
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
function generateMultiStepCheckCode(test: DatadogTest, specFilename: string, locationType: string): string {
  const { public_id, name, tags, options, locations, privateLocations } = test;

  const logicalId = generateLogicalId(name);
  const frequency = convertFrequency(options?.tick_every);
  const retryStrategy = generateRetryStrategy(options?.retry);
  const activated = test.status === 'live';
  const specsPath = `${SPECS_RELATIVE_PATH}/${locationType}`;

  const code = `/**
 * Migrated from Datadog Synthetic: ${public_id}
 */
import {
  Frequency,
  MultiStepCheck,
  RetryStrategyBuilder,
} from "checkly/constructs";

new MultiStepCheck("${logicalId}", {
  name: "${name.replace(/"/g, '\\"')}",
  tags: ${JSON.stringify(tags || [])},
  code: {
    entrypoint: "${specsPath}/${specFilename}",
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
function generateIndexFile(files: GeneratedFile[]): string {
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
 * Generate constructs for a location type
 */
async function generateConstructsForLocationType(
  tests: DatadogTest[],
  specFileMap: Map<string, string>,
  outputDir: string,
  locationType: string
): Promise<GenerationResult> {
  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  const generatedFiles: GeneratedFile[] = [];

  for (const test of tests) {
    const specFilename = specFileMap.get(test.public_id);

    if (!specFilename) {
      skippedCount++;
      continue;
    }

    try {
      const code = generateMultiStepCheckCode(test, specFilename, locationType);
      const filename = `${sanitizeFilename(test.name)}.check.ts`;
      const filepath = path.join(outputDir, filename);

      await writeFile(filepath, code, 'utf-8');
      successCount++;
      generatedFiles.push({
        logicalId: test.public_id,
        name: test.name,
        filename,
      });
    } catch (err) {
      console.error(`  Error generating ${test.public_id}: ${(err as Error).message}`);
      errorCount++;
    }
  }

  // Generate index file if there are files
  if (generatedFiles.length > 0) {
    const indexCode = generateIndexFile(generatedFiles);
    await writeFile(path.join(outputDir, 'index.ts'), indexCode, 'utf-8');
  }

  return { successCount, errorCount, skippedCount };
}

/**
 * Main generation function
 */
async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('MultiStepCheck Construct Generator');
  console.log('='.repeat(60));

  // Check input file exists
  if (!existsSync(INPUT_FILE)) {
    console.error(`Error: Input file not found: ${INPUT_FILE}`);
    console.error('Run "npm run filter-multi" first to separate multi-step tests.');
    process.exit(1);
  }

  // Read test data
  console.log(`\nReading: ${INPUT_FILE}`);
  const data = JSON.parse(await readFile(INPUT_FILE, 'utf-8')) as { tests: DatadogTest[] };
  const tests = data.tests || [];
  console.log(`Found ${tests.length} multi-step tests`);

  // Create output directories
  if (!existsSync(OUTPUT_DIR_PUBLIC)) {
    await mkdir(OUTPUT_DIR_PUBLIC, { recursive: true });
  }
  if (!existsSync(OUTPUT_DIR_PRIVATE)) {
    await mkdir(OUTPUT_DIR_PRIVATE, { recursive: true });
  }

  let publicSuccess = 0, publicSkipped = 0, publicErrors = 0;
  let privateSuccess = 0, privateSkipped = 0, privateErrors = 0;

  // Process public manifest
  if (existsSync(MANIFEST_FILE_PUBLIC)) {
    console.log(`\nReading: ${MANIFEST_FILE_PUBLIC}`);
    const publicManifest = JSON.parse(await readFile(MANIFEST_FILE_PUBLIC, 'utf-8')) as Manifest;

    const publicSpecMap = new Map<string, string>();
    for (const file of publicManifest.files) {
      publicSpecMap.set(file.logicalId, file.filename);
    }
    console.log(`Found ${publicManifest.files.length} public spec files`);

    // Filter tests that have specs in the public manifest
    const publicTests = tests.filter(t => publicSpecMap.has(t.public_id));

    console.log('\nGenerating public constructs...');
    const publicResult = await generateConstructsForLocationType(
      publicTests, publicSpecMap, OUTPUT_DIR_PUBLIC, 'public'
    );
    publicSuccess = publicResult.successCount;
    publicSkipped = publicResult.skippedCount;
    publicErrors = publicResult.errorCount;
  } else {
    console.log(`\nNo public manifest found at ${MANIFEST_FILE_PUBLIC}`);
  }

  // Process private manifest
  if (existsSync(MANIFEST_FILE_PRIVATE)) {
    console.log(`\nReading: ${MANIFEST_FILE_PRIVATE}`);
    const privateManifest = JSON.parse(await readFile(MANIFEST_FILE_PRIVATE, 'utf-8')) as Manifest;

    const privateSpecMap = new Map<string, string>();
    for (const file of privateManifest.files) {
      privateSpecMap.set(file.logicalId, file.filename);
    }
    console.log(`Found ${privateManifest.files.length} private spec files`);

    // Filter tests that have specs in the private manifest
    const privateTests = tests.filter(t => privateSpecMap.has(t.public_id));

    console.log('\nGenerating private constructs...');
    const privateResult = await generateConstructsForLocationType(
      privateTests, privateSpecMap, OUTPUT_DIR_PRIVATE, 'private'
    );
    privateSuccess = privateResult.successCount;
    privateSkipped = privateResult.skippedCount;
    privateErrors = privateResult.errorCount;
  } else {
    console.log(`\nNo private manifest found at ${MANIFEST_FILE_PRIVATE}`);
  }

  // Collect private locations for summary
  const allPrivateLocations = [...new Set(
    tests.flatMap(t => (t.locations || []).filter(l => l.startsWith('pl:')))
  )];

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Generation Summary');
  console.log('='.repeat(60));
  console.log(`  Public checks generated: ${publicSuccess} → ${OUTPUT_DIR_PUBLIC}`);
  console.log(`  Private checks generated: ${privateSuccess} → ${OUTPUT_DIR_PRIVATE}`);
  console.log(`  Skipped (no spec): ${publicSkipped + privateSkipped}`);
  console.log(`  Errors: ${publicErrors + privateErrors}`);

  if (allPrivateLocations.length > 0) {
    console.log('\nPrivate locations found (need mapping in Checkly):');
    allPrivateLocations.forEach(loc => console.log(`  - ${loc}`));
  }

  console.log('\nNext steps:');
  console.log('  1. Review generated files');
  console.log('  2. Map private locations to Checkly PrivateLocation constructs');
  console.log('  3. Run "npx checkly test" to validate');
  console.log('  4. Run "npx checkly deploy" to deploy');

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
