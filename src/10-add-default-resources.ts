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
    },
  };
  await writeFile(path.join(outputRoot, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n', 'utf-8');
  console.log(`  Generated: ${outputRoot}/package.json`);
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
