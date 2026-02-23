/**
 * Converts Datadog global variables to Checkly environment variables format.
 *
 * Reads: exports/global-variables.json
 * Outputs:
 *   - checkly-migrated/variables/env-variables.json (clean, non-secure vars)
 *   - checkly-migrated/variables/secrets.json (clean, secure vars - needs manual values)
 *   - checkly-migrated/variables/create-variables.ts (API create script)
 *   - checkly-migrated/variables/delete-variables.ts (API delete script)
 *
 * Datadog attributes used:
 *   - name → key
 *   - value.value → value
 *   - value.secure → determines if secret (locked in Checkly)
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { getOutputRoot, getExportsDir } from './shared/output-config.ts';

interface DatadogVariable {
  name: string;
  value?: {
    value?: string;
    secure?: boolean;
  };
}

interface ChecklyVariable {
  key: string;
  value: string;
  locked: boolean;
}

/**
 * Main conversion function
 */
async function main(): Promise<void> {
  const outputRoot = await getOutputRoot();
  const exportsDir = await getExportsDir();
  const INPUT_FILE = `${exportsDir}/global-variables.json`;
  const OUTPUT_DIR = `${outputRoot}/variables`;

  console.log('='.repeat(60));
  console.log('Datadog Global Variables → Checkly Environment Variables');
  console.log('='.repeat(60));

  // Check input file exists
  if (!existsSync(INPUT_FILE)) {
    console.log(`\nSkipping: Input file not found: ${INPUT_FILE}`);
    console.log('No global variables to convert. Run "npm run export" first if you have global variables.');
    return;
  }

  console.log(`\nReading: ${INPUT_FILE}`);
  const data = JSON.parse(await readFile(INPUT_FILE, 'utf-8')) as { variables: DatadogVariable[] };

  const variables = data.variables || [];
  console.log(`Found ${variables.length} global variables`);

  // Separate secure vs non-secure
  const envVariables: ChecklyVariable[] = [];
  const secrets: ChecklyVariable[] = [];

  for (const variable of variables) {
    const name = variable.name;
    const isSecure = variable.value?.secure === true;
    const value = variable.value?.value;

    if (isSecure) {
      // Secure variables don't expose their values in Datadog export
      secrets.push({
        key: name,
        value: '', // Must be filled in manually
        locked: true,
      });
    } else {
      envVariables.push({
        key: name,
        value: value || '',
        locked: false,
      });
    }
  }

  console.log(`  Non-secure variables: ${envVariables.length}`);
  console.log(`  Secure variables (secrets): ${secrets.length}`);

  // Create output directory
  if (!existsSync(OUTPUT_DIR)) {
    await mkdir(OUTPUT_DIR, { recursive: true });
    console.log(`Created directory: ${OUTPUT_DIR}`);
  }

  // Write clean env-variables.json (just key/value/locked)
  await writeFile(
    `${OUTPUT_DIR}/env-variables.json`,
    JSON.stringify(envVariables, null, 2),
    'utf-8'
  );
  console.log(`\nWritten: ${OUTPUT_DIR}/env-variables.json`);

  // Write clean secrets.json (needs manual value entry)
  await writeFile(
    `${OUTPUT_DIR}/secrets.json`,
    JSON.stringify(secrets, null, 2),
    'utf-8'
  );
  console.log(`Written: ${OUTPUT_DIR}/secrets.json`);

  // Generate create script (TypeScript)
  const createScript = generateCreateScript();
  await writeFile(`${OUTPUT_DIR}/create-variables.ts`, createScript, 'utf-8');
  console.log(`Written: ${OUTPUT_DIR}/create-variables.ts`);

  // Generate delete script (TypeScript)
  const deleteScript = generateDeleteScript();
  await writeFile(`${OUTPUT_DIR}/delete-variables.ts`, deleteScript, 'utf-8');
  console.log(`Written: ${OUTPUT_DIR}/delete-variables.ts`);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Conversion Summary');
  console.log('='.repeat(60));
  console.log(`  Total variables: ${variables.length}`);
  console.log(`  Non-secure (env-variables.json): ${envVariables.length}`);
  console.log(`  Secure (secrets.json): ${secrets.length}`);
  console.log(`  Output directory: ${OUTPUT_DIR}`);

  console.log('\nGenerated files:');
  console.log('  - env-variables.json   (non-secure, values included)');
  console.log('  - secrets.json         (secure, FILL IN VALUES MANUALLY)');
  console.log('  - create-variables.ts  (creates vars via API + appends to .env)');
  console.log('  - delete-variables.ts  (deletes vars via API + removes from .env)');

  console.log('\nNext steps:');
  console.log('  1. Add CHECKLY_API_KEY and CHECKLY_ACCOUNT_ID to .env file');
  console.log('  2. Fill in secret values in secrets.json');
  console.log(`  3. Run: cd ${OUTPUT_DIR}/.. && npm run create-variables`);
  console.log('\nDone!');
}

