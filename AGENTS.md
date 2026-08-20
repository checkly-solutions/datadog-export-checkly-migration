# AGENTS.md

Operating manual for AI coding assistants (Claude Code, Codex, and friends) working in this repo. Read this first, then defer to the linked docs for depth. Don't re-derive what's already written down.

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

The migrator has its own **tool test suite**, run via `npm run test:tool` (see the Testing SOP section at the end of this file). There is still no linter or formatter, and `npm test` remains intentionally undefined. Validation of generated output is done by running the pipeline and inspecting `checkly-migrated/<account-name>/` output (and, for the generated project, running `npx checkly test` from inside it).

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
- **`checkly-migrated/<account-name>/`** = the generated *output*, a fully self-contained Checkly CLI project with its own `package.json`, `checkly*.config.ts`, and `README.md`. It is git-ignored and meant to be copied out and handed to a customer. `checkly-migrated-sample/` is a checked-in example of this output — use it as a reference for what generated files should look like.

The generated `package.json` (written by step 10) exposes its own scripts, run **from inside the account dir**, not the repo root: `test:public` / `test:private` (`npx checkly test` against the matching config), `deploy:public` / `deploy:private` (`npx checkly deploy --force`), `create-variables` (push `env-variables.json` + `secrets.json` to Checkly, needs `CHECKLY_API_KEY` + `CHECKLY_ACCOUNT_ID`), and `update-mapping` (after deploy, backfill the `checkly_uuid` column in `migration-mapping.csv` by matching the `migration_check_id` tag). When editing step 10, keep this script set intact.

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
- **Diagnostic tags are the source of truth for what happened to a check.** Before theorizing about why a check is deactivated, mistagged, or missing, read its tags and `migration-report.md` — they already record the why. The vocabulary: `migration_check_id` (Datadog↔Checkly link), `failingInDatadog` / `noDataInDatadog` (added by 10a `check:status`), `missingSecretsFromDatadog` (added by 10b `check:secrets`), `requiresClientCertificate`.
- **TCP/DNS have inline vs standalone output modes** controlled by `CHECKLY_TCP_PROJECT_NAME` / `CHECKLY_DNS_PROJECT_NAME` — when set, those monitors are written as a separate standalone Checkly project instead of inlined. See the TCP/DNS sections of `README.md`.

## Checkly capability claims — verify, don't trust in-repo comments

When deciding whether Checkly supports a given Datadog feature (assertion type, monitor construct, builder method), **verify against live Checkly docs** (checklyhq.com or the Context7 MCP / Checkly skill) rather than this repo's code comments or `migration_readmes/`. Several in-repo comments understate or misstate Checkly's actual capabilities. The Checkly CLI version in use is pinned in `package.json` (`checkly` devDependency).

# Output color themes
When possible, use the checkly brand guidelines (found in notion which you have acces to via connector: https://app.notion.com/p/checkly/Brand-Guidelines-29b886a6b3e441328760bff2feb17514?source=copy_link)

## Testing SOP (tool tests)

The migrator has its own software test suite, called **tool tests** throughout this repo. This SOP is the contract for running the suite, extending it, and keeping it deterministic and public-safe.

### Running the suite

```bash
npm run test:tool        # full suite: fixture-integrity gate first, then every tool test
npm run test:tool:watch  # watch mode
npm run test:tool:tap    # TAP reporter output
```

`npm run test:tool` runs in two stages. The fixture-integrity denylist gate (`tool-tests/fixture-integrity.test.ts`) runs first and must pass before the full glob (`tool-tests/**/*.test.ts`) runs. Tests are plain `node:test` executed through jiti; no build step, no test framework dependency.

Node 22 or newer is required for the glob stage. On Node 18, pass explicit `.test.ts` file paths to `node --import jiti/register --test` instead of the glob.

Every invocation sets `CHECKLY_ACCOUNT_NAME` (already baked into the npm scripts) so no import chain can ever reach the interactive account prompt in `src/shared/output-config.ts`.

### When a change requires a new tool test

Any change to a numbered generator script (`src/NN-*.ts`) or to a `src/shared/` helper ships with a unit or generation test in the same change. Every fix phase ships its own tool tests covering the behavior it fixes.

### Fixture rules

- Fixtures are authored synthetic from scratch against the code's own input interfaces (the per-script local interfaces and `src/shared/types.ts`). Nothing is ever copied or adapted from customer exports.
- Only invented values are allowed: `example.com` family hosts, RFC-5737 IPs (`192.0.2.x`, `198.51.100.x`, `203.0.113.x`), all-zeros UUIDs, `syn-` prefixed public IDs, and `user@example.com` style emails.
- Check names stay at 25 characters or fewer.
- The fixture-integrity denylist test is a backstop, not the defense; synthetic authorship is the defense. A denylist hit means fix the fixture, never loosen the pattern.

### Determinism rules

- No network, no wall-clock, no randomness anywhere in the suite.
- Tests that touch `DD_TAGS_*` environment variables save and restore them in before/after hooks.
- The suite must pass twice in a row with identical results.

### Terminology rule (tool tests vs Checkly checks)

"Tool tests" are this repo's own tests: the `tool-tests/` directory, the `.test.ts` suffix, and the `test:tool*` npm scripts. They are distinct from Checkly checks, which are also called tests: the generated `*.check.ts` constructs, the generated Playwright `*.spec.ts` files, the `npx checkly test` command, and the generated project's `test:public` / `test:private` scripts. The `.spec.ts` suffix is reserved for generated Playwright specs and is never used by tool tests. There is intentionally no plain `npm test` script; keeping it undefined keeps the two meanings of "test" unambiguous.

### Golden harness (one-time refactor safety net)

`npm run golden:capture` and `npm run golden:verify` drive `tool-tests/golden/capture-golden.ts`. The harness runs the pipeline against the committed fixture seed in an isolated temp directory and byte-compares the output tree after normalizing the timestamp keys documented in the harness constant `NORMALIZED_TIMESTAMP_KEYS`. It exists as a one-time safety net for the main-guard/export refactor. Ongoing tests use structural assertions on generator output, not golden snapshots.

### Validating changed generator output

When a change alters what the generators emit, run the pipeline, then run a test-only `npx checkly test` from inside the generated project (`checkly-migrated/<account-name>/`, via its `test:public` / `test:private` scripts). Deployment is never part of validation.