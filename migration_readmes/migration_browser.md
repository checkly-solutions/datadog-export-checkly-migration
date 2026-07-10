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

Datadog stores several locator strategies per element step (`multiLocator`, plus an optional human-pinned `userLocator`). The migrator does not pick one. It emits an ordered list of candidates per step and lets a shared runtime helper resolve the first that matches. See "Self-healing locator chains (firstMatch)" below for the full candidate order, the runtime failure signal, and the review tag.

## Self-healing locator chains (firstMatch)

Each element step migrates to an ordered list of candidate locators, not a single pick. A shared `firstMatch()` helper in `tests/browser/helpers.ts` probes the candidates in priority order and uses the first one that matches, searching the main page first and then every iframe. This is one mechanism: the old separate iframe fallback is gone. A check keeps working when one selector shifts, which mirrors how a Datadog browser test self-heals across its own locator set.

### What the migrator emits

The candidate order per step is:

1. `userLocator`, the human-pinned selector, first when present.
2. Role, derived from `targetOuterHTML` (never from Datadog's `ro`, which is not a real ARIA role in practice).
3. Test id (`data-testid`), before a raw `id`.
4. Anchored, case-insensitive text from the `co` content value. The `co` text is stored lowercased, so the migrator anchors a case-insensitive regex rather than an exact match.
5. Stable attributes and stable ids.
6. Structural fallbacks last.

Dynamic ids and hashed-class-only selectors are demoted, and the most brittle of them are rejected, so a self-healing candidate is only chosen when nothing more stable exists.

### Runtime failure signal

When every candidate misses at runtime, the spec prints the `MIGRATION-LOCATOR-EXHAUSTION` token in a boxed test step and a console error. Grep for it in Checkly run results to find a check whose locators all went stale. It is distinct from an ordinary selector timeout, so exhaustion is easy to tell apart from a slow page.

### The reviewMultiSelector tag

Every check that emits a multi-candidate chain carries a `reviewMultiSelector` tag. The tag is set in the generated `.check.ts` code (never applied via the API, because the next deploy would overwrite an API-applied tag), and it never changes activation. These checks stay active. The tag is a greppable review surface: verify the element each chain resolved matches the original Datadog step, then remove the tag once confirmed.

### Negative assertions

A negative element assertion (for example `notContains`) is pinned to the primary candidate only, under an all-candidates (INVERT) default. This avoids a pass-if-any trap where a negative would pass just because one throwaway candidate happened to lack the text. This polarity is a reasoned inference from Datadog's single-healed-element model, not documented Datadog behavior. When a negative assertion had multiple candidates and the migrator discarded the fallbacks to pin it, it emits a `negative-assertion-degraded` flag so the discard is visible.

### Flag reason codes

The self-healing path surfaces gaps it cannot close deterministically as `MIGRATION-FLAG` records (see the step-12 report's "Migration Flags" section):

- `weak-fallback-chain`: only weak structural candidates were available for a step, so the chain is brittle.
- `shadow-dom-locator`: a step's locator reaches into shadow DOM. The chain emits from the top-level fields only. Shadow-root piercing is not attempted.
- `negative-assertion-degraded`: a negative assertion had multiple candidates and was pinned to the highest-priority one, discarding the fallbacks.
- `assertion-operator-unknown`: an assertion value has no implemented matcher yet, so the gap is surfaced rather than emitting a possibly inverted assertion.

Datadog's `userLocator.failTestOnCannotLocate` checkbox ("If user specified locator fails, fail test") informs review priority: a check whose author pinned a locator and asked to fail on a miss deserves a closer look. The emitted chain always falls through on a miss regardless of that checkbox.

### Filenames

Every generated file now ends with the Datadog `public_id` tail, so two same-named tests never overwrite each other on disk.

## Variable Handling

Datadog variables are converted to Checkly environment variables:

| Datadog | Checkly |
|---------|---------|
| `{{ VAR_NAME }}` | `${process.env.VAR_NAME}` |

## Subtest Handling (`playSubTest`)

Datadog browser tests can reference other tests as reusable "subtests" via `playSubTest` steps. These are shared utility tests (e.g., email verification, login flows) that multiple parent tests call inline.

### How the exporter resolves subtests

During export, the tool automatically discovers and fetches subtests referenced by any exported browser test, even if the subtest doesn't match the tag filter. This uses a queue-based approach: each fetched test is scanned for `playSubTest` references, and any new subtest IDs are enqueued for fetching. Each subtest is only fetched once regardless of how many parents reference it. Nested subtests (subtests that call other subtests) are resolved automatically.

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

This preserves the reusable nature of the original Datadog subtest: if multiple parent tests reference the same subtest, they all import the same helper.

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
