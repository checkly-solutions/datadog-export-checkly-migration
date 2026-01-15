/**
 * Generates Checkly CLI constructs from the intermediate JSON format.
 *
 * Reads: exports/checkly-api-checks.json
 * Outputs: checkly/__checks__/*.check.ts
 *
 * Generates TypeScript files using Checkly CLI constructs that can be
 * deployed with `npx checkly deploy`.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const INPUT_FILE = './exports/checkly-api-checks.json';
const OUTPUT_DIR = './checkly-migrated/__checks__/api';

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
 * Generate AssertionBuilder code for an assertion
 */
function generateAssertion(assertion) {
  const { source, comparison, target, property } = assertion;

  // Map source to AssertionBuilder method
  const sourceMethodMap = {
    STATUS_CODE: 'statusCode',
    RESPONSE_TIME: 'responseTime',
    JSON_BODY: 'jsonBody',
    TEXT_BODY: 'textBody',
    HEADERS: 'headers',
  };

  // Map comparison to AssertionBuilder comparison method
  const comparisonMethodMap = {
    EQUALS: 'equals',
    NOT_EQUALS: 'notEquals',
    LESS_THAN: 'lessThan',
    LESS_THAN_OR_EQUAL: 'lessThanOrEqual',
    GREATER_THAN: 'greaterThan',
    GREATER_THAN_OR_EQUAL: 'greaterThanOrEqual',
    CONTAINS: 'contains',
    NOT_CONTAINS: 'notContains',
    MATCHES: 'matches',
    NOT_MATCHES: 'notMatches',
    IS_EMPTY: 'isEmpty',
    IS_NOT_EMPTY: 'isNotEmpty',
    IS_NULL: 'isNull',
  };

  const sourceMethod = sourceMethodMap[source] || 'statusCode';
  const comparisonMethod = comparisonMethodMap[comparison] || 'equals';

  // Build the assertion chain
  let code = 'AssertionBuilder';

  // Add source method with optional property
  if (source === 'JSON_BODY' && property) {
    code += `.jsonBody("${property}")`;
  } else if (source === 'HEADERS' && property) {
    code += `.headers("${property}")`;
  } else {
    code += `.${sourceMethod}()`;
  }

  // Add comparison method with target
  if (comparisonMethod === 'isEmpty' || comparisonMethod === 'isNotEmpty' || comparisonMethod === 'isNull') {
    code += `.${comparisonMethod}()`;
  } else {
    const targetValue = typeof target === 'string' ? `"${target}"` : target;
    code += `.${comparisonMethod}(${targetValue})`;
  }

  return code;
}

/**
 * Generate RetryStrategyBuilder code
 */
function generateRetryStrategy(retryStrategy) {
  if (!retryStrategy || retryStrategy.type === 'NONE') {
    return 'RetryStrategyBuilder.noRetries()';
  }

  const { type, baseBackoffSeconds, maxRetries, maxDurationSeconds, sameRegion } = retryStrategy;

  const strategyMethodMap = {
    LINEAR: 'linearStrategy',
    EXPONENTIAL: 'exponentialStrategy',
    FIXED: 'fixedStrategy',
  };

  const method = strategyMethodMap[type] || 'linearStrategy';

  const options = [];
  if (baseBackoffSeconds !== undefined) options.push(`baseBackoffSeconds: ${baseBackoffSeconds}`);
  if (maxRetries !== undefined) options.push(`maxRetries: ${maxRetries}`);
  if (maxDurationSeconds !== undefined) options.push(`maxDurationSeconds: ${maxDurationSeconds}`);
  if (sameRegion !== undefined) options.push(`sameRegion: ${sameRegion}`);

  return `RetryStrategyBuilder.${method}({
    ${options.join(',\n    ')},
  })`;
}

/**
 * Generate a single ApiCheck construct
 */
