# Environment Variables Migration

Migrate Datadog global variables to Checkly environment variables.

## Quick Start

```bash
# 1. Export from Datadog (if not done)
npm run export

# 2. Convert variables to Checkly format
npm run convert:variables

# 3. Add Checkly credentials to .env
# CHECKLY_API_KEY=your_key
# CHECKLY_ACCOUNT_ID=your_account_id

# 4. Fill in secret values in secrets.json 
# migrated secrets do not contain original values

# 5. Run the import
cd checkly-migrated/variables
chmod +x create-variables.sh
./create-variables.sh
```

## Output Structure

```
checkly-migrated/
└── variables/
    ├── env-variables.json      # Non-secure vars (values included)
    ├── secrets.json            # Secure vars (values empty - fill manually)
    ├── create-variables.sh     # Script to create vars via API
    └── delete-variables.sh     # Script to delete vars via API
```

## JSON Format

Both files use a clean format ready for the Checkly API:

```json
[
  {
    "key": "API_BASE_URL",
    "value": "https://api.example.com",
    "locked": false
  }
]
```

## Attribute Mapping

| Datadog | Checkly |
|---------|---------|
| `name` | `key` |
| `value.value` | `value` |
| `value.secure: true` | `locked: true` |
| `value.secure: false` | `locked: false` |

## Handling Secrets

Datadog **does not export secret values**. The `secrets.json` file contains empty values:

```json
[
  {
    "key": "API_SECRET_KEY",
    "value": "",        // ← Fill this in manually
    "locked": true
  }
]
```

You must retrieve these from your secure storage before importing.

## Import to Checkly

### Step 1: Add Checkly Credentials

Add to your `.env` file:

```bash
CHECKLY_API_KEY=your_checkly_api_key_here
CHECKLY_ACCOUNT_ID=your_checkly_account_id_here
```

Get these from [Checkly Settings](https://app.checklyhq.com/settings/account/api-keys).

### Step 2: Fill in Secret Values

Edit `checkly-migrated/variables/secrets.json` and add the actual values for each secret.

### Step 3: Run the Create Script

```bash
cd checkly-migrated/variables
chmod +x create-variables.sh
./create-variables.sh
```

The script:
- Loads credentials from `.env`
- Creates non-secure variables from `env-variables.json`
- Creates secrets from `secrets.json` (skips empty values)

## Delete Variables

To remove all variables (for cleanup or re-import):

```bash
./delete-variables.sh
```

Prompts for confirmation before deleting.

## API Reference

The scripts use the Checkly API:

| Action | Endpoint |
|--------|----------|
| Create | `POST https://api.checklyhq.com/v1/variables` |
| Delete | `DELETE https://api.checklyhq.com/v1/variables/{key}` |

See [Checkly API Docs](https://developers.checklyhq.com/reference/postv1variables) for details.

## Requirements

- `jq` must be installed (for JSON parsing in shell scripts)
- Checkly API key with write permissions

## Security Notes

- The `variables/` directory should be gitignored (contains sensitive data)
- Secret values must be obtained from your secure storage
- Never commit actual secret values to version control

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run convert:variables` | Convert Datadog global variables to Checkly format |
