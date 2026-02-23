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
import { sanitizeFilename, generateLogicalId, hasPrivateLocations } from './shared/utils.ts';
import { trackVariablesFromMultiple, loadExistingVariableUsage, writeVariableUsageReport } from './shared/variable-tracker.ts';
import { getOutputRoot, getExportsDir } from './shared/output-config.ts';

interface ChecklyAssertion {
  source: string;
  comparison: string;
  target?: string | number | Record<string, unknown>;
  property?: string;
}

interface ChecklyRetryStrategy {
  type: string;
  baseBackoffSeconds?: number;
  maxRetries?: number;
  maxDurationSeconds?: number;
  sameRegion?: boolean;
}

interface ChecklyCheck {
  logicalId: string;
  name: string;
  tags: string[];
  request: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
    basicAuth?: {
      username: string;
      password: string;
    };
    queryParameters?: Record<string, string>;
  };
  assertions: ChecklyAssertion[];
  frequency: string;
  degradedResponseTime: number;
  maxResponseTime: number;
  locations: string[];
  privateLocations: string[];
  retryStrategy: ChecklyRetryStrategy;
  activated: boolean;
  muted: boolean;
  _conversionError?: string;
  _datadogMeta?: {
    publicId: string;
    monitorId?: number;
    createdAt?: string;
    modifiedAt?: string;
    creator?: Record<string, unknown>;
    message?: string;
    subtype?: string;
  };
}

interface GeneratedFile {
  name: string;
  filename: string;
}

/**
 * Extract all content strings that might contain variables from an API check
 */
