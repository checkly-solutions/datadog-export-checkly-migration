/**
 * Generates Playwright spec files from Datadog multi-step tests.
 *
 * Reads: exports/multi-step-tests.json
 * Outputs: checkly/__checks__/multi-step/*.spec.ts
 *
 * These spec files are designed for Checkly MultiStepCheck constructs.
 * They use Playwright's request context (no browser) for API testing.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { sanitizeFilename, hasPrivateLocations, escapeTemplateLiteral, escapeString } from './shared/utils.ts';

const INPUT_FILE = './exports/multi-step-tests.json';
const OUTPUT_BASE = './checkly-migrated/tests/multi';
const OUTPUT_DIR_PUBLIC = `${OUTPUT_BASE}/public`;
const OUTPUT_DIR_PRIVATE = `${OUTPUT_BASE}/private`;

interface DatadogAssertion {
  type: string;
  operator: string;
  target?: string | number;
  property?: string;
}

interface DatadogRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface DatadogStep {
  name: string;
  subtype?: string;
  request: DatadogRequest;
  assertions: DatadogAssertion[];
  allowFailure?: boolean;
}

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
  config?: {
    steps?: DatadogStep[];
  };
}

interface GeneratedFile {
  logicalId: string;
  name: string;
  filename: string;
  stepCount: number;
}

interface SkippedTest {
  logicalId: string;
  name: string;
  incompatibleSubtypes: string[];
}

interface GenerationResult {
  successCount: number;
  errorCount: number;
  skippedCount: number;
  skippedTests: SkippedTest[];
}

/**
 * Generate assertion code for a single assertion
 */
function generateAssertionCode(
  assertion: DatadogAssertion,
  responseVar: string,
  bodyVar: string,
  softPrefix: string = ''
): string {
  const { type, operator, target, property } = assertion;
  const expect = softPrefix ? 'expect.soft' : 'expect';

  switch (type) {
    case 'statusCode':
      return generateComparisonCode(`${expect}(${responseVar}.status())`, operator, target);

    case 'responseTime':
      // Response time assertions are handled separately via timing
      return `// Response time assertion: ${operator} ${target}ms (handled by Checkly)`;

    case 'body':
      return generateComparisonCode(`${expect}(${bodyVar})`, operator, target);

    case 'header':
      if (property) {
        return generateComparisonCode(
          `${expect}(${responseVar}.headers()["${property.toLowerCase()}"])`,
          operator,
          target
        );
      }
      return `// Header assertion missing property`;

    default:
      return `// Unknown assertion type: ${type}`;
  }
}

/**
 * Generate comparison code based on operator
 */
function generateComparisonCode(expectExpr: string, operator: string, target?: string | number): string {
  const targetValue = typeof target === 'string' ? `"${escapeString(target)}"` : target;

  switch (operator) {
    case 'is':
      return `${expectExpr}.toBe(${targetValue});`;
    case 'isNot':
      return `${expectExpr}.not.toBe(${targetValue});`;
    case 'lessThan':
      return `${expectExpr}.toBeLessThan(${targetValue});`;
    case 'lessThanOrEqual':
      return `${expectExpr}.toBeLessThanOrEqual(${targetValue});`;
    case 'moreThan':
      return `${expectExpr}.toBeGreaterThan(${targetValue});`;
    case 'moreThanOrEqual':
      return `${expectExpr}.toBeGreaterThanOrEqual(${targetValue});`;
    case 'contains':
      return `${expectExpr}.toContain(${targetValue});`;
    case 'doesNotContain':
      return `${expectExpr}.not.toContain(${targetValue});`;
    case 'matches':
      return `${expectExpr}.toMatch(${typeof target === 'string' ? `/${target}/` : targetValue});`;
    case 'doesNotMatch':
      return `${expectExpr}.not.toMatch(${typeof target === 'string' ? `/${target}/` : targetValue});`;
    case 'isEmpty':
      return `${expectExpr}.toBeFalsy();`;
    case 'isNotEmpty':
      return `${expectExpr}.toBeTruthy();`;
    default:
      return `${expectExpr}.toBe(${targetValue}); // Unknown operator: ${operator}`;
  }
}

/**
 * Generate the request call code for a step
 */
