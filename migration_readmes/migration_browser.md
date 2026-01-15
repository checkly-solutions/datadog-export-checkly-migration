# Browser Check Migration

Migrate Datadog browser synthetic tests to Checkly `BrowserCheck` constructs with Playwright spec files.

## Quick Start

```bash
# 1. Export from Datadog (if not done)
npm run export

# 2. Run the full migration
npm run migrate:browser
```

## Migration Workflow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Browser Tests  │     │  Playwright     │     │  BrowserCheck   │
│  (JSON)         │ ──► │  Spec Files     │ ──► │  Constructs     │
│                 │     │  (.spec.ts)     │     │  (.check.ts)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
   browser-tests.json   npm run generate:       npm run generate:
                        browser-specs           browser-checks
```

## Step-by-Step

### Step 1: Generate Playwright Spec Files

```bash
npm run generate:browser-specs
```

Generates `.spec.ts` files in `checkly-migrated/tests/browser/{public,private}/`.

### Step 2: Generate BrowserCheck Constructs

```bash
npm run generate:browser-checks
```

Generates `.check.ts` files in `checkly-migrated/__checks__/browser/{public,private}/`.

### One-Command Migration

```bash
npm run migrate:browser
```

Runs steps 1-2 together.

## Output Structure

```
checkly-migrated/
├── __checks__/
│   └── browser/
│       ├── public/
│       │   ├── index.ts
│       │   └── *.check.ts
│       └── private/
│           ├── index.ts
│           └── *.check.ts
└── tests/
    └── browser/
        ├── public/
        │   ├── _manifest.json
        │   └── *.spec.ts
        └── private/
            ├── _manifest.json
            └── *.spec.ts
```

## Generated Spec Example

```typescript
import { test, expect } from "@playwright/test";

test.describe("My Browser Test", () => {
  test("My Browser Test", async ({ page }) => {
    // Step 1: Navigate to link
    await page.goto(`https://example.com`);

    // Step 2: Type text on input #username
    await page.locator("#username").fill(`${process.env.USERNAME}`);

    // Step 3: Click on button #submit
    await page.locator("#submit").click();

    // Step 4: Test heading is present
    await expect(page.getByText("dashboard")).toBeVisible();
  });
});
```

## Generated Construct Example

```typescript
import {
  BrowserCheck,
  Frequency,
  RetryStrategyBuilder,
} from "checkly/constructs";

new BrowserCheck("abc-123-xyz", {
  name: "My Browser Test",
  tags: ["env:PROD", "team:myteam"],
  code: {
    entrypoint: "../../../tests/browser/public/my-browser-test.spec.ts",
  },
  frequency: Frequency.EVERY_15M,
  locations: ["us-east-1"],
  activated: true,
  muted: false,
  retryStrategy: RetryStrategyBuilder.linearStrategy({
    baseBackoffSeconds: 1,
    maxRetries: 2,
    maxDurationSeconds: 600,
    sameRegion: true,
  }),
  runParallel: true,
});
```

## Step Type Mapping

| Datadog Step | Playwright Equivalent |
|--------------|----------------------|
| `goToUrl` | `page.goto()` |
| `typeText` | `page.locator().fill()` |
| `click` | `page.locator().click()` |
| `hover` | `page.locator().hover()` |
| `pressKey` | `page.keyboard.press()` |
| `selectOption` | `page.locator().selectOption()` |
| `wait` | `page.waitForTimeout()` |
| `refresh` | `page.reload()` |
| `scroll` | `page.evaluate(() => window.scrollBy())` |
| `assertElementPresent` | `expect(locator).toBeVisible()` |
| `assertElementContent` | `expect(locator).toContainText()` |
| `assertPageContains` | `expect(page.locator("body")).toContainText()` |
| `assertCurrentUrl` | `expect(page).toHaveURL()` |
| `runApiTest` | `page.request.get/post()` |

## Element Locator Extraction

Datadog uses multiple locator strategies (`multiLocator`). The migration prioritizes:

1. **ID selectors** (`#elementId`) - from `targetOuterHTML`
2. **data-testid** - from `targetOuterHTML`
3. **name attribute** - from `targetOuterHTML`
4. **Text-based** - from `co` (content) locator → `page.getByText()`
5. **CSS class** - from `cl` locator
6. **XPath** - fallback from `at` or `ab` locators

## Variable Handling

Datadog variables are converted to Checkly environment variables:

| Datadog | Checkly |
|---------|---------|
| `{{ VAR_NAME }}` | `${process.env.VAR_NAME}` |

## Manual Review Required

- Element locators may need adjustment if Datadog's `multiLocator` data is incomplete
- Complex assertions with regex patterns may need refinement
- `runApiTest` embedded API calls may need additional assertion logic

## Deploy to Checkly

```bash
# Test locally
npx checkly test

# Deploy
npx checkly deploy
```

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run generate:browser-specs` | Generate Playwright spec files |
| `npm run generate:browser-checks` | Generate BrowserCheck constructs |
| `npm run migrate:browser` | Full pipeline: specs + constructs |