/**
 * Generate TypeScript file to create variables via Checkly API
 * and append them to the local .env file
 */
function generateCreateScript(): string {
  return `/**
 * Creates Checkly environment variables via API
 * and appends them to the local .env file.
 *
 * Usage: npm run create-variables
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import 'dotenv/config';
import path from 'path';

const SCRIPT_DIR = './variables';
const ENV_FILE = './.env';
const API_URL = 'https://api.checklyhq.com/v1/variables';

interface ChecklyVariable {
  key: string;
  value: string;
  locked: boolean;
}

interface CreateResult {
  key: string;
  success: boolean;
  error?: string;
}

const CHECKLY_API_KEY = process.env.CHECKLY_API_KEY?.trim();
const CHECKLY_ACCOUNT_ID = process.env.CHECKLY_ACCOUNT_ID?.trim();

async function createVariable(variable: ChecklyVariable): Promise<CreateResult> {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': \`Bearer \${CHECKLY_API_KEY}\`,
        'X-Checkly-Account': CHECKLY_ACCOUNT_ID!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        key: variable.key,
        value: variable.value,
        locked: variable.locked,
      }),
    });

    if (response.ok) {
      return { key: variable.key, success: true };
    } else {
      const error = await response.text();
      return { key: variable.key, success: false, error: \`HTTP \${response.status}: \${error}\` };
    }
  } catch (err) {
    return { key: variable.key, success: false, error: (err as Error).message };
  }
}

async function appendToEnvFile(variables: ChecklyVariable[]): Promise<void> {
  // Read existing .env content
  let existingContent = '';
  if (existsSync(ENV_FILE)) {
    existingContent = await readFile(ENV_FILE, 'utf-8');
  }

  // Parse existing keys
  const existingKeys = new Set<string>();
  for (const line of existingContent.split('\\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match) {
      existingKeys.add(match[1]);
    }
  }

  // Build new entries (only for non-existing keys)
  const newEntries: string[] = [];
  for (const variable of variables) {
    if (!existingKeys.has(variable.key)) {
      // Escape special characters in value
      const escapedValue = variable.value.includes(' ') || variable.value.includes('"')
        ? \`"\${variable.value.replace(/"/g, '\\\\"')}"\`
        : variable.value;
      newEntries.push(\`\${variable.key}=\${escapedValue}\`);
    }
  }

  if (newEntries.length > 0) {
    const separator = existingContent.endsWith('\\n') || existingContent === '' ? '' : '\\n';
    const header = existingContent === '' ? '' : \`\${separator}\\n# Checkly Variables (added by create-variables)\\n\`;
    await appendFile(ENV_FILE, header + newEntries.join('\\n') + '\\n');
    console.log(\`  Appended \${newEntries.length} variables to .env\`);
  } else {
    console.log('  All variables already exist in .env');
  }
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Create Checkly Environment Variables');
  console.log('='.repeat(60));

  if (!CHECKLY_API_KEY) {
    console.error('Error: CHECKLY_API_KEY not set in .env file');
    process.exit(1);
  }

  if (!CHECKLY_ACCOUNT_ID) {
    console.error('Error: CHECKLY_ACCOUNT_ID not set in .env file');
    process.exit(1);
  }

  const allVariables: ChecklyVariable[] = [];
  let created = 0;
  let failed = 0;
  let skipped = 0;

  // Process env-variables.json
  const envVarsFile = path.join(SCRIPT_DIR, 'env-variables.json');
  if (existsSync(envVarsFile)) {
    console.log('\\nProcessing env-variables.json...');
    const envVars = JSON.parse(await readFile(envVarsFile, 'utf-8')) as ChecklyVariable[];

    for (const variable of envVars) {
      process.stdout.write(\`  Creating: \${variable.key}... \`);
      const result = await createVariable(variable);
      if (result.success) {
        console.log('OK');
        created++;
        allVariables.push(variable);
      } else {
        console.log(\`FAILED - \${result.error}\`);
        failed++;
      }
    }
  }

  // Process secrets.json
  const secretsFile = path.join(SCRIPT_DIR, 'secrets.json');
  if (existsSync(secretsFile)) {
    console.log('\\nProcessing secrets.json...');
    const secrets = JSON.parse(await readFile(secretsFile, 'utf-8')) as ChecklyVariable[];

    for (const variable of secrets) {
      if (!variable.value) {
        console.log(\`  Skipping: \${variable.key} (empty value - fill in secrets.json first)\`);
        skipped++;
        continue;
      }

      process.stdout.write(\`  Creating: \${variable.key}... \`);
      const result = await createVariable(variable);
      if (result.success) {
        console.log('OK');
        created++;
        allVariables.push(variable);
      } else {
        console.log(\`FAILED - \${result.error}\`);
        failed++;
      }
    }
  }

  // Append to .env file
  if (allVariables.length > 0) {
    console.log('\\nUpdating local .env file...');
    await appendToEnvFile(allVariables);
  }

  // Summary
  console.log('\\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(\`  Created: \${created}\`);
  console.log(\`  Failed: \${failed}\`);
  console.log(\`  Skipped: \${skipped}\`);
  console.log('\\nDone!');
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
`;
}

