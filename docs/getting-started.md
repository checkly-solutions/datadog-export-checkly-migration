# How the Tool Works & What Migrates

This tool is a one-way ETL pipeline. It reads your Datadog Synthetic monitors through the Datadog API and writes a self-contained Checkly CLI TypeScript-constructs project to `checkly-migrated/<your-account-name>/`. It is not a live sync — it runs, produces a project, and stops. Re-run it any time; each run regenerates the output.

## Two project layers — name the trap before it bites you

There are two `package.json` files, and confusing them is the most common early mistake:

- **The root repo (this directory)** is the migration *tool*. Its npm scripts orchestrate the conversion and always run from here.
- **`checkly-migrated/<your-account-name>/`** is the generated *output* — a fully self-contained Checkly CLI project with its own `package.json`, `checkly*.config.ts`, `README.md`, and `variables/`. It is git-ignored and meant to be copied out and deployed. `checkly-migrated-sample/` is a checked-in example of exactly what this output looks like.

Pipeline scripts (`migrate:all`, `export`, etc.) run from the root. Deploy scripts (`test:public`, `deploy:public`, `create-variables`, etc.) run from inside the account dir. When a command "doesn't exist," you're almost always in the wrong layer.

## Safe by default: deploy is not go-live

Generated check **groups** are created `activated: false`, with the exact names **"Datadog Migrated Public Checks"** and **"Datadog Migrated Private Checks"**. Nothing runs until a human toggles a group to activated in the Checkly UI. That's the design: deploying never starts runs or alerts. You can push every migrated check today with zero monitors running, then enable groups deliberately when you're ready. Individual checks also preserve Datadog's paused/failing state. Enabling a group in the UI is the go-live moment and the final kill switch — never flip `activated` to `true` in code.

## Built-in traceability

Every generated check carries a `migration_check_id:<datadog_public_id>` tag (for example `migration_check_id:cpt-vgi-fiz`). That tag is the durable Datadog↔Checkly link — it's visible in the Checkly UI and Prometheus metrics, and `npm run update-mapping` uses it to backfill Checkly UUIDs after deploy. The tag is appended *after* any user tag filtering, so your exclude/remap rules can't strip it. After every migration, `migration-report.md` plus a small set of explanatory tags account for every outcome — what converted, what didn't, and why.

## What it is not

- Not a live service. There's nothing long-running to operate.
- No build step — TypeScript runs directly via `jiti`; `npm run build` does not exist.
- No test suite, linter, or formatter — validation is running the pipeline and inspecting the output, then `npx checkly test` from inside the generated project.

## What migrates

API, TCP, and DNS checks are essentially review-and-deploy. Budget your review time for **browser** and **multi-step** checks — that's where the manual follow-up lives. Per-type detail lives in `migration_readmes/` (`migration_api.md`, `migration_tcp.md`, `migration_dns.md`, `migration_multi.md`, `migration_browser.md`, `migration_env.md`); link to those rather than re-deriving them here.

| Source | Converts cleanly | Needs review | Doesn't migrate (today) |
|---|---|---|---|
| **API tests** | → `ApiCheck`, full support | `OPTIONS`-method requests aren't converted by the tool yet — re-add them by hand on the generated `ApiCheck` | — |
| **Browser tests** | → `BrowserCheck` + Playwright `.spec.ts` | Locators/selectors from Datadog's multiLocator may need review — a primary review-time driver | — |
| **Multi-step API tests** | → `MultiStepCheck` + Playwright `.spec.ts` | Variable extraction between steps may need manual edits — the other primary review-time driver | A multi-step test containing TCP/DNS/ICMP steps is skipped entirely and recorded in the spec folder's `_manifest.json` |
| **TCP tests** (`subtype: tcp`) | → `TcpMonitor` (step 04b) | — | — |
| **DNS tests** (`subtype: dns`) | → `DnsMonitor` (step 04c), A records | `recordEvery matches` is downgraded to a "some record matches" check, emitted with a WARNING comment | Non-A record types; `request.timeout` is dropped |
| **Global variables** | Non-secret → `variables/env-variables.json` (with values) | Secret → `variables/secrets.json` with values **empty** — Datadog never exports secret values; you fill them in before deploy | — |
| **Locations** | Public stay in `locations` | Private (`pl:*`) → `privateLocations`; any test using a private location is routed to `private/` and `checkly.private.config.ts` | Private locations must be created in Checkly first |
| **Tags** | → tags (filterable via `DD_TAGS_*`) | — | — |
| **SSL / ICMP tests** | — | — | No Checkly equivalent yet |

A few advanced assertion types may need a manual follow-up — your AI assistant and Checkly can help close those.

Browser and multi-step are where the review time goes. If a locator didn't translate or a variable extraction came out wrong, that's our line — send it over.

---

# Run & Deploy

## Prerequisites

- Node >= 18.0.0.
- No build step. Every entry point is a numbered script in `src/` run in sequence via `jiti`.

## Credentials

Copy the example env file and fill it in with your real values:

```bash
cp .env.example .env
```

Datadog:

- `DD_API_KEY` — your Datadog API key, e.g. `DD_API_KEY=<your-datadog-api-key>`.
- `DD_APP_KEY` — your Datadog App Key. It needs **four scopes**: `synthetics_read`, `monitors_read`, `synthetics_global_variable_read`, `synthetics_private_location_read`. A missing scope is the usual cause of an empty export.
- `DD_SITE` — optional, defaults to `datadoghq.com`. Match it to your Datadog region:

  | Region | DD_SITE |
  |---|---|
  | US1 (default) | datadoghq.com |
  | US3 | us3.datadoghq.com |
  | US5 | us5.datadoghq.com |
  | EU1 | datadoghq.eu |
  | AP1 | ap1.datadoghq.com |
  | US1-FED | ddog-gov.com |

Checkly:

- `CHECKLY_API_KEY` and `CHECKLY_ACCOUNT_ID` — required for variable import and for the Checkly CLI test/deploy.
- `CHECKLY_ACCOUNT_NAME` — sets the output dir name (`checkly-migrated/<your-account-name>/`). If unset, you're prompted once and the value is cached in `.account-name` so later steps don't re-prompt.

Optional scoping levers: `DD_TAGS_TO_MIGRATE` (comma-separated, OR logic) exports only tests matching at least one tag — this is the multi-team scoping lever. `DD_TAGS_EXCLUDE`, `DD_TAGS_EXCLUDE_ALL=true`, and `DD_TAGS_REMAP=old->new` clean up tags during generation. `DD_CHECK_STATUS=true` queries Datadog monitor status so checks already in Alert / No Data deploy deactivated. `CHECKLY_TCP_PROJECT_NAME` / `CHECKLY_DNS_PROJECT_NAME` split TCP/DNS monitors into a separate standalone project instead of inlining them.

If the export comes back empty, check the App Key scopes first — that's the line we field most often.

## Run the migration

```bash
npm install
npm run migrate:all
```

`migrate:all` runs the full pipeline in order: export → filter-multi → migrate:api → migrate:multi → migrate:browser → convert:variables → generate:groups → add:defaults → check:status → check:secrets → generate:report. Each step writes JSON into `checkly-migrated/<your-account-name>/exports/` and later steps read it, so you can re-run any one step in isolation as long as its input JSON already exists.

## Read the report first

```bash
cat checkly-migrated/<your-account-name>/migration-report.md
```

Read it before doing anything else — it drives the rest of the runbook. It lists what converted versus what was skipped and why, which checks were deactivated (failing in Datadog, No Data, or referencing an empty secret) and why, the private locations you need to create (exact slugs and how many checks depend on each), the secret variables that need values, the env vars your checks reference, and any mTLS checks with the cert files they require. A handful of explanatory tags back this up: `failingInDatadog`, `noDataInDatadog`, `missingSecretsFromDatadog`, `requiresClientCertificate`, `datadogBasicAuthWeb`, and `priority:P<n>` (preserved from Datadog `monitor_priority`).

## Deploy runbook

Run these from the account dir, `checkly-migrated/<your-account-name>/`, in this order:

1. **Create private locations** in the Checkly UI (Settings → Private Locations) using the exact slugs from the report, and deploy the Checkly Agent for each. Public checks deploy and run without this.
2. **Fill in `variables/secrets.json`** — Datadog didn't export secret values, so these come out empty. Checks referencing an empty secret deploy deactivated and tagged `missingSecretsFromDatadog`; set the value, remove the tag, and re-activate.
3. **Push variables:**

   ```bash
   npm run create-variables
   ```

   Needs `CHECKLY_API_KEY` + `CHECKLY_ACCOUNT_ID`. Use `npm run delete-variables` to undo.

4. *(Optional)* configure alert channels in `default_resources/alertChannels.ts` — the default is a placeholder email channel; supported types are Email, Slack, Webhook, Opsgenie, PagerDuty, and MS Teams.
5. **Authenticate the Checkly CLI:**

   ```bash
   npm install -g checkly
   npx checkly login
   ```

   Or rely on the `CHECKLY_API_KEY` + `CHECKLY_ACCOUNT_ID` env vars.

6. **Dry-run the checks:**

   ```bash
   npm run test:public
   npm run test:private
   ```

   `test:private` needs your private locations created and agents running. This is where you fix browser locators (in `tests/browser/`), multi-step variable extraction (in `tests/multi/`), and any incorrect secret values.

7. **Deploy:**

   ```bash
   npm run deploy:public
   npm run deploy:private
   ```

   Both deploy with groups still paused — nothing runs yet.

8. **Backfill the mapping:**

   ```bash
   npm run update-mapping
   ```

   Fills the `checkly_uuid` column in `migration-mapping.csv` by matching the `migration_check_id` tag.

9. **Enable the two groups in the Checkly UI when ready.** This is go-live, and your final kill switch.
10. **Monitor for a few days,** review the `failingInDatadog` / `noDataInDatadog` checks, decommission the corresponding Datadog monitors, and rotate any API keys you used.

Browser locators and multi-step variable extraction are the two places review time concentrates. If something didn't translate, send it over — that's our line, and your AI assistant is the first stop. Escalation order: AI assistant → quick-reference → your Checkly contact.
