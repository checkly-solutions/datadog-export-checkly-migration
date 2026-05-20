# TCP Monitor Migration

Migrate Datadog TCP synthetic tests (`subtype: tcp`) to Checkly `TcpMonitor` constructs.

## Quick Start

```bash
# 1. Export from Datadog (if not done)
npm run export

# 2. Generate TCP monitor constructs
npm run generate:tcp
```

`npm run migrate:api` runs `generate:tcp` automatically — you only need the standalone command when re-generating TCP after editing the source export or switching output modes.

## Migration Workflow

```
┌─────────────────┐     ┌───────────────────┐     ┌─────────────────────┐
│  Datadog API    │     │  Filter           │     │  Checkly CLI        │
│  Export (JSON)  │ ──► │  subtype: 'tcp'   │ ──► │  TcpMonitor         │
│                 │     │                   │     │  constructs (.ts)   │
└─────────────────┘     └───────────────────┘     └─────────────────────┘
   npm run export        (in step 04b)             npm run generate:tcp
```

TCP tests live in the raw export file `exports/api-tests.json` alongside HTTP API tests — step 04b filters them out by `subtype === 'tcp'` and routes them to a dedicated generator. Step 02 (`convert:api`) is aware of this and does **not** count them as "skipped non-HTTP" tests.

## Step-by-Step

### Step 1: Export from Datadog

```bash
npm run export
```

Creates `checkly-migrated/<account-name>/exports/api-tests.json`, which contains *all* API synthetic subtypes (HTTP, TCP, DNS, SSL, etc.). TCP tests are identified by `subtype: 'tcp'`.

### Step 2: Generate TcpMonitor Constructs

```bash
npm run generate:tcp
```

Reads `exports/api-tests.json`, filters `subtype === 'tcp'`, partitions by public vs private locations, and writes one `.check.ts` file per TCP test.

## Output Modes

Step 04b supports two output modes, controlled by the optional `CHECKLY_TCP_PROJECT_NAME` environment variable.

### Inline (default)

When `CHECKLY_TCP_PROJECT_NAME` is **unset**, TCP files are written into the main migration project alongside the other constructs:

```
checkly-migrated/<account-name>/
└── __checks__/
    └── tcp/
        ├── public/             # Checks using public locations only
        │   ├── index.ts
        │   └── *.check.ts
        └── private/            # Checks using private locations
            ├── index.ts
            └── *.check.ts
```

The TCP monitors deploy as part of the same Checkly project as the API, browser, and multi-step checks.

### Standalone project

When `CHECKLY_TCP_PROJECT_NAME=<slug>` is set, TCP files are written to a **fully self-contained Checkly project** at `checkly-migrated/<slug>/`:

```
checkly-migrated/<slug>/
├── __checks__/tcp/{public,private}/    # TcpMonitor constructs
├── default_resources/alertChannels.ts  # Alert channel config (placeholder email)
├── variables/
│   ├── env-variables.json              # [] (TCP monitors don't use variables)
│   ├── secrets.json                    # []
│   ├── create-variables.ts             # Copied from source migration
│   └── delete-variables.ts             # Copied from source migration
├── checkly.config.ts                   # logicalId: <slug>
├── checkly.private.config.ts           # logicalId: <slug>-private
├── checkly.public.config.ts            # logicalId: <slug>-public
├── package.json                        # test:/deploy:/create-variables scripts
├── README.md                           # Deploy guide
├── migration-mapping.csv               # TCP-only rows (filtered from source)
└── update-mapping.ts                   # Post-deploy UUID backfill
```

The standalone project has its own Checkly `logicalId`, so deploying it **cannot affect** the main migration project. Use this mode when:

- You want to deploy TCP monitors separately from the rest of the migration (e.g., a different team owns them).
- The main migration is already deployed and you don't want to risk touching it when adding TCP support.
- You want a cleaner change history when version-controlling the TCP monitors separately.

```bash
# Default: inline mode
CHECKLY_ACCOUNT_NAME=acme npm run generate:tcp

# Standalone mode
CHECKLY_ACCOUNT_NAME=acme CHECKLY_TCP_PROJECT_NAME=acme-tcp npm run generate:tcp
```

Each generated `.check.ts` in standalone mode imports `alertChannels` from `default_resources/alertChannels.ts` so notifications are wired up automatically when you customize that file.

## Generated Code Example

