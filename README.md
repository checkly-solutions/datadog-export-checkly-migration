# Datadog to Checkly Migration Tool

Automated migration of Datadog Synthetic monitors to Checkly. Converts API, Browser, and Multi-step tests into deployment-ready Checkly TypeScript constructs.

## Quick Start

```bash
npm install
cp .env.example .env   # Edit with your credentials
npm run migrate:all     # Reads CHECKLY_ACCOUNT_NAME from .env, outputs a self-contained project
```

The pipeline reads `CHECKLY_ACCOUNT_NAME` from `.env` (e.g. `acme`) and writes all output to `checkly-migrated/<account-name>/` — a self-contained Checkly project directory. If the variable is not set, you'll be prompted.

## Configuration

### Datadog Credentials (Required)

```bash
DD_API_KEY=your_api_key_here
DD_APP_KEY=your_app_key_here
DD_SITE=datadoghq.com  # Optional, see regions below
```

- API Key: https://app.datadoghq.com/organization-settings/api-keys
- App Key: https://app.datadoghq.com/organization-settings/application-keys

**Required App Key scopes:** `synthetics_read`, `monitors_read`, `synthetics_global_variable_read`, `synthetics_private_location_read`

### Checkly Credentials (Required)

```bash
CHECKLY_API_KEY=your_checkly_api_key
CHECKLY_ACCOUNT_ID=your_checkly_account_id
```

- API Key: https://app.checklyhq.com/settings/account/api-keys
- Account ID: https://app.checklyhq.com/settings/account/general

The API key is used both for variable import and for the Checkly CLI (`test` and `deploy` commands).

### Optional Settings

```bash
DD_CHECK_STATUS=true        # Check Datadog test status and deactivate failing tests
CHECKLY_ACCOUNT_NAME=acme   # Account name for output directory
```

