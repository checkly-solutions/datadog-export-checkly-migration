# Datadog to Checkly Migration Tool

Export your Datadog Synthetic tests, global variables, and private locations for migration to Checkly.

## Prerequisites

- Node.js 18 or higher
- A Datadog account with API access
- API and Application keys with the required permissions

## Step 1: Create Datadog API Credentials

You'll need both an **API Key** and an **Application Key** from your Datadog account.

### Create an API Key

1. Log in to your Datadog account
2. Navigate to **Organization Settings** → **API Keys**
   - Direct link: `https://app.datadoghq.com/organization-settings/api-keys`
3. Click **+ New Key**
4. Give it a name (e.g., "Checkly Migration")
5. Copy the key value

### Create an Application Key

1. Navigate to **Organization Settings** → **Application Keys**
   - Direct link: `https://app.datadoghq.com/organization-settings/application-keys`
2. Click **+ New Key**
3. Give it a name (e.g., "Checkly Migration")
4. **Important:** Configure the following scopes:
   - `synthetics_read`
   - `synthetics_global_variable_read`
   - `synthetics_private_location_read`
5. Copy the key value

## Step 2: Determine Your Datadog Region

Datadog operates multiple regional sites. Use the site that matches where your account was created:

| Region | Site Value | API Endpoint |
|--------|------------|--------------|
| US1 (default) | `datadoghq.com` | api.datadoghq.com |
| US3 | `us3.datadoghq.com` | api.us3.datadoghq.com |
| US5 | `us5.datadoghq.com` | api.us5.datadoghq.com |
| EU1 | `datadoghq.eu` | api.datadoghq.eu |
| AP1 | `ap1.datadoghq.com` | api.ap1.datadoghq.com |
| US1-FED | `ddog-gov.com` | api.ddog-gov.com |

You can identify your region by looking at the URL when logged into Datadog (e.g., `app.datadoghq.eu` means EU1).

## Step 3: Configure Environment Variables

1. Copy the example environment file:

```bash
cp .env.example .env
```

2. Edit `.env` with your credentials:

```bash
# Required
DD_API_KEY=your_api_key_here
DD_APP_KEY=your_application_key_here

# Optional - defaults to US1 if not specified
DD_SITE=datadoghq.com
```

## Step 4: Run the Export

```bash
npm run export
```

The tool will connect to the Datadog API and export all your resources.

## Output Files

After a successful export, you'll find the following files in the `exports/` directory:

| File | Description |
|------|-------------|
| `api-tests.json` | All API synthetic tests with full configurations |
| `browser-tests.json` | All Browser synthetic tests with full configurations |
| `global-variables.json` | All global/environment variables |
| `private-locations.json` | All private location configurations |
| `export-summary.json` | Summary with counts of all exported resources |

### Example Output Structure

```
exports/
├── api-tests.json
├── browser-tests.json
├── global-variables.json
├── private-locations.json
└── export-summary.json
```

## Troubleshooting

### "Missing required environment variables"

Ensure both `DD_API_KEY` and `DD_APP_KEY` are set in your `.env` file.

### "403 Forbidden" errors

Your Application Key is missing required scopes. Create a new Application Key with the scopes listed in Step 1.

### "404 Not Found" errors

You may be using the wrong Datadog site. Check your region in Step 2 and update `DD_SITE` accordingly.

### Empty exports

Verify that your Datadog account has synthetic tests configured. You can check this in the Datadog UI under **UX Monitoring** → **Synthetic Tests**.

## Next Steps

Once you have your exported data, you can proceed with the migration to Checkly:

1. **API Tests** → Convert to Checkly API Checks
2. **Browser Tests** → Convert to Playwright tests, then create Checkly Browser Checks
3. **Global Variables** → Create corresponding environment variables in Checkly

## Security Notes

- Never commit your `.env` file to version control
- The `exports/` directory is gitignored by default
- Rotate your Datadog API keys after migration is complete
- Exported global variables may contain sensitive values - handle with care
