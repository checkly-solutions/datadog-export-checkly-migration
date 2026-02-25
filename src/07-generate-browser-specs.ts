/**
 * Generates Playwright spec files from Datadog browser tests.
 *
 * Reads: exports/browser-tests.json
 * Outputs: checkly-migrated/tests/browser/*.spec.ts
 *
 * These spec files are designed for Checkly BrowserCheck constructs.
 *
 * Iframe handling:
 *   Datadog handles iframes transparently — element.url on each step reflects
 *   the iframe src when the element lives inside one. This generator detects
 *   URL divergence between the page context and element.url and wraps those
 *   steps with a shared findInFrame() helper that scans the main page and all
 *   iframes at runtime.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { sanitizeFilename, hasPrivateLocations, escapeTemplateLiteral, escapeString } from './shared/utils.ts';
import { trackVariablesFromMultiple, loadExistingVariableUsage, writeVariableUsageReport } from './shared/variable-tracker.ts';
import { getOutputRoot, getExportsDir } from './shared/output-config.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ElementLocator {
  url?: string;              // URL where DD found this element (iframe signal)
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
  locations: string[];
  privateLocations: string[];
  originalLocations: string[];
  status?: string;
  tags?: string[];
  steps?: BrowserStep[];
  config?: {
    request?: {
      url?: string;
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
  hasIframes: boolean;
}

interface GenerationResult {
  successCount: number;
  errorCount: number;
  iframeTestCount: number;
  iframeStepCount: number;
}

/** Stored per iframe-step so we can log the source URL */
interface IframeContext {
  iframeSrc: string;
}

// ---------------------------------------------------------------------------
// Iframe detection helpers
// ---------------------------------------------------------------------------

/**
 * Check if a URL is an auth/SSO redirect (not an iframe).
 */
function isAuthRedirectUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return /(?:login\.|identity\.|auth\.|oauth|okta|sso)/.test(hostname);
  } catch {
    return false;
  }
}

/**
 * Check if a URL path contains known iframe patterns.
 */
function isKnownIframeUrl(elementUrl: string): boolean {
  try {
    const urlPath = new URL(elementUrl).pathname.toLowerCase();
    return /\/(frames|embed|widget)\//.test(urlPath);
  } catch {
    return false;
  }
}

/**
 * Extract the pathname from a URL (for logging).
 */
function extractIframeSrcPath(elementUrl: string): string {
  try {
    return new URL(elementUrl).pathname;
  } catch {
    return elementUrl;
  }
}

/**
 * Get the first meaningful path segment from a URL.
 * e.g. "/awaf-profile/" → "awaf-profile", "/CipherWeb/admin/..." → "CipherWeb"
 */
function getFirstPathSegment(urlStr: string): string {
  try {
    const segments = new URL(urlStr).pathname.split('/').filter(Boolean);
    return segments[0] || '';
  } catch {
    return '';
  }
}

/**
 * Pre-analyze all steps to detect which ones target elements inside iframes.
 *
 * Detection rules (applied per step that has element.url):
 *   1. Auth/SSO URLs are temporary redirects — skip, don't update page context.
 *   2. Same URL as current page context — not an iframe.
 *   3. Different hostname from current page context — iframe.
 *   4. Same hostname, but different first path segment after auth — iframe.
 *   5. Same hostname, same first path segment — page navigation, update context.
 */
