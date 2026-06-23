# AGENTS.md

Operating manual for AI coding assistants (Claude Code, Codex, and friends) working in this repo. Read this first, then defer to the linked docs for depth. Don't re-derive what's already written down.

## Orientation

This repo is a one-way ETL tool: it reads Datadog Synthetic monitors via the Datadog API and writes a self-contained Checkly CLI **TypeScript constructs** project to `checkly-migrated/<your-account-name>/`. There is no long-running service — every entry point is a numbered script in `src/` run in sequence.

Your prime directive: help users **run** migrations, **troubleshoot** them, and **contribute back** to this tool. This tool ships with Checkly's support behind it — when you hit a real product limit, say so and point the user at their Checkly contact instead of inventing a workaround.

## Command cheat-sheet

Root pipeline — run from the repo root. `migrate:all` runs every stage below in order.

| Script | Stage | Does |
|---|---|---|
| `npm run migrate:all` | full | export → filter-multi → migrate:api → migrate:multi → migrate:browser → convert:variables → generate:groups → add:defaults → check:status → check:secrets → generate:report |
| `npm run export` | 01 | Datadog API → `checkly-migrated/<your-account-name>/exports/*.json` |
| `npm run filter-multi` | 03 | split multi-step tests out of `api-tests.json` |
| `npm run migrate:api` | 02+04+04b+04c | API → `ApiCheck`, TCP → `TcpMonitor`, DNS → `DnsMonitor` |
| `npm run migrate:multi` | 05+06 | multi-step → Playwright `.spec.ts` + `MultiStepCheck` |
| `npm run migrate:browser` | 07+08 | browser → Playwright `.spec.ts` + `BrowserCheck` |
| `npm run convert:variables` | 09 | global variables → `variables/{env-variables,secrets}.json` |
| `npm run generate:groups` | 11 | check group constructs |
| `npm run add:defaults` | 10 | account project shell (configs, package.json, README, alertChannels.ts, update-mapping.ts) |
| `npm run check:status` | 10a | deactivate tests failing in Datadog (needs `DD_CHECK_STATUS=true`) |
| `npm run check:secrets` | 10b | deactivate checks referencing empty secrets |
| `npm run generate:report` | 12 | `migration-report.{md,json}` + `migration-mapping.csv` |

Re-running a later stage in isolation works as long as the JSON it depends on already exists in `exports/`.

Generated-project commands — run from the account dir, `checkly-migrated/<your-account-name>/`, not the repo root:

| Script | Does |
|---|---|
| `npm run test:public` | `npx checkly test --config=./checkly.public.config.ts --record` (dry run public checks) |
| `npm run test:private` | same with `checkly.private.config.ts` (needs private locations + agents running) |
| `npm run deploy:public` | `npx checkly deploy --config=./checkly.public.config.ts --force` |
| `npm run deploy:private` | same with the private config |
| `npm run create-variables` | push `env-variables.json` + `secrets.json` to Checkly (needs `CHECKLY_API_KEY` + `CHECKLY_ACCOUNT_ID`) |
| `npm run update-mapping` | after deploy, backfill the `checkly_uuid` column in `migration-mapping.csv` by matching the `migration_check_id` tag |

## Operating invariants for safe edits

These are the rules that break the migration's safety guarantees if you miss them. Honor them on every edit.

- **ESM + `.ts` import specifiers.** `package.json` has `"type": "module"`, tsconfig is `NodeNext`. Relative imports must carry the `.ts` extension: `import { x } from './shared/utils.ts'`.
- **No build step.** TypeScript runs directly via `jiti` (`node --import jiti/register src/NN-name.ts`). There is no `tsc` pass and no `npm run build` — don't add one or assume one ran.
- **Keep the public/private paths in sync.** A test using *any* private location is routed to `private/` folders and `checkly.private.config.ts`; public-only tests go to `public/`. Most generators branch on private locations — when you edit one branch, edit the other.
- **Safe-by-default `activated: false`.** Generated groups are created deactivated; individual checks preserve Datadog's paused/failing state. This is what lets a customer deploy with zero monitors running and go live deliberately. Never "helpfully" flip `activated` to `true` in generated code.
- **Traceability tags are appended AFTER `filterAndRemapTags`.** `migration_check_id:<datadog_public_id>` and the other system tags are added after user tag filtering, so a user's exclude/remap rules can't strip them. Keep that ordering — moving the append before the filter would let `DD_TAGS_EXCLUDE` delete the Datadog↔Checkly link.
- **Two project layers, don't confuse them.** The repo root is the migration *tool* (its `package.json` orchestrates the conversion). `checkly-migrated/<your-account-name>/` is the generated *output* — a self-contained Checkly project with its own `package.json` and configs, git-ignored, meant to be handed to a customer. `checkly-migrated-sample/` is a checked-in example of that output; use it as a reference for what generated files should look like.
- **No test suite, linter, or formatter.** `npm test` is not defined. Validate a change by running the pipeline and inspecting `checkly-migrated/<your-account-name>/`, then running `npx checkly test` from inside the generated project.

## Source of truth

Every check carries tags, and `migration-report.md` explains what happened to it. If a check is deactivated, mistagged, or missing, read the tags (`migration_check_id`, `failingInDatadog`, `noDataInDatadog`, `missingSecretsFromDatadog`, `requiresClientCertificate`) and the report before theorizing — they already record the why.

## Guardrails

- **Verify Checkly capabilities against live docs before saying "unsupported."** Several in-repo code comments and `migration_readmes/` understate what Checkly actually does. Before telling a user a Datadog feature can't migrate, confirm against live Checkly docs (checklyhq.com, the Context7 MCP, or the Checkly skill) for the pinned CLI version. Concrete reality check: `AssertionBuilder` supports regex via the property argument on `textBody()` and `headers()`, and `MultiStepCheck` covers advanced flows. A few advanced assertion types may still need a manual follow-up — your AI assistant and Checkly can help; that's the right framing, not a flat "not supported."
- **Never emit real secrets or tokens.** Use placeholders only — `<your-datadog-api-key>`, `<your-account-name>`. Datadog never exports secret *values*, so `secrets.json` comes out empty by design; that's expected, not a bug to fix.

## Doc map

| Doc | Read it for |
|---|---|
| `CLAUDE.md` | architecture deep-dive: pipeline stages, JSON handoffs, shared modules |
| `docs/ai-primer.md` | troubleshooting decision tree + the contributing runbook |
| `README.md` | the authoritative end-to-end human guide (credentials, deploy steps, caveats) |
| `migration_readmes/` | per-type deep dives (`migration_api.md`, `migration_tcp.md`, `migration_dns.md`, `migration_multi.md`, `migration_browser.md`, `migration_env.md`) |