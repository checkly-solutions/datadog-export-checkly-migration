/**
 * Adds default alert channels, groups, and location tags to all generated Checkly checks.
 *
 * This script:
 * 1. Updates all check files to import and use alertChannels
 * 2. Updates all check files to import and use the appropriate group (public/private)
 * 3. Adds "public" or "private" tag to each check's tags array
 *
 * Reads: checkly-migrated/__checks__/{api,multi,browser}/{public,private}/*.check.ts
 * Modifies: Same files in place
 *
 * Run this as the final step before deploying.
 */

import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { getOutputRoot, getAccountName } from './shared/output-config.ts';

let CHECKS_BASE = '';
const CHECK_TYPES = ['api', 'multi', 'browser'];
const LOCATION_TYPES = ['public', 'private'];

interface UpdateResult {
  skipped: boolean;
  reason?: string;
}

interface ProcessResult {
  processed: number;
  skipped: number;
  errors: number;
}

/**
 * Calculate relative path from check file to groups directory
 */
function getRelativePathToGroups(checkType: string, locationType: string): string {
  // From checkly-migrated/__checks__/{type}/{location}/*.check.ts
  // To checkly-migrated/__checks__/groups/{location}/
  // That's: ../../groups/{location}
  return `../../groups/${locationType}`;
}

/**
 * Calculate relative path from check file to default_resources
 */
function getRelativePathToDefaultResources(checkType: string, locationType: string): string {
  // From <outputRoot>/__checks__/{type}/{location}/*.check.ts
  // To <outputRoot>/default_resources/
  // That's: ../../../default_resources
  return '../../../default_resources';
}

/**
 * Get the appropriate group variable name based on location type
 */
function getGroupName(locationType: string): string {
  return locationType === 'private' ? 'private_locations_group' : 'public_locations_group';
}

/**
 * Update a single check file to include alertChannels and group
 */
async function updateCheckFile(filepath: string, checkType: string, locationType: string): Promise<UpdateResult> {
  const content = await readFile(filepath, 'utf-8');

  // Skip if already has alertChannels import (already processed)
  if (content.includes('alertChannels')) {
    return { skipped: true, reason: 'already has alertChannels' };
  }

  // Skip index files
  if (path.basename(filepath) === 'index.ts') {
    return { skipped: true, reason: 'index file' };
  }

  const relativePath = getRelativePathToDefaultResources(checkType, locationType);
  const groupName = getGroupName(locationType);

  // Build the new imports to add
  const alertChannelsImport = `import { alertChannels } from "${relativePath}/alertChannels";`;
  const groupsPath = getRelativePathToGroups(checkType, locationType);
  const groupImport = `import { ${groupName} } from "${groupsPath}/group.check";`;

  // Find the last import statement and add our imports after it
  // This regex handles both single-line and multi-line imports
  const importRegex = /^import\s+[\s\S]*?from\s+["'][^"']+["'];$/gm;
  let lastImportMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    lastImportMatch = match;
  }

  if (!lastImportMatch) {
    return { skipped: true, reason: 'no imports found' };
  }

  const insertPosition = lastImportMatch.index + lastImportMatch[0].length;

  // Insert new imports after the last import
  let newContent =
    content.slice(0, insertPosition) +
    '\n' + alertChannelsImport +
    '\n' + groupImport +
    content.slice(insertPosition);

  // Add the location type tag to the tags array
  // Match tags: ["tag1", "tag2"] or tags: []
  const tagsPattern = /tags:\s*\[([^\]]*)\]/;
  const tagsMatch = newContent.match(tagsPattern);

  if (tagsMatch) {
    const existingTags = tagsMatch[1].trim();
    let newTags: string;

    if (existingTags === '') {
      // Empty tags array: tags: []
      newTags = `tags: ["${locationType}"]`;
    } else {
      // Has existing tags: tags: ["tag1", "tag2"]
      newTags = `tags: [${existingTags}, "${locationType}"]`;
    }

    newContent = newContent.replace(tagsPattern, newTags);
  }

  // Now add alertChannels and group to the check configuration
  // Find the check constructor and add the properties before the closing });

  // Pattern to find the check definition - matches ApiCheck, BrowserCheck, MultiStepCheck
  const checkPatterns = [
    /new ApiCheck\("[^"]+",\s*\{/,
    /new BrowserCheck\("[^"]+",\s*\{/,
    /new MultiStepCheck\("[^"]+",\s*\{/,
  ];

  let checkFound = false;
  for (const pattern of checkPatterns) {
    if (pattern.test(newContent)) {
      checkFound = true;
      break;
    }
  }

  if (!checkFound) {
    return { skipped: true, reason: 'no check constructor found' };
  }

  // Find the closing }); of the check and insert alertChannels and group before it
  // We need to find the last }); in the file which closes the check constructor
  const closingPattern = /\}\);[\s]*$/;

  if (!closingPattern.test(newContent)) {
    return { skipped: true, reason: 'could not find closing pattern' };
  }

  // Insert alertChannels and group before the final });
  newContent = newContent.replace(
    closingPattern,
    `  alertChannels,\n  group: ${groupName},\n});`
  );

  await writeFile(filepath, newContent, 'utf-8');
  return { skipped: false };
}