function analyzeStepsForIframes(
  startUrl: string | undefined,
  steps: BrowserStep[]
): Map<number, IframeContext> {
  const result = new Map<number, IframeContext>();

  let currentPageUrl = startUrl || '';
  let currentPageHostname = '';
  try {
    currentPageHostname = new URL(currentPageUrl).hostname;
  } catch { /* ignore */ }
  const startFirstSegment = getFirstPathSegment(currentPageUrl);

  let seenAuthSteps = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // goToUrl steps update the current page URL
    if (step.type === 'goToUrl') {
      const goUrl = step.params?.value || '';
      currentPageUrl = goUrl;
      try { currentPageHostname = new URL(goUrl).hostname; } catch { /* ignore */ }
      continue;
    }

    const elementUrl = step.params?.element?.url;
    if (!elementUrl) continue;

    // Rule 1: Auth/SSO — skip
    if (isAuthRedirectUrl(elementUrl)) {
      seenAuthSteps = true;
      continue;
    }

    let elementHostname = '';
    try { elementHostname = new URL(elementUrl).hostname; } catch { continue; }

    // Rule 2: Same URL — not an iframe
    if (elementUrl === currentPageUrl) continue;

    // Rule 2.5: Known iframe URL patterns (/frames/, /embed/, /widget/)
    if (isKnownIframeUrl(elementUrl)) {
      result.set(i, { iframeSrc: elementUrl });
      continue;
    }

    // Rule 3: Cross-origin — iframe
    if (elementHostname !== currentPageHostname && currentPageHostname) {
      result.set(i, { iframeSrc: elementUrl });
      continue;
    }

    // Rule 4: Same origin, post-auth path divergence — iframe
    const elementFirstSegment = getFirstPathSegment(elementUrl);
    if (seenAuthSteps && startFirstSegment && elementFirstSegment !== startFirstSegment) {
      result.set(i, { iframeSrc: elementUrl });
      continue;
    }

    // Rule 5: Same origin, same path prefix — page navigation
    currentPageUrl = elementUrl;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Shared helpers file (written once, imported by specs that need it)
// ---------------------------------------------------------------------------

const FIND_IN_FRAME_HELPER_SOURCE = `import { Page, Locator } from "@playwright/test";

/**
 * Search for an element in iframes first, then fall back to the main page.
 * Datadog browser tests handle iframes transparently — this replicates that behavior.
 */
export async function findInFrame(page: Page, locator: string): Promise<Locator> {
  // Check iframes first
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const el = frame.locator(locator);
    if (await el.count() > 0) {
      console.log(\`[findInFrame] Found "\${locator}" in iframe: \${frame.url()}\`);
      return el;
    }
  }

  // Fall back to main page
  console.log(\`[findInFrame] "\${locator}" not in any iframe, using main page\`);
  return page.locator(locator);
}
`;

// ---------------------------------------------------------------------------
// Variable handling
// ---------------------------------------------------------------------------

function extractVariableContent(test: BrowserTest): string[] {
  const content: string[] = [];
  if (test.config?.request?.url) content.push(test.config.request.url);
  for (const step of test.steps || []) {
    if (step.params?.value) content.push(step.params.value);
    if (step.params?.request?.config?.request?.url) {
      content.push(step.params.request.config.request.url);
    }
  }
  return content;
}

function convertVariables(str: string): string {
  if (!str) return str;
  return str.replace(/\{\{\s*(\w+)\s*\}\}/g, '${process.env.$1}');
}

// ---------------------------------------------------------------------------
// Locator extraction
// ---------------------------------------------------------------------------

/**
 * Extract the best locator from element data.
 * Priority: ID > data-testid > name > text > CSS class > XPath
 */
function extractLocator(element?: ElementLocator): Locator | null {
  if (!element) return null;

  const targetHtml = element.targetOuterHTML || '';
  const multiLocator = element.multiLocator || {};

  const idMatch = targetHtml.match(/id="([^"]+)"/);
  if (idMatch) return { type: 'id', value: `#${idMatch[1]}` };

  const testIdMatch = targetHtml.match(/data-testid="([^"]+)"/);
  if (testIdMatch) return { type: 'testId', value: `[data-testid="${testIdMatch[1]}"]` };

  const nameMatch = targetHtml.match(/name="([^"]+)"/);
  if (nameMatch) return { type: 'name', value: `[name="${nameMatch[1]}"]` };

  if (multiLocator.ro) {
    const ro = multiLocator.ro;
    if (ro.startsWith('//*[@id="')) {
      const match = ro.match(/\/\/\*\[@id="([^"]+)"\]/);
      if (match) return { type: 'id', value: `#${match[1]}` };
    }
    if (ro.includes('text()')) {
      const textMatch = ro.match(/text\(\)[^\]]*=\s*"([^"]+)"/i);
      if (textMatch) return { type: 'text', value: textMatch[1] };
    }
  }

  if (multiLocator.co) {
    try {
      const content = JSON.parse(multiLocator.co) as Array<{ text?: string }>;
      if (content[0]?.text) return { type: 'text', value: content[0].text };
    } catch { /* ignore */ }
  }

  if (multiLocator.cl) {
    const classMatch = multiLocator.cl.match(/contains\([^,]+,\s*"\s*([^"]+)\s*"\)/);
    if (classMatch) {
      const className = classMatch[1].trim();
      return { type: 'class', value: `.${className.replace(/\s+/g, '.')}` };
    }
  }

  if (multiLocator.at && multiLocator.at.length > 0) return { type: 'xpath', value: multiLocator.at };
  if (multiLocator.ab) return { type: 'xpath', value: multiLocator.ab };
  return null;
}

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
 * Return a selector string usable with findInFrame (always page.locator style).
 */
