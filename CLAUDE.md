# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A one-way ETL pipeline that converts Datadog Synthetic monitors into deployment-ready **Checkly CLI TypeScript constructs**. It reads from the Datadog API and writes a self-contained Checkly project to `checkly-migrated/<account-name>/`. There is no long-running service — every entry point is a numbered script in `src/` run in sequence.

`README.md` is the authoritative end-to-end guide (credentials, what gets migrated, post-migration deploy steps, output structure, per-type caveats). Read it before changing migration behavior. Per-type deep dives live in `migration_readmes/` (`migration_api.md`, `migration_tcp.md`, `migration_dns.md`, `migration_multi.md`, `migration_browser.md`, `migration_env.md`). For AI coding assistants, `AGENTS.md` is the operating cheat-sheet and `docs/ai-primer.md` is the troubleshooting decision tree + contributing runbook; human-facing guides live in `docs/`.

## Running scripts

TypeScript runs directly via `jiti` — there is **no build step** (the `outDir`/`dist` in `tsconfig.json` is unused; `npm run build` does not exist). Every script is invoked as `node --import jiti/register src/NN-name.ts`, wrapped in an npm script.

```bash
npm install
cp .env.example .env          # fill in DD_* and CHECKLY_* credentials
npm run migrate:all           # full pipeline, root → checkly-migrated/<account-name>/
```

Individual stages (see `package.json` for the complete list):

```bash
npm run export            # 01  Datadog API → exports/*.json
npm run filter-multi      # 03  split multi-step out of api-tests.json
npm run migrate:api       # 02 + 04 + 04b(tcp) + 04c(dns)
npm run migrate:multi     # 05 + 06
npm run migrate:browser   # 07 + 08
npm run convert:variables # 09
npm run generate:groups   # 11
npm run add:defaults      # 10  writes the account project shell (configs, package.json, README)
npm run check:status      # 10a deactivate tests failing in Datadog (needs DD_CHECK_STATUS=true)
npm run check:secrets     # 10b deactivate checks referencing empty secrets
npm run generate:report   # 12  migration-report.{md,json} + migration-mapping.csv
```

There is **no test suite, linter, or formatter** in this repo — `npm test` is not defined. Validation is done by running the pipeline and inspecting `checkly-migrated/<account-name>/` output (and, for the generated project, running `npx checkly test` from inside it).

## Pipeline architecture

Scripts are **strictly ordered** and communicate through JSON files in `checkly-migrated/<account-name>/exports/`. Each step reads the previous step's JSON and writes its own; later steps emit `.check.ts` construct files and Playwright `.spec.ts` files.

```
01 export ──► exports/{api-tests,browser-tests,multi-step-tests,
              global-variables,public-locations,private-locations,
              export-summary}.json
02 convert:api      api-tests.json        ──► checkly-api-checks.json
03 filter-multi     api-tests.json        ──► splits multi-step into multi-step-tests.json
04  api constructs  checkly-api-checks.json ──► __checks__/api/{public,private}/*.check.ts
04b tcp             api-tests.json (subtype:tcp) ──► __checks__/tcp/...  (TcpMonitor)
04c dns             api-tests.json (subtype:dns) ──► __checks__/dns/...  (DnsMonitor)
05/06 multi-step    multi-step-tests.json  ──► tests/multi/*.spec.ts + __checks__/multi/*.check.ts
07/08 browser       browser-tests.json     ──► tests/browser/*.spec.ts + __checks__/browser/*.check.ts
09 variables        global-variables.json  ──► variables/{env-variables,secrets}.json
10 add:defaults     ──► checkly.config.ts, checkly.{public,private}.config.ts, package.json,
                        default_resources/alertChannels.ts, account README, update-mapping.ts
10a/10b status/secrets ──► flip activated:false + add tags on failing/secret-missing checks
12 report           everything            ──► migration-report.{md,json}, migration-mapping.csv
```

Re-running a later step in isolation works as long as the JSON it depends on already exists in `exports/`.

### Two project layers — don't confuse them

- **Root repo (this directory)** = the migration *tool*. Its `package.json` scripts orchestrate the conversion and run from here.
- **`checkly-migrated/<account-name>/`** = the generated *output*, a fully self-contained Checkly CLI project with its own `package.json` (`test:public`, `deploy:private`, `create-variables`, etc.), `checkly*.config.ts`, and `README.md`. It is git-ignored and meant to be copied out and handed to a customer. `checkly-migrated-sample/` is a checked-in example of this output — use it as a reference for what generated files should look like.

### Shared modules (`src/shared/`)

- `output-config.ts` — resolves the output root `./checkly-migrated/<account-name>`. Account name comes from `CHECKLY_ACCOUNT_NAME` → `.account-name` cache file → interactive prompt (which writes the cache so subsequent steps don't re-prompt). **Every step gets its paths from here**; never hardcode the account dir.
- `types.ts` — Datadog API shapes (`DatadogTest`, `MultiStepTest`, `BrowserTest`, assertions, steps, config variables) and the `TransformedTest` shape that step 01 produces (locations pre-split into public `locations` + `privateLocations`).
- `utils.ts` — conversion primitives shared across generators: `convertFrequency` (`tick_every` seconds → `EVERY_*`), `filterAndRemapTags` (implements `DD_TAGS_EXCLUDE` / `DD_TAGS_EXCLUDE_ALL` / `DD_TAGS_REMAP`), `convertConfigVariables`, `detectBodyType`, `priorityTag`, private-location slug derivation, filename/identifier sanitizers.
- `variable-tracker.ts` — accumulates which env/secret variables each check references (scans `{{ VAR }}` and `${process.env.VAR}`); feeds the variable-usage section of the report.

## Conventions that bite if missed

- **ESM + `.ts` import specifiers.** `package.json` has `"type": "module"` and `tsconfig` uses `NodeNext`. Relative imports must include the `.ts` extension (e.g. `import { ... } from './shared/utils.ts'`). Imports run through jiti, not `tsc`.
- **Public/private split is structural.** A test using *any* private location is routed to `private/` folders and `checkly.private.config.ts`; public-only tests go to `public/`. Most generators branch on `hasPrivateLocations()`. Keep both paths in sync when editing a generator.
- **Safe-by-default activation.** Generated check groups are `activated: false` and individual checks preserve Datadog's paused/failing state. The migration is designed so deploying never starts runs or alerts until a human enables the group. Don't "helpfully" flip these to active.
- **Migration traceability tags are appended after user tag filtering.** `migration_check_id:<datadog_public_id>`, `requiresClientCertificate`, etc. are added *after* `filterAndRemapTags`, so user exclude/remap rules can't strip them.
- **TCP/DNS have inline vs standalone output modes** controlled by `CHECKLY_TCP_PROJECT_NAME` / `CHECKLY_DNS_PROJECT_NAME` — when set, those monitors are written as a separate standalone Checkly project instead of inlined. See the TCP/DNS sections of `README.md`.

## Checkly capability claims — verify, don't trust in-repo comments

When deciding whether Checkly supports a given Datadog feature (assertion type, monitor construct, builder method), **verify against live Checkly docs** (checklyhq.com or the Context7 MCP / Checkly skill) rather than this repo's code comments or `migration_readmes/`. Several in-repo comments understate or misstate Checkly's actual capabilities. The Checkly CLI version in use is pinned in `package.json` (`checkly` devDependency).
