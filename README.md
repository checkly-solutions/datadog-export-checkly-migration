# Datadog to Checkly Migration Tool

Export your Datadog Synthetic tests, global variables, and private locations for migration to Checkly.

## Prerequisites

- Node.js 18 or higher
- A Datadog account with API access
- API and Application keys with the required permissions

## Step 1: Create Datadog API Credentials

You'll need both an **API Key** and an **Application Key** from your Datadog account.

### Create an API Key

1. Log in to your Datadog account
2. Navigate to **Organization Settings** → **API Keys**
   - Direct link: `https://app.datadoghq.com/organization-settings/api-keys`
3. Click **+ New Key**
4. Give it a name (e.g., "Checkly Migration")
5. Copy the key value

### Create an Application Key

1. Navigate to **Organization Settings** → **Application Keys**
   - Direct link: `https://app.datadoghq.com/organization-settings/application-keys`
2. Click **+ New Key**
3. Give it a name (e.g., "Checkly Migration")
4. **Important:** Configure the following scopes:
   - `synthetics_read`
   - `synthetics_global_variable_read`
   - `synthetics_private_location_read`
5. Copy the key value

## Step 2: Determine Your Datadog Region

Datadog operates multiple regional sites. Use the site that matches where your account was created:

| Region | Site Value | API Endpoint |
|--------|------------|--------------|
| US1 (default) | `datadoghq.com` | api.datadoghq.com |
| US3 | `us3.datadoghq.com` | api.us3.datadoghq.com |
| US5 | `us5.datadoghq.com` | api.us5.datadoghq.com |
| EU1 | `datadoghq.eu` | api.datadoghq.eu |
| AP1 | `ap1.datadoghq.com` | api.ap1.datadoghq.com |
| US1-FED | `ddog-gov.com` | api.ddog-gov.com |

You can identify your region by looking at the URL when logged into Datadog (e.g., `app.datadoghq.eu` means EU1).

## Step 3: Configure Environment Variables

1. Copy the example environment file:

```bash
cp .env.example .env
```

2. Edit `.env` with your credentials:

```bash
# Required
DD_API_KEY=your_api_key_here
DD_APP_KEY=your_application_key_here

# Optional - defaults to US1 if not specified
DD_SITE=datadoghq.com
```

## Step 4: Run the Export

```bash
npm run export
```

The tool will connect to the Datadog API and export all your resources.

## Output Files

After a successful export, you'll find the following files in the `exports/` directory:

| File | Description |
|------|-------------|
| `api-tests.json` | All API synthetic tests with full configurations |
| `browser-tests.json` | All Browser synthetic tests with full configurations |
| `global-variables.json` | All global/environment variables |
| `private-locations.json` | All private location configurations |
| `export-summary.json` | Summary with counts of all exported resources |

### Example Output Structure

```
exports/
├── api-tests.json
├── browser-tests.json
├── global-variables.json
├── private-locations.json
└── export-summary.json
```

## Troubleshooting

### "Missing required environment variables"

Ensure both `DD_API_KEY` and `DD_APP_KEY` are set in your `.env` file.

### "403 Forbidden" errors

Your Application Key is missing required scopes. Create a new Application Key with the scopes listed in Step 1.

### "404 Not Found" errors

You may be using the wrong Datadog site. Check your region in Step 2 and update `DD_SITE` accordingly.

### Empty exports

Verify that your Datadog account has synthetic tests configured. You can check this in the Datadog UI under **UX Monitoring** → **Synthetic Tests**.

## Next Steps

Once you have your exported data, you can proceed with the migration to Checkly:

1. **API Tests** → Convert to Checkly API Checks (see below)
2. **Browser Tests** → Convert to Playwright tests, then create Checkly Browser Checks
3. **Global Variables** → Create corresponding environment variables in Checkly

---

## API Check Migration

This tool provides a complete pipeline for migrating Datadog API synthetic tests to Checkly API Checks.

### Migration Workflow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Datadog API    │     │  Filter         │     │  Intermediate   │     │  Checkly CLI    │
│  Export (JSON)  │ ──► │  Multi-step     │ ──► │  Config (JSON)  │ ──► │  Constructs     │
│                 │     │                 │     │                 │     │  (TypeScript)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘     └─────────────────┘
   npm run export       npm run filter-multi   npm run convert:api    npm run generate:checkly