/**
 * Process all check files in a directory
 */
async function processDirectory(checkType: string, locationType: string): Promise<ProcessResult> {
  const dirPath = path.join(CHECKS_BASE, checkType, locationType);

  if (!existsSync(dirPath)) {
    return { processed: 0, skipped: 0, errors: 0 };
  }

  const files = await readdir(dirPath);
  const checkFiles = files.filter(f => f.endsWith('.check.ts'));

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of checkFiles) {
    const filepath = path.join(dirPath, file);
    try {
      const result = await updateCheckFile(filepath, checkType, locationType);
      if (result.skipped) {
        skipped++;
      } else {
        processed++;
      }
    } catch (err) {
      console.error(`  Error processing ${file}: ${(err as Error).message}`);
      errors++;
    }
  }

  return { processed, skipped, errors };
}

/**
 * Main function
 */
async function main(): Promise<void> {
  const outputRoot = await getOutputRoot();
  CHECKS_BASE = `${outputRoot}/__checks__`;

  console.log('='.repeat(60));
  console.log('Add Default Resources to Checkly Checks');
  console.log('='.repeat(60));

  // Generate default_resources inside account directory
  const defaultResourcesDir = `${outputRoot}/default_resources`;
  if (!existsSync(defaultResourcesDir)) {
    await mkdir(defaultResourcesDir, { recursive: true });
  }
  const alertChannelsPath = path.join(defaultResourcesDir, 'alertChannels.ts');
  if (!existsSync(alertChannelsPath)) {
    const alertChannelsContent = `import { EmailAlertChannel } from "checkly/constructs";

/**
 * Default Alert Channels
 *
 * Add your alert channels here and include them in the alertChannels array below.
 * These will be applied to all checks when running the add:defaults step.
 *
 * Supported channel types:
 * - EmailAlertChannel
 * - SlackAlertChannel
 * - WebhookAlertChannel
 * - OpsgenieAlertChannel
 * - PagerdutyAlertChannel
 * - MSTeamsAlertChannel
 *
//  * Example:
//  *   import { SlackAlertChannel } from "checkly/constructs";
//  *   export const slackChannel = new SlackAlertChannel("slack-channel-1", {
//  *     url: "https://hooks.slack.com/services/xxx/yyy/zzz",
//  *   });
//  */

export const emailChannel = new EmailAlertChannel("email-channel-1", {
  address: "alerts@example.com",
});

// Add additional alert channels above and include them in this array
export const alertChannels = [emailChannel];
`;
    await writeFile(alertChannelsPath, alertChannelsContent, 'utf-8');
    console.log(`Generated: ${alertChannelsPath}`);
  } else {
    console.log(`Exists: ${alertChannelsPath} (not overwritten)`);
  }

  if (!existsSync(CHECKS_BASE)) {
    console.log(`\nSkipping: Checks directory not found: ${CHECKS_BASE}`);
    console.log('No checks to update. Run the migration scripts first if you have checks to migrate.');
    return;
  }

  let totalProcessed = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const checkType of CHECK_TYPES) {
    console.log(`\nProcessing ${checkType} checks...`);

    for (const locationType of LOCATION_TYPES) {
      const { processed, skipped, errors } = await processDirectory(checkType, locationType);

      if (processed > 0 || skipped > 0 || errors > 0) {
        console.log(`  ${locationType}: ${processed} updated, ${skipped} skipped, ${errors} errors`);
      }

      totalProcessed += processed;
      totalSkipped += skipped;
      totalErrors += errors;
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`  Checks updated: ${totalProcessed}`);
  console.log(`  Checks skipped: ${totalSkipped}`);
  console.log(`  Errors: ${totalErrors}`);

  console.log('\nDefault resources added:');
  console.log('  - alertChannels: imported from default_resources/alertChannels.ts');
  console.log('  - group: public_locations_group or private_locations_group');
  console.log('  - tags: added "public" or "private" tag to each check');

  // Generate checkly config files and package.json inside account directory
  const accountName = await getAccountName();
  await generateProjectFiles(outputRoot, accountName);

  console.log('\nTo customize alert channels:');
  console.log(`  1. Edit ${outputRoot}/default_resources/alertChannels.ts`);
  console.log('  2. Add new alert channel constructs');
  console.log('  3. Add them to the alertChannels array export');

  console.log('\nNext steps:');
  console.log(`  1. Review ${outputRoot}/default_resources/alertChannels.ts`);
  console.log(`  2. Review ${outputRoot}/__checks__/groups/{public,private}/group.check.ts`);
  console.log(`  3. cd ${outputRoot} && npx checkly test`);
  console.log(`  4. cd ${outputRoot} && npx checkly deploy`);

  console.log('\nDone!');
}

