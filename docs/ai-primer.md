# AI Operational Primer: Datadog→Checkly Migration

This is the primer an AI assistant loads to help someone **run** a migration or **contribute** to this tool. It is the runbook and the mechanism, not the architecture (that's `CLAUDE.md`) and not the cheat-sheet (`AGENTS.md`). Don't re-derive the pipeline; reference it.

You are the user's first-line support. Solve what you can from this primer. When the mechanism is genuinely unclear or a check won't translate, point the user to the [Checkly docs](https://www.checklyhq.com/docs/) and suggest opening an issue on the repo or contacting Checkly support rather than guessing.

## How to use this primer: two modes

**Mode A: help a user run a migration.** They have a Datadog Synthetics account and want a deployable Checkly project out the other side. Drive them through credentials → run → read the report → deploy → enable groups. Section "Run a migration" plus the troubleshooting tree are your working set.

**Mode B: help a user contribute a change.** They're editing the tool itself: a generator, a mapping, a shared module. Your job is to keep their change inside the invariants in "Contributing via AI" so the pipeline stays internally consistent. There is no test suite; you validate by running the pipeline and `npx checkly test`.

Decide the mode from what they're touching: output under `checkly-migrated/<your-account-name>/` is Mode A; `src/` is Mode B.

## Pipeline mental model

A one-way ETL: it reads Datadog Synthetics over the Datadog API and writes a self-contained Checkly CLI **TypeScript constructs** project to `checkly-migrated/<your-account-name>/`. No long-running service: every step is a numbered script in `src/` run in sequence, each reading the previous step's JSON from `exports/` and writing its own. The architecture and the full step DAG live in `CLAUDE.md`; the end-to-end guide is the root `README.md`. Point users there instead of re-explaining.

Two things to hold in your head before you touch anything:

- **Two project layers, don't confuse them.** The root repo is the migration *tool*: its `package.json` scripts orchestrate the conversion and run from the repo root. `checkly-migrated/<your-account-name>/` is the generated *output*: a fully self-contained Checkly project with its own `package.json`, `checkly*.config.ts`, `README.md`, and `variables/`. It's git-ignored and meant to be copied out and deployed. `checkly-migrated-sample/` is a checked-in reference for what that output should look like.
- **Safe by default.** Generated check groups deploy `activated: false`, and individual checks preserve Datadog's paused/failing state. So deploying never starts runs or alerts; the user enables groups deliberately when they're ready. Never advise flipping `activated` to `true` in code; the group toggle in the Checkly UI is go-live.

## Run a migration (happy path)

The whole thing is `npm run migrate:all`, run from the repo root. It runs every stage in order: export → filter-multi → migrate:api → migrate:multi → migrate:browser → convert:variables → generate:groups → add:defaults → check:status → check:secrets → generate:report. Before you point a user at it, get three things right.

**1. Credentials (`.env` at the repo root).**

```bash
cp .env.example .env
```

Fill in:

```bash
DD_API_KEY=<your-datadog-api-key>
DD_APP_KEY=<your-datadog-app-key>
```

The **App Key needs four scopes**: `synthetics_read`, `monitors_read`, `synthetics_global_variable_read`, `synthetics_private_location_read`. A missing scope is the usual cause of an empty or partial export, and the error is rarely loud, so check the scopes before anything else.

Set `DD_SITE` to match the user's Datadog region; a wrong region also yields an empty or partial export because you're hitting the wrong API host:

| Region | DD_SITE |
|---|---|
| US1 (default) | datadoghq.com |
| US3 | us3.datadoghq.com |
| US5 | us5.datadoghq.com |
| EU1 | datadoghq.eu |
| AP1 | ap1.datadoghq.com |
| US1-FED | ddog-gov.com |

Two optional levers worth knowing early: `DD_TAGS_TO_MIGRATE` (comma-separated, OR logic, case-insensitive) scopes the export to tests matching at least one tag; this is the multi-team lever, and unset means export everything. `CHECKLY_ACCOUNT_NAME` sets the output dir name; if unset, the first step prompts once and caches the answer in `.account-name` so later steps don't re-prompt.

**2. Run it.**

```bash
npm run migrate:all
```

Individual stages exist (`npm run export`, `npm run migrate:api`, `npm run migrate:browser`, etc., see `package.json`). Re-running a later stage in isolation works as long as the JSON it depends on already exists in `exports/`. There is **no build step**: TypeScript runs directly via `jiti`, each script as `node --import jiti/register src/NN-name.ts`. If a user reaches for `npm run build`, it doesn't exist, and isn't missing.

**3. Read the report first.**

```bash
cat checkly-migrated/<your-account-name>/migration-report.md
```

`migration-report.md` drives everything downstream. It lists what converted versus what was skipped and why, which checks were deactivated and for what reason, the exact private-location slugs to create (and how many checks depend on each), the secret variables needing values, the env vars checks reference, and any mTLS checks with their required cert files. Don't deploy before reading it.

**4. Deploy, from the account dir.** The exact runbook lives in the generated project's own `README.md`; the spine is: create private locations in the Checkly UI using the exact slugs from the report and deploy an agent for each (public checks don't need this) → fill `variables/secrets.json` → `npm run create-variables` → `npm run test:public` then `npm run test:private` (dry runs) → `npm run deploy:public` then `npm run deploy:private` → `npm run update-mapping` to backfill Checkly UUIDs.

**5. Enable the groups: go-live.** Deploy and go-live are separate decisions. Every migrated check can be deployed with zero monitors running. The user flips the two groups (**"Datadog Migrated Public Checks"** and **"Datadog Migrated Private Checks"**) to activated in the Checkly UI when they're ready. That's the final kill switch and the go-live moment. No change window, no operational risk until then.

Budget the user's review time honestly: API/TCP/DNS checks are essentially review-and-deploy; **browser and multi-step checks are where the time goes** (locator translation and inter-step variable extraction, respectively).

## Troubleshooting decision tree

Symptom → cause → fix. Start at the symptom the user reports.

| Symptom | Cause | Fix |
|---|---|---|
| Export is empty or partial | Missing `DD_API_KEY`/`DD_APP_KEY`, or App Key missing a scope | Confirm all four App Key scopes: `synthetics_read`, `monitors_read`, `synthetics_global_variable_read`, `synthetics_private_location_read`. Re-run `npm run export`. |
| Export is empty or partial, creds look right | `DD_SITE` doesn't match the account's region | Set `DD_SITE` from the region table (e.g. `datadoghq.eu` for EU1). Re-run `npm run export`. |
| Private checks won't run | Private locations not created in Checkly, or the Checkly Agent isn't running | Create each private location in the Checkly UI (Settings → Private Locations) using the **exact slugs** from `migration-report.md`, then deploy an agent for each. Public checks deploy and run without this. |
| Checks deployed deactivated, tagged `missingSecretsFromDatadog` | They reference a secret whose value is empty. Datadog never exports secret *values*, so `variables/secrets.json` comes out empty; step 10b deactivates anything referencing it | Set the value in `variables/secrets.json`, run `npm run create-variables`, then remove the tag and set `activated: true` on the affected checks. |
| Browser check fails on a selector | Datadog's multiLocator didn't translate cleanly (locator priority is ID → data-testid → name → `getByText` → CSS class → XPath) | Fix the Playwright spec under `tests/browser/` directly, then re-run `npm run test:public`/`test:private`. If a locator genuinely won't translate, flag it for the user to raise with Checkly support. |
| A multi-step test is missing entirely | It contains a TCP/DNS/ICMP step inside the flow; Playwright has no equivalent, so the **whole test is skipped** | Confirmed in the spec folder's `_manifest.json` (`skipped` array, `incompatibleSubtypes`). Standalone TCP/DNS synthetics still migrate separately via steps 04b/04c. Rebuild the flow manually if it's needed. |
| Multi-step check passes locally but data doesn't carry between steps | Variable extraction between steps may need a manual edit | Adjust the extraction in the spec under `tests/multi/`, then re-run the dry run. |
| DNS check has a `WARNING` comment | A `recordEvery matches` assertion was **downgraded** to a "some record matches" check; Checkly's DNS assertion can't express "every record matches" | Review the generated file; tighten the assertion by hand if the stricter semantics matter. Only A records migrate. |
| Check tagged `requiresClientCertificate`, deactivated | The test uses an mTLS client certificate (`config.request.certificate`) | The generated file carries a `WARNING` comment listing the required key/cert filenames. Supply the certs, then re-activate. |
| Pipeline keeps re-prompting for an account name, or output lands in the wrong dir | `CHECKLY_ACCOUNT_NAME` unset and the `.account-name` cache is stale or missing | Set `CHECKLY_ACCOUNT_NAME`, or delete/correct the `.account-name` file. Every step resolves the output dir from there; never hardcode it. |
| `ERR_MODULE_NOT_FOUND` / import resolution error in `src/` | Relative import missing the `.ts` extension | This repo is ESM (`"type": "module"`, `NodeNext`). Relative imports must include `.ts` (e.g. `import { x } from './shared/utils.ts'`). |
| "Where's the build?" | There isn't one | No build step. Scripts run through `jiti`. The `outDir`/`dist` in `tsconfig.json` is unused; `npm run build` is not defined and not needed. |

A few advanced assertion types may need a manual follow-up after the dry run; your AI assistant and the Checkly docs can help you close those.

## "Why was this check skipped or deactivated?"

Answer from the two sources of truth: **the check's tags** and **`migration-report.md`**. Don't speculate; every skip/deactivation reason is recorded in one or both. The traceability tags are appended *after* user tag filtering, so a user's `DD_TAGS_EXCLUDE`/`DD_TAGS_REMAP` rules can never strip them.

| Tag | Meaning |
|---|---|
| `migration_check_id:<datadog_public_id>` | On every generated check (e.g. `migration_check_id:cpt-vgi-fiz`). The traceable Datadog↔Checkly link, visible in the Checkly UI and Prometheus metrics, and what `npm run update-mapping` matches on. |
| `failingInDatadog` | The Datadog monitor was in Alert state when `DD_CHECK_STATUS=true`; check set `activated: false` by step 10a. |
| `noDataInDatadog` | Same as above, for No Data state. |
| `missingSecretsFromDatadog` | References a secret with no value; deactivated by step 10b. Set the value, remove the tag, re-activate. |
| `requiresClientCertificate` | Uses an mTLS client certificate; deactivated, with a `WARNING` comment listing the cert files. |
| `priority:P<n>` (P1–P5) | Preserved from Datadog's `monitor_priority`. |

If the check is missing rather than deactivated, it's a skip; look in the relevant spec folder's `_manifest.json` and the "skipped" section of the report.

## Checkly-capability verification guardrail

Before you tell a user "Checkly can't do X," verify against **live Checkly docs** (checklyhq.com, the Context7 MCP, or the Checkly skill) for the pinned CLI version (`checkly` devDependency in `package.json`). Several in-repo code comments and the `migration_readmes/` *understate* what Checkly supports, and parroting them sends users to a manual workaround they don't need.

The canonical example: Checkly's `AssertionBuilder` **does support regex**, via the property/regex argument, both on a response body (`AssertionBuilder.textBody()`) and on a header (`AssertionBuilder.headers('strict-transport-security', 'max-age=(\d+)').greaterThan(100000)`). A code comment may imply otherwise; it's wrong. Likewise, `MultiStepCheck` covers advanced flows beyond what a single-step mapping suggests. When a capability is genuinely unclear after checking live docs, point the user to the Checkly docs or Checkly support rather than guessing.

## Contributing via AI

When helping someone change the tool, hold the change inside these invariants. Breaking one silently corrupts the generated project.

- **ESM + `.ts` import specifiers.** `"type": "module"`, `NodeNext`. Every relative import includes the `.ts` extension. Imports run through `jiti`, not `tsc`.
- **No build step.** Don't add one or assume one. Run scripts as `node --import jiti/register src/NN-name.ts` (via their npm wrappers).
- **Keep the public/private generator paths in sync.** The public/private split is structural: a test using *any* private location is routed to `private/` folders and `checkly.private.config.ts`; public-only tests go to `public/`. Most generators branch on this. Edit one branch, edit the other.
- **Preserve safe-by-default.** Groups stay `activated: false`; checks keep Datadog's paused/failing state. Don't "helpfully" activate anything.
- **Tags appended after `filterAndRemapTags`.** Traceability tags (`migration_check_id`, `requiresClientCertificate`, etc.) are added *after* user tag filtering so filters can't strip them. Keep that ordering.
- **Resolve paths from `output-config.ts`.** Account name comes from `CHECKLY_ACCOUNT_NAME` → `.account-name` cache → interactive prompt. Never hardcode the account dir.
- **Update the matching `migration_readmes/` when behavior changes.** Per-type docs (`migration_api.md`, `migration_tcp.md`, `migration_dns.md`, `migration_multi.md`, `migration_browser.md`, `migration_env.md`) are part of the change, not an afterthought.
- **Two project layers stay separate.** Don't leak tool concerns into the generated output or vice versa.
- **Validate by running it.** No test suite, linter, or formatter. Run the affected stage (or `npm run migrate:all`), inspect `checkly-migrated/<your-account-name>/`, and run `npx checkly test` from inside the generated project. Compare against `checkly-migrated-sample/` for shape.

The shared primitives most changes touch live in `src/shared/`: `utils.ts` (`convertFrequency`, `filterAndRemapTags`, `convertConfigVariables`, `detectBodyType`, `priorityTag`, slug/identifier sanitizers), `types.ts` (Datadog API shapes + the `TransformedTest` shape with locations pre-split), and `variable-tracker.ts` (scans `{{ VAR }}` and `${process.env.VAR}` usage for the report).

## Hard guardrails

- **Never emit or commit a real secret, token, or key.** Placeholders only: `<your-datadog-api-key>`, `<your-account-name>`. `variables/secrets.json` ships empty by design; the user fills it after migration.
- **Never advise activating a check or group in code.** Go-live is a deliberate UI action by a human.
- **Verify Checkly capabilities against live docs** before calling something unsupported.
- **Escalate when stuck.** If a check won't translate or a capability is genuinely unclear, point the user to the Checkly docs and suggest opening an issue or contacting Checkly support rather than guessing.
