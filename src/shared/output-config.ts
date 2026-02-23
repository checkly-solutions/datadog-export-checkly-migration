/**
 * Shared output configuration for the migration pipeline.
 *
 * Resolves the account name in this order:
 *   1. CHECKLY_ACCOUNT_NAME env variable (from .env or shell)
 *   2. .account-name cache file (written after first prompt)
 *   3. Interactive prompt (writes cache for subsequent pipeline steps)
 *
 * Returns the output root path: ./checkly-migrated/<account-name>
 *
 * All account-specific output (exports, checks, configs) goes under the
 * output root, making it a self-contained project directory.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import * as readline from 'readline';

const CACHE_FILE = './.account-name';
let cachedOutputRoot: string | null = null;

/**
 * Prompt the user for input via stdin.
 */
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Sanitize the account name for use as a directory name.
 */
function sanitizeAccountName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Get the output root directory for generated files.
 *
 * Resolution order: env var → cache file → prompt (writes cache).
 *
 * Returns a path like ./checkly-migrated/acme
 */
export async function getOutputRoot(): Promise<string> {
  if (cachedOutputRoot) {
    return cachedOutputRoot;
  }

  let raw = process.env.CHECKLY_ACCOUNT_NAME?.trim() || '';

  // Check cache file if env var not set
  if (!raw && existsSync(CACHE_FILE)) {
    const cached = (await readFile(CACHE_FILE, 'utf-8')).trim();
    if (cached) {
      raw = cached;
    }
  }

  // Prompt if still not set
  if (!raw) {
    raw = await prompt('Enter account name (e.g. acme): ');
  }

  if (!raw) {
    console.error('Account name is required. Set CHECKLY_ACCOUNT_NAME in .env or pass it when prompted.');
    process.exit(1);
  }

  const accountName = sanitizeAccountName(raw);
  console.log(`Using account name: ${accountName}`);

  // Write cache so subsequent pipeline steps don't re-prompt
  await writeFile(CACHE_FILE, accountName, 'utf-8');

  cachedOutputRoot = `./checkly-migrated/${accountName}`;
  return cachedOutputRoot;
}

/**
 * Get just the account name (without the path prefix).
 */
export async function getAccountName(): Promise<string> {
  const root = await getOutputRoot();
  return root.split('/').pop()!;
}

/**
 * Get the exports directory path inside the account directory.
 *
 * Returns a path like ./checkly-migrated/acme/exports
 */
export async function getExportsDir(): Promise<string> {
  const root = await getOutputRoot();
  return `${root}/exports`;
}
