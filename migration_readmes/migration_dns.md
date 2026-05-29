# DNS Monitor Migration

Migrate Datadog DNS synthetic tests (`subtype: dns`) to Checkly `DnsMonitor` constructs.

## Quick Start

```bash
# 1. Export from Datadog (if not done)
npm run export

# 2. Generate DNS monitor constructs
npm run generate:dns
```

`npm run migrate:api` runs `generate:dns` automatically (after `convert:api` and `generate:tcp`). You only need the standalone command when re-generating DNS after editing the source export or switching output modes.

## Migration Workflow

```
┌─────────────────┐     ┌───────────────────┐     ┌─────────────────────┐
│  Datadog API    │     │  Filter           │     │  Checkly CLI        │
│  Export (JSON)  │ ──► │  subtype: 'dns'   │ ──► │  DnsMonitor         │
│                 │     │                   │     │  constructs (.ts)   │
└─────────────────┘     └───────────────────┘     └─────────────────────┘
   npm run export        (in step 04c)             npm run generate:dns
```

DNS tests live in the raw export file `exports/api-tests.json` alongside HTTP/TCP API tests — step 04c filters them out by `subtype === 'dns'` and routes them to a dedicated generator. Step 02 (`convert:api`) is aware of this and does **not** count them as "skipped non-HTTP" tests.

## Step-by-Step

### Step 1: Export from Datadog

```bash
npm run export
```

Creates `checkly-migrated/<account-name>/exports/api-tests.json`, which contains all API synthetic subtypes (HTTP, TCP, DNS, SSL, etc.). DNS tests are identified by `subtype: 'dns'`.

### Step 2: Generate DnsMonitor Constructs

```bash
npm run generate:dns
```

Reads `exports/api-tests.json`, filters `subtype === 'dns'`, partitions by public vs private locations, and writes one `.check.ts` file per DNS test.

## Output Modes

Step 04c supports two output modes, controlled by the optional `CHECKLY_DNS_PROJECT_NAME` environment variable. This mirrors `CHECKLY_TCP_PROJECT_NAME` exactly.

### Inline (default)

When `CHECKLY_DNS_PROJECT_NAME` is **unset**, DNS files are written into the main migration project:

```
checkly-migrated/<account-name>/
└── __checks__/
    └── dns/
        ├── public/             # Monitors using public locations only
        │   ├── index.ts
        │   └── *.check.ts
        └── private/            # Monitors using private locations
            ├── index.ts
            └── *.check.ts
```

The DNS monitors deploy as part of the same Checkly project as the API, browser, multi-step, and TCP checks.

### Standalone project

When `CHECKLY_DNS_PROJECT_NAME=<slug>` is set, DNS files are written to a **fully self-contained Checkly project** at `checkly-migrated/<slug>/`:

```
checkly-migrated/<slug>/
├── __checks__/dns/{public,private}/    # DnsMonitor constructs
├── default_resources/alertChannels.ts  # Alert channel config (placeholder email)
├── variables/
│   ├── env-variables.json              # []  (DNS monitors don't use variables)
│   ├── secrets.json                    # []
│   ├── create-variables.ts             # Copied from source migration
│   └── delete-variables.ts             # Copied from source migration
├── checkly.config.ts                   # logicalId: <slug>
├── checkly.private.config.ts           # logicalId: <slug>-private
├── checkly.public.config.ts            # logicalId: <slug>-public
├── package.json                        # test:/deploy:/create-variables scripts
├── README.md                           # Deploy guide
├── migration-mapping.csv               # DNS-only rows (filtered from source)
└── update-mapping.ts                   # Post-deploy UUID backfill
```

The standalone project has its own Checkly `logicalId`, so deploying it **cannot affect** the main migration project. Use this mode when you want to deploy DNS monitors as an isolated Checkly project.

```bash
# Default: inline mode
CHECKLY_ACCOUNT_NAME=acme npm run generate:dns

# Standalone mode
CHECKLY_ACCOUNT_NAME=acme CHECKLY_DNS_PROJECT_NAME=acme-dns npm run generate:dns
```

In standalone mode each generated `.check.ts` imports `alertChannels` from `default_resources/alertChannels.ts` so notifications are wired up automatically when you customize that file.

## Generated Code Example

```typescript
/**
 * Migrated from Datadog Synthetic: mu5-wdw-nau
 */
import {
  DnsMonitor,
  DnsAssertionBuilder,
  Frequency,
  RetryStrategyBuilder,
} from "checkly/constructs";
import { alertChannels } from "../../../default_resources/alertChannels";


// NOTE: Datadog config.request.timeout=10ms was dropped — DnsMonitor has no request-level timeout. The maxResponseTime property below is the effective deadline.

new DnsMonitor("dns-dns-test-for-dns-google-on-10-247-104-97-us-prod-ns1", {
  name: "DNS Test for dns.google on 10.247.104.97  (US Prod NS1)",
  tags: ["dns_type:Canary", "env:PROD", "region:eastus2", "migration_check_id:mu5-wdw-nau", "priority:P1"],
  request: {
    recordType: "A",
    query: "dns.google",
    nameServer: "10.247.104.97",
    assertions: [
      DnsAssertionBuilder.textAnswer().contains("8.8.8.8"),
    ],
  },
  frequency: Frequency.EVERY_2M,
  locations: [],
  privateLocations: ["niq-aks-eastus2", "niq-aks-westeurope"],
  degradedResponseTime: 800,
  maxResponseTime: 1000,
  activated: true,
  muted: false,
  retryStrategy: RetryStrategyBuilder.noRetries(),
  alertChannels,
});
```

