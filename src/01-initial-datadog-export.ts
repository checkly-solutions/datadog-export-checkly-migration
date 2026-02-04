/**
 * Datadog Synthetics & Global Variables Export Tool
 *
 * Exports all synthetics (API & Browser tests), global variables, and private locations
 * from a Datadog account for migration to Checkly.
 *
 * Required Environment Variables:
 *   DD_API_KEY  - Datadog API key
 *   DD_APP_KEY  - Datadog Application key
 *
 * Optional Environment Variables:
 *   DD_SITE     - Datadog site/region (default: datadoghq.com)
 *                 Options: datadoghq.com, us3.datadoghq.com, us5.datadoghq.com,
 *                          datadoghq.eu, ap1.datadoghq.com, ddog-gov.com
 */

import 'dotenv/config';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

// Configuration
const DD_API_KEY = process.env.DD_API_KEY;
const DD_APP_KEY = process.env.DD_APP_KEY;
const DD_SITE = process.env.DD_SITE || 'datadoghq.com';
const BASE_URL = `https://api.${DD_SITE}/api/v1`;
const OUTPUT_DIR = './exports';

interface DatadogTest {
  public_id: string;
  name: string;
  type: string;
  status?: string;
  tags?: string[];
  locations?: string[];
  config?: Record<string, unknown>;
  options?: Record<string, unknown>;
  message?: string;
  monitor_id?: number;
  created_at?: string;
  modified_at?: string;
  creator?: Record<string, unknown>;
  subtype?: string;
}

interface DatadogVariable {
  name: string;
  value?: {
    value?: string;
    secure?: boolean;
  };
}

interface DatadogLocation {
  id: string;
  name: string;
}

interface ExtractedLocation {
  id: string;
  type: 'public' | 'private';
  original: string;
  checklyLocation?: string;
}

interface TransformedTest extends Omit<DatadogTest, 'locations'> {
  locations: string[];           // Mapped public Checkly locations
  privateLocations: string[];    // Private location IDs (pl:xxx)
  originalLocations: string[];   // Original Datadog locations for reference
}

