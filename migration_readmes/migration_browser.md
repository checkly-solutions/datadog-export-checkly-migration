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

Generates `.spec.ts` files in `checkly-migrated/<account-name>/tests/browser/{public,private}/`.

### Step 2: Generate BrowserCheck Constructs

```bash
npm run generate:browser-checks
```

Generates `.check.ts` files in `checkly-migrated/<account-name>/__checks__/browser/{public,private}/`.

### One-Command Migration

```bash
npm run migrate:browser
```

Runs steps 1-2 together.

## Output Structure

```
checkly-migrated/<account-name>/
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

The generator automatically handles the start URL from `config.request.url`. If the first step is not a `goToUrl`, a navigation to the start URL is prepended:

```typescript
import { test, expect } from "@playwright/test";

test.describe("My Browser Test", () => {
  test("My Browser Test", async ({ page }) => {
    // Navigate to start URL
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
| `playSubTest` | Shared helper function import + call |

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

## Subtest Handling (`playSubTest`)

Datadog browser tests can reference other tests as reusable "subtests" via `playSubTest` steps. These are shared utility tests (e.g., email verification, login flows) that multiple parent tests call inline.

### How the exporter resolves subtests

During export, the tool automatically discovers and fetches subtests referenced by any exported browser test — even if the subtest doesn't match the tag filter. This uses a queue-based approach: each fetched test is scanned for `playSubTest` references, and any new subtest IDs are enqueued for fetching. Each subtest is only fetched once regardless of how many parents reference it. Nested subtests (subtests that call other subtests) are resolved automatically.

Subtests appear in `browser-tests.json` under a separate `subtests` array, annotated with:
- `isSubtest: true`
- `referencedBy: [<parent_public_ids>]`

### How the spec generator converts subtests

Subtests are generated as **shared helper functions** rather than standalone specs:

```
tests/browser/helpers/
  get-email-verification-code.ts   ← generated from subtest
```

Parent specs import and call them:

```typescript
import { getEmailVerificationCodeFromMailosaur } from "../helpers/get-email-verification-code";

// Step 5: Get email verification code from Mailosaur
await getEmailVerificationCodeFromMailosaur(page);
```

This preserves the reusable nature of the original Datadog subtest — if multiple parent tests reference the same subtest, they all import the same helper.

## Manual Review Required

- Element locators may need adjustment if Datadog's `multiLocator` data is incomplete
- Complex assertions with regex patterns may need refinement
- `runApiTest` embedded API calls may need additional assertion logic

## Test and Deploy to Checkly

Run from the account directory:

```bash
cd checkly-migrated/<account-name>

# Test public browser checks
npm run test:public

# Test private browser checks (requires private locations in your account)
npm run test:private

# Deploy public checks
npm run deploy:public

# Deploy private checks
npm run deploy:private
```

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run generate:browser-specs` | Generate Playwright spec files |
| `npm run generate:browser-checks` | Generate BrowserCheck constructs |
| `npm run migrate:browser` | Full pipeline: specs + constructs |