```

### Step 1: Export from Datadog

```bash
npm run export
```

This creates `exports/api-tests.json` with all your Datadog API synthetic tests.

### Step 2: Filter Multi-Step Tests

```bash
npm run filter-multi
```

Datadog API tests include both single-step and multi-step tests. This command separates them:

- **Single-step tests** remain in `exports/api-tests.json` → Convert to `ApiCheck`
- **Multi-step tests** are moved to `exports/multi-step-tests.json` → Convert to `MultiStepCheck` (requires Playwright)

Multi-step tests have `subtype: "multi"` and contain multiple chained requests with setup/teardown logic. These require a different migration path using Playwright scripts.

### Step 3: Convert to Checkly Configuration (Single-Step Only)

```bash
npm run convert:api
```

This transforms the single-step Datadog tests into a deployment-agnostic intermediate format at `exports/checkly-api-checks.json`.

**What gets converted:**

| Datadog | Checkly |
|---------|---------|
| `public_id` | `logicalId` |
| `name` | `name` |
| `tags` | `tags` |
| `config.request.url` | `request.url` |
| `config.request.method` | `request.method` |
| `config.assertions` | `assertions` (mapped to AssertionBuilder format) |
| `config.assertions[type=responseTime].target` | `maxResponseTime` |
| `options.tick_every` | `frequency` |
| `options.retry` | `retryStrategy` |
| `locations` (public) | `locations` |
| `locations` (`pl:*`) | `privateLocations` |

> **Note:** Datadog's `min_failure_duration` is an alerting threshold (how long a test must fail before alerting), not a response time threshold. The response time threshold is extracted from the `responseTime` assertion.

### Step 4: Generate Checkly CLI Constructs

```bash
npm run generate:checkly
```

This generates TypeScript files in `checkly-migrated/__checks__/api/` using Checkly CLI constructs:

```typescript
import {
  ApiCheck,
  AssertionBuilder,
  Frequency,
  RetryStrategyBuilder,
} from "checkly/constructs";

new ApiCheck("rcv-pv3-aen", {
  name: "SPORTS - portal score API",
  tags: ["appid:4622219", "bu:SPORTS"],
  request: {
    url: "https://portal.score.nbcuni.com/",
    method: "GET",
  },
  assertions: [
    AssertionBuilder.responseTime().lessThan(10000),
    AssertionBuilder.statusCode().equals(302),
  ],
  frequency: Frequency.EVERY_15M,
  locations: ["us-east-1"],
  // ...
});
```

> **Note:** Files are named based on the Datadog synthetic `name` (e.g., `sports-portal-score-api.check.ts`), while the `logicalId` uses the Datadog `public_id` for traceability.

### One-Command Migration

Run the full conversion pipeline (steps 3-4):

```bash
npm run migrate:api
```

This executes `convert:api` followed by `generate:checkly`.

> **Note:** Run `npm run filter-multi` first if you haven't already separated multi-step tests.

### Step 5: Deploy to Checkly

After generating the constructs, use the Checkly CLI to test and deploy:

```bash
# Install Checkly CLI (if not already installed)
npm create checkly@latest

# Test your checks locally
npx checkly test

# Deploy to Checkly
npx checkly deploy
```

### NPM Scripts Reference

| Script | Description |
|--------|-------------|
| `npm run export` | Export synthetics from Datadog API |
| `npm run filter-multi` | Separate multi-step tests from single-step |
| `npm run convert:api` | Convert Datadog JSON to Checkly config format |
| `npm run generate:checkly` | Generate TypeScript construct files |
| `npm run migrate:api` | Full pipeline: convert + generate |
| `npm run generate:multi-specs` | Generate Playwright spec files from multi-step JSON |
| `npm run generate:multi-checks` | Generate MultiStepCheck construct files |
| `npm run migrate:multi` | Full multi-step pipeline: specs + constructs |
| `npm run generate:browser-specs` | Generate Playwright spec files from browser tests |
| `npm run generate:browser-checks` | Generate BrowserCheck construct files |
| `npm run migrate:browser` | Full browser pipeline: specs + constructs |
| `npm run convert:variables` | Convert global variables to Checkly format |

### Output Structure

After running the full migration, checks are separated by location type (public vs private):

```
exports/
├── api-tests.json              # Single-step API tests (after filtering)
├── multi-step-tests.json       # Multi-step tests
├── checkly-api-checks.json     # Intermediate Checkly config
├── browser-tests.json          # Browser tests
├── global-variables.json       # Environment variables
└── private-locations.json      # Private location configs

