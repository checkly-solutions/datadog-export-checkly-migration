/**
 * Shared output configuration for the migration pipeline.
 *
 * Reads the account name from the CHECKLY_ACCOUNT_NAME env variable.
 * If not set, prompts via readline.
 *
 * Returns the output root path: ./checkly-migrated/<account-name>
 *
 * All account-specific output (exports, checks, configs) goes under the
 * output root, making it a self-contained project directory.
 */

import * as readline from 'readline';

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
 * Reads CHECKLY_ACCOUNT_NAME from env. If not set, prompts via readline.
 *
 * Returns a path like ./checkly-migrated/acme
 */
export async function getOutputRoot(): Promise<string> {
  if (cachedOutputRoot) {
    return cachedOutputRoot;
  }

  let raw = process.env.CHECKLY_ACCOUNT_NAME?.trim() || '';

  if (!raw) {
    raw = await prompt('Enter account name (e.g. acme): ');
  }

  if (!raw) {
    console.error('Account name is required. Set CHECKLY_ACCOUNT_NAME in .env or pass it when prompted.');
    process.exit(1);
  }

  const accountName = sanitizeAccountName(raw);
  console.log(`Using account name: ${accountName}`);

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