When `DD_CHECK_STATUS` is enabled, the migration pipeline queries Datadog for current monitor statuses and deactivates checks that are already failing. See [Failing Test Deactivation](#failing-test-deactivation) below.

`CHECKLY_ACCOUNT_NAME` sets the output directory name. Output goes to `checkly-migrated/<account-name>/`. If not set, you'll be prompted at runtime.

### Datadog Regions

| Region | DD_SITE value |
|--------|---------------|
| US1 (default) | `datadoghq.com` |
| US3 | `us3.datadoghq.com` |
| US5 | `us5.datadoghq.com` |
| EU1 | `datadoghq.eu` |
| AP1 | `ap1.datadoghq.com` |
| US1-FED | `ddog-gov.com` |

## What Gets Migrated

| Datadog | Checkly | Notes |
|---------|---------|-------|
| API Tests | ApiCheck | Full support |
| Browser Tests | BrowserCheck + Playwright | Locators may need review |
| Multi-step API Tests | MultiStepCheck + Playwright | Variable extraction may need adjustment |
| Global Variables | Environment Variables | Secrets require manual value entry |
| Locations | Public + Private | Private locations must be created in Checkly first |
| Paused monitors | `activated: false` | Preserves paused state |

### Not Migrated

- **TCP/DNS/SSL/ICMP tests** — No Checkly equivalent
- **OPTIONS HTTP method** — Not supported
- **JavaScript assertions** — Must be manually converted to Playwright

See `checkly-migrated/<account-name>/migration-report.md` for a full breakdown of your specific migration.

## After Migration: Deploying to Checkly

After running `npm run migrate:all`, follow these steps to get your checks running in Checkly.

All commands below run from the account directory:

```bash
cd checkly-migrated/<account-name>
```

### Step 1. Review the Migration Report

```bash
cat migration-report.md
```

This tells you:
- What converted successfully vs. what was skipped (and why)
- Which checks were deactivated due to failing or missing data in Datadog
- Private locations that need to be created
- Secret variables that need values filled in
- Environment variables referenced by checks

### Step 2. Create Private Locations in Checkly (if applicable)

If your Datadog monitors use private locations, you must create them in Checkly **before testing or deploying**. The migration report lists the exact slugs and how many checks depend on each one.

1. Go to [Checkly > Settings > Private Locations](https://app.checklyhq.com/settings/private-locations)
2. Click **New Private Location**
3. Use the **exact slug** from the migration report (e.g. `niq-aks-eastus2`)
4. Deploy the [Checkly Agent](https://www.checklyhq.com/docs/private-locations/) in your infrastructure for that location

Without this, private checks cannot run. You can still deploy and test public checks independently.

### Step 3. Fill in Secret Values

Datadog doesn't expose secret values via API. The migration exports the variable names but not their values:

```bash
# Edit this file and fill in each secret value
vi variables/secrets.json
```

You'll need to get the actual values from your team, secrets manager, or vault.

### Step 4. Import Environment Variables to Checkly

This pushes all environment variables and secrets to your Checkly account:

```bash
npm run create-variables
```

This requires `CHECKLY_API_KEY` and `CHECKLY_ACCOUNT_ID` to be set in the root `.env` file. To remove imported variables later, run `npm run delete-variables`.

### Step 5. Configure Alert Channels (optional)

Edit `default_resources/alertChannels.ts` to set up notifications. By default it creates a placeholder email channel:

```bash
vi default_resources/alertChannels.ts
```

Supported channel types: Email, Slack, Webhook, Opsgenie, PagerDuty, MS Teams. See the comments in the file for examples.

### Step 6. Install Checkly CLI

The account directory uses the Checkly CLI for testing and deployment. Install it if you haven't already:

```bash
npm install -g checkly
```

Authenticate with your Checkly account:

```bash
npx checkly login
```

Or set `CHECKLY_API_KEY` and `CHECKLY_ACCOUNT_ID` as environment variables (already in your root `.env`).

### Step 7. Test (dry run)

Run checks without deploying them. This executes each check once and shows pass/fail results:

```bash
# Test public checks first (no private location setup needed)
npm run test:public

# Test private checks (requires private locations + agents running)
npm run test:private
```

Review the results. Common issues to fix:
- **Browser checks**: Locators from Datadog may not match — update selectors in the Playwright spec files under `tests/browser/`
- **Multi-step checks**: Variable extraction between steps may need adjustment — review specs under `tests/multi/`
- **Environment variables**: Missing or incorrect values — check `variables/secrets.json`

### Step 8. Deploy to Checkly

Once tests are passing (or you're ready to deploy):

```bash
# Deploy public checks
npm run deploy:public

# Deploy private checks
npm run deploy:private
```

This creates all checks, groups, and alert channel subscriptions in your Checkly account.

### Step 9. Enable Check Groups

All checks deploy inside groups with `activated: false`. Nothing runs until you explicitly enable them:

1. Go to [Checkly > Groups](https://app.checklyhq.com/checks)
2. Find **"Datadog Migrated Public Checks"** and **"Datadog Migrated Private Checks"**
3. Toggle each group to **activated** when ready

This gives you a final kill switch before checks start running and generating alerts.

### Step 10. Verify and Clean Up

- Monitor checks in Checkly for a few days to confirm they're stable
- Review checks tagged `failingInDatadog` or `noDataInDatadog` — decide whether to fix, keep deactivated, or remove
- Once confident, decommission the corresponding Datadog Synthetic monitors
- Rotate any API keys used during the migration

## Output Structure

```
checkly-migrated/<account-name>/
├── __checks__/
│   ├── api/{public,private}/       # ApiCheck constructs
│   ├── browser/{public,private}/   # BrowserCheck constructs
│   ├── multi/{public,private}/     # MultiStepCheck constructs
│   └── groups/{public,private}/    # Check groups
├── tests/
│   ├── browser/{public,private}/   # Playwright specs for browser tests
│   └── multi/{public,private}/     # Playwright specs for multi-step tests
├── variables/
│   ├── env-variables.json          # Non-secret variables (with values)
│   ├── secrets.json                # Secret variables (fill in manually)
│   ├── create-variables.ts         # API script to create variables
│   └── delete-variables.ts         # API script to delete variables
├── exports/                        # Raw Datadog export data
├── default_resources/
│   └── alertChannels.ts            # Alert channel configuration
├── checkly.config.ts               # All checks config
├── checkly.private.config.ts       # Private checks config
├── checkly.public.config.ts        # Public checks config
├── package.json                    # Account project scripts
├── migration-report.json           # Machine-readable report
└── migration-report.md             # Human-readable report
```

## Pipeline Scripts

These scripts run from the **root** project directory (not the account directory):

| Script | Description |
|--------|-------------|
| `npm run migrate:all` | Run full migration pipeline |
| `npm run export` | Export all synthetics from Datadog |
| `npm run filter-multi` | Separate multi-step from single-step tests |
| `npm run migrate:api` | Convert API tests to ApiCheck |
| `npm run migrate:multi` | Convert multi-step tests to MultiStepCheck |
| `npm run migrate:browser` | Convert browser tests to BrowserCheck |
| `npm run convert:variables` | Convert variables to Checkly format |
| `npm run generate:groups` | Generate check group constructs |
| `npm run add:defaults` | Add alert channels, groups, tags, and generate project files |
| `npm run check:status` | Check Datadog test status and deactivate failing tests |
| `npm run generate:report` | Generate migration report |

These scripts run from the **account** directory (`checkly-migrated/<account-name>/`):

| Script | Description |
|--------|-------------|
| `npm run test:public` | Run public checks via Checkly CLI (dry run) |
| `npm run test:private` | Run private checks via Checkly CLI (dry run) |
| `npm run deploy:public` | Deploy public checks to Checkly |
| `npm run deploy:private` | Deploy private checks to Checkly |
| `npm run create-variables` | Import environment variables to Checkly |
| `npm run delete-variables` | Remove imported environment variables from Checkly |

## Key Behaviors

### Check Activation

- **Check groups** are created with `activated: false` — checks won't run until you enable the group in Checkly
- **Individual checks** preserve their Datadog status: paused monitors become `activated: false`
- This means deployment is safe — nothing runs or alerts until you explicitly enable the groups

### Failing Test Deactivation

When `DD_CHECK_STATUS=true`, the migration pipeline queries Datadog for the current status of each test's monitor. Tests in `Alert` or `No Data` state are deactivated:

- The generated Checkly check is set to `activated: false`
- A `"failingInDatadog"` or `"noDataInDatadog"` tag is added for easy filtering
- A comment is added to the check file explaining the override

This prevents migrating known-broken tests as active checks, which would trigger false alerts in Checkly.

### Location Separation

Tests are separated by location type:
- Tests using **any** private location → `private/` folders
- Tests using **only** public locations → `public/` folders

This allows you to deploy and test public checks immediately while setting up private locations separately.

### Re-running for a Different Account

Change the `CHECKLY_ACCOUNT_NAME` value in `.env` and run `npm run migrate:all` again. Each account gets its own directory under `checkly-migrated/`.

## Detailed Guides

- [API Check Migration](migration_readmes/migration_api.md)
- [Multi-Step Check Migration](migration_readmes/migration_multi.md)
- [Browser Check Migration](migration_readmes/migration_browser.md)
- [Environment Variables](migration_readmes/migration_env.md)

## Security Notes

- Never commit `.env` to version control
- `checkly-migrated/` is gitignored
- Secret values are not exported from Datadog — fill in manually
- Rotate API keys after migration is complete

## License

MIT
