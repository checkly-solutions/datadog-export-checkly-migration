/**
 * Shared output configuration for the migration pipeline.
 *
 * Prompts for the customer name once (on first call), caches it to
 * ./.customer-name so subsequent pipeline steps don't re-prompt,
 * and returns the output root path: ./checkly-migrated/<customer-name>
 *
 * All customer-specific output (exports, checks, configs) goes under the
 * output root, making it a self-contained project directory.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import * as readline from 'readline';

const CACHE_FILE = './.customer-name';
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
 * Sanitize the customer name for use as a directory name.
 */
function sanitizeCustomerName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Get the output root directory for generated files.
 *
 * On first call, checks ./.customer-name for a cached value.
 * If not found, prompts via readline and caches the result.
 *
 * Returns a path like ./checkly-migrated/acme
 */
export async function getOutputRoot(): Promise<string> {
  if (cachedOutputRoot) {
    return cachedOutputRoot;
  }

  // Check cache file first
  if (existsSync(CACHE_FILE)) {
    const cached = (await readFile(CACHE_FILE, 'utf-8')).trim();
    if (cached) {
      cachedOutputRoot = `./checkly-migrated/${cached}`;
      return cachedOutputRoot;
    }
  }

  // Prompt for customer name
  const raw = await prompt('Enter customer name (e.g. acme): ');
  if (!raw) {
    console.error('Customer name is required.');
    process.exit(1);
  }

  const customerName = sanitizeCustomerName(raw);
  console.log(`Using customer name: ${customerName}`);

  // Cache it
  await writeFile(CACHE_FILE, customerName, 'utf-8');

  cachedOutputRoot = `./checkly-migrated/${customerName}`;
  return cachedOutputRoot;
}

/**
 * Get just the customer name (without the path prefix).
 */
export async function getCustomerName(): Promise<string> {
  const root = await getOutputRoot();
  return root.split('/').pop()!;
}

/**
 * Get the exports directory path inside the customer directory.
 *
 * Returns a path like ./checkly-migrated/acme/exports
 */
export async function getExportsDir(): Promise<string> {
  const root = await getOutputRoot();
  return `${root}/exports`;
}
