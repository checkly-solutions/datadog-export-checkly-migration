/**
 * Generates Checkly BrowserCheck constructs from Datadog browser tests.
 *
 * Reads: exports/browser-tests.json (for metadata: tags, locations, frequency, etc.)
 * Reads: checkly-migrated/tests/browser/_manifest.json (for spec file mappings)
 * Outputs: checkly-migrated/__checks__/browser/*.check.ts
 *
 * Each BrowserCheck construct references its corresponding .spec.ts file.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { FREQUENCY_MAP, sanitizeFilename, generateLogicalId, convertFrequency } from './shared/utils.ts';
import { getOutputRoot, getExportsDir } from './shared/output-config.ts';
// Relative path from __checks__/browser/{public,private} to tests/browser/{public,private}
const SPECS_RELATIVE_PATH = '../../../tests/browser';

interface BrowserTest {
  public_id: string;
  name: string;
  // Pre-processed by step 01:
  locations: string[];           // Mapped public Checkly locations
  privateLocations: string[];    // Checkly private location slugs (derived from Datadog pl:xxx)
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

/**
 * Convert Datadog retry config to Checkly retry strategy
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
 * Generate a BrowserCheck construct for a test
 */
function generateBrowserCheckCode(test: BrowserTest, specFilename: string, locationType: string): string {
  const { public_id, name, tags, options, locations, privateLocations } = test;

  const logicalId = `browser-${generateLogicalId(name)}`;
  const frequency = convertFrequency(options?.tick_every);
  const retryStrategy = generateRetryStrategy(options?.retry);
  const activated = test.status === 'live'; // Preserves paused status from Datadog
  const specsPath = `${SPECS_RELATIVE_PATH}/${locationType}`;

  const code = `/**
 * Migrated from Datadog Synthetic: ${public_id}
 */
import {
  BrowserCheck,
  Frequency,
  RetryStrategyBuilder,
} from "checkly/constructs";

new BrowserCheck("${logicalId}", {
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
    const checkFilename = f.filename.replace('.ts', '');
    return `import "./${checkFilename}";`;
  });

  return `/**
 * Auto-generated index file for all Browser checks
 * Generated from Datadog export
 */

${imports.join('\n')}
`;
}

/**
 * Generate constructs for a location type
 */
async function generateConstructsForLocationType(
  tests: BrowserTest[],
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
      const code = generateBrowserCheckCode(test, specFilename, locationType);
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
  const outputRoot = await getOutputRoot();
  const exportsDir = await getExportsDir();
  const INPUT_FILE = `${exportsDir}/browser-tests.json`;
  const MANIFEST_FILE_PUBLIC = `${outputRoot}/tests/browser/public/_manifest.json`;
  const MANIFEST_FILE_PRIVATE = `${outputRoot}/tests/browser/private/_manifest.json`;
  const OUTPUT_DIR_PUBLIC = `${outputRoot}/__checks__/browser/public`;
  const OUTPUT_DIR_PRIVATE = `${outputRoot}/__checks__/browser/private`;

  console.log('='.repeat(60));
  console.log('BrowserCheck Construct Generator');
  console.log('='.repeat(60));

  // Check input file exists
  if (!existsSync(INPUT_FILE)) {
    console.log(`\nSkipping: Input file not found: ${INPUT_FILE}`);
    console.log('No browser tests to process. Run "npm run export" first if you have browser tests.');
    return;
  }

  // Read test data
  console.log(`\nReading: ${INPUT_FILE}`);
  const data = JSON.parse(await readFile(INPUT_FILE, 'utf-8')) as { tests: BrowserTest[] };
  const tests = data.tests || [];
  console.log(`Found ${tests.length} browser tests`);

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
