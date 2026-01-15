# Datadog to Checkly Migration Tool

Export and convert Datadog Synthetic tests to Checkly monitoring checks.

## What This Tool Does

This tool automates the migration of Datadog synthetics to Checkly:

| Datadog | Checkly | Guide |
|---------|---------|-------|
| API Tests (single-step) | `ApiCheck` | [migration_api.md](docs/migration_api.md) |
| API Tests (multi-step) | `MultiStepCheck` | [migration_multi.md](docs/migration_multi.md) |
| Browser Tests | `BrowserCheck` | [migration_browser.md](docs/migration_browser.md) |
| Global Variables | Environment Variables | [migration_env.md](docs/migration_env.md) |

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Datadog Credentials

```bash
cp .env.example .env
```

Edit `.env` with your Datadog API credentials:

```bash
DD_API_KEY=your_api_key
DD_APP_KEY=your_application_key
DD_SITE=datadoghq.com  # or your region
```

### 3. Export from Datadog

```bash
npm run export
```

### 4. Run Migrations

```bash
# Migrate API checks
npm run filter-multi
npm run migrate:api

# Migrate multi-step checks
npm run migrate:multi

# Migrate browser checks
npm run migrate:browser

# Migrate environment variables
npm run convert:variables
```

### 5. Deploy to Checkly

```bash
npx checkly test
npx checkly deploy
```

## Output Structure

All generated files are separated by location type (public vs private):

```
checkly-migrated/
├── __checks__/
│   ├── api/{public,private}/
│   ├── multi/{public,private}/
│   └── browser/{public,private}/
├── tests/
│   ├── multi/{public,private}/
│   └── browser/{public,private}/
└── variables/
```

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
| `npm run export` | Export all synthetics from Datadog |
| `npm run filter-multi` | Separate multi-step from single-step API tests |
| `npm run migrate:api` | Convert single-step API tests to ApiCheck |
| `npm run migrate:multi` | Convert multi-step tests to MultiStepCheck |
| `npm run migrate:browser` | Convert browser tests to BrowserCheck |
| `npm run convert:variables` | Convert global variables to Checkly format |

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

### "403 Forbidden" errors

Your Application Key is missing required scopes. Create a new key with the scopes listed above.

### "404 Not Found" errors

Wrong Datadog region. Update `DD_SITE` in your `.env` file.

### Empty exports

Verify synthetics exist in Datadog under **UX Monitoring** → **Synthetic Tests**.

## Security Notes

- Never commit `.env` to version control
- `exports/` and `checkly-migrated/` are gitignored
- Secret values are not exported from Datadog (fill manually)
- Rotate API keys after migration

## Documentation

- [API Check Migration](docs/migration_api.md)
- [Multi-Step Check Migration](docs/migration_multi.md)
- [Browser Check Migration](docs/migration_browser.md)
- [Environment Variables Migration](docs/migration_env.md)

## License

MIT