function extractLocatorSelector(locator: Locator | null): string | null {
  if (!locator) return null;
  switch (locator.type) {
    case 'id':
    case 'name':
    case 'testId':
    case 'class':
      return `"${escapeString(locator.value)}"`;
    case 'text':
      return `"text=${escapeString(locator.value)}"`;
    case 'xpath':
      return `"xpath=${escapeString(locator.value)}"`;
    default:
      return `"${escapeString(locator.value)}"`;
  }
}

// ---------------------------------------------------------------------------
// Naming helper for fallback variables
// ---------------------------------------------------------------------------

/**
 * Generate a descriptive camelCase variable name from a step name.
 * e.g. 'Click on div "Recent Reports..."' → "divRecentReports"
 */
function generateElementVarName(step: BrowserStep): string {
  const name = step.name || step.type;
  let cleaned = name
    .replace(/^(Click on|Type text on|Hover over|Select option on|Assert|Test)\s*/i, '')
    .replace(/["']/g, '')
    .replace(/\.\.\./g, '')
    .replace(/[^a-zA-Z0-9_\s]/g, ' ')
    .trim();

  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 4);
  if (words.length === 0) return 'element';

  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      return i === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
}

/** Return a unique variable name, appending a counter if needed. */
function uniqueVarName(base: string, used: Set<string>): string {
  let name = base;
  let counter = 2;
  while (used.has(name)) {
    name = `${base}${counter}`;
    counter++;
  }
  used.add(name);
  return name;
}

// ---------------------------------------------------------------------------
// Step code generators (all target `page` — iframe steps go through findInFrame)
// ---------------------------------------------------------------------------

function generateGoToUrl(step: BrowserStep): string {
  const url = convertVariables(escapeTemplateLiteral(step.params?.value || ''));
  return `  await page.goto(\`${url}\`);`;
}

function generateTypeText(step: BrowserStep): string {
  const value = convertVariables(escapeTemplateLiteral(step.params?.value || ''));
  const locatorCode = generateLocatorCode(extractLocator(step.params?.element));
  return `  await ${locatorCode}.fill(\`${value}\`);`;
}

function generateClick(step: BrowserStep): string {
  return `  await ${generateLocatorCode(extractLocator(step.params?.element))}.click();`;
}

function generateHover(step: BrowserStep): string {
  return `  await ${generateLocatorCode(extractLocator(step.params?.element))}.hover();`;
}

function generatePressKey(step: BrowserStep): string {
  const key = step.params?.value || 'Enter';
  return `  await page.keyboard.press("${escapeString(key)}");`;
}

function generateSelectOption(step: BrowserStep): string {
  const value = convertVariables(escapeTemplateLiteral(step.params?.value || ''));
  const locatorCode = generateLocatorCode(extractLocator(step.params?.element));
  return `  await ${locatorCode}.selectOption(\`${value}\`);`;
}

function generateWait(step: BrowserStep): string {
  const ms = parseInt(step.params?.value || '1000', 10) || 1000;
  return `  await page.waitForTimeout(${ms});`;
}

function generateRefresh(_step: BrowserStep): string {
  return `  await page.reload();`;
}

function generateScroll(step: BrowserStep): string {
  const x = step.params?.x || 0;
  const y = step.params?.y || 0;
  return `  await page.evaluate(() => window.scrollBy(${x}, ${y}));`;
}

function generateAssertElementPresent(step: BrowserStep): string {
  const locatorCode = generateLocatorCode(extractLocator(step.params?.element));
  const expectFn = step.allowFailure ? 'expect.soft' : 'expect';
  return `  await ${expectFn}(${locatorCode}).toBeVisible();`;
}

function generateAssertElementContent(step: BrowserStep): string {
  const value = step.params?.value || '';
  const check = step.params?.check || 'contains';
  const locatorCode = generateLocatorCode(extractLocator(step.params?.element));
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

function generateAssertPageContains(step: BrowserStep): string {
  const value = step.params?.value || '';
  const expectFn = step.allowFailure ? 'expect.soft' : 'expect';
  return `  await ${expectFn}(page.locator("body")).toContainText("${escapeString(value)}");`;
}

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

function generateRunApiTest(step: BrowserStep): string {
  const request = step.params?.request?.config?.request || {};
  const method = (request.method || 'GET').toLowerCase();
  const url = request.url || '';
  const convertedUrl = convertVariables(escapeTemplateLiteral(url));
  return `  // Embedded API test
  const apiResponse = await page.request.${method}(\`${convertedUrl}\`);
  await expect(apiResponse).toBeOK();`;
}

/** Dispatch to the right generator (non-iframe path). */
function generateStepCodeDefault(step: BrowserStep): string {
  switch (step.type) {
    case 'goToUrl':              return generateGoToUrl(step);
    case 'typeText':             return generateTypeText(step);
    case 'click':                return generateClick(step);
    case 'hover':                return generateHover(step);
    case 'pressKey':             return generatePressKey(step);
    case 'selectOption':         return generateSelectOption(step);
    case 'wait':                 return generateWait(step);
    case 'refresh':              return generateRefresh(step);
    case 'scroll':               return generateScroll(step);
    case 'assertElementPresent': return generateAssertElementPresent(step);
    case 'assertElementContent': return generateAssertElementContent(step);
    case 'assertPageContains':   return generateAssertPageContains(step);
    case 'assertCurrentUrl':     return generateAssertCurrentUrl(step);
    case 'runApiTest':           return generateRunApiTest(step);
    default:
      return `  // TODO: Unsupported step type "${step.type}" - manual conversion required`;
  }
}

// ---------------------------------------------------------------------------
// Iframe-aware step code (uses findInFrame)
// ---------------------------------------------------------------------------

function generateIframeStepCode(
  step: BrowserStep,
  stepIndex: number,
  usedVarNames: Set<string>,
): string | null {
  const locator = extractLocator(step.params?.element);
  const selector = extractLocatorSelector(locator);
  if (!selector) return null;

  const varName = uniqueVarName(generateElementVarName(step), usedVarNames);
  let code = `  // May be inside an iframe — using fallback\n`;
  code += `  const ${varName} = await findInFrame(page, ${selector});\n`;

  switch (step.type) {
    case 'click':
      code += `  await ${varName}.click();`;
      break;
    case 'typeText': {
      const value = convertVariables(escapeTemplateLiteral(step.params?.value || ''));
      code += `  await ${varName}.fill(\`${value}\`);`;
      break;
    }
    case 'hover':
      code += `  await ${varName}.hover();`;
      break;
    case 'selectOption': {
      const value = convertVariables(escapeTemplateLiteral(step.params?.value || ''));
      code += `  await ${varName}.selectOption(\`${value}\`);`;
      break;
    }
    case 'assertElementPresent': {
      const expectFn = step.allowFailure ? 'expect.soft' : 'expect';
      code += `  await ${expectFn}(${varName}).toBeVisible();`;
      break;
    }
    case 'assertElementContent': {
      const value = step.params?.value || '';
      const check = step.params?.check || 'contains';
      const expectFn = step.allowFailure ? 'expect.soft' : 'expect';
      switch (check) {
        case 'contains':
          code += `  await ${expectFn}(${varName}).toContainText("${escapeString(value)}");`;
          break;
        case 'equals':
          code += `  await ${expectFn}(${varName}).toHaveText("${escapeString(value)}");`;
          break;
        case 'notContains':
          code += `  await ${expectFn}(${varName}).not.toContainText("${escapeString(value)}");`;
          break;
        default:
          code += `  await ${expectFn}(${varName}).toContainText("${escapeString(value)}");`;
      }
      break;
    }
    default:
      return null; // fall through to default generation
  }
  return code;
}

// ---------------------------------------------------------------------------
// Full step code (picks iframe or default path)
// ---------------------------------------------------------------------------

function generateStepCode(
  step: BrowserStep,
  stepIndex: number,
  isIframe: boolean,
  usedVarNames: Set<string>,
): string {
  const stepComment = `  // Step ${stepIndex + 1}: ${step.name || step.type}`;

  if (isIframe) {
    const iframeCode = generateIframeStepCode(step, stepIndex, usedVarNames);
    if (iframeCode) return `${stepComment}\n${iframeCode}`;
  }

  return `${stepComment}\n${generateStepCodeDefault(step)}`;
}

// ---------------------------------------------------------------------------
// Spec file generation
// ---------------------------------------------------------------------------

function generateSpecFile(test: BrowserTest): { spec: string; hasIframes: boolean; iframeStepCount: number } {
  const { name, steps, config } = test;
  const testName = escapeString(name);
  const startUrl = config?.request?.url;
  const stepsArray = steps || [];

  // Analyze steps for iframe usage
  const iframeMap = analyzeStepsForIframes(startUrl, stepsArray);
  const hasIframes = iframeMap.size > 0;

  // Log iframe detections
  for (const [stepIdx, ctx] of iframeMap) {
    console.log(`  iframe: "${name}" step ${stepIdx + 1} → ${extractIframeSrcPath(ctx.iframeSrc)}`);
  }

  // Check if we need to prepend a goto for the start URL
  const firstStepIsGoTo = stepsArray.length > 0 && stepsArray[0].type === 'goToUrl';
  const needsStartUrlGoto = startUrl && !firstStepIsGoTo;

  let spec = `import { test, expect } from "@playwright/test";\n`;
  if (hasIframes) {
    spec += `import { findInFrame } from "../helpers";\n`;
  }

  spec += `
test.describe("${testName}", () => {
  test("${testName}", async ({ page }) => {
    test.setTimeout(120_000);
    page.on('request', (request) => {
      if (request.isNavigationRequest()) {
        console.log('Navigation request:', request.url());
      }
    });
`;

  if (needsStartUrlGoto) {
    const convertedUrl = convertVariables(escapeTemplateLiteral(startUrl));
    spec += `  // Navigate to start URL\n`;
    spec += `  await page.goto(\`${convertedUrl}\`);\n`;
    if (stepsArray.length > 0) spec += '\n';
  }

  const usedVarNames = new Set<string>();

  for (let i = 0; i < stepsArray.length; i++) {
    spec += generateStepCode(stepsArray[i], i, iframeMap.has(i), usedVarNames);
    if (i < stepsArray.length - 1) spec += '\n\n';
  }

  spec += `
  });
});
`;

  return { spec, hasIframes, iframeStepCount: iframeMap.size };
}

// ---------------------------------------------------------------------------
// Batch generation
// ---------------------------------------------------------------------------

async function generateSpecsForTests(
  tests: BrowserTest[],
  outputDir: string,
  locationType: string
): Promise<GenerationResult> {
  let successCount = 0;
  let errorCount = 0;
  let iframeTestCount = 0;
  let iframeStepCount = 0;
  const generatedFiles: GeneratedFile[] = [];

  for (const test of tests) {
    try {
      const variableContent = extractVariableContent(test);
      trackVariablesFromMultiple(test.name, variableContent);

      const { spec, hasIframes, iframeStepCount: testIframeSteps } = generateSpecFile(test);
      const filename = `${sanitizeFilename(test.name)}.spec.ts`;
      const filepath = path.join(outputDir, filename);

      if (hasIframes) {
        iframeTestCount++;
        iframeStepCount += testIframeSteps;
      }

      await writeFile(filepath, spec, 'utf-8');
      successCount++;
      generatedFiles.push({
        logicalId: test.public_id,
        name: test.name,
        filename,
        stepCount: test.steps?.length || 0,
        hasIframes,
      });
    } catch (err) {
      console.error(`  Error generating ${test.public_id}: ${(err as Error).message}`);
      errorCount++;
    }
  }

  if (generatedFiles.length > 0) {
    const manifest = {
      generatedAt: new Date().toISOString(),
      outputDir,
      locationType,
      files: generatedFiles,
    };
    await writeFile(
      path.join(outputDir, '_manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    );
  }

  return { successCount, errorCount, iframeTestCount, iframeStepCount };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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

  await loadExistingVariableUsage();

  if (!existsSync(INPUT_FILE)) {
    console.log(`\nSkipping: Input file not found: ${INPUT_FILE}`);
    console.log('No browser tests to process. Run "npm run export" first if you have browser tests.');
    return;
  }

  console.log(`\nReading: ${INPUT_FILE}`);
  const data = JSON.parse(await readFile(INPUT_FILE, 'utf-8')) as { tests: BrowserTest[] };
  const tests = data.tests || [];
  console.log(`Found ${tests.length} browser tests to process`);

  const publicTests = tests.filter(t => !hasPrivateLocations(t));
  const privateTests = tests.filter(t => hasPrivateLocations(t));
  console.log(`  - Public location tests: ${publicTests.length}`);
  console.log(`  - Private location tests: ${privateTests.length}`);

  if (!existsSync(OUTPUT_DIR_PUBLIC)) await mkdir(OUTPUT_DIR_PUBLIC, { recursive: true });
  if (!existsSync(OUTPUT_DIR_PRIVATE)) await mkdir(OUTPUT_DIR_PRIVATE, { recursive: true });
  console.log(`\nCreated directories: ${OUTPUT_DIR_PUBLIC}, ${OUTPUT_DIR_PRIVATE}`);

  console.log('\nGenerating public location specs...');
  const publicResult = await generateSpecsForTests(publicTests, OUTPUT_DIR_PUBLIC, 'public');

  console.log('\nGenerating private location specs...');
  const privateResult = await generateSpecsForTests(privateTests, OUTPUT_DIR_PRIVATE, 'private');

  // Write shared helpers file if any test needs iframe handling
  const totalIframeTests = publicResult.iframeTestCount + privateResult.iframeTestCount;
  if (totalIframeTests > 0) {
    const helpersPath = path.join(OUTPUT_BASE, 'helpers.ts');
    await writeFile(helpersPath, FIND_IN_FRAME_HELPER_SOURCE, 'utf-8');
    console.log(`\nWritten shared helpers: ${helpersPath}`);
  }

  console.log('\nWriting variable usage report...');
  await writeVariableUsageReport();

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Generation Summary');
  console.log('='.repeat(60));
  console.log(`  Public specs generated: ${publicResult.successCount} → ${OUTPUT_DIR_PUBLIC}`);
  console.log(`  Private specs generated: ${privateResult.successCount} → ${OUTPUT_DIR_PRIVATE}`);
  console.log(`  Errors: ${publicResult.errorCount + privateResult.errorCount}`);

  const totalIframeSteps = publicResult.iframeStepCount + privateResult.iframeStepCount;
  if (totalIframeTests > 0) {
    console.log(`  Iframe handling: ${totalIframeTests} tests, ${totalIframeSteps} steps`);
  }

  console.log('\nNext: Run "npm run generate:browser-checks" to create BrowserCheck constructs');
  console.log('Done!');
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
