/**
 * Converts Datadog API tests to Checkly API check configuration objects.
 *
 * Reads: exports/api-tests.json
 * Outputs: exports/checkly-api-checks.json
 *
 * The output format is deployment-agnostic and can be used with:
 *   - Checkly CLI constructs (TypeScript)
 *   - Checkly Terraform provider
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { FREQUENCY_MAP, convertFrequency } from './shared/utils.ts';

const EXPORTS_DIR = './exports';
const INPUT_FILE = path.join(EXPORTS_DIR, 'api-tests.json');
const OUTPUT_FILE = path.join(EXPORTS_DIR, 'checkly-api-checks.json');

interface DatadogAssertion {
  type: string;
  operator: string;
  target?: string | number;
  property?: string;
  targetjsonpath?: {
    jsonpath: string;
    operator: string;
    targetvalue: string | number;
  };
}

interface DatadogRetry {
  count?: number;
  interval?: number;
}

interface DatadogTest {
  public_id: string;
  name: string;
  type: string;
  subtype?: string;
  status?: string;
  tags?: string[];
  // Pre-processed by step 01:
  locations: string[];           // Mapped public Checkly locations
  privateLocations: string[];    // Checkly private location slugs (derived from Datadog pl:xxx)
  originalLocations: string[];   // Original Datadog locations for reference
  config?: {
    request?: {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      basicAuth?: {
        username?: string;
        password?: string;
      };
      query?: Record<string, string>;
    };
    assertions?: DatadogAssertion[];
  };
  options?: {
    tick_every?: number;
    retry?: DatadogRetry;
  };
  message?: string;
  monitor_id?: number;
  created_at?: string;
  modified_at?: string;
  creator?: Record<string, unknown>;
}

interface ChecklyAssertion {
  source: string;
  comparison: string;
  target?: string | number;
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
  shouldFail: boolean;
  _datadogMeta: {
    publicId: string;
    monitorId?: number;
    createdAt?: string;
    modifiedAt?: string;
    creator?: Record<string, unknown>;
    message?: string;
    subtype?: string;
  };
  _conversionError?: string;
  _originalTest?: DatadogTest;
}

// Datadog operator to Checkly comparison mapping
const OPERATOR_MAP: Record<string, string> = {
  is: 'EQUALS',
  isNot: 'NOT_EQUALS',
  lessThan: 'LESS_THAN',
  lessThanOrEqual: 'LESS_THAN_OR_EQUAL',
  moreThan: 'GREATER_THAN',
  moreThanOrEqual: 'GREATER_THAN_OR_EQUAL',
  contains: 'CONTAINS',
  doesNotContain: 'NOT_CONTAINS',
  matches: 'MATCHES',
  doesNotMatch: 'NOT_MATCHES',
  isInLessThan: 'LESS_THAN',
  isInMoreThan: 'GREATER_THAN',
  isEmpty: 'IS_EMPTY',
  isNotEmpty: 'IS_NOT_EMPTY',
  validatesJSONPath: 'JSON_PATH',
  isUndefined: 'IS_NULL',
};

// Datadog assertion type to Checkly source mapping
const ASSERTION_SOURCE_MAP: Record<string, string> = {
  statusCode: 'STATUS_CODE',
  responseTime: 'RESPONSE_TIME',
  body: 'TEXT_BODY',
  header: 'HEADERS',
  certificate: 'CERTIFICATE',
};

/**
 * Convert a Datadog assertion to Checkly assertion format
 */
function convertAssertion(ddAssertion: DatadogAssertion): ChecklyAssertion | null {
  const { type, operator, target, property } = ddAssertion;

  // Skip JavaScript assertions - they require custom handling
  if (type === 'javascript') {
    return null;
  }

  const assertion: ChecklyAssertion = {
    source: ASSERTION_SOURCE_MAP[type] || type?.toUpperCase() || 'STATUS_CODE',
    comparison: OPERATOR_MAP[operator] || operator?.toUpperCase() || 'EQUALS',
    target: target,
  };

  // Handle property for header assertions
  if (property) {
    assertion.property = property;
  }

  // Handle JSON body assertions (validatesJSONPath operator)
  if (operator === 'validatesJSONPath' && ddAssertion.targetjsonpath) {
    assertion.source = 'JSON_BODY';
    assertion.property = ddAssertion.targetjsonpath.jsonpath;
    assertion.comparison = OPERATOR_MAP[ddAssertion.targetjsonpath.operator] || 'EQUALS';
    assertion.target = ddAssertion.targetjsonpath.targetvalue;
  }

  return assertion;
}