function generateRequestCode(request: DatadogRequest, stepIndex: number): { code: string; responseVar: string } {
  const { method, url, headers, body } = request;
  const methodLower = (method || 'GET').toLowerCase();
  const responseVar = `response${stepIndex}`;

  let code = `const ${responseVar} = await request.${methodLower}(\`${escapeTemplateLiteral(url || '')}\``;

  const options: string[] = [];

  // Add headers if present
  if (headers && Object.keys(headers).length > 0) {
    const headersStr = JSON.stringify(headers, null, 6).replace(/\n/g, '\n      ');
    options.push(`headers: ${headersStr}`);
  }

  // Add body if present (for POST, PUT, PATCH)
  if (body && ['post', 'put', 'patch'].includes(methodLower)) {
    // Check if body is XML/SOAP
    if (typeof body === 'string' && (body.includes('<?xml') || body.includes('<soap:'))) {
      options.push(`data: \`${escapeTemplateLiteral(body)}\``);
    } else if (typeof body === 'string') {
      options.push(`data: \`${escapeTemplateLiteral(body)}\``);
    } else {
      options.push(`data: ${JSON.stringify(body, null, 6).replace(/\n/g, '\n      ')}`);
    }
  }

  if (options.length > 0) {
    code += `, {\n      ${options.join(',\n      ')},\n    }`;
  }

  code += ');';

  return { code, responseVar };
}

// Subtypes that can be converted to Playwright HTTP requests
const HTTP_COMPATIBLE_SUBTYPES = ['http', 'ssl'];

/**
 * Check if a test contains only HTTP-compatible steps
 */
function hasOnlyHttpSteps(test: DatadogTest): boolean {
  const steps = test.config?.steps || [];
  for (const step of steps) {
    if (step.subtype && !HTTP_COMPATIBLE_SUBTYPES.includes(step.subtype)) {
      return false;
    }
  }
  return true;
}

/**
 * Get incompatible step subtypes in a test
 */
function getIncompatibleSubtypes(test: DatadogTest): string[] {
  const steps = test.config?.steps || [];
  const incompatible = new Set<string>();
  for (const step of steps) {
    if (step.subtype && !HTTP_COMPATIBLE_SUBTYPES.includes(step.subtype)) {
      incompatible.add(step.subtype);
    }
  }
  return [...incompatible];
}

/**
 * Generate a single step's code
 */
function generateStepCode(step: DatadogStep, stepIndex: number): string {
  const { name, request, assertions, allowFailure } = step;
  const { code: requestCode, responseVar } = generateRequestCode(request, stepIndex);
  const bodyVar = `body${stepIndex}`;

  // Check if we need to read body (for body assertions)
  const needsBody = assertions.some(a => a.type === 'body');

  let stepCode = `    // Step ${stepIndex + 1}: ${name}\n`;
  stepCode += `    ${requestCode}\n`;

  if (needsBody) {
    stepCode += `    const ${bodyVar} = await ${responseVar}.text();\n`;
  }

  stepCode += '\n';

  // Generate assertions
  for (const assertion of assertions) {
    const assertionCode = generateAssertionCode(
      assertion,
      responseVar,
      bodyVar,
      allowFailure ? '' : '' // We'll use expect.soft for allowFailure
    );

    if (allowFailure && !assertionCode.startsWith('//')) {
      // Replace expect with expect.soft for allowFailure steps
      stepCode += `    ${assertionCode.replace('expect(', 'expect.soft(')}\n`;
    } else {
      stepCode += `    ${assertionCode}\n`;
    }
  }

  return stepCode;
}

/**
 * Generate a complete spec file for a multi-step test
 */
function generateSpecFile(test: DatadogTest): string {
  const { name, config } = test;
  const steps = config?.steps || [];

  const testName = escapeString(name);
  const describeName = escapeString(name);

  let spec = `import { test, expect } from "@playwright/test";

test.describe("${describeName}", () => {
  test("${testName}", async ({ request }) => {
`;

  // Generate code for each step
  for (let i = 0; i < steps.length; i++) {
    spec += generateStepCode(steps[i], i);
    if (i < steps.length - 1) {
      spec += '\n';
    }
  }

  spec += `  });
});
`;

  return spec;
}

/**
 * Generate specs for a list of tests into a directory
 */
