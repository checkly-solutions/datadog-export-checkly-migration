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

### Output Structure

After running the full migration:

```
exports/
├── api-tests.json              # Single-step API tests (after filtering)
├── multi-step-tests.json       # Multi-step tests (require separate handling)
├── checkly-api-checks.json     # Intermediate Checkly config
├── browser-tests.json          # Browser tests (separate migration)
├── global-variables.json       # Environment variables
└── private-locations.json      # Private location configs

checkly-migrated/
├── __checks__/
│   └── api/
│       ├── index.ts                    # Index file importing all checks
│       ├── sports-portal-score-api.check.ts  # Named by Datadog synthetic name
│       └── ...
└── tests/
    └── (browser tests would go here)
```

### Handling Private Locations

Datadog private locations (prefixed with `pl:`) are extracted separately. After migration:

1. Create corresponding `PrivateLocation` constructs in Checkly
2. Update the generated check files to reference your Checkly private locations
3. Or use Checkly's public locations as alternatives

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
    entrypoint: "../../tests/multi/sports-nbc-sports-group-scheduall-api.spec.ts",
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

After running the full migration (API + Multi-Step):

```
checkly-migrated/
├── __checks__/
│   ├── api/
│   │   ├── index.ts                              # Index file for API checks
│   │   ├── sports-portal-score-api.check.ts      # ApiCheck constructs
│   │   └── ...
│   └── multi/
│       ├── index.ts                              # Index file for multi-step checks
│       ├── sports-nbc-sports-group-scheduall-api.check.ts  # MultiStepCheck constructs
│       └── ...
└── tests/
    └── multi/
        ├── _manifest.json                        # Manifest of generated spec files
        ├── sports-nbc-sports-group-scheduall-api.spec.ts   # Playwright spec files
        └── ...
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

## Security Notes

- Never commit your `.env` file to version control
- The `exports/` directory is gitignored by default
- Rotate your Datadog API keys after migration is complete
- Exported global variables may contain sensitive values - handle with care