checkly-migrated/
├── __checks__/
│   ├── api/
│   │   ├── public/             # Checks using public locations only
│   │   │   ├── index.ts
│   │   │   └── *.check.ts
│   │   └── private/            # Checks using private locations
│   │       ├── index.ts
│   │       └── *.check.ts
│   ├── multi/
│   │   ├── public/
│   │   └── private/
│   └── browser/
│       ├── public/
│       └── private/
├── tests/
│   ├── multi/
│   │   ├── public/
│   │   │   ├── _manifest.json
│   │   │   └── *.spec.ts
│   │   └── private/
│   │       ├── _manifest.json
│   │       └── *.spec.ts
│   └── browser/
│       ├── public/
│       └── private/
└── variables/
    ├── env-variables.json
    ├── secrets.json
    ├── create-variables.sh
    └── delete-variables.sh
```

**Location separation logic:**
- Tests with **any private location** (`pl:*`) → `private/` folder
- Tests with **only public locations** → `public/` folder

### Handling Private Locations

Datadog private locations (prefixed with `pl:`) are extracted to separate folders. After migration:

1. Create corresponding `PrivateLocation` constructs in Checkly
2. The `private/` folders contain checks that reference these locations
3. Map the Datadog location IDs to your Checkly private location slugs

### Assertion Mapping

| Datadog Operator | Checkly AssertionBuilder |
|------------------|--------------------------|
| `is` | `.equals()` |
| `isNot` | `.notEquals()` |
| `lessThan` | `.lessThan()` |
| `moreThan` | `.greaterThan()` |
| `contains` | `.contains()` |
| `doesNotContain` | `.notContains()` |
| `matches` | `.matches()` |

### Frequency Mapping

| Datadog `tick_every` | Checkly Frequency |
|---------------------|-------------------|
| 60 | `EVERY_1M` |
| 300 | `EVERY_5M` |
| 600 | `EVERY_10M` |
| 900 | `EVERY_15M` |
| 1800 | `EVERY_30M` |
| 3600 | `EVERY_1H` |

---

## Multi-Step Check Migration

Multi-step tests (with `subtype: "multi"` in Datadog) contain chained API requests with variables passed between steps. These are converted to Checkly `MultiStepCheck` constructs with Playwright spec files.

### Migration Workflow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Multi-step     │     │  Playwright     │     │  MultiStepCheck │
│  Tests (JSON)   │ ──► │  Spec Files     │ ──► │  Constructs     │
│                 │     │  (.spec.ts)     │     │  (.check.ts)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
   (after filter)       npm run generate:       npm run generate:
                        multi-specs             multi-checks
```

### Step 1: Filter Multi-Step Tests

If not already done, separate multi-step tests from single-step:

```bash
npm run filter-multi
```

This creates `exports/multi-step-tests.json` containing all tests with `subtype: "multi"`.

### Step 2: Generate Playwright Spec Files

```bash
npm run generate:multi-specs
```

This generates `.spec.ts` files in `checkly-migrated/tests/multi/`:

```typescript
import { test, expect } from "@playwright/test";

test.describe("ScheduALL API - Multi-step Health Check", () => {
  test("should verify webservice login flow", async ({ request }) => {
    // Step 1: Check Base Webservice
    const response0 = await request.get(`https://api.example.com/api.asmx`);
    expect(response0.status()).toBe(200);
    const body0 = await response0.text();
    expect(body0).toContain("Login");

    // Step 2: Login
    const response1 = await request.post(`https://api.example.com/api.asmx?op=Login`, {
      headers: { "content-type": "text/xml" },
      data: `<?xml ...>`,
    });
    expect(response1.status()).toBe(200);
    // ...
  });
});
```

**Key mappings:**

| Datadog | Playwright |
|---------|------------|
| `steps[].request` | `request.get()`, `request.post()`, etc. |
| `steps[].assertions` | `expect()` calls |
| `steps[].allowFailure: true` | `expect.soft()` (soft assertions) |

### Step 3: Generate MultiStepCheck Constructs

```bash
npm run generate:multi-checks
```

This generates `.check.ts` files in `checkly-migrated/__checks__/multi/` that reference the spec files:

```typescript
import {
  Frequency,
  MultiStepCheck,
  RetryStrategyBuilder,
} from "checkly/constructs";

