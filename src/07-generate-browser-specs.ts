/**
 * Generates Playwright spec files from Datadog browser tests.
 *
 * Reads: exports/browser-tests.json
 * Outputs: checkly-migrated/tests/browser/*.spec.ts
 *
 * These spec files are designed for Checkly BrowserCheck constructs.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { sanitizeFilename, hasPrivateLocations, escapeTemplateLiteral, escapeString } from './shared/utils.ts';
import { trackVariablesFromMultiple, loadExistingVariableUsage, writeVariableUsageReport } from './shared/variable-tracker.ts';
import { getOutputRoot, getExportsDir } from './shared/output-config.ts';

interface ElementLocator {
  targetOuterHTML?: string;
  multiLocator?: {
    ro?: string;
    co?: string;
    cl?: string;
    at?: string;
    ab?: string;
  };
}

interface BrowserStep {
  type: string;
  name?: string;
  allowFailure?: boolean;
  params?: {
    value?: string;
    element?: ElementLocator;
    check?: string;
    x?: number;
    y?: number;
    request?: {
      config?: {
        request?: {
          method?: string;
          url?: string;
        };
      };
    };
  };
}

interface BrowserTest {
  public_id: string;
  name: string;
  // Pre-processed by step 01:
  locations: string[];           // Mapped public Checkly locations
  privateLocations: string[];    // Private location IDs (pl:xxx)
  originalLocations: string[];   // Original Datadog locations for reference
  status?: string;
  tags?: string[];
  steps?: BrowserStep[];
  config?: {
    request?: {
      url?: string;              // Start URL for the browser test
    };
  };
  options?: {
    tick_every?: number;
    retry?: {
      count?: number;
      interval?: number;
    };
  };
}

interface Locator {
  type: string;
  value: string;
}

interface GeneratedFile {
  logicalId: string;
  name: string;
  filename: string;
  stepCount: number;
}

interface GenerationResult {
  successCount: number;
  errorCount: number;
}

/**
 * Extract all content strings that might contain variables from a browser test
 */
function extractVariableContent(test: BrowserTest): string[] {
  const content: string[] = [];

  // Start URL
  if (test.config?.request?.url) {
    content.push(test.config.request.url);
  }

  // Step values
  for (const step of test.steps || []) {
    if (step.params?.value) {
      content.push(step.params.value);
    }
    // API test URLs within browser tests
    if (step.params?.request?.config?.request?.url) {
      content.push(step.params.request.config.request.url);
    }
  }

  return content;
}

/**
 * Convert Datadog variable syntax {{ VAR }} to process.env.VAR
 */
function convertVariables(str: string): string {
  if (!str) return str;
  return str.replace(/\{\{\s*(\w+)\s*\}\}/g, '${process.env.$1}');
}

/**
 * Extract the best locator from element data
 * Priority: ID > data-testid > name > text > CSS class > XPath
 */