/**
 * Generate the update-mapping.ts script content for post-deploy UUID backfill.
 *
 * The generated script reads migration-mapping.csv, calls the Checkly API to list all
 * checks (paginated), matches each check's migration_check_id tag to the datadog_public_id
 * in the CSV, and writes the real Checkly UUID into the checkly_uuid column.
 */
function generateUpdateMappingScript(): string {
  return `/**
 * Backfills the checkly_uuid column in migration-mapping.csv after deploying to Checkly.
 *
 * Usage: npm run update-mapping
 *
 * Requires CHECKLY_API_KEY and CHECKLY_ACCOUNT_ID to be set (via .env or environment).
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import 'dotenv/config';

const CSV_FILE = './migration-mapping.csv';
const API_BASE = 'https://api.checklyhq.com/v1';
const PAGE_LIMIT = 100;

const CHECKLY_API_KEY = process.env.CHECKLY_API_KEY?.trim();
const CHECKLY_ACCOUNT_ID = process.env.CHECKLY_ACCOUNT_ID?.trim();

interface ChecklyCheckItem {
  id: string;
  name: string;
  tags: string[];
}

/**
 * Parse a CSV line respecting double-quoted fields (RFC 4180 subset).
 * Internal "" sequences are decoded back to ".
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      // Quoted field
      i++; // skip opening quote
      let value = '';
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++; // skip closing quote
          break;
        } else {
          value += line[i];
          i++;
        }
      }
      fields.push(value);
      if (line[i] === ',') i++; // skip comma
    } else {
      // Unquoted field
      const end = line.indexOf(',', i);
      if (end === -1) {
        fields.push(line.slice(i));
        break;
      } else {
        fields.push(line.slice(i, end));
        i = end + 1;
      }
    }
  }
  return fields;
}

/**
 * Fetch all checks from Checkly API with pagination.
 */
async function fetchAllChecks(): Promise<ChecklyCheckItem[]> {
  const allChecks: ChecklyCheckItem[] = [];
  let page = 1;

  while (true) {
    const url = \`\${API_BASE}/checks?limit=\${PAGE_LIMIT}&page=\${page}\`;
    const response = await fetch(url, {
      headers: {
        'Authorization': \`Bearer \${CHECKLY_API_KEY}\`,
        'X-Checkly-Account': CHECKLY_ACCOUNT_ID!,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(\`Checkly API error: HTTP \${response.status} \${response.statusText}\\n\${errorText}\`);
    }

    const items = await response.json() as ChecklyCheckItem[];
    allChecks.push(...items);

    if (items.length < PAGE_LIMIT) {
      break; // Last page
    }
    page++;
  }

  return allChecks;
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Update Migration Mapping — Backfill Checkly UUIDs');
  console.log('='.repeat(60));

  if (!CHECKLY_API_KEY) {
    console.error('Error: CHECKLY_API_KEY not set in .env file');
    process.exit(1);
  }

  if (!CHECKLY_ACCOUNT_ID) {
    console.error('Error: CHECKLY_ACCOUNT_ID not set in .env file');
    process.exit(1);
  }

  if (!existsSync(CSV_FILE)) {
    console.error(\`Error: \${CSV_FILE} not found. Run the migration pipeline first.\`);
    process.exit(1);
  }

  console.log('\\nFetching all checks from Checkly API...');
  const checks = await fetchAllChecks();
  console.log(\`  Found \${checks.length} checks in Checkly\`);

  // Build lookup: datadogPublicId -> checkly UUID
  const uuidByDdId = new Map<string, string>();
  for (const check of checks) {
    for (const tag of (check.tags || [])) {
      if (tag.startsWith('migration_check_id:')) {
        const ddId = tag.slice('migration_check_id:'.length);
        uuidByDdId.set(ddId, check.id);
        break;
      }
    }
  }
  console.log(\`  Matched \${uuidByDdId.size} checks via migration_check_id tags\`);

  // Read and parse CSV
  const rawCsv = await readFile(CSV_FILE, 'utf-8');
  const lines = rawCsv.split('\\n');

  if (lines.length < 2) {
    console.error('Error: CSV file appears empty or has no data rows.');
    process.exit(1);
  }

  const header = lines[0];
  const headerFields = parseCsvLine(header);
  const ddIdIdx = headerFields.indexOf('datadog_public_id');
  const uuidIdx = headerFields.indexOf('checkly_uuid');

  if (ddIdIdx === -1 || uuidIdx === -1) {
    console.error('Error: CSV missing expected columns (datadog_public_id, checkly_uuid).');
    process.exit(1);
  }

  let matched = 0;
  let total = 0;

  const updatedLines: string[] = [header];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      updatedLines.push(line);
      continue;
    }

    total++;
    const fields = parseCsvLine(line);
    const ddId = fields[ddIdIdx];

    if (uuidByDdId.has(ddId) && fields[uuidIdx] === 'FILL_AFTER_DEPLOY') {
      fields[uuidIdx] = uuidByDdId.get(ddId)!;
      matched++;
      // Reconstruct line (fields that contained commas/quotes were already unescaped by parseCsvLine;
      // re-escape them to maintain valid CSV)
      const escapedFields = fields.map(f => {
        if (f.includes(',') || f.includes('"') || f.includes('\\n')) {
          return \`"\${f.replace(/"/g, '""')}"\`;
        }
        return f;
      });
      updatedLines.push(escapedFields.join(','));
    } else {
      updatedLines.push(line);
    }
  }

  await writeFile(CSV_FILE, updatedLines.join('\\n'), 'utf-8');

  console.log(\`\\nDone! \${matched} of \${total} checks matched with Checkly UUIDs.\`);
  if (matched < total) {
    console.log(\`  \${total - matched} rows still show FILL_AFTER_DEPLOY — deploy those checks first.\`);
  }
  console.log(\`  Updated: \${CSV_FILE}\`);
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
`;
}

