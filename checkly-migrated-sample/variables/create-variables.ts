/**
 * Creates Checkly environment variables via API
 * and appends them to the local .env file.
 *
 * Usage: npm run sample:create-variables
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import 'dotenv/config';
import path from 'path';

const SCRIPT_DIR = './checkly-migrated-sample/variables';
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
        'Authorization': `Bearer ${CHECKLY_API_KEY}`,
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
      return { key: variable.key, success: false, error: `HTTP ${response.status}: ${error}` };
    }
  } catch (err) {
    return { key: variable.key, success: false, error: (err as Error).message };
  }
}

async function appendToEnvFile(variables: ChecklyVariable[]): Promise<void> {
  let existingContent = '';
  if (existsSync(ENV_FILE)) {
    existingContent = await readFile(ENV_FILE, 'utf-8');
  }

  const existingKeys = new Set<string>();
  for (const line of existingContent.split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match) {
      existingKeys.add(match[1]);
    }
  }

  const newEntries: string[] = [];
  for (const variable of variables) {
    if (!existingKeys.has(variable.key)) {
      const escapedValue = variable.value.includes(' ') || variable.value.includes('"')
        ? `"${variable.value.replace(/"/g, '\\"')}"`
        : variable.value;
      newEntries.push(`${variable.key}=${escapedValue}`);
    }
  }

  if (newEntries.length > 0) {
    const separator = existingContent.endsWith('\n') || existingContent === '' ? '' : '\n';
    const header = existingContent === '' ? '' : `${separator}\n# Checkly Variables (added by create-variables)\n`;
    await appendFile(ENV_FILE, header + newEntries.join('\n') + '\n');
    console.log(`  Appended ${newEntries.length} variables to .env`);
  } else {
    console.log('  All variables already exist in .env');
  }
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Create Checkly Environment Variables (Sample)');
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

  const envVarsFile = path.join(SCRIPT_DIR, 'env-variables.json');
  if (existsSync(envVarsFile)) {
    console.log('\nProcessing env-variables.json...');
    const envVars = JSON.parse(await readFile(envVarsFile, 'utf-8')) as ChecklyVariable[];

    for (const variable of envVars) {
      process.stdout.write(`  Creating: ${variable.key}... `);
      const result = await createVariable(variable);
      if (result.success) {
        console.log('OK');
        created++;
        allVariables.push(variable);
      } else {
        console.log(`FAILED - ${result.error}`);
        failed++;
      }
    }
  }

  const secretsFile = path.join(SCRIPT_DIR, 'secrets.json');
  if (existsSync(secretsFile)) {
    console.log('\nProcessing secrets.json...');
    const secrets = JSON.parse(await readFile(secretsFile, 'utf-8')) as ChecklyVariable[];

    for (const variable of secrets) {
      if (!variable.value) {
        console.log(`  Skipping: ${variable.key} (empty value - fill in secrets.json first)`);
        skipped++;
        continue;
      }

      process.stdout.write(`  Creating: ${variable.key}... `);
      const result = await createVariable(variable);
      if (result.success) {
        console.log('OK');
        created++;
        allVariables.push(variable);
      } else {
        console.log(`FAILED - ${result.error}`);
        failed++;
      }
    }
  }

  if (allVariables.length > 0) {
    console.log('\nUpdating local .env file...');
    await appendToEnvFile(allVariables);
  }

  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`  Created: ${created}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Skipped: ${skipped}`);
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
