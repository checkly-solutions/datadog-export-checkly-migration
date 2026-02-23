# Multi-Step Check Migration

Migrate Datadog multi-step API tests to Checkly `MultiStepCheck` constructs with Playwright spec files.

## Quick Start

```bash
# 1. Export from Datadog (if not done)
npm run export

# 2. Filter multi-step tests
npm run filter-multi

# 3. Run the full migration
npm run migrate:multi
```

## Migration Workflow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Multi-step     │     │  Playwright     │     │  MultiStepCheck │
│  Tests (JSON)   │ ──► │  Spec Files     │ ──► │  Constructs     │
│                 │     │  (.spec.ts)     │     │  (.check.ts)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
   (after filter)       npm run generate:       npm run generate:
                        multi-specs             multi-checks
```

## Step-by-Step

### Step 1: Filter Multi-Step Tests

```bash
npm run filter-multi
```

Creates `exports/multi-step-tests.json` with all tests that have `subtype: "multi"`.

### Step 2: Generate Playwright Spec Files

```bash
npm run generate:multi-specs
```

Generates `.spec.ts` files in `checkly-migrated/<customer-name>/tests/multi/{public,private}/`.

### Step 3: Generate MultiStepCheck Constructs

```bash
npm run generate:multi-checks
```

Generates `.check.ts` files in `checkly-migrated/<customer-name>/__checks__/multi/{public,private}/`.

### One-Command Migration

```bash
npm run migrate:multi
```

Runs steps 2-3 together.

## Output Structure

```
checkly-migrated/<customer-name>/
├── __checks__/
│   └── multi/
│       ├── public/
│       │   ├── index.ts
│       │   └── *.check.ts
│       └── private/
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

## Generated Spec Example

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
  });
});
```

## Generated Construct Example

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

## Step Mapping

| Datadog | Playwright |
|---------|------------|
| `steps[].request.method` | `request.get()`, `request.post()`, etc. |
| `steps[].request.url` | URL parameter |
| `steps[].request.headers` | `headers` option |
| `steps[].request.body` | `data` option |
| `steps[].assertions` | `expect()` calls |
| `steps[].allowFailure: true` | `expect.soft()` (soft assertions) |

## Handling Variables Between Steps

Datadog multi-step tests may extract values between steps. The generated specs preserve structure, but variable extraction may need manual adjustment:

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

## Non-HTTP Step Limitations

Tests containing non-HTTP steps are **skipped entirely** because Playwright only supports HTTP/HTTPS.

| Step Subtype | Reason | Alternative in Checkly |
|--------------|--------|------------------------|
| `tcp` | Not supported in Playwright | Use `TcpMonitor` construct |
| `icmp` | Not supported in Playwright | Not available |
| `dns` | Not supported in Playwright | Use `DnsMonitor` construct |
| `wait` | No direct equivalent | Manual implementation |

Skipped tests are recorded in `_manifest.json`:

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

## Test and Deploy to Checkly

Run from the customer directory:

```bash
cd checkly-migrated/<customer-name>

# Test public multi-step checks
npm run test:public

# Test private multi-step checks (requires private locations in your account)
npm run test:private

# Deploy public checks
npm run deploy:public

# Deploy private checks
npm run deploy:private
```

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run filter-multi` | Separate multi-step from single-step tests |
| `npm run generate:multi-specs` | Generate Playwright spec files |
| `npm run generate:multi-checks` | Generate MultiStepCheck constructs |
| `npm run migrate:multi` | Full pipeline: specs + constructs |