async function generateSpecsForTests(
  tests: DatadogTest[],
  outputDir: string,
  label: string
): Promise<GenerationResult> {
  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  const generatedFiles: GeneratedFile[] = [];
  const skippedTests: SkippedTest[] = [];

  for (const test of tests) {
    // Skip tests with non-HTTP steps (tcp, icmp, dns, wait)
    if (!hasOnlyHttpSteps(test)) {
      const incompatible = getIncompatibleSubtypes(test);
      console.log(`  Skipping ${test.public_id}: contains incompatible step types (${incompatible.join(', ')})`);
      skippedTests.push({
        logicalId: test.public_id,
        name: test.name,
        incompatibleSubtypes: incompatible,
      });
      skippedCount++;
      continue;
    }

    try {
      const spec = generateSpecFile(test);
      const filename = `${sanitizeFilename(test.name)}.spec.ts`;
      const filepath = path.join(outputDir, filename);

      await writeFile(filepath, spec, 'utf-8');
      successCount++;
      generatedFiles.push({
        logicalId: test.public_id,
        name: test.name,
        filename,
        stepCount: test.config?.steps?.length || 0,
      });
    } catch (err) {
      console.error(`  Error generating ${test.public_id}: ${(err as Error).message}`);
      errorCount++;
    }
  }

  // Write manifest for the construct generator
  if (generatedFiles.length > 0 || skippedTests.length > 0) {
    const manifest = {
      generatedAt: new Date().toISOString(),
      outputDir: outputDir,
      locationType: label,
      files: generatedFiles,
      skipped: skippedTests,
    };

    await writeFile(
      path.join(outputDir, '_manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    );
  }

  return { successCount, errorCount, skippedCount, skippedTests };
}

/**
 * Main generation function
 */
async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Multi-Step Playwright Spec Generator');
  console.log('='.repeat(60));

  // Check input file exists
  if (!existsSync(INPUT_FILE)) {
    console.log(`\nSkipping: Input file not found: ${INPUT_FILE}`);
    console.log('No multi-step tests to process. Run "npm run filter-multi" first if you have multi-step tests.');
    return;
  }

  console.log(`\nReading: ${INPUT_FILE}`);
  const data = JSON.parse(await readFile(INPUT_FILE, 'utf-8')) as { tests: DatadogTest[] };

  const tests = data.tests || [];
  console.log(`Found ${tests.length} multi-step tests to process`);

  // Separate by location type
  const publicTests = tests.filter(t => !hasPrivateLocations(t));
  const privateTests = tests.filter(t => hasPrivateLocations(t));

  console.log(`  - Public location tests: ${publicTests.length}`);
  console.log(`  - Private location tests: ${privateTests.length}`);

  // Create output directories
  if (!existsSync(OUTPUT_DIR_PUBLIC)) {
    await mkdir(OUTPUT_DIR_PUBLIC, { recursive: true });
  }
  if (!existsSync(OUTPUT_DIR_PRIVATE)) {
    await mkdir(OUTPUT_DIR_PRIVATE, { recursive: true });
  }
  console.log(`\nCreated directories: ${OUTPUT_DIR_PUBLIC}, ${OUTPUT_DIR_PRIVATE}`);

  // Generate specs for public tests
  console.log('\nGenerating public location specs...');
  const publicResult = await generateSpecsForTests(publicTests, OUTPUT_DIR_PUBLIC, 'public');

  // Generate specs for private tests
  console.log('\nGenerating private location specs...');
  const privateResult = await generateSpecsForTests(privateTests, OUTPUT_DIR_PRIVATE, 'private');

  // Combine skipped tests for summary
  const allSkipped = [...publicResult.skippedTests, ...privateResult.skippedTests];

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Generation Summary');
  console.log('='.repeat(60));
  console.log(`  Public specs generated: ${publicResult.successCount} → ${OUTPUT_DIR_PUBLIC}`);
  console.log(`  Private specs generated: ${privateResult.successCount} → ${OUTPUT_DIR_PRIVATE}`);
  console.log(`  Skipped (non-HTTP steps): ${publicResult.skippedCount + privateResult.skippedCount}`);
  console.log(`  Errors: ${publicResult.errorCount + privateResult.errorCount}`);

  if (allSkipped.length > 0) {
    console.log('\nSkipped tests (contain TCP/ICMP/DNS/wait steps):');
    allSkipped.forEach(t => {
      console.log(`  - ${t.name} (${t.incompatibleSubtypes.join(', ')})`);
    });
    console.log('\nThese tests require manual conversion or alternative Checkly check types.');
  }

  console.log('\nNext: Run "npm run generate:multi-checks" to create MultiStepCheck constructs');
  console.log('Done!');
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
