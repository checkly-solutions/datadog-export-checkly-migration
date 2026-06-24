# Using an AI Assistant to Run and Troubleshoot Migrations

An AI coding assistant (Claude Code, Codex, or similar) is the first-line way to run this tool, diagnose what went wrong, and contribute fixes back. This page tells you how to point one at the repo and gives you prompts that work on day one.

## Why the assistant is first-line

The assistant has the same context you do. It reads `CLAUDE.md`, `AGENTS.md`, and `docs/ai-primer.md`, so it knows the pipeline order, the env vars, and the safe-by-default rules. It can run the numbered scripts in `src/`, read the JSON they write to `checkly-migrated/<your-account-name>/exports/`, and read `migration-report.md` back to you with the reasoning attached. For the common cases (a scoped run, an empty export, a check that came out deactivated, a browser locator that needs a hand), that loop is faster than waiting on a human. Reach for the Checkly docs, a GitHub issue, or Checkly support only when the assistant hits a real wall, not before.

## Setup

Open this repo in your assistant and point it at the three files that make up the operating manual:

- `CLAUDE.md`: what the tool is, the pipeline architecture, and the conventions that bite if missed.
- `AGENTS.md`: the same guidance, surfaced for assistants that read it by convention.
- `docs/ai-primer.md`: the runbook with pipeline stages, env vars, and the deploy sequence in order.

Once it has loaded those, the assistant knows the strict script order and won't, for example, try to run a later stage before the JSON it depends on exists.

## Prompt library

Copy-paste these. They're grounded in this tool's actual scripts, env vars, and output. Adjust the placeholders and go.

### Run a scoped migration for one team

```
Set DD_TAGS_TO_MIGRATE to "team:payments" in .env, then run `npm run migrate:all`.
DD_TAGS_TO_MIGRATE is comma-separated OR logic, case-insensitive, only tests
matching at least one tag are exported. When it finishes, read
checkly-migrated/<your-account-name>/migration-report.md and tell me what
converted, what was skipped, and which private locations I need to create.
```

`DD_TAGS_TO_MIGRATE` is the multi-team scoping lever: unset exports everything, set narrows the run to one team's tests.

### Diagnose an empty or partial export

```
`npm run export` produced an empty or partial api-tests.json. Check my App Key
scopes and DD_SITE. The DD_APP_KEY needs all four scopes: synthetics_read,
monitors_read, synthetics_global_variable_read, synthetics_private_location_read.
DD_SITE must match my Datadog region. Walk me through verifying both.
```

A missing App Key scope is the usual cause of an empty export. The other common cause is a `DD_SITE` that doesn't match your region; the assistant has the region table from the primer.

### Explain why a check was skipped or deactivated

```
Open checkly-migrated/<your-account-name>/migration-report.md and the .check.ts
file for <check name>. Tell me why it's deactivated or skipped. Check its tags:
failingInDatadog, noDataInDatadog, missingSecretsFromDatadog, requiresClientCertificate.
Explain what I do next for each.
```

Deactivation is always tagged and always explained in the report. A `missingSecretsFromDatadog` check, for instance, deploys deactivated because Datadog never exports secret *values*. You set the value in Checkly, remove the tag, and set `activated: true`.

### Fix a browser locator that didn't translate

```
The browser check <name> has a locator that didn't survive the migration. Open
its spec under tests/browser/ in checkly-migrated/<your-account-name>/, find the
failing locator, and fix it. Datadog's multiLocator priority is ID → data-testid →
name → text → CSS class → XPath. Pick the most stable selector and update the spec.
Then run `npm run test:public` to confirm.
```

Browser locators from Datadog's multiLocator are a primary review-time driver; budget your review time here, not on API/TCP/DNS checks.

### Wire up multi-step variable extraction between steps

```
The multi-step check <name> passes a value from one step to the next and the
extraction didn't translate cleanly. Open its spec under tests/multi/ in
checkly-migrated/<your-account-name>/, show me where step N produces the value
and step N+1 consumes it, and fix the extraction. Steps map to request.get/post,
assertions to expect(), and allowFailure to expect.soft(). Run `npm run test:public`
to confirm.
```

Variable extraction between steps is the other primary review-time driver. The request and assertion mapping is mechanical; the hand-off between steps is where you'll edit.

### Open a PR back to the tool

```
I want to contribute a fix to the migration tool. Branch off main, make the change
in src/, and open a PR. The shared conversion primitives live in src/shared/
(utils.ts, types.ts, output-config.ts, variable-tracker.ts). Remember: ESM with
.ts import specifiers, no build step (scripts run via jiti), and the public/private
split is structural so keep both paths in sync.
```

There's no build step, test suite, or linter. Validation is running the pipeline and inspecting the output, then `npx checkly test` from inside the generated project. The assistant knows this from the operating manual; have it validate by running, not by assuming.

## Guardrails

- **Never paste a real secret, API key, or token into a prompt.** Use placeholders: `<your-datadog-api-key>`, `<your-account-name>`. The assistant doesn't need the real value to reason about scopes or wiring, and prompts shouldn't carry credentials.
- **Make the assistant verify Checkly capabilities against live docs before it concludes anything is unsupported.** Several in-repo code comments understate what Checkly actually does: its `AssertionBuilder` supports regex (via the property argument on body and headers), and `MultiStepCheck` covers advanced API flows. Tell the assistant to check the live Checkly docs (checklyhq.com or the Checkly skill) for the pinned CLI version rather than parroting a code comment. A few advanced assertion types may need a manual follow-up; the [Checkly docs](https://www.checklyhq.com/docs/) cover the assertion API.
- **Don't let it flip `activated` to true in code.** Groups deploy paused on purpose; enabling them is a deliberate UI action, and that's the safety model. The assistant should respect it.

## When you get stuck

The assistant is the fast path for the cases above. When it hits a genuine wall (a locator that won't translate no matter how it's rewritten, a mapping the tool doesn't handle yet), check the [Checkly docs](https://www.checklyhq.com/docs/), then open an issue on the repo or reach out to Checkly support with the report and the failing file in hand. Narrowing it down first gets you a faster answer.