function extractLocator(element?: ElementLocator): Locator | null {
  if (!element) return null;

  const targetHtml = element.targetOuterHTML || '';
  const multiLocator = element.multiLocator || {};

  // Try to extract ID from targetOuterHTML
  const idMatch = targetHtml.match(/id="([^"]+)"/);
  if (idMatch) {
    return { type: 'id', value: `#${idMatch[1]}` };
  }

  // Try to extract data-testid
  const testIdMatch = targetHtml.match(/data-testid="([^"]+)"/);
  if (testIdMatch) {
    return { type: 'testId', value: `[data-testid="${testIdMatch[1]}"]` };
  }

  // Try to extract name attribute
  const nameMatch = targetHtml.match(/name="([^"]+)"/);
  if (nameMatch) {
    return { type: 'name', value: `[name="${nameMatch[1]}"]` };
  }

  // Try ro (ID/role based XPath) - often contains simple selectors
  if (multiLocator.ro) {
    const ro = multiLocator.ro;
    // Check if it's a simple ID selector
    if (ro.startsWith('//*[@id="')) {
      const match = ro.match(/\/\/\*\[@id="([^"]+)"\]/);
      if (match) {
        return { type: 'id', value: `#${match[1]}` };
      }
    }
    // Check for text-based selector
    if (ro.includes('text()')) {
      // Extract text content for getByText
      const textMatch = ro.match(/text\(\)[^\]]*=\s*"([^"]+)"/i);
      if (textMatch) {
        return { type: 'text', value: textMatch[1] };
      }
    }
  }

  // Try co (content-based) - JSON array with text info
  if (multiLocator.co) {
    try {
      const content = JSON.parse(multiLocator.co) as Array<{ text?: string }>;
      if (content[0]?.text) {
        return { type: 'text', value: content[0].text };
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  // Try class-based from cl
  if (multiLocator.cl) {
    const classMatch = multiLocator.cl.match(/contains\([^,]+,\s*"\s*([^"]+)\s*"\)/);
    if (classMatch) {
      const className = classMatch[1].trim();
      return { type: 'class', value: `.${className.replace(/\s+/g, '.')}` };
    }
  }

  // Fall back to XPath from at (attribute-based)
  if (multiLocator.at && multiLocator.at.length > 0) {
    return { type: 'xpath', value: multiLocator.at };
  }

  // Last resort: absolute XPath
  if (multiLocator.ab) {
    return { type: 'xpath', value: multiLocator.ab };
  }

  return null;
}

/**
 * Generate Playwright locator code from extracted locator
 */
function generateLocatorCode(locator: Locator | null): string {
  if (!locator) return 'page.locator("/* MANUAL: locator not found */")';

  switch (locator.type) {
    case 'id':
    case 'name':
    case 'testId':
    case 'class':
      return `page.locator("${escapeString(locator.value)}")`;
    case 'text':
      return `page.getByText("${escapeString(locator.value)}")`;
    case 'xpath':
      return `page.locator("xpath=${escapeString(locator.value)}")`;
    default:
      return `page.locator("${escapeString(locator.value)}")`;
  }
}

/**
 * Generate code for a goToUrl step
 */
function generateGoToUrl(step: BrowserStep): string {
  const url = convertVariables(step.params?.value || '');
  return `  await page.goto(\`${escapeTemplateLiteral(url)}\`);`;
}

/**
 * Generate code for a typeText step
 */
function generateTypeText(step: BrowserStep): string {
  const value = convertVariables(step.params?.value || '');
  const locator = extractLocator(step.params?.element);
  const locatorCode = generateLocatorCode(locator);
  return `  await ${locatorCode}.fill(\`${escapeTemplateLiteral(value)}\`);`;
}

/**
 * Generate code for a click step
 */
function generateClick(step: BrowserStep): string {
  const locator = extractLocator(step.params?.element);
  const locatorCode = generateLocatorCode(locator);
  return `  await ${locatorCode}.click();`;
}

/**
 * Generate code for a hover step
 */
function generateHover(step: BrowserStep): string {
  const locator = extractLocator(step.params?.element);
  const locatorCode = generateLocatorCode(locator);
  return `  await ${locatorCode}.hover();`;
}

/**
 * Generate code for a pressKey step
 */
function generatePressKey(step: BrowserStep): string {
  const key = step.params?.value || 'Enter';
  return `  await page.keyboard.press("${escapeString(key)}");`;
}

/**
 * Generate code for a selectOption step
 */
function generateSelectOption(step: BrowserStep): string {
  const value = convertVariables(step.params?.value || '');
  const locator = extractLocator(step.params?.element);
  const locatorCode = generateLocatorCode(locator);
  return `  await ${locatorCode}.selectOption(\`${escapeTemplateLiteral(value)}\`);`;
}

/**
 * Generate code for a wait step
 */
function generateWait(step: BrowserStep): string {
  const ms = parseInt(step.params?.value || '1000', 10) || 1000;
  return `  await page.waitForTimeout(${ms});`;
}

/**
 * Generate code for a refresh step
 */
function generateRefresh(step: BrowserStep): string {
  return `  await page.reload();`;
}

/**
 * Generate code for a scroll step
 */
function generateScroll(step: BrowserStep): string {
  const x = step.params?.x || 0;
  const y = step.params?.y || 0;
  return `  await page.evaluate(() => window.scrollBy(${x}, ${y}));`;
}

/**
 * Generate code for assertElementPresent step
 */
function generateAssertElementPresent(step: BrowserStep): string {
  const locator = extractLocator(step.params?.element);
  const locatorCode = generateLocatorCode(locator);
  const expectFn = step.allowFailure ? 'expect.soft' : 'expect';
  return `  await ${expectFn}(${locatorCode}).toBeVisible();`;
}

/**
 * Generate code for assertElementContent step
 */
function generateAssertElementContent(step: BrowserStep): string {
  const value = step.params?.value || '';
  const check = step.params?.check || 'contains';
  const locator = extractLocator(step.params?.element);
  const locatorCode = generateLocatorCode(locator);
  const expectFn = step.allowFailure ? 'expect.soft' : 'expect';

  switch (check) {
    case 'contains':
      return `  await ${expectFn}(${locatorCode}).toContainText("${escapeString(value)}");`;
    case 'equals':
      return `  await ${expectFn}(${locatorCode}).toHaveText("${escapeString(value)}");`;
    case 'startsWith':
      return `  await ${expectFn}(await ${locatorCode}.textContent()).toMatch(/^${escapeString(value)}/);`;
    case 'notContains':
      return `  await ${expectFn}(${locatorCode}).not.toContainText("${escapeString(value)}");`;
    default:
      return `  await ${expectFn}(${locatorCode}).toContainText("${escapeString(value)}");`;
  }
}

/**
 * Generate code for assertPageContains step
 */
function generateAssertPageContains(step: BrowserStep): string {
  const value = step.params?.value || '';
  const expectFn = step.allowFailure ? 'expect.soft' : 'expect';
  return `  await ${expectFn}(page.locator("body")).toContainText("${escapeString(value)}");`;
}

/**
 * Generate code for assertCurrentUrl step
 */
function generateAssertCurrentUrl(step: BrowserStep): string {
  const value = step.params?.value || '';
  const check = step.params?.check || 'contains';
  const expectFn = step.allowFailure ? 'expect.soft' : 'expect';

  switch (check) {
    case 'contains':
      return `  await ${expectFn}(page).toHaveURL(/${escapeString(value)}/);`;
    case 'equals':
      return `  await ${expectFn}(page).toHaveURL("${escapeString(value)}");`;
    case 'startsWith':
      return `  await ${expectFn}(page).toHaveURL(/^${escapeString(value)}/);`;
    default:
      return `  await ${expectFn}(page).toHaveURL(/${escapeString(value)}/);`;
  }
}

/**
 * Generate code for runApiTest step (embedded API call in browser test)
 */
function generateRunApiTest(step: BrowserStep): string {
  const request = step.params?.request?.config?.request || {};
  const method = (request.method || 'GET').toLowerCase();
  const url = request.url || '';

  return `  // Embedded API test
  const apiResponse = await page.request.${method}(\`${escapeTemplateLiteral(url)}\`);
  await expect(apiResponse).toBeOK();`;
}

/**
 * Generate code for a single step
 */
function generateStepCode(step: BrowserStep, stepIndex: number): string {
  const stepComment = `  // Step ${stepIndex + 1}: ${step.name || step.type}`;

  let stepCode: string;
  switch (step.type) {
    case 'goToUrl':
      stepCode = generateGoToUrl(step);
      break;
    case 'typeText':
      stepCode = generateTypeText(step);
      break;
    case 'click':
      stepCode = generateClick(step);
      break;
    case 'hover':
      stepCode = generateHover(step);
      break;
    case 'pressKey':
      stepCode = generatePressKey(step);
      break;
    case 'selectOption':
      stepCode = generateSelectOption(step);
      break;
    case 'wait':
      stepCode = generateWait(step);
      break;
    case 'refresh':
      stepCode = generateRefresh(step);
      break;
    case 'scroll':
      stepCode = generateScroll(step);
      break;
    case 'assertElementPresent':
      stepCode = generateAssertElementPresent(step);
      break;
    case 'assertElementContent':
      stepCode = generateAssertElementContent(step);
      break;
    case 'assertPageContains':
      stepCode = generateAssertPageContains(step);
      break;
    case 'assertCurrentUrl':
      stepCode = generateAssertCurrentUrl(step);
      break;
    case 'runApiTest':
      stepCode = generateRunApiTest(step);
      break;
    default:
      stepCode = `  // TODO: Unsupported step type "${step.type}" - manual conversion required`;
  }

  return `${stepComment}\n${stepCode}`;
}

/**
 * Generate a complete spec file for a browser test
 */
function generateSpecFile(test: BrowserTest): string {
  const { name, steps, config } = test;
  const testName = escapeString(name);
  const startUrl = config?.request?.url;
  const stepsArray = steps || [];

  // Check if we need to prepend a goto for the start URL
  // Only add if: 1) startUrl exists AND 2) first step is NOT already a goToUrl
  const firstStepIsGoTo = stepsArray.length > 0 && stepsArray[0].type === 'goToUrl';
  const needsStartUrlGoto = startUrl && !firstStepIsGoTo;

  let spec = `import { test, expect } from "@playwright/test";

test.describe("${testName}", () => {
  test("${testName}", async ({ page }) => {
    test.setTimeout(120_000);
`;

  // Prepend navigation to start URL if needed
  if (needsStartUrlGoto) {
    const convertedUrl = convertVariables(startUrl);
    spec += `  // Navigate to start URL\n`;
    spec += `  await page.goto(\`${escapeTemplateLiteral(convertedUrl)}\`);\n`;
    if (stepsArray.length > 0) {
      spec += '\n';
    }
  }

  // Generate code for each step
  for (let i = 0; i < stepsArray.length; i++) {
    spec += generateStepCode(stepsArray[i], i);
    if (i < stepsArray.length - 1) {
      spec += '\n\n';
    }
  }

  spec += `
  });
});
`;

  return spec;
}

/**
 * Generate specs for a list of tests into a directory
 */
async function generateSpecsForTests(
  tests: BrowserTest[],
  outputDir: string,
  locationType: string
): Promise<GenerationResult> {
  let successCount = 0;
  let errorCount = 0;
  const generatedFiles: GeneratedFile[] = [];

  for (const test of tests) {
    try {
      // Track variable usage for this test
      const variableContent = extractVariableContent(test);
      trackVariablesFromMultiple(test.name, variableContent);

      const spec = generateSpecFile(test);
      const filename = `${sanitizeFilename(test.name)}.spec.ts`;
      const filepath = path.join(outputDir, filename);

      await writeFile(filepath, spec, 'utf-8');
      successCount++;
      generatedFiles.push({
        logicalId: test.public_id,
        name: test.name,
        filename,
        stepCount: test.steps?.length || 0,
      });
    } catch (err) {
      console.error(`  Error generating ${test.public_id}: ${(err as Error).message}`);
      errorCount++;
    }
  }

  // Write manifest for the construct generator
  if (generatedFiles.length > 0) {
    const manifest = {
      generatedAt: new Date().toISOString(),
      outputDir: outputDir,
      locationType: locationType,
      files: generatedFiles,
    };

    await writeFile(
      path.join(outputDir, '_manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    );
  }

  return { successCount, errorCount };
}

/**
 * Main generation function
 */
async function main(): Promise<void> {
  const outputRoot = await getOutputRoot();
  const exportsDir = await getExportsDir();
  const INPUT_FILE = `${exportsDir}/browser-tests.json`;
  const OUTPUT_BASE = `${outputRoot}/tests/browser`;
  const OUTPUT_DIR_PUBLIC = `${OUTPUT_BASE}/public`;
  const OUTPUT_DIR_PRIVATE = `${OUTPUT_BASE}/private`;

  console.log('='.repeat(60));
  console.log('Browser Test Playwright Spec Generator');
  console.log('='.repeat(60));

  // Load existing variable usage (for merging across generator runs)
  await loadExistingVariableUsage();

  // Check input file exists
  if (!existsSync(INPUT_FILE)) {
    console.log(`\nSkipping: Input file not found: ${INPUT_FILE}`);
    console.log('No browser tests to process. Run "npm run export" first if you have browser tests.');
    return;
  }

  console.log(`\nReading: ${INPUT_FILE}`);
  const data = JSON.parse(await readFile(INPUT_FILE, 'utf-8')) as { tests: BrowserTest[] };

  const tests = data.tests || [];
  console.log(`Found ${tests.length} browser tests to process`);

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

  // Write variable usage report
  console.log('\nWriting variable usage report...');
  await writeVariableUsageReport();

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Generation Summary');
  console.log('='.repeat(60));
  console.log(`  Public specs generated: ${publicResult.successCount} → ${OUTPUT_DIR_PUBLIC}`);
  console.log(`  Private specs generated: ${privateResult.successCount} → ${OUTPUT_DIR_PRIVATE}`);
  console.log(`  Errors: ${publicResult.errorCount + privateResult.errorCount}`);

  console.log('\nNext: Run "npm run generate:browser-checks" to create BrowserCheck constructs');
  console.log('Done!');
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
