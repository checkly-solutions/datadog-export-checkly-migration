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
import path from 'path';

const EXPORTS_DIR = './exports';
const INPUT_FILE = path.join(EXPORTS_DIR, 'api-tests.json');
const OUTPUT_FILE = path.join(EXPORTS_DIR, 'checkly-api-checks.json');

// Datadog operator to Checkly comparison mapping
const OPERATOR_MAP = {
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
const ASSERTION_SOURCE_MAP = {
  statusCode: 'STATUS_CODE',
  responseTime: 'RESPONSE_TIME',
  body: 'TEXT_BODY',
  header: 'HEADERS',
  certificate: 'CERTIFICATE',
};

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
 * Convert a Datadog assertion to Checkly assertion format
 */
function convertAssertion(ddAssertion) {
  const { type, operator, target, property } = ddAssertion;

  const assertion = {
    source: ASSERTION_SOURCE_MAP[type] || type.toUpperCase(),
    comparison: OPERATOR_MAP[operator] || operator.toUpperCase(),
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
function convertRetryStrategy(ddRetry) {
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

/**
 * Separate locations into public and private
 */
function separateLocations(ddLocations) {
  const locations = [];
  const privateLocations = [];

  for (const loc of ddLocations || []) {
    if (loc.startsWith('pl:')) {
      // Private location - extract the identifier
      privateLocations.push(loc);
    } else {
      // Public location - map to Checkly location
      const mapped = LOCATION_MAP[loc];
      if (mapped) {
        locations.push(mapped);
      } else {
        // Keep original if no mapping found (might need manual review)
        locations.push(loc);
      }
    }
  }

  return { locations, privateLocations };
}

/**
 * Map Datadog tick_every to Checkly frequency
 */
function convertFrequency(tickEvery) {
  // Find closest frequency
  const frequencies = Object.keys(FREQUENCY_MAP).map(Number).sort((a, b) => a - b);

  for (const freq of frequencies) {
    if (tickEvery <= freq) {
      return FREQUENCY_MAP[freq];
    }
  }

  // Default to closest available
  return FREQUENCY_MAP[tickEvery] || 'EVERY_10M';
}

/**
 * Convert a single Datadog API test to Checkly config
 */
function convertTest(ddTest) {
  const { locations, privateLocations } = separateLocations(ddTest.locations);

  const config = {
    // Identity
    logicalId: ddTest.public_id,
    name: ddTest.name,
    tags: ddTest.tags || [],

    // Request configuration
    request: {
      url: ddTest.config?.request?.url || '',
      method: ddTest.config?.request?.method || 'GET',
    },

    // Assertions
    assertions: (ddTest.config?.assertions || []).map(convertAssertion),

    // Timing
    frequency: convertFrequency(ddTest.options?.tick_every || 300),

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
async function main() {
  console.log('='.repeat(60));
  console.log('Datadog to Checkly API Check Converter');
  console.log('='.repeat(60));

  console.log(`\nReading: ${INPUT_FILE}`);
  const data = JSON.parse(await readFile(INPUT_FILE, 'utf-8'));

  console.log(`Found ${data.tests.length} API tests to convert`);

  // Filter out multi-step tests (subtype: "multi") - they need different handling
  const singleStepTests = data.tests.filter(test => test.subtype !== 'multi');
  const multiStepTests = data.tests.filter(test => test.subtype === 'multi');

  if (multiStepTests.length > 0) {
    console.log(`  - Skipping ${multiStepTests.length} multi-step tests (require MultiStepCheck)`);
  }
  console.log(`  - Converting ${singleStepTests.length} single-step API tests`);

  // Convert each test
  const convertedChecks = singleStepTests.map(test => {
    try {
      return convertTest(test);
    } catch (err) {
      console.error(`  Error converting ${test.public_id}: ${err.message}`);
      return {
        logicalId: test.public_id,
        name: test.name,
        _conversionError: err.message,
        _originalTest: test,
      };
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
      total: singleStepTests.length,
      successful,
      failed,
      skippedMultiStep: multiStepTests.length,
    },
    privateLocationsFound: allPrivateLocations,
    checks: convertedChecks,
  };

  await writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\nWritten: ${OUTPUT_FILE}`);

  console.log('\n' + '='.repeat(60));
  console.log('Conversion Summary');
  console.log('='.repeat(60));
  console.log(`  Total processed: ${singleStepTests.length}`);
  console.log(`  Successful: ${successful}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Private locations found: ${allPrivateLocations.length}`);

  if (allPrivateLocations.length > 0) {
    console.log('\nPrivate locations (need mapping in Checkly):');
    allPrivateLocations.forEach(loc => console.log(`  - ${loc}`));
  }

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