// Datadog to Checkly public location mapping
const PUBLIC_LOCATION_MAP: Record<string, string> = {
  // AWS locations (with prefix)
  'aws:us-east-1': 'us-east-1',
  'aws:us-east-2': 'us-east-2',
  'aws:us-west-1': 'us-west-1',
  'aws:us-west-2': 'us-west-2',
  'aws:eu-central-1': 'eu-central-1',
  'aws:eu-west-1': 'eu-west-1',
  'aws:eu-west-2': 'eu-west-2',
  'aws:eu-west-3': 'eu-west-3',
  'aws:eu-north-1': 'eu-north-1',
  'aws:eu-south-1': 'eu-south-1',
  'aws:ap-northeast-1': 'ap-northeast-1',
  'aws:ap-northeast-2': 'ap-northeast-2',
  'aws:ap-northeast-3': 'ap-northeast-3',
  'aws:ap-southeast-1': 'ap-southeast-1',
  'aws:ap-southeast-2': 'ap-southeast-2',
  'aws:ap-southeast-3': 'ap-southeast-3',
  'aws:ap-south-1': 'ap-south-1',
  'aws:ap-east-1': 'ap-east-1',
  'aws:sa-east-1': 'sa-east-1',
  'aws:ca-central-1': 'ca-central-1',
  'aws:af-south-1': 'af-south-1',
  'aws:me-south-1': 'me-south-1',

  // Azure locations - mapped to nearest AWS regions
  'azure:eastus': 'us-east-1',
  'azure:eastus2': 'us-east-2',
  'azure:westus': 'us-west-1',
  'azure:westus2': 'us-west-2',
  'azure:centralus': 'us-east-2',
  'azure:northcentralus': 'us-east-2',
  'azure:southcentralus': 'us-east-2',
  'azure:westeurope': 'eu-west-1',
  'azure:northeurope': 'eu-west-1',
  'azure:uksouth': 'eu-west-2',
  'azure:ukwest': 'eu-west-2',
  'azure:germanywestcentral': 'eu-central-1',
  'azure:francecentral': 'eu-west-3',
  'azure:swedencentral': 'eu-north-1',
  'azure:norwayeast': 'eu-north-1',
  'azure:japaneast': 'ap-northeast-1',
  'azure:japanwest': 'ap-northeast-1',
  'azure:koreacentral': 'ap-northeast-2',
  'azure:koreasouth': 'ap-northeast-2',
  'azure:southeastasia': 'ap-southeast-1',
  'azure:australiaeast': 'ap-southeast-2',
  'azure:australiasoutheast': 'ap-southeast-2',
  'azure:centralindia': 'ap-south-1',
  'azure:southindia': 'ap-south-1',
  'azure:eastasia': 'ap-east-1',
  'azure:brazilsouth': 'sa-east-1',
  'azure:canadacentral': 'ca-central-1',
  'azure:canadaeast': 'ca-central-1',
  'azure:southafricanorth': 'af-south-1',
  'azure:uaenorth': 'me-south-1',

  // GCP locations - mapped to nearest AWS regions
  'gcp:us-east4': 'us-east-1',
  'gcp:us-east1': 'us-east-1',
  'gcp:us-central1': 'us-east-2',
  'gcp:us-west1': 'us-west-1',
  'gcp:us-west2': 'us-west-2',
  'gcp:us-west3': 'us-west-2',
  'gcp:us-west4': 'us-west-2',
  'gcp:us-south1': 'us-east-2',
  'gcp:europe-west1': 'eu-west-1',
  'gcp:europe-west2': 'eu-west-2',
  'gcp:europe-west3': 'eu-central-1',
  'gcp:europe-west4': 'eu-west-1',
  'gcp:europe-west6': 'eu-central-1',
  'gcp:europe-north1': 'eu-north-1',
  'gcp:asia-northeast1': 'ap-northeast-1',
  'gcp:asia-northeast2': 'ap-northeast-1',
  'gcp:asia-northeast3': 'ap-northeast-2',
  'gcp:asia-southeast1': 'ap-southeast-1',
  'gcp:asia-southeast2': 'ap-southeast-1',
  'gcp:asia-east1': 'ap-east-1',
  'gcp:asia-east2': 'ap-east-1',
  'gcp:asia-south1': 'ap-south-1',
  'gcp:australia-southeast1': 'ap-southeast-2',
  'gcp:australia-southeast2': 'ap-southeast-2',
  'gcp:southamerica-east1': 'sa-east-1',
  'gcp:northamerica-northeast1': 'ca-central-1',
  'gcp:northamerica-northeast2': 'ca-central-1',
};

// Validate required environment variables
function validateConfig(): void {
  const missing: string[] = [];
  if (!DD_API_KEY) missing.push('DD_API_KEY');
  if (!DD_APP_KEY) missing.push('DD_APP_KEY');

  if (missing.length > 0) {
    console.error('Missing required environment variables:', missing.join(', '));
    console.error('\nRequired:');
    console.error('  DD_API_KEY  - Your Datadog API key');
    console.error('  DD_APP_KEY  - Your Datadog Application key');
    console.error('\nOptional:');
    console.error('  DD_SITE     - Datadog site (default: datadoghq.com)');
    console.error('\nDatadog Sites:');
    console.error('  US1 (default): datadoghq.com');
    console.error('  US3:           us3.datadoghq.com');
    console.error('  US5:           us5.datadoghq.com');
    console.error('  EU1:           datadoghq.eu');
    console.error('  AP1:           ap1.datadoghq.com');
    console.error('  US1-FED:       ddog-gov.com');
    process.exit(1);
  }
}

