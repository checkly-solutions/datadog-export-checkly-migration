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

// Fetch private locations
async function fetchPrivateLocations(): Promise<DatadogLocation[]> {
  console.log('\nFetching private locations...');
  const data = await apiRequest<{ locations?: DatadogLocation[] }>('/synthetics/private-locations');
  return data.locations || [];
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

    // Fetch private locations
    const privateLocations = await fetchPrivateLocations();
    console.log(`Found ${privateLocations.length} private locations`);

    // Write output files
    console.log('\nWriting export files...');
    await writeJsonFile('api-tests.json', {
      exportedAt: new Date().toISOString(),
      site: DD_SITE,
      count: apiTestsDetailed.length,
      tests: apiTestsDetailed,
    });

    await writeJsonFile('browser-tests.json', {
      exportedAt: new Date().toISOString(),
      site: DD_SITE,
      count: browserTestsDetailed.length,
      tests: browserTestsDetailed,
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
      count: privateLocations.length,
      locations: privateLocations,
    });

    // Summary file with all data
    await writeJsonFile('export-summary.json', {
      exportedAt: new Date().toISOString(),
      site: DD_SITE,
      summary: {
        apiTests: apiTestsDetailed.length,
        browserTests: browserTestsDetailed.length,
        globalVariables: globalVariables.length,
        privateLocations: privateLocations.length,
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
    console.log('  - exports/export-summary.json');

  } catch (error) {
    console.error('\nExport failed:', (error as Error).message);
    process.exit(1);
  }
}

main();
