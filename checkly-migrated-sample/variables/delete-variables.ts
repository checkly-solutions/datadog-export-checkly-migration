/**
 * Deletes Checkly environment variables via API
 * and removes them from the local .env file.
 *
 * Usage: npm run sample:delete-variables
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import 'dotenv/config';
import path from 'path';
import * as readline from 'readline';

const SCRIPT_DIR = './checkly-migrated-sample/variables';
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
    const response = await fetch(`${API_URL}/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${CHECKLY_API_KEY}`,
        'X-Checkly-Account': CHECKLY_ACCOUNT_ID!,
      },
    });

    if (response.ok || response.status === 204) {
      return { key, success: true };
    } else if (response.status === 404) {
      return { key, success: true, error: 'not found (already deleted?)' };
    } else {
      const error = await response.text();
      return { key, success: false, error: `HTTP ${response.status}: ${error}` };
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
  const lines = content.split('\n');
  const filteredLines: string[] = [];
  let removed = 0;

  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match && keySet.has(match[1])) {
      removed++;
      continue;
    }
    filteredLines.push(line);
  }

  const finalLines: string[] = [];
  for (let i = 0; i < filteredLines.length; i++) {
    const line = filteredLines[i];
    if (line === '# Checkly Variables (added by create-variables)') {
      continue;
    }
    finalLines.push(line);
  }

  await writeFile(ENV_FILE, finalLines.join('\n'));
  console.log(`  Removed ${removed} variables from .env`);
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Delete Checkly Environment Variables (Sample)');
  console.log('='.repeat(60));

  if (!CHECKLY_API_KEY) {
    console.error('Error: CHECKLY_API_KEY not set in .env file');
    process.exit(1);
  }

  if (!CHECKLY_ACCOUNT_ID) {
    console.error('Error: CHECKLY_ACCOUNT_ID not set in .env file');
    process.exit(1);
  }

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

  console.log(`\nFound ${keysToDelete.length} variables to delete.\n`);
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
    process.stdout.write(`  Deleting: ${key}... `);
    const result = await deleteVariable(key);
    if (result.success) {
      console.log(result.error ? `OK (${result.error})` : 'OK');
      deleted++;
    } else {
      console.log(`FAILED - ${result.error}`);
      failed++;
    }
  }

  console.log('\nUpdating local .env file...');
  await removeFromEnvFile(keysToDelete);

  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`  Deleted: ${deleted}`);
  console.log(`  Failed: ${failed}`);
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