new MultiStepCheck("ubf-2nq-wvf", {
  name: "SPORTS - NBC Sports Group - ScheduALL - API",
  tags: ["sltier:GOLD", "bu:SPORTS", "env:PROD"],
  code: {
    entrypoint: "../../../tests/multi/private/sports-nbc-sports-group-scheduall-api.spec.ts",
  },
  frequency: Frequency.EVERY_15M,
  locations: ["us-east-1"],
  activated: true,
  muted: false,
  retryStrategy: RetryStrategyBuilder.noRetries(),
  runParallel: true,
});
```

> **Note:** Files are named based on the Datadog synthetic `name`, while the `logicalId` uses the Datadog `public_id`.

### One-Command Migration

Run the full multi-step conversion pipeline:

```bash
npm run migrate:multi
```

This executes `generate:multi-specs` followed by `generate:multi-checks`.

### Output Structure

After running the full migration, checks are separated by location type:

```
checkly-migrated/
├── __checks__/
│   ├── api/
│   │   ├── public/                                # Public location checks
│   │   └── private/                               # Private location checks
│   └── multi/
│       ├── public/                                # Public location checks
│       │   ├── index.ts
│       │   └── *.check.ts
│       └── private/                               # Private location checks
│           ├── index.ts
│           └── *.check.ts
└── tests/
    └── multi/
        ├── public/
        │   ├── _manifest.json
        │   └── *.spec.ts
        └── private/
            ├── _manifest.json
            └── *.spec.ts
```

### NPM Scripts Reference (Multi-Step)

| Script | Description |
|--------|-------------|
| `npm run generate:multi-specs` | Generate Playwright spec files from multi-step JSON |
| `npm run generate:multi-checks` | Generate MultiStepCheck construct files |
| `npm run migrate:multi` | Full pipeline: specs + constructs |

### Handling Variables Between Steps

Datadog multi-step tests may extract values from one step to use in another (`extractedValues`). The generated Playwright specs preserve the step structure, but variable extraction may need manual adjustment:

```typescript
// Manual variable extraction example
const response = await request.post('/login');
const body = await response.json();
const token = body.accessToken;

// Use in next request
const response2 = await request.get('/protected', {
  headers: { Authorization: `Bearer ${token}` },
});
```

### Soft Assertions

Datadog steps with `allowFailure: true` are converted to Playwright soft assertions (`expect.soft()`), which log failures but don't stop test execution.

### Non-HTTP Step Limitations

Datadog multi-step tests can contain various step types beyond HTTP requests. **Tests containing non-HTTP steps are skipped entirely** during migration because Playwright's request API only supports HTTP/HTTPS.

**Skipped step types:**

| Step Subtype | Reason | Alternative in Checkly |
|--------------|--------|------------------------|
| `tcp` | Raw TCP connections not supported in Playwright | Use `TcpMonitor` construct |
| `icmp` | Ping/ICMP not supported in Playwright | Not available (use external monitoring) |
| `dns` | DNS lookups not supported in Playwright | Use `DnsMonitor` construct |
| `wait` | Sleep/delay steps have no direct equivalent | Manual implementation if needed |

**What happens:**
- Tests with any non-HTTP steps are completely skipped
- Skipped tests are logged during generation with their incompatible step types
- Skipped tests are recorded in `_manifest.json` under the `skipped` array

**Example manifest entry for skipped test:**
```json
{
  "skipped": [
    {
      "logicalId": "abc-123-xyz",
      "name": "My TCP Health Check",
      "incompatibleSubtypes": ["tcp"]
    }
  ]
}
```

**Manual migration options for skipped tests:**
1. Create separate `TcpMonitor` or `DnsMonitor` constructs for those check types
2. Split the test into HTTP-only and non-HTTP portions
3. Use Checkly's API to create custom monitoring solutions

---

## Browser Check Migration

Browser tests from Datadog are converted to Checkly `BrowserCheck` constructs with Playwright spec files.

### Migration Workflow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Browser Tests  │     │  Playwright     │     │  BrowserCheck   │
│  (JSON)         │ ──► │  Spec Files     │ ──► │  Constructs     │
│                 │     │  (.spec.ts)     │     │  (.check.ts)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
   browser-tests.json   npm run generate:       npm run generate:
                        browser-specs           browser-checks
```

