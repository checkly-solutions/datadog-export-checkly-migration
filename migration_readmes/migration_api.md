# API Check Migration

Migrate Datadog single-step API synthetic tests to Checkly `ApiCheck` constructs.

## Quick Start

```bash
# 1. Export from Datadog (if not done)
npm run export

# 2. Filter out multi-step tests
npm run filter-multi

# 3. Run the full migration
npm run migrate:api
```

## Migration Workflow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Datadog API    │     │  Filter         │     │  Intermediate   │     │  Checkly CLI    │
│  Export (JSON)  │ ──► │  Multi-step     │ ──► │  Config (JSON)  │ ──► │  Constructs     │
│                 │     │                 │     │                 │     │  (TypeScript)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘     └─────────────────┘
   npm run export       npm run filter-multi   npm run convert:api    npm run generate:checkly
```

## Step-by-Step

### Step 1: Export from Datadog

```bash
npm run export
```

Creates `exports/api-tests.json` with all your Datadog API synthetic tests.

### Step 2: Filter Multi-Step Tests

```bash
npm run filter-multi
```

Datadog API tests include both single-step and multi-step tests. This separates them:

- **Single-step tests** remain in `exports/api-tests.json` → `ApiCheck`
- **Multi-step tests** move to `exports/multi-step-tests.json` → `MultiStepCheck` (see [migration_multi.md](migration_multi.md))

### Step 3: Convert to Checkly Configuration

```bash
npm run convert:api
```

Transforms Datadog tests into intermediate format at `exports/checkly-api-checks.json`.

### Step 4: Generate Checkly Constructs

```bash
npm run generate:checkly
```

Generates TypeScript files in `checkly-migrated/__checks__/api/{public,private}/`.

### One-Command Migration

Run steps 3-4 together:

```bash
npm run migrate:api
```

## Output Structure

Checks are separated by location type:

```
checkly-migrated/
└── __checks__/
    └── api/
        ├── public/              # Checks using public locations only
        │   ├── index.ts
        │   └── *.check.ts
        └── private/             # Checks using private locations
            ├── index.ts
            └── *.check.ts
```

## Generated Code Example

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
  activated: true,
  muted: false,
  retryStrategy: RetryStrategyBuilder.noRetries(),
});
```

## Attribute Mapping

| Datadog | Checkly |
|---------|---------|
| `public_id` | `logicalId` |
| `name` | `name` |
| `tags` | `tags` |
| `config.request.url` | `request.url` |
| `config.request.method` | `request.method` |
| `config.assertions` | `assertions` (AssertionBuilder) |
| `config.assertions[type=responseTime].target` | `maxResponseTime` |
| `options.tick_every` | `frequency` |
| `options.retry` | `retryStrategy` |
| `locations` (public) | `locations` |
| `locations` (`pl:*`) | `privateLocations` |

## Assertion Mapping

| Datadog Operator | Checkly AssertionBuilder |
|------------------|--------------------------|
| `is` | `.equals()` |
| `isNot` | `.notEquals()` |
| `lessThan` | `.lessThan()` |
| `moreThan` | `.greaterThan()` |
| `contains` | `.contains()` |
| `doesNotContain` | `.notContains()` |
| `matches` | `.matches()` |

## Frequency Mapping

| Datadog `tick_every` | Checkly Frequency |
|---------------------|-------------------|
| 60 | `EVERY_1M` |
| 300 | `EVERY_5M` |
| 600 | `EVERY_10M` |
| 900 | `EVERY_15M` |
| 1800 | `EVERY_30M` |
| 3600 | `EVERY_1H` |

## Private Locations

Checks using Datadog private locations (`pl:*`) are placed in the `private/` folder. After migration:

1. Create `PrivateLocation` constructs in Checkly
2. Map Datadog location IDs to Checkly private location slugs
3. Update the generated files if needed

## Test and Deploy to Checkly

Use the appropriate config file for public or private checks:

```bash
# Test public API checks
npx checkly test --config checkly.public.config.ts

# Test private API checks (requires private locations in your account)
npx checkly test --config checkly.private.config.ts

# Deploy public checks
npx checkly deploy --config checkly.public.config.ts

# Deploy private checks
npx checkly deploy --config checkly.private.config.ts
```

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run filter-multi` | Separate multi-step from single-step tests |
| `npm run convert:api` | Convert Datadog JSON to Checkly config |
| `npm run generate:checkly` | Generate TypeScript construct files |
| `npm run migrate:api` | Full pipeline: convert + generate |
