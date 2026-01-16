# Datadog to Checkly Migration Tool

Export and convert Datadog Synthetic tests to Checkly monitoring checks.

## What This Tool Does

This tool automates the migration of Datadog synthetics to Checkly:

| Datadog | Checkly | Guide |
|---------|---------|-------|
| API Tests (single-step) | `ApiCheck` | [migration_api.md](migration_readmes/migration_api.md) |
| API Tests (multi-step) | `MultiStepCheck` | [migration_multi.md](migration_readmes/migration_multi.md) |
| Browser Tests | `BrowserCheck` | [migration_browser.md](migration_readmes/migration_browser.md) |
| Global Variables | Environment Variables | [migration_env.md](migration_readmes/migration_env.md) |

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Credentials

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```bash
# Datadog (required for export)
DD_API_KEY=your_datadog_api_key
DD_APP_KEY=your_datadog_application_key
DD_SITE=datadoghq.com  # or your region

# Checkly (required for create:variables / delete:variables)
CHECKLY_API_KEY=your_checkly_api_key
CHECKLY_ACCOUNT_ID=your_checkly_account_id
```

### 3. Export from Datadog

```bash
npm run export
```

### 4. Run Migrations

**Option A: Run everything at once**

```bash
npm run migrate:all
```

This runs all migration steps in order: export → filter-multi → migrate:api → migrate:multi → migrate:browser → convert:variables → add:defaults

**Option B: Run individual steps**

```bash
# Migrate API checks
npm run filter-multi
npm run migrate:api

# Migrate multi-step checks
npm run migrate:multi

# Migrate browser checks
npm run migrate:browser

# Convert environment variables (generates JSON + TypeScript API scripts)
npm run convert:variables

# Create variables in Checkly via API (requires CHECKLY_API_KEY)
npm run create:variables
```

> **Note:** Scripts handle missing input files gracefully. If you don't have browser tests, `migrate:browser` will skip instead of failing.

### 5. Configure Default Resources (Optional)

Edit `default_resources/alertChannels.ts` to customize alert channels:

```typescript
import { EmailAlertChannel, SlackAlertChannel } from "checkly/constructs";

export const emailChannel = new EmailAlertChannel("email-channel-1", {
  address: "alerts@acme.com",
});

export const slackChannel = new SlackAlertChannel("slack-channel-1", {
  url: "https://hooks.slack.com/services/xxx/yyy/zzz",
});

// Add all channels to this array
export const alertChannels = [emailChannel, slackChannel];
```

### 6. Add Default Resources to Checks

```bash
npm run add:defaults
```

This adds alert channels and groups to all generated checks.

### 7. Test and Deploy to Checkly

The project uses separate config files for public and private checks:

| Config | Purpose | Command |
|--------|---------|---------|
| `checkly.public.config.ts` | Public location checks only | `npx checkly test --config checkly.public.config.ts` |
| `checkly.private.config.ts` | Private location checks only | `npx checkly test --config checkly.private.config.ts` |

```bash
# Test public checks
npx checkly test --config checkly.public.config.ts

# Test private checks (requires private locations configured in your account)
npx checkly test --config checkly.private.config.ts

# Deploy public checks
npx checkly deploy --config checkly.public.config.ts

# Deploy private checks
npx checkly deploy --config checkly.private.config.ts
```

**Why separate configs?** The Checkly CLI validates all checks during parsing before applying tag filters. Private checks reference private locations that must exist in your account. Using separate configs prevents validation errors when testing only public checks.

## Output Structure

All generated files are separated by location type (public vs private):

```
checkly-migrated/
├── __checks__/
│   ├── api/{public,private}/      # ApiCheck constructs
│   ├── multi/{public,private}/    # MultiStepCheck constructs
│   └── browser/{public,private}/  # BrowserCheck constructs
├── tests/
│   ├── multi/{public,private}/    # Playwright specs for multi-step
│   └── browser/{public,private}/  # Playwright specs for browser
└── variables/
    ├── env-variables.json         # Non-secure variables with values
    ├── secrets.json               # Secure variables (fill in values manually)
    ├── create-variables.ts        # Script to create vars via Checkly API
    └── delete-variables.ts        # Script to delete vars via Checkly API
```