### Step 1: Generate Playwright Spec Files

```bash
npm run generate:browser-specs
```

This generates `.spec.ts` files in `checkly-migrated/tests/browser/`:

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

### Step 2: Generate BrowserCheck Constructs

```bash
npm run generate:browser-checks
```

This generates `.check.ts` files in `checkly-migrated/__checks__/browser/{public,private}/`:

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

### One-Command Migration

```bash
npm run migrate:browser
```

This executes `generate:browser-specs` followed by `generate:browser-checks`.

### Step Type Mapping

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

### Element Locator Extraction

Datadog uses multiple locator strategies (`multiLocator`). The migration prioritizes:

1. **ID selectors** (`#elementId`) - extracted from `targetOuterHTML`
2. **data-testid** - extracted from `targetOuterHTML`
3. **name attribute** - extracted from `targetOuterHTML`
4. **Text-based** - from `co` (content) locator
5. **CSS class** - from `cl` locator
6. **XPath** - fallback from `at` or `ab` locators

### Variable Handling

Datadog variables (`{{ VAR_NAME }}`) are converted to `${process.env.VAR_NAME}` for Checkly environment variable support.

### NPM Scripts Reference (Browser)

| Script | Description |
|--------|-------------|
| `npm run generate:browser-specs` | Generate Playwright spec files from browser tests |
| `npm run generate:browser-checks` | Generate BrowserCheck construct files |
| `npm run migrate:browser` | Full pipeline: specs + constructs |

### Output Structure

Checks are separated by location type (public vs private):

```
checkly-migrated/
├── __checks__/
│   └── browser/
│       ├── public/                # Public location checks
│       │   ├── index.ts
│       │   └── *.check.ts
│       └── private/               # Private location checks
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

---

## Environment Variables Migration

Global variables from Datadog can be converted to Checkly environment variables using the API.

### Convert Variables

```bash
npm run convert:variables
```

This creates clean JSON files and shell scripts in `checkly-migrated/variables/`:

```
checkly-migrated/
└── variables/
    ├── env-variables.json      # Non-secure vars with values
    ├── secrets.json            # Secure vars (need manual values)
    ├── create-variables.sh     # API script to create vars
    └── delete-variables.sh     # API script to delete vars
```

### JSON Format

Both JSON files use a clean format ready for the Checkly API:

```json
[
  {
    "key": "API_BASE_URL",
    "value": "https://api.example.com",
    "locked": false
  }
]
```

### Handling Secrets

Datadog **does not export the values of secure variables**. The `secrets.json` file contains empty values that must be filled in manually:

```json
[
  {
    "key": "API_SECRET_KEY",
    "value": "",        // ← Fill this in manually
    "locked": true
  }
]
```

Retrieve these values from your secure storage or password manager before running the import.

### Import to Checkly

1. **Add Checkly credentials to `.env`:**

```bash
# In your .env file (see .env.example)
CHECKLY_API_KEY=your_checkly_api_key_here
CHECKLY_ACCOUNT_ID=your_checkly_account_id_here
```

2. **Fill in secret values** in `checkly-migrated/variables/secrets.json`

3. **Run the create script:**

```bash
cd checkly-migrated/variables
chmod +x create-variables.sh
./create-variables.sh
```

The script automatically loads credentials from `.env` and creates variables via the Checkly API. Secrets with empty values are skipped.

### Delete Variables

To remove all variables (useful for cleanup or re-import):

```bash
./delete-variables.sh
```

This script prompts for confirmation before deleting.

### API Reference

The scripts use the Checkly API:
- **Create:** `POST https://api.checklyhq.com/v1/variables`
- **Delete:** `DELETE https://api.checklyhq.com/v1/variables/{key}`

See [Checkly API Docs](https://developers.checklyhq.com/reference/postv1variables) for details.

### NPM Scripts Reference (Variables)

| Script | Description |
|--------|-------------|
| `npm run convert:variables` | Convert Datadog global variables to Checkly format |

---

## Security Notes

- Never commit your `.env` file to version control
- The `exports/` directory is gitignored by default
- The `checkly-migrated/variables/` directory should also be gitignored (contains sensitive values)
- Rotate your Datadog API keys after migration is complete
- Exported global variables may contain sensitive values - handle with care