/**
 * Convert Datadog retry config to Checkly retry strategy
 */
function convertRetryStrategy(ddRetry?: DatadogRetry): ChecklyRetryStrategy {
  if (!ddRetry || ddRetry.count === 0) {
    return {
      type: 'NONE',
    };
  }

  // Datadog interval is in milliseconds, Checkly uses seconds
  const intervalSeconds = Math.ceil((ddRetry.interval || 10000) / 1000);

  return {
    type: 'LINEAR',
    baseBackoffSeconds: intervalSeconds,
    maxRetries: ddRetry.count || 2,
    maxDurationSeconds: 600,
    sameRegion: true,
  };
}

// Checkly supported HTTP methods
const SUPPORTED_METHODS = ['GET', 'POST', 'PUT', 'HEAD', 'DELETE', 'PATCH'];

/**
 * Convert a single Datadog API test to Checkly config
 */
function convertTest(ddTest: DatadogTest): ChecklyCheck {
  // Locations are pre-processed by step 01
  const { locations, privateLocations } = ddTest;

  // Check for unsupported HTTP method
  const rawMethod = ddTest.config?.request?.method;
  const method = (rawMethod || 'GET').toUpperCase();
  if (!SUPPORTED_METHODS.includes(method)) {
    return {
      logicalId: ddTest.public_id,
      name: ddTest.name,
      tags: ddTest.tags || [],
      request: { url: '', method: 'GET' },
      assertions: [],
      frequency: 'EVERY_10M',
      degradedResponseTime: 10000,
      maxResponseTime: 30000,
      locations: [],
      privateLocations: [],
      retryStrategy: { type: 'NONE' },
      activated: false,
      muted: false,
      shouldFail: false,
      _datadogMeta: { publicId: ddTest.public_id, subtype: ddTest.subtype },
      _conversionError: `Unsupported HTTP method: ${method}. Checkly supports: ${SUPPORTED_METHODS.join(', ')}`,
    };
  }

  const config: ChecklyCheck = {
    // Identity
    logicalId: ddTest.public_id,
    name: ddTest.name,
    tags: ddTest.tags || [],

    // Request configuration
    request: {
      url: ddTest.config?.request?.url || '',
      method: ddTest.config?.request?.method || 'GET',
    },

    // Assertions (filter out null values from unsupported assertion types like javascript)
    assertions: (ddTest.config?.assertions || []).map(convertAssertion).filter((a): a is ChecklyAssertion => a !== null),

    // Timing
    frequency: convertFrequency(ddTest.options?.tick_every),

    // Response time thresholds (reasonable defaults for API checks)
    // These are independent of responseTime assertions which are converted separately
    degradedResponseTime: 10000,  // 10 seconds - check shows as degraded
    maxResponseTime: 30000,       // 30 seconds - check fails

    // Locations
    locations,
    privateLocations,

    // Retry strategy
    retryStrategy: convertRetryStrategy(ddTest.options?.retry),

    // Status
    activated: ddTest.status === 'live',
    muted: false,
    shouldFail: false,

    // Metadata from Datadog (for reference)
    _datadogMeta: {
      publicId: ddTest.public_id,
      monitorId: ddTest.monitor_id,
      createdAt: ddTest.created_at,
      modifiedAt: ddTest.modified_at,
      creator: ddTest.creator,
      message: ddTest.message,
      subtype: ddTest.subtype,
    },
  };

  // Add optional request properties if present
  if (ddTest.config?.request?.headers) {
    config.request.headers = ddTest.config.request.headers;
  }

  if (ddTest.config?.request?.body) {
    config.request.body = ddTest.config.request.body;
  }

  if (ddTest.config?.request?.basicAuth) {
    config.request.basicAuth = {
      username: ddTest.config.request.basicAuth.username || '',
      password: ddTest.config.request.basicAuth.password || '',
    };
  }

  if (ddTest.config?.request?.query) {
    config.request.queryParameters = ddTest.config.request.query;
  }

  return config;
}

/**
 * Main conversion function
 */