/**
 * Generate TypeScript file to delete variables via Checkly API
 * and remove them from the local .env file
 */
function generateDeleteScript(): string {
  return `/**
 * Deletes Checkly environment variables via API
 * and removes them from the local .env file.
 *
 * Usage: npm run delete-variables
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import 'dotenv/config';
import path from 'path';
import * as readline from 'readline';

const SCRIPT_DIR = './variables';
const ENV_FILE = './.env';
const API_URL = 'https://api.checklyhq.com/v1/variables';

interface ChecklyVariable {
  key: string;
  value: string;
  locked: boolean;
}

interface DeleteResult {
  key: string;
  success: boolean;
  error?: string;
}

const CHECKLY_API_KEY = process.env.CHECKLY_API_KEY?.trim();
const CHECKLY_ACCOUNT_ID = process.env.CHECKLY_ACCOUNT_ID?.trim();

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => {
    rl.question(message, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

async function deleteVariable(key: string): Promise<DeleteResult> {
  try {
    const response = await fetch(\`\${API_URL}/\${encodeURIComponent(key)}\`, {
      method: 'DELETE',
      headers: {
        'Authorization': \`Bearer \${CHECKLY_API_KEY}\`,
        'X-Checkly-Account': CHECKLY_ACCOUNT_ID!,
      },
    });

    if (response.ok || response.status === 204) {
      return { key, success: true };
    } else if (response.status === 404) {
      return { key, success: true, error: 'not found (already deleted?)' };
    } else {
      const error = await response.text();
      return { key, success: false, error: \`HTTP \${response.status}: \${error}\` };
    }
  } catch (err) {
    return { key, success: false, error: (err as Error).message };
  }
}

async function removeFromEnvFile(keys: string[]): Promise<void> {
  if (!existsSync(ENV_FILE)) {
    console.log('  No .env file found');
    return;
  }

  const content = await readFile(ENV_FILE, 'utf-8');
  const keySet = new Set(keys);
  const lines = content.split('\\n');
  const filteredLines: string[] = [];
  let removed = 0;

  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match && keySet.has(match[1])) {
      removed++;
      continue; // Skip this line
    }
    filteredLines.push(line);
  }

  // Also remove the header comment if present and no variables remain after it
  const finalLines: string[] = [];
  for (let i = 0; i < filteredLines.length; i++) {
    const line = filteredLines[i];
    if (line === '# Checkly Variables (added by create-variables)') {
      // Skip if next non-empty lines don't start with a variable
      continue;
    }
    finalLines.push(line);
  }

  await writeFile(ENV_FILE, finalLines.join('\\n'));
  console.log(\`  Removed \${removed} variables from .env\`);
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Delete Checkly Environment Variables');
  console.log('='.repeat(60));

  if (!CHECKLY_API_KEY) {
    console.error('Error: CHECKLY_API_KEY not set in .env file');
    process.exit(1);
  }

  if (!CHECKLY_ACCOUNT_ID) {
    console.error('Error: CHECKLY_ACCOUNT_ID not set in .env file');
    process.exit(1);
  }

  // Collect all keys to delete
  const keysToDelete: string[] = [];

  const envVarsFile = path.join(SCRIPT_DIR, 'env-variables.json');
  if (existsSync(envVarsFile)) {
    const envVars = JSON.parse(await readFile(envVarsFile, 'utf-8')) as ChecklyVariable[];
    keysToDelete.push(...envVars.map(v => v.key));
  }

  const secretsFile = path.join(SCRIPT_DIR, 'secrets.json');
  if (existsSync(secretsFile)) {
    const secrets = JSON.parse(await readFile(secretsFile, 'utf-8')) as ChecklyVariable[];
    keysToDelete.push(...secrets.map(v => v.key));
  }

  console.log(\`\\nFound \${keysToDelete.length} variables to delete.\\n\`);
  console.log('WARNING: This will delete all variables from Checkly AND remove them from .env!');

  const confirmed = await confirm('Are you sure? (y/N) ');
  if (!confirmed) {
    console.log('Aborted.');
    process.exit(0);
  }

  console.log('');
  let deleted = 0;
  let failed = 0;

  for (const key of keysToDelete) {
    process.stdout.write(\`  Deleting: \${key}... \`);
    const result = await deleteVariable(key);
    if (result.success) {
      console.log(result.error ? \`OK (\${result.error})\` : 'OK');
      deleted++;
    } else {
      console.log(\`FAILED - \${result.error}\`);
      failed++;
    }
  }

  // Remove from .env file
  console.log('\\nUpdating local .env file...');
  await removeFromEnvFile(keysToDelete);

  // Summary
  console.log('\\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(\`  Deleted: \${deleted}\`);
  console.log(\`  Failed: \${failed}\`);
  console.log('\\nDone!');
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
`;
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