// HTTP headers for Datadog API
function getHeaders(): Record<string, string> {
  return {
    'DD-API-KEY': DD_API_KEY!,
    'DD-APPLICATION-KEY': DD_APP_KEY!,
    'Content-Type': 'application/json',
  };
}

// Generic API request function with error handling
async function apiRequest<T>(endpoint: string): Promise<T> {
  const url = `${BASE_URL}${endpoint}`;
  console.log(`  Fetching: ${endpoint}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: getHeaders(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  return response.json() as Promise<T>;
}

// Fetch all synthetics tests (list only)
async function fetchSyntheticsList(): Promise<DatadogTest[]> {
  console.log('\nFetching synthetics list...');
  const data = await apiRequest<{ tests?: DatadogTest[] }>('/synthetics/tests');
  return data.tests || [];
}

// Fetch detailed configuration for an API test
async function fetchApiTestDetails(publicId: string): Promise<DatadogTest> {
  return apiRequest<DatadogTest>(`/synthetics/tests/api/${publicId}`);
}

// Fetch detailed configuration for a Browser test
async function fetchBrowserTestDetails(publicId: string): Promise<DatadogTest> {
  return apiRequest<DatadogTest>(`/synthetics/tests/browser/${publicId}`);
}

// Fetch all global variables
async function fetchGlobalVariables(): Promise<DatadogVariable[]> {
  console.log('\nFetching global variables...');
  const data = await apiRequest<{ variables?: DatadogVariable[] }>('/synthetics/variables');
  return data.variables || [];
}

// Fetch private locations from API
async function fetchPrivateLocations(): Promise<DatadogLocation[]> {
  console.log('\nFetching private locations from API...');
  try {
    const data = await apiRequest<{ locations?: DatadogLocation[] }>('/synthetics/private-locations');
    return data.locations || [];
  } catch (error) {
    console.log('  Note: Could not fetch private locations API (may not have permission)');
    return [];
  }
}

/**
 * Extract and classify all locations from tests
 * Private locations start with "pl:"
 * Public locations are everything else (aws:, azure:, gcp:, etc.)
 */
function extractLocationsFromTests(tests: DatadogTest[]): {
  publicLocations: ExtractedLocation[];
  privateLocations: ExtractedLocation[];
  unmappedLocations: string[];
} {
  const publicLocationsMap = new Map<string, ExtractedLocation>();
  const privateLocationsMap = new Map<string, ExtractedLocation>();
  const unmappedLocations = new Set<string>();

  for (const test of tests) {
    for (const loc of test.locations || []) {
      if (loc.startsWith('pl:')) {
        // Private location
        if (!privateLocationsMap.has(loc)) {
          privateLocationsMap.set(loc, {
            id: loc,
            type: 'private',
            original: loc,
          });
        }
      } else {
        // Public location
        const checklyLocation = PUBLIC_LOCATION_MAP[loc];
        if (!publicLocationsMap.has(loc)) {
          publicLocationsMap.set(loc, {
            id: loc,
            type: 'public',
            original: loc,
            checklyLocation: checklyLocation,
          });
        }
        if (!checklyLocation) {
          unmappedLocations.add(loc);
        }
      }
    }
  }

  return {
    publicLocations: Array.from(publicLocationsMap.values()),
    privateLocations: Array.from(privateLocationsMap.values()),
    unmappedLocations: Array.from(unmappedLocations),
  };
}

/**
 * Transform a test's locations into separated public/private arrays
 * - locations: mapped Checkly public location IDs
 * - privateLocations: private location IDs (unchanged, pl:xxx format)
 * - originalLocations: original Datadog location strings for reference
 */
function transformTestLocations(test: DatadogTest): TransformedTest {
  const originalLocations = test.locations || [];
  const locations: string[] = [];
  const privateLocations: string[] = [];

  for (const loc of originalLocations) {
    if (loc.startsWith('pl:')) {
      privateLocations.push(loc);
    } else {
      const mapped = PUBLIC_LOCATION_MAP[loc];
      if (mapped) {
        locations.push(mapped);
      } else {
        // Keep unmapped locations as-is (will be flagged in unmapped report)
        locations.push(loc);
      }
    }
  }

  // Remove original locations and add transformed ones
  const { locations: _removed, ...testWithoutLocations } = test;

  return {
    ...testWithoutLocations,
    locations,
    privateLocations,
    originalLocations,
  };
}

// Fetch detailed configs for all tests of a given type
async function fetchDetailedConfigs(tests: DatadogTest[], type: string): Promise<DatadogTest[]> {
  const filteredTests = tests.filter(t => t.type === type);
  console.log(`\nFetching detailed configs for ${filteredTests.length} ${type} tests...`);

  const detailed: DatadogTest[] = [];
  for (const test of filteredTests) {
    try {
      const fetchFn = type === 'browser' ? fetchBrowserTestDetails : fetchApiTestDetails;
      const details = await fetchFn(test.public_id);
      detailed.push(details);
    } catch (error) {
      console.error(`  Error fetching ${test.public_id}: ${(error as Error).message}`);
      // Include the basic info even if detailed fetch fails
      detailed.push({ ...test, _fetchError: (error as Error).message } as DatadogTest & { _fetchError: string });
    }
  }

  return detailed;
}

// Write data to JSON file
async function writeJsonFile(filename: string, data: unknown): Promise<void> {
  const filepath = path.join(OUTPUT_DIR, filename);
  await writeFile(filepath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`  Written: ${filepath}`);
}

// Main export function
async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Datadog Synthetics Export Tool');
  console.log('='.repeat(60));
  console.log(`\nSite: ${DD_SITE}`);
  console.log(`API Base URL: ${BASE_URL}`);

  validateConfig();

  // Create output directory
  if (!existsSync(OUTPUT_DIR)) {
    await mkdir(OUTPUT_DIR, { recursive: true });
  }

  try {
    // Fetch all synthetics (basic list)
    const allTests = await fetchSyntheticsList();
    console.log(`Found ${allTests.length} total synthetics`);

    // Separate by type
    const apiTests = allTests.filter(t => t.type === 'api');
    const browserTests = allTests.filter(t => t.type === 'browser');

    console.log(`  - API tests: ${apiTests.length}`);
    console.log(`  - Browser tests: ${browserTests.length}`);

    // Fetch detailed configurations
    const apiTestsDetailed = await fetchDetailedConfigs(allTests, 'api');
    const browserTestsDetailed = await fetchDetailedConfigs(allTests, 'browser');

    // Fetch global variables
    const globalVariables = await fetchGlobalVariables();
    console.log(`Found ${globalVariables.length} global variables`);

    // Fetch private locations from API
    const apiPrivateLocations = await fetchPrivateLocations();
    console.log(`Found ${apiPrivateLocations.length} private locations from API`);

    // Extract all locations from tests (both API and browser)
    const allDetailedTests = [...apiTestsDetailed, ...browserTestsDetailed];
    const extractedLocations = extractLocationsFromTests(allDetailedTests);

    console.log('\nLocation analysis:');
    console.log(`  - Public locations found in tests: ${extractedLocations.publicLocations.length}`);
    console.log(`  - Private locations found in tests: ${extractedLocations.privateLocations.length}`);
    if (extractedLocations.unmappedLocations.length > 0) {
      console.log(`  - Unmapped locations (need review): ${extractedLocations.unmappedLocations.length}`);
    }

    // Merge API private locations with extracted ones
    const allPrivateLocationIds = new Set<string>();
    const mergedPrivateLocations: Array<{
      id: string;
      name?: string;
      source: 'api' | 'test' | 'both';
    }> = [];

    // Add from API first
    for (const loc of apiPrivateLocations) {
      allPrivateLocationIds.add(loc.id);
      mergedPrivateLocations.push({
        id: loc.id,
        name: loc.name,
        source: 'api',
      });
    }

    // Add from tests (merge if already exists)
    for (const loc of extractedLocations.privateLocations) {
      if (allPrivateLocationIds.has(loc.id)) {
        // Update source to 'both'
        const existing = mergedPrivateLocations.find(l => l.id === loc.id);
        if (existing) {
          existing.source = 'both';
        }
      } else {
        allPrivateLocationIds.add(loc.id);
        mergedPrivateLocations.push({
          id: loc.id,
          source: 'test',
        });
      }
    }

    console.log(`  - Total unique private locations: ${mergedPrivateLocations.length}`);

    // Transform test locations (separate public/private, map to Checkly)
    console.log('\nTransforming test locations...');
    const transformedApiTests = apiTestsDetailed.map(transformTestLocations);
    const transformedBrowserTests = browserTestsDetailed.map(transformTestLocations);

    // Write output files
    console.log('\nWriting export files...');
    await writeJsonFile('api-tests.json', {
      exportedAt: new Date().toISOString(),
      site: DD_SITE,
      count: transformedApiTests.length,
      tests: transformedApiTests,
    });

    await writeJsonFile('browser-tests.json', {
      exportedAt: new Date().toISOString(),
      site: DD_SITE,
      count: transformedBrowserTests.length,
      tests: transformedBrowserTests,
    });

    await writeJsonFile('global-variables.json', {
      exportedAt: new Date().toISOString(),
      site: DD_SITE,
      count: globalVariables.length,
      variables: globalVariables,
    });

    await writeJsonFile('private-locations.json', {
      exportedAt: new Date().toISOString(),
      site: DD_SITE,
      count: mergedPrivateLocations.length,
      locations: mergedPrivateLocations,
      note: 'Private locations extracted from test configurations. These need to be mapped to Checkly private location slugs.',
    });

    await writeJsonFile('public-locations.json', {
      exportedAt: new Date().toISOString(),
      site: DD_SITE,
      count: extractedLocations.publicLocations.length,
      locations: extractedLocations.publicLocations,
      unmapped: extractedLocations.unmappedLocations,
      locationMap: PUBLIC_LOCATION_MAP,
      note: 'Datadog to Checkly location mapping. Unmapped locations may need manual review.',
    });

    // Summary file with all data
    await writeJsonFile('export-summary.json', {
      exportedAt: new Date().toISOString(),
      site: DD_SITE,
      summary: {
        apiTests: apiTestsDetailed.length,
        browserTests: browserTestsDetailed.length,
        globalVariables: globalVariables.length,
        privateLocations: mergedPrivateLocations.length,
        publicLocations: extractedLocations.publicLocations.length,
        unmappedLocations: extractedLocations.unmappedLocations.length,
      },
    });

    console.log('\n' + '='.repeat(60));
    console.log('Export completed successfully!');
    console.log('='.repeat(60));
    console.log('\nExported files:');
    console.log('  - exports/api-tests.json');
    console.log('  - exports/browser-tests.json');
    console.log('  - exports/global-variables.json');
    console.log('  - exports/private-locations.json');
    console.log('  - exports/public-locations.json');
    console.log('  - exports/export-summary.json');

    if (extractedLocations.unmappedLocations.length > 0) {
      console.log('\nUnmapped locations (need manual mapping):');
      extractedLocations.unmappedLocations.forEach(loc => console.log(`  - ${loc}`));
    }

    if (mergedPrivateLocations.length > 0) {
      console.log('\nPrivate locations (need Checkly private location setup):');
      mergedPrivateLocations.forEach(loc => console.log(`  - ${loc.id}${loc.name ? ` (${loc.name})` : ''}`));
    }

  } catch (error) {
    console.error('\nExport failed:', (error as Error).message);
    process.exit(1);
  }
}

main();