```typescript
/**
 * Migrated from Datadog Synthetic: jxu-w9e-wxw
 */
import {
  TcpMonitor,
  Frequency,
  RetryStrategyBuilder,
} from "checkly/constructs";

new TcpMonitor("tcp-osabe-us-adls-telnet-...-applicationhealth", {
  name: "OSABE - US ADLS telnet csusprodprocessing.dfs.core.windows.net 443 -applicationHealth",
  tags: [
    "applicationname:osa_be",
    "env:prod",
    "team:gcc",
    "migration_check_id:jxu-w9e-wxw",
    "priority:P2",
  ],
  request: {
    hostname: "csusprodprocessing.dfs.core.windows.net",
    port: 443,
  },
  frequency: Frequency.EVERY_5M,
  locations: [],
  privateLocations: ["niq-aks-eastus2"],
  degradedResponseTime: 800,
  maxResponseTime: 1000,
  activated: true,
  muted: false,
  retryStrategy: RetryStrategyBuilder.linearStrategy({
    maxRetries: 2,
    baseBackoffSeconds: 3,
  }),
});
```

In standalone mode the file also imports `alertChannels` and passes it to the constructor.

## Attribute Mapping

| Datadog | Checkly |
|---------|---------|
| `public_id` | `migration_check_id:<publicId>` tag |
| `name` | `name` |
| `tags` | `tags` (after `filterAndRemapTags`) |
| `config.request.host` | `request.hostname` |
| `config.request.port` | `request.port` |
| `config.assertions[type=responseTime].target` | `maxResponseTime` (capped at Checkly's 5000ms limit) |
| (derived from maxResponseTime) | `degradedResponseTime: floor(maxResponseTime * 0.8)` |
| `options.tick_every` | `frequency` |
| `options.retry.count` | `retryStrategy.maxRetries` |
| `options.retry.interval` (ms) | `retryStrategy.baseBackoffSeconds` (seconds) |
| `options.monitor_priority` | `priority:P<n>` tag |
| `status === 'live'` | `activated: true` (otherwise `false`) |
| `locations` (public) | `locations` |
| `locations` (`pl:*`) | `privateLocations` |

## Assertion Mapping

Datadog TCP synthetics only support one assertion type:

| Datadog | Checkly |
|---------|---------|
| `responseTime lessThan T` | `maxResponseTime: T` (top-level prop on `TcpMonitor`) |
| `responseTime lessThanOrEqual T` | `maxResponseTime: T` |

These are semantically identical to a `TcpAssertionBuilder.responseTime().lessThan(T)` assertion but cleaner — they live as a typed property on the monitor instead of in the assertions array. `degradedResponseTime` is derived as `floor(T * 0.8)` so degraded thresholds fire before failures.

If a TCP test had no `responseTime` assertion, both `maxResponseTime` and `degradedResponseTime` are omitted and Checkly uses its defaults (4000ms degraded, 5000ms max).

## Frequency Mapping

Same as API checks — see [migration_api.md](migration_api.md#frequency-mapping).

## Private Locations

TCP monitors use the same private-location infrastructure as API checks. The Datadog `pl:<id>-private-location-<hash>` format is mapped to a Checkly slug by step 01 and passed through unchanged. Create the corresponding `PrivateLocation` in Checkly (with the exact slug) before deploying.

## Edge Cases

### TCP steps inside multi-step tests

`TcpMonitor` is a single-host/port construct, **not** a sequence. A Datadog multi-step API test that contains a TCP step (`subtype: tcp` nested inside the steps array) cannot be migrated to a single `TcpMonitor`. Step 05 (multi-step generator) skips these tests with `incompatibleSubtypes: ["tcp"]` in `_manifest.json`. If you need monitoring for the TCP step specifically, lift it out into its own standalone TcpMonitor manually.

### Tests with no `responseTime` assertion

Some Datadog TCP tests have no assertions at all (a bare "is the port reachable" probe). Step 04b emits these without `maxResponseTime` / `degradedResponseTime`, so Checkly uses its defaults: a check fails only if the connection takes > 5000ms or fails outright.

### Long hostnames or unusual characters in names

The same `sanitizeFilename` helper used by API checks is applied to TCP filenames. If the slugged name exceeds 50 characters, a 9-char suffix derived from the Datadog `publicId` is appended so regional fanouts (US/EU/CALATAM/APAC variants of the same name) don't collide on disk.

## Test and Deploy to Checkly

### Inline mode

Same as the rest of the migration — `npm run test:public` / `test:private` / `deploy:public` / `deploy:private` from the account directory pick up TCP files via the existing `checkMatch: "__checks__/**/private/*.check.ts"` glob.

### Standalone mode

Each TCP project is its own deployable unit:

```bash
cd checkly-migrated/<slug>

# (Optional) edit alert channels
$EDITOR default_resources/alertChannels.ts

# (Optional) edit checkly.private.config.ts and set privateRunLocation
$EDITOR checkly.private.config.ts

# Test
npm run test:private

# Deploy (creates a NEW Checkly project — does not touch other deployments)
npm run deploy:private
```

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run generate:tcp` | Generate `TcpMonitor` constructs from `exports/api-tests.json` |
| `npm run migrate:api` | Full API + TCP pipeline (`convert:api && generate:checkly && generate:tcp`) |
