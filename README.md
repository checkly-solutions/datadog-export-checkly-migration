# Datadog to Checkly Migration Tool

Automated migration of Datadog Synthetic monitors to Checkly. Converts API, Browser, and Multi-step tests into deployment-ready Checkly TypeScript constructs.

## Quick Start

```bash
npm install
cp .env.example .env   # Edit with your credentials
npm run migrate:all
cat exports/migration-report.md   # Review what was migrated
```

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
```

When enabled, the migration pipeline queries Datadog for current monitor statuses and deactivates checks that are already failing. See [Failing Test Deactivation](#failing-test-deactivation) below.

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

See `exports/migration-report.md` for a full breakdown of your specific migration.

## After Migration: What To Do Next

### 1. Review the Migration Report

```bash
cat exports/migration-report.md
```

This tells you what was converted, what was skipped, and lists action items specific to your migration.

### 2. Create Private Locations (if applicable)

If your Datadog monitors use private locations, you must create them in Checkly **before testing or deploying**. The migration report lists the exact slugs to use.

In Checkly: Settings > Private Locations > Create with the exact slug from the report.

### 3. Fill in Secret Values

Datadog doesn't expose secret values via API. Edit and fill in:

```bash
checkly-migrated/variables/secrets.json
```

### 4. Import Variables to Checkly

```bash
npm run create:variables
```

### 5. Configure Alert Channels (optional)

Edit `checkly-migrated/default_resources/alertChannels.ts` to configure notifications.

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
checkly-migrated/
├── __checks__/
│   ├── api/{public,private}/      # ApiCheck constructs
│   ├── browser/{public,private}/  # BrowserCheck constructs
│   ├── multi/{public,private}/    # MultiStepCheck constructs
│   └── groups/{public,private}/   # Check groups
├── tests/
│   ├── browser/{public,private}/  # Playwright specs for browser tests
│   └── multi/{public,private}/    # Playwright specs for multi-step tests
├── variables/
│   ├── env-variables.json         # Non-secret variables (with values)
│   └── secrets.json               # Secret variables (fill in manually)
└── default_resources/
    └── alertChannels.ts           # Alert channel configuration

exports/
├── migration-report.md            # Human-readable summary + action items
├── migration-report.json          # Machine-readable report
└── variable-usage.json            # Which checks use which variables
```

## Key Behaviors

### Check Activation

- **Check groups** are created with `activated: false` - checks won't run until you enable the group
- **Individual checks** preserve their Datadog status: paused monitors become `activated: false`

### Failing Test Deactivation

When `DD_CHECK_STATUS=true`, the migration pipeline queries Datadog for the current status of each test's monitor. Tests in `Alert` state are considered failing:

- The generated Checkly check is set to `activated: false`
- A `"failingInDatadog"` tag is added for easy filtering
- A comment is added to the check file explaining the override

This prevents migrating known-broken tests as active checks, which would trigger false alerts in Checkly. Tests already `activated: false` (e.g., paused in Datadog) are left untouched. The step is one-directional — it only deactivates, never re-activates.

After migration, filter by the `failingInDatadog` tag to review these checks and re-activate them once the underlying issues are resolved.

### Location Separation

Tests are separated by location type:
- Tests using **any** private location → `private/` folders
- Tests using **only** public locations → `public/` folders

This allows you to deploy public checks immediately while setting up private locations.

## Troubleshooting

### "Private location not found" during test/deploy

Create the private locations in Checkly first. Use the exact slugs from `exports/migration-report.md`.

### Browser tests failing with locator errors

Element locators are auto-converted but may need adjustment. Review the Playwright specs in `checkly-migrated/tests/browser/`. Locator priority: `id` > `data-testid` > `name` > `text` > `class` > `xpath`

### Multi-step tests failing on variable extraction

Variable passing between steps may need manual adjustment. Check the specs in `checkly-migrated/tests/multi/`.

### "Variable not found" errors

1. Run `npm run create:variables`
2. Fill in secret values in `checkly-migrated/variables/secrets.json`
3. Verify variables exist in your Checkly account

### Checks not running after deploy

Check groups are created with `activated: false`. Enable the group in Checkly UI, or edit `checkly-migrated/__checks__/groups/*/group.check.ts` and set `activated: true` before deploying.

### 403 Forbidden from Datadog

Your App Key is missing required scopes. Create a new key with all required scopes.

### 404 Not Found from Datadog

Wrong region. Update `DD_SITE` in your `.env` file.

## NPM Scripts Reference

| Script | Description |
|--------|-------------|
| `npm run migrate:all` | Run full migration pipeline |
| `npm run export` | Export all synthetics from Datadog |
| `npm run migrate:api` | Convert API tests to ApiCheck |
| `npm run migrate:multi` | Convert multi-step tests to MultiStepCheck |
| `npm run migrate:browser` | Convert browser tests to BrowserCheck |
| `npm run convert:variables` | Convert variables to Checkly format |
| `npm run create:variables` | Import variables to Checkly via API |
| `npm run generate:groups` | Generate check group constructs |
| `npm run check:status` | Check Datadog test status and deactivate failing tests |
| `npm run generate:report` | Generate migration report |
| `npm run test:public` | Test public location checks |
| `npm run test:private` | Test private location checks |
| `npm run deploy:public` | Deploy public location checks |
| `npm run deploy:private` | Deploy private location checks |

## Security Notes

- Never commit `.env` to version control
- `exports/` and `checkly-migrated/` are gitignored
- Secret values are not exported from Datadog - fill in manually
- Rotate API keys after migration is complete

## License

MIT