## Default Resources

The `default_resources/` folder contains shared configurations applied to all checks:

```
default_resources/
├── alertChannels.ts    # Alert channel definitions
└── group.check.ts      # Check group definitions
```

### Alert Channels

Edit `default_resources/alertChannels.ts` to configure alert channels:

```typescript
// Add your alert channels and include them in the array
export const alertChannels = [emailChannel, slackChannel];
```

Supported channel types:
- `EmailAlertChannel`
- `SlackAlertChannel`
- `WebhookAlertChannel`
- `OpsgenieAlertChannel`
- `PagerdutyAlertChannel`
- `MSTeamsAlertChannel`

### Check Groups

Groups in `default_resources/group.check.ts` organize checks by location type:
- `public_locations_group` - Checks using Checkly's public locations
- `private_locations_group` - Checks using private locations

## Datadog API Setup

### Required Permissions

Create an Application Key with these scopes:
- `synthetics_read`
- `synthetics_global_variable_read`
- `synthetics_private_location_read`

### Datadog Regions

| Region | Site Value |
|--------|------------|
| US1 (default) | `datadoghq.com` |
| US3 | `us3.datadoghq.com` |
| US5 | `us5.datadoghq.com` |
| EU1 | `datadoghq.eu` |
| AP1 | `ap1.datadoghq.com` |
| US1-FED | `ddog-gov.com` |

## NPM Scripts Reference

| Script | Description |
|--------|-------------|
| `npm run migrate:all` | **Run full migration pipeline** (export through add:defaults) |
| `npm run export` | Export all synthetics from Datadog |
| `npm run filter-multi` | Separate multi-step from single-step API tests |
| `npm run migrate:api` | Convert single-step API tests to ApiCheck |
| `npm run migrate:multi` | Convert multi-step tests to MultiStepCheck |
| `npm run migrate:browser` | Convert browser tests to BrowserCheck |
| `npm run convert:variables` | Convert global variables to Checkly format |
| `npm run create:variables` | Create variables in Checkly via API + append to .env |
| `npm run delete:variables` | Delete variables from Checkly via API + remove from .env |
| `npm run add:defaults` | Add alert channels and groups to all checks |

## Export Output

After `npm run export`:

```
exports/
├── api-tests.json          # All API tests
├── browser-tests.json      # All browser tests
├── global-variables.json   # All global variables
├── private-locations.json  # Private location configs
└── export-summary.json     # Summary counts
```

## Private Locations

Tests using Datadog private locations (`pl:*`) are placed in `private/` folders. After migration:

1. Create `PrivateLocation` constructs in Checkly
2. Map Datadog location IDs to Checkly slugs
3. Update generated files if needed

## Troubleshooting

### "Private location not found" errors when testing

If you see an error like `ApiCheck 'xxx' is using a private-location not found in your account`, you're likely running checks that reference private locations not configured in your Checkly account.

**Solution:** Use the appropriate config file:
```bash
# For public checks only
npx checkly test --config checkly.public.config.ts

# For private checks (requires private locations in your account)
npx checkly test --config checkly.private.config.ts
```

### "403 Forbidden" errors

Your Application Key is missing required scopes. Create a new key with the scopes listed above.

### "404 Not Found" errors

Wrong Datadog region. Update `DD_SITE` in your `.env` file.

### Empty exports

Verify synthetics exist in Datadog under **UX Monitoring** → **Synthetic Tests**.

## Security Notes

- Never commit `.env` to version control
- `exports/` and `checkly-migrated/` are gitignored
- Secret values are not exported from Datadog (fill in `secrets.json` manually)
- Rotate Datadog and Checkly API keys after migration
- The `create:variables` script appends variables to your local `.env` file

## Documentation

- [API Check Migration](migration_readmes/migration_api.md)
- [Multi-Step Check Migration](migration_readmes/migration_multi.md)
- [Browser Check Migration](migration_readmes/migration_browser.md)
- [Environment Variables Migration](migration_readmes/migration_env.md)

## License

MIT