## Attribute Mapping

| Datadog | Checkly |
|---------|---------|
| `public_id` | `migration_check_id:<publicId>` tag |
| `name` | `name` |
| `tags` | `tags` (after `filterAndRemapTags`) |
| `config.request.host` | `request.query` |
| `config.request.dnsServer` (non-empty) | `request.nameServer` |
| (defaulted) | `request.recordType: 'A'` |
| `config.request.timeout` | **dropped** — comment added to the generated file when set |
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

| Datadog | Checkly |
|---------|---------|
| `responseTime lessThan T` | `maxResponseTime: T` (top-level prop on `DnsMonitor`) |
| `responseTime lessThanOrEqual T` | `maxResponseTime: T` |
| `recordSome is V` (property=A) | `DnsAssertionBuilder.textAnswer().contains(V)` |
| `recordEvery matches P` (property=A) | `DnsAssertionBuilder.textAnswer(<glob→regex>).notEquals("")` (**downgrade**) |

### About the `recordEvery` downgrade

Datadog's `recordEvery matches <pattern>` means **every** record returned must match. Checkly's `textAnswer(regex)` only checks whether **some** record matches the regex (returns the first match against the full text answer). There's no Checkly construct for the "every record" semantic.

The migrator does its best:
1. Converts Datadog's glob target (e.g. `10.247.1*`) to a regex (`10.247.1.*`)
2. Emits `DnsAssertionBuilder.textAnswer(<regex>).notEquals("")` — passes if the regex matches any part of the answer
3. Adds a `// WARNING:` comment block at the top of the generated file

If "every record matches" is a hard requirement (e.g. you're verifying that **all** A records for a hostname are in a specific subnet), tighten the assertion by hand after migration.

## Record Types

The Datadog API doesn't expose an explicit record type field for synthetic DNS tests — the default behavior is to query `A` records, and all observed Datadog DNS tests use that default. Step 04c emits `recordType: "A"` for every monitor.

If you have Datadog DNS tests that query other record types (`AAAA`, `MX`, `CNAME`, `TXT`, `NS`, `SOA`), the generated file will need the `recordType` field updated by hand. Check the original Datadog test name or message for hints about what record type was intended.

## Frequency Mapping

Same as API checks — see [migration_api.md](migration_api.md#frequency-mapping).

## Private Locations

DNS monitors use the same private-location infrastructure as API checks. The Datadog `pl:<id>-private-location-<hash>` format is mapped to a Checkly slug by step 01 and passed through unchanged. Create the corresponding `PrivateLocation` in Checkly (with the exact slug) before deploying.

## Edge Cases

### DNS steps inside multi-step tests

`DnsMonitor` is a single-query construct, **not** a sequence. A Datadog multi-step API test that contains a DNS step (`subtype: dns` nested inside the steps array) cannot be migrated to a single `DnsMonitor`. Step 05 (multi-step generator) skips these tests with `incompatibleSubtypes: ["dns"]` in `_manifest.json`. If you need monitoring for the DNS step specifically, lift it out into a standalone DnsMonitor manually.

### Tests with no record-content assertion

Some Datadog DNS tests have no `recordSome` / `recordEvery` assertion (just a "did the query return *something* within the time limit" probe). Step 04c emits these without the `request.assertions` array — Checkly's defaults check that the query succeeds and the response time is within `maxResponseTime`.

### Empty `dnsServer`

Some Datadog tests have `dnsServer: ""` (empty string) — this means "use the default resolver". Step 04c omits the `nameServer` field in this case, which makes Checkly use its automatic name server selection.

### `config.request.timeout` is dropped

Datadog supports a per-test request timeout that's separate from the response-time assertion. `DnsMonitor` has no equivalent — only `maxResponseTime` controls the deadline. The generated file includes a `// NOTE:` comment when the source test had a timeout set, so you can verify the response-time threshold is appropriate.

### Hostnames with trailing dots

A few of the observed Datadog DNS tests have hostnames ending in `.` (e.g. `a.resolvers.level3.net.`) — the trailing-dot fully-qualified DNS form. Step 04c preserves the host string verbatim. Most resolvers (including Checkly's) tolerate this.

## Test and Deploy to Checkly

### Inline mode

Same as the rest of the migration — `npm run test:public` / `test:private` / `deploy:public` / `deploy:private` from the account directory pick up DNS files via the existing `checkMatch: "__checks__/**/private/*.check.ts"` glob.

### Standalone mode

Each DNS project is its own deployable unit:

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
| `npm run generate:dns` | Generate `DnsMonitor` constructs from `exports/api-tests.json` |
| `npm run migrate:api` | Full API + TCP + DNS pipeline (`convert:api && generate:checkly && generate:tcp && generate:dns`) |