function generateApiCheckCode(check) {
  const {
    logicalId,
    name,
    tags,
    request,
    assertions,
    frequency,
    maxResponseTime,
    degradedResponseTime,
    locations,
    privateLocations,
    retryStrategy,
    activated,
    muted,
  } = check;

  // Build request object
  const requestLines = [
    `url: "${request.url}"`,
    `method: "${request.method}"`,
  ];

  if (request.headers && Object.keys(request.headers).length > 0) {
    requestLines.push(`headers: ${JSON.stringify(request.headers, null, 6).replace(/\n/g, '\n    ')}`);
  }

  if (request.body) {
    const bodyStr = typeof request.body === 'string'
      ? `"${request.body.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
      : JSON.stringify(request.body);
    requestLines.push(`body: ${bodyStr}`);
  }

  if (request.queryParameters && Object.keys(request.queryParameters).length > 0) {
    requestLines.push(`queryParameters: ${JSON.stringify(request.queryParameters, null, 6).replace(/\n/g, '\n    ')}`);
  }

  if (request.basicAuth) {
    requestLines.push(`basicAuth: {
      username: "${request.basicAuth.username}",
      password: "${request.basicAuth.password}",
    }`);
  }

  // Build assertions array
  const assertionLines = assertions.map(a => generateAssertion(a));

  // Build the full construct
  const code = `import {
  ApiCheck,
  AssertionBuilder,
  Frequency,
  RetryStrategyBuilder,
} from "checkly/constructs";

new ApiCheck("${logicalId}", {
  name: "${name.replace(/"/g, '\\"')}",
  tags: ${JSON.stringify(tags)},
  request: {
    ${requestLines.join(',\n    ')},
  },
  assertions: [
    ${assertionLines.join(',\n    ')},
  ],
  frequency: Frequency.${frequency},
  locations: ${JSON.stringify(locations)},${privateLocations.length > 0 ? `\n  privateLocations: ${JSON.stringify(privateLocations)},` : ''}
  degradedResponseTime: ${degradedResponseTime},
  maxResponseTime: ${maxResponseTime},
  activated: ${activated},
  muted: ${muted},
  retryStrategy: ${generateRetryStrategy(retryStrategy)},
});
`;

  return code;
}

/**
 * Generate an index file that exports all checks
 */
function generateIndexFile(generatedFiles) {
  const imports = generatedFiles.map(f => {
    // Use the already-generated filename (without .ts extension)
    const checkFilename = f.filename.replace('.ts', '');
    return `import "./${checkFilename}";`;
  });

  return `/**
 * Auto-generated index file for all API checks
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
  console.log('Checkly Construct Generator');
  console.log('='.repeat(60));

  // Read input
  console.log(`\nReading: ${INPUT_FILE}`);

  if (!existsSync(INPUT_FILE)) {
    console.error(`Error: Input file not found: ${INPUT_FILE}`);
    console.error('Run "npm run convert:api" first to generate the intermediate JSON.');
    process.exit(1);
  }

  const data = JSON.parse(await readFile(INPUT_FILE, 'utf-8'));
  console.log(`Found ${data.checks.length} checks to generate`);

  // Filter out checks with conversion errors
  const validChecks = data.checks.filter(c => !c._conversionError);
  const errorChecks = data.checks.filter(c => c._conversionError);

  if (errorChecks.length > 0) {
    console.log(`  - Skipping ${errorChecks.length} checks with conversion errors`);
  }
  console.log(`  - Generating ${validChecks.length} check files`);

  // Create output directory
  if (!existsSync(OUTPUT_DIR)) {
    await mkdir(OUTPUT_DIR, { recursive: true });
    console.log(`\nCreated directory: ${OUTPUT_DIR}`);
  }

  // Generate check files
  let successCount = 0;
  let errorCount = 0;
  const generatedFiles = [];

  for (const check of validChecks) {
    try {
      const code = generateApiCheckCode(check);
      const filename = `${sanitizeFilename(check.name)}.check.ts`;
      const filepath = path.join(OUTPUT_DIR, filename);

      await writeFile(filepath, code, 'utf-8');
      successCount++;
      generatedFiles.push({ name: check.name, filename });
    } catch (err) {
      console.error(`  Error generating ${check.logicalId}: ${err.message}`);
      errorCount++;
    }
  }

  // Generate index file
  const indexCode = generateIndexFile(generatedFiles);
  await writeFile(path.join(OUTPUT_DIR, 'index.ts'), indexCode, 'utf-8');

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Generation Summary');
  console.log('='.repeat(60));
  console.log(`  Files generated: ${successCount}`);
  console.log(`  Errors: ${errorCount}`);
  console.log(`  Output directory: ${OUTPUT_DIR}`);

  if (data.privateLocationsFound?.length > 0) {
    console.log('\n⚠️  Private Locations Found:');
    console.log('   These need to be mapped to Checkly private locations.');
    console.log('   Create PrivateLocation constructs or update the generated files.');
    data.privateLocationsFound.forEach(loc => console.log(`   - ${loc}`));
  }

  console.log('\nNext steps:');
  console.log('  1. Review generated files in', OUTPUT_DIR);
  console.log('  2. Create a checkly.config.ts if not present');
  console.log('  3. Map private locations to Checkly PrivateLocation constructs');
  console.log('  4. Run "npx checkly test" to validate');
  console.log('  5. Run "npx checkly deploy" to deploy');

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
