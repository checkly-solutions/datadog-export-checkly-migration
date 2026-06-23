# Troubleshooting

Start with the AI assistant — it can read your tags, `migration-report.md`, and the generated specs alongside you and explain what happened in context. This table is the fast lookup for the failure modes you'll actually hit.

## Symptom → cause → fix

| Symptom | Likely cause | Fix |
|---|---|---|
| Empty or partial export | Missing scope on the Datadog **App Key**, or `DD_SITE` pointed at the wrong region | Add all four scopes — `synthetics_read`, `monitors_read`, `synthetics_global_variable_read`, `synthetics_private_location_read` — set `DD_SITE` to your region (e.g. `datadoghq.eu` for EU1), then re-run `npm run export`. |
| "Command not found" / paths don't resolve / you're editing files that get overwritten | The two project layers got crossed: the tool root vs the generated `checkly-migrated/<your-account-name>/` project | Run pipeline scripts (`npm run migrate:all`, `npm run export`, …) from the repo **root**. Run deploy scripts (`npm run test:public`, `npm run deploy:public`, `npm run create-variables`, …) from the **account dir**, `checkly-migrated/<your-account-name>/`. |
| Private checks won't run | The private location isn't created in Checkly yet, or its Checkly Agent isn't running | Create the private location using the exact slug listed in `migration-report.md` (Settings → Private Locations) and deploy the Agent for it. Public checks don't need this. |
| Deployed cleanly, but nothing is running | The check group is still `activated: false` — by design, so deploying never starts runs or alerts | Enable the group in the Checkly UI when you're ready. The groups are **"Datadog Migrated Public Checks"** and **"Datadog Migrated Private Checks"**; enabling them is go-live. |
| A browser check fails on a selector | Datadog's multiLocator didn't translate to a clean Playwright locator | Update the locator in the spec under `tests/browser/`, then re-run `npm run test:public`. |
| A multi-step check fails between steps | Variable extraction from one step to the next needs a manual adjustment | Edit the spec under `tests/multi/` to pass the value forward, then re-run the test. |
| Check deployed deactivated and tagged `missingSecretsFromDatadog` | It references a secret whose value is empty — Datadog never exports secret values | Fill the value in `variables/secrets.json` (or set it in Checkly), remove the `missingSecretsFromDatadog` tag, and set `activated: true`. |
| A whole multi-step test is missing from the output | It contained a non-HTTP step (tcp/dns/icmp); Playwright has no equivalent, so the test was skipped entirely | Check the spec folder's `_manifest.json` (`skipped` array) for the reason. Standalone TCP/DNS synthetics migrate separately via `npm run generate:tcp` / `npm run generate:dns`. |

A few advanced assertion types may need a manual follow-up — your AI assistant and Checkly can help you port those.

## Escalation order

AI assistant first → this table and `migration-report.md` → your Checkly contact. If a locator or a variable hand-off didn't translate cleanly, that's our line — send it over.