function extractVariableContent(check: ChecklyCheck): string[] {
  const content: string[] = [];

  // Request URL
  if (check.request?.url) {
    content.push(check.request.url);
  }

  // Request body
  if (check.request?.body) {
    content.push(check.request.body);
  }

  // Request headers
  if (check.request?.headers) {
    for (const value of Object.values(check.request.headers)) {
      content.push(value);
    }
  }

  // Query parameters
  if (check.request?.queryParameters) {
    for (const value of Object.values(check.request.queryParameters)) {
      content.push(value);
    }
  }

  // Basic auth credentials
  if (check.request?.basicAuth) {
    content.push(check.request.basicAuth.username);
    content.push(check.request.basicAuth.password);
  }

  return content;
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
 * Check if target is a JSON path object from Datadog conversion
 */
interface JsonPathTarget {
  jsonPath: string;
  operator: string;
  targetValue: string | number;
}

function isJsonPathTarget(target: unknown): target is JsonPathTarget {
  return (
    typeof target === 'object' &&
    target !== null &&
    'jsonPath' in target &&
    'operator' in target &&
    'targetValue' in target
  );
}

/**
 * Check if target is an XPath object from Datadog conversion
 */
interface XPathTarget {
  xPath: string;
  operator: string;
  targetValue: string | number;
}

function isXPathTarget(target: unknown): target is XPathTarget {
  return (
    typeof target === 'object' &&
    target !== null &&
    'xPath' in target &&
    'operator' in target &&
    'targetValue' in target
  );
}

/**
 * Generate AssertionBuilder code for an assertion
 * Returns null for unsupported assertion types
 */
function generateAssertion(assertion: ChecklyAssertion): string | null {
  const { source, comparison, target, property } = assertion;

  // Map source to AssertionBuilder method
  // Only sources supported by Checkly's AssertionBuilder
  const sourceMethodMap: Record<string, string> = {
    STATUS_CODE: 'statusCode',
    RESPONSE_TIME: 'responseTime',
    JSON_BODY: 'jsonBody',
    TEXT_BODY: 'textBody',
    HEADERS: 'headers',
  };

  // Unsupported Datadog assertion sources that have no Checkly equivalent
  // These are typically from SSL and TCP checks
  const unsupportedSources = [
    'CERTIFICATE',
    'TLSVERSION',
    'CONNECTION',
    'GRPC_HEALTHCHECK_STATUS',
    'GRPC_METADATA',
    'GRPC_PROTO',
  ];

  // Skip unsupported assertion sources with a comment
  if (unsupportedSources.includes(source)) {
    return null; // Will be filtered out and replaced with a comment
  }

  // Numeric sources that don't support string comparison methods
  const numericSources = ['STATUS_CODE', 'RESPONSE_TIME'];
  // String comparison methods that don't work with numeric sources
  const stringOnlyComparisons = ['MATCHES', 'NOT_MATCHES', 'CONTAINS', 'NOT_CONTAINS', 'IS_EMPTY', 'IS_NOT_EMPTY'];

  // Skip incompatible source/comparison combinations
  if (numericSources.includes(source) && stringOnlyComparisons.includes(comparison)) {
    return null; // Will be filtered out - regex/string comparisons don't work on status codes
  }

  // Map comparison to AssertionBuilder comparison method
  // Note: Checkly doesn't have lessThanOrEqual/greaterThanOrEqual, so we map to closest
  const comparisonMethodMap: Record<string, string> = {
    EQUALS: 'equals',
    NOT_EQUALS: 'notEquals',
    LESS_THAN: 'lessThan',
    LESS_THAN_OR_EQUAL: 'lessThan', // Checkly doesn't have lessThanOrEqual
    GREATER_THAN: 'greaterThan',
    GREATER_THAN_OR_EQUAL: 'greaterThan', // Checkly doesn't have greaterThanOrEqual
    CONTAINS: 'contains',
    NOT_CONTAINS: 'notContains',
    MATCHES: 'matches',
    NOT_MATCHES: 'notMatches',
    IS_EMPTY: 'isEmpty',
    IS_NOT_EMPTY: 'isNotEmpty',
    IS_NULL: 'isNull',
  };

  // Numeric comparison methods that require number arguments
  const numericComparisonMethods = ['lessThan', 'greaterThan'];

  // Handle JSON_PATH comparison with object target (from Datadog validatesJSONPath)
  // Convert to jsonBody(jsonPath).operator(targetValue)
  if (comparison === 'JSON_PATH' && isJsonPathTarget(target)) {
    const { jsonPath, operator, targetValue } = target;
    const method = comparisonMethodMap[operator.toUpperCase()] || 'contains';

    // Escape quotes in jsonPath
    const escapedJsonPath = jsonPath.replace(/"/g, '\\"');

    // Format the target value
    let formattedValue: string;
    if (typeof targetValue === 'string') {
      // Check if it's a numeric string for numeric methods
      if (numericComparisonMethods.includes(method) && !isNaN(Number(targetValue))) {
        formattedValue = String(Number(targetValue));
      } else {
        formattedValue = `"${targetValue.replace(/"/g, '\\"')}"`;
      }
    } else {
      formattedValue = String(targetValue);
    }

    return `AssertionBuilder.jsonBody("${escapedJsonPath}").${method}(${formattedValue})`;
  }

  // Handle VALIDATESXPATH comparison with object target (from Datadog validatesXPath)
  // Checkly has no XPath support, so extract the targetValue and use textBody().contains()
  if (comparison === 'VALIDATESXPATH' && isXPathTarget(target)) {
    const { targetValue } = target;
    let formattedValue: string;
    if (typeof targetValue === 'string') {
      formattedValue = `"${targetValue.replace(/"/g, '\\"')}"`;
    } else {
      formattedValue = String(targetValue);
    }
    return `AssertionBuilder.textBody().contains(${formattedValue})`;
  }

  const sourceMethod = sourceMethodMap[source] || 'statusCode';
  const comparisonMethod = comparisonMethodMap[comparison] || 'equals';

  // Build the assertion chain
  let code = 'AssertionBuilder';

  // Add source method with optional property (escape quotes in property)
  if (source === 'JSON_BODY' && property) {
    const escapedProperty = property.replace(/"/g, '\\"');
    code += `.jsonBody("${escapedProperty}")`;
  } else if (source === 'HEADERS' && property) {
    const escapedProperty = property.replace(/"/g, '\\"');
    code += `.headers("${escapedProperty}")`;
  } else {
    code += `.${sourceMethod}()`;
  }

  // Add comparison method with target
  if (comparisonMethod === 'isEmpty' || comparisonMethod === 'isNotEmpty' || comparisonMethod === 'isNull') {
    code += `.${comparisonMethod}()`;
  } else {
    // Handle different target types
    let targetValue: string;
    if (target === undefined || target === null) {
      targetValue = '""';
    } else if (typeof target === 'string') {
      // For numeric comparison methods, convert string to number if valid
      if (numericComparisonMethods.includes(comparisonMethod) && !isNaN(Number(target))) {
        targetValue = String(Number(target));
      } else {
        targetValue = `"${target.replace(/"/g, '\\"')}"`;
      }
    } else if (typeof target === 'number' || typeof target === 'boolean') {
      targetValue = String(target);
    } else if (typeof target === 'object' && target !== null && 'targetValue' in target) {
      // Object with targetValue (e.g. unhandled xPath/jsonPath assertion) — extract the value
      const tv = (target as Record<string, unknown>).targetValue;
      if (typeof tv === 'string') {
        targetValue = `"${tv.replace(/"/g, '\\"')}"`;
      } else {
        targetValue = String(tv);
      }
    } else {
      // For other objects/arrays, stringify them
      targetValue = JSON.stringify(target);
    }
    code += `.${comparisonMethod}(${targetValue})`;
  }

  return code;
}

/**
 * Generate RetryStrategyBuilder code
 */
function generateRetryStrategy(retryStrategy: ChecklyRetryStrategy): string {
  if (!retryStrategy || retryStrategy.type === 'NONE') {
    return 'RetryStrategyBuilder.noRetries()';
  }

  const { type, baseBackoffSeconds, maxRetries, maxDurationSeconds, sameRegion } = retryStrategy;

  const strategyMethodMap: Record<string, string> = {
    LINEAR: 'linearStrategy',
    EXPONENTIAL: 'exponentialStrategy',
    FIXED: 'fixedStrategy',
  };

  const method = strategyMethodMap[type] || 'linearStrategy';

  const options: string[] = [];
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
function generateApiCheckCode(check: ChecklyCheck): string {
  const {
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
    _datadogMeta,
  } = check;

  const datadogPublicId = _datadogMeta?.publicId || check.logicalId;
  const logicalId = `api-${generateLogicalId(name)}`;

  // Build request object
  const requestLines: string[] = [
    `url: "${request.url}"`,
    `method: "${request.method}"`,
  ];

  if (request.headers && Object.keys(request.headers).length > 0) {
    // Convert headers from Record<string, string> to KeyValuePair[] format
    const headerPairs = Object.entries(request.headers).map(
      ([key, value]) => `{ key: "${key}", value: "${value.replace(/"/g, '\\"')}" }`
    );
    requestLines.push(`headers: [\n      ${headerPairs.join(',\n      ')},\n    ]`);
  }

  if (request.body) {
    const bodyStr = typeof request.body === 'string'
      // Escape backslashes first, then quotes, then newlines
      ? `"${request.body.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`
      : JSON.stringify(request.body);
    requestLines.push(`body: ${bodyStr}`);
  }

  if (request.queryParameters && Object.keys(request.queryParameters).length > 0) {
    // Convert query params from Record<string, string> to KeyValuePair[] format
    const queryPairs = Object.entries(request.queryParameters).map(
      ([key, value]) => `{ key: "${key}", value: "${String(value).replace(/"/g, '\\"')}" }`
    );
    requestLines.push(`queryParameters: [\n      ${queryPairs.join(',\n      ')},\n    ]`);
  }

  if (request.basicAuth) {
    requestLines.push(`basicAuth: {
      username: "${request.basicAuth.username}",
      password: "${request.basicAuth.password}",
    }`);
  }

  // Build assertions array - assertions go inside the request object
  // Filter out null values (unsupported assertions) and add comment if any were skipped
  const assertionResults = assertions.map(a => generateAssertion(a));
  const validAssertions = assertionResults.filter((a): a is string => a !== null);
  const skippedCount = assertionResults.length - validAssertions.length;

  if (validAssertions.length > 0) {
    const skippedComment = skippedCount > 0
      ? ` // Note: ${skippedCount} unsupported assertion(s) from Datadog were skipped (e.g., SSL certificate, TCP connection)`
      : '';
    requestLines.push(`assertions: [${skippedComment}
      ${validAssertions.join(',\n      ')},
    ]`);
  }

  // Filter out unsupported location formats (azure:*, gcp:* are not valid Checkly locations)
  // Valid Checkly locations are AWS region codes like us-east-1, eu-west-2, etc.
  const validLocations = locations.filter(loc => !loc.includes(':') || loc.startsWith('aws:'));
  // Remove aws: prefix if present
  const cleanLocations = validLocations.map(loc => loc.replace(/^aws:/, ''));

  // Build the full construct
  const code = `/**
 * Migrated from Datadog Synthetic: ${datadogPublicId}
 */
import {
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
  frequency: Frequency.${frequency},
  locations: ${JSON.stringify(cleanLocations)},${privateLocations.length > 0 ? `\n  privateLocations: ${JSON.stringify(privateLocations)},` : ''}
  degradedResponseTime: ${degradedResponseTime},
  maxResponseTime: ${maxResponseTime},
  activated: ${activated}, // Preserves paused status from Datadog (status !== 'live' -> activated: false)
  muted: ${muted},
  retryStrategy: ${generateRetryStrategy(retryStrategy)},
});
`;

  return code;
}

/**
 * Generate an index file that exports all checks
 */
function generateIndexFile(generatedFiles: GeneratedFile[]): string {
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
async function main(): Promise<void> {
  const outputRoot = await getOutputRoot();
  const exportsDir = await getExportsDir();
  const INPUT_FILE = `${exportsDir}/checkly-api-checks.json`;
  const OUTPUT_BASE = `${outputRoot}/__checks__/api`;
  const OUTPUT_DIR_PUBLIC = `${OUTPUT_BASE}/public`;
  const OUTPUT_DIR_PRIVATE = `${OUTPUT_BASE}/private`;

  console.log('='.repeat(60));
  console.log('Checkly Construct Generator');
  console.log('='.repeat(60));

  // Load existing variable usage (for merging across generator runs)
  await loadExistingVariableUsage();

  // Read input
  console.log(`\nReading: ${INPUT_FILE}`);

  if (!existsSync(INPUT_FILE)) {
    console.log(`\nSkipping: Input file not found: ${INPUT_FILE}`);
    console.log('No API checks to generate. Run "npm run convert:api" first if you have API tests.');
    return;
  }

  const data = JSON.parse(await readFile(INPUT_FILE, 'utf-8')) as {
    checks: ChecklyCheck[];
    privateLocationsFound?: string[];
  };
  console.log(`Found ${data.checks.length} checks to generate`);

  // Filter out checks with conversion errors
  const validChecks = data.checks.filter(c => !c._conversionError);
  const errorChecks = data.checks.filter(c => c._conversionError);

  if (errorChecks.length > 0) {
    console.log(`  - Skipping ${errorChecks.length} checks with conversion errors`);
  }

  // Separate by location type
  const publicChecks = validChecks.filter(c => !hasPrivateLocations(c));
  const privateChecks = validChecks.filter(c => hasPrivateLocations(c));

  console.log(`  - Public location checks: ${publicChecks.length}`);
  console.log(`  - Private location checks: ${privateChecks.length}`);

  // Create output directories
  if (!existsSync(OUTPUT_DIR_PUBLIC)) {
    await mkdir(OUTPUT_DIR_PUBLIC, { recursive: true });
  }
  if (!existsSync(OUTPUT_DIR_PRIVATE)) {
    await mkdir(OUTPUT_DIR_PRIVATE, { recursive: true });
  }
  console.log(`\nCreated directories: ${OUTPUT_DIR_PUBLIC}, ${OUTPUT_DIR_PRIVATE}`);

  // Generate check files
  let publicSuccess = 0;
  let privateSuccess = 0;
  let errorCount = 0;
  const publicFiles: GeneratedFile[] = [];
  const privateFiles: GeneratedFile[] = [];

  // Generate public checks
  for (const check of publicChecks) {
    try {
      // Track variable usage for this check
      const variableContent = extractVariableContent(check);
      trackVariablesFromMultiple(check.name, variableContent);

      const code = generateApiCheckCode(check);
      const filename = `${sanitizeFilename(check.name)}.check.ts`;
      const filepath = path.join(OUTPUT_DIR_PUBLIC, filename);

      await writeFile(filepath, code, 'utf-8');
      publicSuccess++;
      publicFiles.push({ name: check.name, filename });
    } catch (err) {
      console.error(`  Error generating ${check.logicalId}: ${(err as Error).message}`);
      errorCount++;
    }
  }

  // Generate private checks
  for (const check of privateChecks) {
    try {
      // Track variable usage for this check
      const variableContent = extractVariableContent(check);
      trackVariablesFromMultiple(check.name, variableContent);

      const code = generateApiCheckCode(check);
      const filename = `${sanitizeFilename(check.name)}.check.ts`;
      const filepath = path.join(OUTPUT_DIR_PRIVATE, filename);

      await writeFile(filepath, code, 'utf-8');
      privateSuccess++;
      privateFiles.push({ name: check.name, filename });
    } catch (err) {
      console.error(`  Error generating ${check.logicalId}: ${(err as Error).message}`);
      errorCount++;
    }
  }

  // Generate index files for each directory
  if (publicFiles.length > 0) {
    const publicIndexCode = generateIndexFile(publicFiles);
    await writeFile(path.join(OUTPUT_DIR_PUBLIC, 'index.ts'), publicIndexCode, 'utf-8');
  }

  if (privateFiles.length > 0) {
    const privateIndexCode = generateIndexFile(privateFiles);
    await writeFile(path.join(OUTPUT_DIR_PRIVATE, 'index.ts'), privateIndexCode, 'utf-8');
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Generation Summary');
  console.log('='.repeat(60));
  console.log(`  Public checks generated: ${publicSuccess} → ${OUTPUT_DIR_PUBLIC}`);
  console.log(`  Private checks generated: ${privateSuccess} → ${OUTPUT_DIR_PRIVATE}`);
  console.log(`  Errors: ${errorCount}`);

  if (data.privateLocationsFound?.length) {
    console.log('\n⚠️  Private Locations Found:');
    console.log('   These need to be mapped to Checkly private locations.');
    data.privateLocationsFound.forEach(loc => console.log(`   - ${loc}`));
  }

  // Write variable usage report
  console.log('\nWriting variable usage report...');
  await writeVariableUsageReport();

  console.log('\nNext steps:');
  console.log('  1. Review generated files in', OUTPUT_BASE);
  console.log('  2. Create a checkly.config.ts if not present');
  console.log('  3. Map private locations to Checkly PrivateLocation constructs');
  console.log('  4. Run "npx checkly test" to validate');
  console.log('  5. Run "npx checkly deploy" to deploy');

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