/**
 * Generate checkly config files and package.json inside the account directory
 */
async function generateProjectFiles(outputRoot: string, accountName: string): Promise<void> {
  console.log('\nGenerating project files...');

  // checkly.config.ts
  const checklyConfig = `import { defineConfig } from "checkly";

const config = defineConfig({
  projectName: \`${accountName} migrated checks\`,
  logicalId: \`${accountName}-migrated-checks\`,
  repoUrl: "",
  checks: {
    activated: true,
    muted: false,
    runtimeId: "2025.04",
    checkMatch: "__checks__/**/**/*.check.ts",
    ignoreDirectoriesMatch: [],
  },
  cli: {
    runLocation: "us-west-1",
  },
});

export default config;
`;
  await writeFile(path.join(outputRoot, 'checkly.config.ts'), checklyConfig, 'utf-8');
  console.log(`  Generated: ${outputRoot}/checkly.config.ts`);

  // checkly.private.config.ts
  const privateConfig = `import { defineConfig } from "checkly";

const config = defineConfig({
  projectName: \`${accountName} migrated checks - private\`,
  logicalId: \`${accountName}-migrated-checks-private\`,
  repoUrl: "",
  checks: {
    activated: true,
    muted: false,
    runtimeId: "2025.04",
    checkMatch: "__checks__/**/private/*.check.ts",
    ignoreDirectoriesMatch: [],
  },
  cli: {
    privateRunLocation: "some-private-location-slug"
  },
});

export default config;
`;
  await writeFile(path.join(outputRoot, 'checkly.private.config.ts'), privateConfig, 'utf-8');
  console.log(`  Generated: ${outputRoot}/checkly.private.config.ts`);

  // checkly.public.config.ts
  const publicConfig = `import { defineConfig } from "checkly";

const config = defineConfig({
  projectName: \`${accountName} migrated checks - public\`,
  logicalId: \`${accountName}-migrated-checks-public\`,
  repoUrl: "",
  checks: {
    activated: true,
    muted: false,
    runtimeId: "2025.04",
    checkMatch: "__checks__/**/public/*.check.ts",
    ignoreDirectoriesMatch: [],
  },
  cli: {
    runLocation: "us-west-1",
  },
});

export default config;
`;
  await writeFile(path.join(outputRoot, 'checkly.public.config.ts'), publicConfig, 'utf-8');
  console.log(`  Generated: ${outputRoot}/checkly.public.config.ts`);

  // package.json
  const packageJson = {
    name: `checkly-${accountName}`,
    private: true,
    scripts: {
      "test:private": "npx checkly test --config=./checkly.private.config.ts --record",
      "test:public": "npx checkly test --config=./checkly.public.config.ts --record",
      "deploy:private": "npx checkly deploy --config=./checkly.private.config.ts --force",
      "deploy:public": "npx checkly deploy --config=./checkly.public.config.ts --force",
      "create-variables": "ts-node variables/create-variables.ts",
      "delete-variables": "ts-node variables/delete-variables.ts",
      "update-mapping": "ts-node update-mapping.ts",
    },
    devDependencies: {
      "checkly": "^7.11.0",
      "ts-node": "^10.9.2",
      "typescript": "^5.9.3",
    },
  };
  await writeFile(path.join(outputRoot, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n', 'utf-8');
  console.log(`  Generated: ${outputRoot}/package.json`);

  // README.md
  await generateReadme(outputRoot, accountName);
  console.log(`  Generated: ${outputRoot}/README.md`);

  // update-mapping.ts — post-deploy UUID backfill script
  const updateMappingScript = generateUpdateMappingScript();
  await writeFile(path.join(outputRoot, 'update-mapping.ts'), updateMappingScript, 'utf-8');
  console.log(`  Generated: ${outputRoot}/update-mapping.ts`);
}

/**
 * Generate a customer-facing README.md inside the account directory
 */
async function generateReadme(outputRoot: string, accountName: string): Promise<void> {
  const readme = `# ${accountName} — Checkly Monitoring Project

This directory contains a **Checkly-as-code** project migrated from Datadog Synthetic monitors. It is a self-contained project that you can deploy directly to your Checkly account.

## Prerequisites

- **Node.js** v18 or later
- **Checkly CLI** — installed globally (\`npm install -g checkly\`) or used via \`npx\`
- **Checkly account** — [sign up](https://app.checklyhq.com/) if you don't have one
- **Checkly API Key** — [create one](https://app.checklyhq.com/settings/account/api-keys)
- **Checkly Account ID** — found at [Settings > General](https://app.checklyhq.com/settings/account/general)

## Directory Structure

\`\`\`
├── __checks__/
│   ├── api/{public,private}/       # API check constructs
│   ├── browser/{public,private}/   # Browser check constructs
│   ├── multi/{public,private}/     # Multi-step check constructs
│   └── groups/{public,private}/    # Check group definitions
├── tests/
│   ├── browser/{public,private}/   # Playwright specs for browser checks
│   └── multi/{public,private}/     # Playwright specs for multi-step checks
├── variables/
│   ├── env-variables.json          # Non-secret variables (with values)
│   ├── secrets.json                # Secret variables (fill in manually)
│   ├── create-variables.ts         # Script to push variables to Checkly
│   └── delete-variables.ts         # Script to remove variables from Checkly
├── default_resources/
│   └── alertChannels.ts            # Alert channel configuration
├── checkly.config.ts               # All checks config
├── checkly.private.config.ts       # Private checks only config
├── checkly.public.config.ts        # Public checks only config
├── package.json                    # Project scripts
├── migration-mapping.csv           # Datadog-to-Checkly ID/location mapping
├── migration-report.json           # Machine-readable migration report
├── migration-report.md             # Human-readable migration report
└── update-mapping.ts               # Post-deploy script to backfill Checkly UUIDs in CSV
\`\`\`

## Deployment Guide

### Step 1. Review the Migration Report

Open \`migration-report.md\` to understand what was migrated:

- What converted successfully vs. what was skipped (and why)
- Checks deactivated due to failing or missing data in Datadog
- Private locations that need to be created
- Secret variables that need values filled in
- Environment variables referenced by checks

### Step 2. Create Private Locations (if applicable)

If your Datadog monitors used private locations, create them in Checkly **before** testing or deploying:

1. Go to [Checkly > Settings > Private Locations](https://app.checklyhq.com/settings/private-locations)
2. Click **New Private Location**
3. Use the **exact slug** from the migration report
4. Deploy the [Checkly Agent](https://www.checklyhq.com/docs/private-locations/) in your infrastructure

You can skip this and still deploy/test public checks independently.

### Step 3. Fill in Secret Values

Secrets cannot be exported from Datadog. The migration created placeholder entries — fill in the actual values:

\`\`\`bash
# Edit this file and fill in each secret value
vi variables/secrets.json
\`\`\`

Get the actual values from your team, secrets manager, or vault.

### Step 4. Import Environment Variables

Push all environment variables and secrets to your Checkly account:

\`\`\`bash
npm run create-variables
\`\`\`

This requires \`CHECKLY_API_KEY\` and \`CHECKLY_ACCOUNT_ID\` to be set as environment variables. To remove imported variables later, run \`npm run delete-variables\`.

### Step 5. Configure Alert Channels (optional)

Edit \`default_resources/alertChannels.ts\` to set up notifications. By default it creates a placeholder email channel. Supported types: Email, Slack, Webhook, Opsgenie, PagerDuty, MS Teams.

### Step 6. Install Checkly CLI and Authenticate

\`\`\`bash
npm install -g checkly
npx checkly login
\`\`\`

Or set \`CHECKLY_API_KEY\` and \`CHECKLY_ACCOUNT_ID\` as environment variables.

### Step 7. Test (dry run)

Run checks without deploying to verify they work:

\`\`\`bash
# Test public checks first (no private location setup needed)
npm run test:public

# Test private checks (requires private locations + agents running)
npm run test:private
\`\`\`

Common issues to review:
- **Browser checks**: Locators may need updating — review Playwright specs in \`tests/browser/\`
- **Multi-step checks**: Variable extraction between steps may need adjustment — review \`tests/multi/\`
- **Environment variables**: Missing or incorrect values — check \`variables/secrets.json\`

### Step 8. Deploy to Checkly

\`\`\`bash
# Deploy public checks
npm run deploy:public

# Deploy private checks
npm run deploy:private
\`\`\`

### Step 9. Backfill Checkly UUIDs in Migration Mapping

After deploying, run this to populate the \`checkly_uuid\` column in \`migration-mapping.csv\`:

\`\`\`bash
npm run update-mapping
\`\`\`

This calls the Checkly API to match deployed checks by their \`migration_check_id\` tag and writes the Checkly UUID back into the CSV. Requires \`CHECKLY_API_KEY\` and \`CHECKLY_ACCOUNT_ID\`.

### Step 10. Enable Check Groups

All checks deploy inside groups with \`activated: false\`. Nothing runs until you explicitly enable them:

1. Go to [Checkly > Groups](https://app.checklyhq.com/checks)
2. Find **"Datadog Migrated Public Checks"** and **"Datadog Migrated Private Checks"**
3. Toggle each group to **activated** when ready

### Step 11. Verify and Clean Up

- Monitor checks for a few days to confirm stability
- Review checks tagged \`failingInDatadog\` or \`noDataInDatadog\` — fix, keep deactivated, or remove
- Once confident, decommission the corresponding Datadog Synthetic monitors
- Rotate any API keys used during the migration

## Version Control

To put this project under version control:

\`\`\`bash
git init
echo ".env" >> .gitignore
echo "node_modules/" >> .gitignore
git add .
git commit -m "Initial Checkly project from Datadog migration"
git remote add origin <your-repo-url>
git push -u origin main
\`\`\`

> **Important:** Never commit \`.env\` files or secret values to version control.

## Available npm Scripts

| Script | Description |
|--------|-------------|
| \`npm run test:public\` | Run public checks via Checkly CLI (dry run) |
| \`npm run test:private\` | Run private checks via Checkly CLI (dry run) |
| \`npm run deploy:public\` | Deploy public checks to Checkly |
| \`npm run deploy:private\` | Deploy private checks to Checkly |
| \`npm run create-variables\` | Import environment variables to Checkly |
| \`npm run delete-variables\` | Remove imported variables from Checkly |
| \`npm run update-mapping\` | Backfill Checkly UUIDs in migration-mapping.csv |

## Resources

- [Checkly Documentation](https://www.checklyhq.com/docs/)
- [Checkly CLI Reference](https://www.checklyhq.com/docs/cli/)
- [Checkly Constructs Reference](https://www.checklyhq.com/docs/cli/constructs-reference/)
- [Playwright Documentation](https://playwright.dev/docs/intro)
`;
  await writeFile(path.join(outputRoot, 'README.md'), readme, 'utf-8');
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