async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Datadog to Checkly API Check Converter');
  console.log('='.repeat(60));

  // Check input file exists
  if (!existsSync(INPUT_FILE)) {
    console.log(`\nSkipping: Input file not found: ${INPUT_FILE}`);
    console.log('No API tests to convert. Run "npm run export" first if you have API tests.');
    return;
  }

  console.log(`\nReading: ${INPUT_FILE}`);
  const data = JSON.parse(await readFile(INPUT_FILE, 'utf-8')) as {
    exportedAt: string;
    site: string;
    tests: DatadogTest[];
  };

  console.log(`Found ${data.tests.length} API tests to convert`);

  // Subtypes that can be converted to Checkly API checks
  const CONVERTIBLE_SUBTYPES = ['http', undefined];

  // Filter tests by subtype
  const multiStepTests = data.tests.filter(test => test.subtype === 'multi');
  const httpTests = data.tests.filter(test =>
    test.subtype !== 'multi' && (test.subtype === 'http' || !test.subtype)
  );
  const skippedTests = data.tests.filter(test =>
    test.subtype !== 'multi' && test.subtype && test.subtype !== 'http'
  );

  // Group skipped tests by subtype for reporting
  const skippedBySubtype: Record<string, Array<{ public_id: string; name: string }>> = {};
  for (const test of skippedTests) {
    const subtype = test.subtype || 'unknown';
    if (!skippedBySubtype[subtype]) {
      skippedBySubtype[subtype] = [];
    }
    skippedBySubtype[subtype].push({ public_id: test.public_id, name: test.name });
  }

  if (multiStepTests.length > 0) {
    console.log(`  - Skipping ${multiStepTests.length} multi-step tests (require MultiStepCheck)`);
  }
  if (skippedTests.length > 0) {
    console.log(`  - Skipping ${skippedTests.length} non-HTTP tests (icmp/tcp/dns/ssl/etc - not supported)`);
    for (const [subtype, tests] of Object.entries(skippedBySubtype)) {
      console.log(`    - ${subtype}: ${tests.length} tests`);
    }
  }
  console.log(`  - Converting ${httpTests.length} HTTP API tests`);

  // Convert each HTTP test
  const convertedChecks: ChecklyCheck[] = httpTests.map(test => {
    try {
      return convertTest(test);
    } catch (err) {
      console.error(`  Error converting ${test.public_id}: ${(err as Error).message}`);
      return {
        logicalId: test.public_id,
        name: test.name,
        _conversionError: (err as Error).message,
        _originalTest: test,
      } as ChecklyCheck;
    }
  });

  // Summary statistics
  const successful = convertedChecks.filter(c => !c._conversionError).length;
  const failed = convertedChecks.filter(c => c._conversionError).length;

  // Collect unique private locations for reference
  const allPrivateLocations = [...new Set(
    convertedChecks.flatMap(c => c.privateLocations || [])
  )];

  // Write output
  const output = {
    convertedAt: new Date().toISOString(),
    source: {
      exportedAt: data.exportedAt,
      site: data.site,
    },
    summary: {
      total: data.tests.length,
      converted: httpTests.length,
      successful,
      failed,
      skippedMultiStep: multiStepTests.length,
      skippedNonHttp: skippedTests.length,
    },
    skippedNonHttpTests: skippedBySubtype,
    privateLocationsFound: allPrivateLocations,
    checks: convertedChecks,
  };

  await writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\nWritten: ${OUTPUT_FILE}`);

  console.log('\n' + '='.repeat(60));
  console.log('Conversion Summary');
  console.log('='.repeat(60));
  console.log(`  Total in file: ${data.tests.length}`);
  console.log(`  Converted (HTTP): ${httpTests.length}`);
  console.log(`  Successful: ${successful}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Skipped (multi-step): ${multiStepTests.length}`);
  console.log(`  Skipped (non-HTTP): ${skippedTests.length}`);
  console.log(`  Private locations found: ${allPrivateLocations.length}`);

  if (skippedTests.length > 0) {
    console.log('\nSkipped non-HTTP tests (by subtype):');
    for (const [subtype, tests] of Object.entries(skippedBySubtype)) {
      console.log(`  ${subtype}: ${tests.length}`);
      tests.forEach(t => console.log(`    - ${t.name} (${t.public_id})`));
    }
  }

  if (allPrivateLocations.length > 0) {
    console.log('\nPrivate locations (need mapping in Checkly):');
    allPrivateLocations.forEach(loc => console.log(`  - ${loc}`));
  }

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
