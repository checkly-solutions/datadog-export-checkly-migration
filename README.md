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

### Optional Settings

```bash
DD_CHECK_STATUS=true  # Check Datadog test status and deactivate failing tests
CHECKLY_ACCOUNT_NAME=acme  # Account name for output directory
```

When `DD_CHECK_STATUS` is enabled, the migration pipeline queries Datadog for current monitor statuses and deactivates checks that are already failing. See [Failing Test Deactivation](#failing-test-deactivation) below.

`CHECKLY_ACCOUNT_NAME` sets the output directory name. Output goes to `checkly-migrated/<account-name>/`. If not set, you'll be prompted at runtime.

### Checkly Credentials (Required for variable import)

```bash
CHECKLY_API_KEY=your_checkly_api_key
CHECKLY_ACCOUNT_ID=your_checkly_account_id
```

- API Key: https://app.checklyhq.com/settings/account/api-keys
- Account ID: https://app.checklyhq.com/settings/account/general

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

- **TCP/DNS/SSL/ICMP tests** - No Checkly equivalent
- **OPTIONS HTTP method** - Not supported
- **JavaScript assertions** - Must be manually converted to Playwright

See `checkly-migrated/<account-name>/migration-report.md` for a full breakdown of your specific migration.

## After Migration: What To Do Next

All commands below run from the account directory:

```bash
cd checkly-migrated/<account-name>
```

### 1. Review the Migration Report

```bash
cat migration-report.md
```

This tells you what was converted, what was skipped, and lists action items specific to your migration.

### 2. Create Private Locations (if applicable)

If your Datadog monitors use private locations, you must create them in Checkly **before testing or deploying**. The migration report lists the exact slugs to use.

In Checkly: Settings > Private Locations > Create with the exact slug from the report.

### 3. Fill in Secret Values

Datadog doesn't expose secret values via API. Edit and fill in:

```bash
variables/secrets.json
```

### 4. Import Variables to Checkly

```bash
npm run create-variables
```

### 5. Configure Alert Channels (optional)

Edit `default_resources/alertChannels.ts` to configure notifications.

### 6. Test

```bash
npm run test:public    # Test public location checks
npm run test:private   # Test private location checks
```

### 7. Deploy

```bash
npm run deploy:public   # Deploy public checks
npm run deploy:private  # Deploy private checks
```

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
│   ├── create-variables.ts         # API create script
│   └── delete-variables.ts         # API delete script
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

## Key Behaviors

### Check Activation

- **Check groups** are created with `activated: false` - checks won't run until you enable the group
- **Individual checks** preserve their Datadog status: paused monitors become `activated: false`

### Failing Test Deactivation

When `DD_CHECK_STATUS=true`, the migration pipeline queries Datadog for the current status of each test's monitor. Tests in `Alert` state are considered failing:

- The generated Checkly check is set to `activated: false`
- A `"failingInDatadog"` tag is added for easy filtering
- A comment is added to the check file explaining the override

This prevents migrating known-broken tests as active checks, which would trigger false alerts in Checkly.

### Location Separation

Tests are separated by location type:
- Tests using **any** private location → `private/` folders
- Tests using **only** public locations → `public/` folders

This allows you to deploy public checks immediately while setting up private locations.

### Re-running for a Different Account

Change the `CHECKLY_ACCOUNT_NAME` value in `.env` and run `npm run migrate:all` again.

## Detailed Guides

- [API Check Migration](migration_readmes/migration_api.md)
- [Multi-Step Check Migration](migration_readmes/migration_multi.md)
- [Browser Check Migration](migration_readmes/migration_browser.md)
- [Environment Variables](migration_readmes/migration_env.md)

## Security Notes

- Never commit `.env` to version control
- `checkly-migrated/` is gitignored
- Secret values are not exported from Datadog - fill in manually
- Rotate API keys after migration is complete

## License

MIT
