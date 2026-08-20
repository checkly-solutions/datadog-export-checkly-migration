/**
 * Shared null-tolerant JSON file reader.
 *
 * Single source of truth for the "read a JSON file, degrade to null on any
 * problem" idiom used across the pipeline. It replaces two byte-for-byte
 * identical copies that had drifted only in a warn-message capital letter:
 * src/12's exported readJsonFile and src/10's local readJsonFileSafe.
 * It lives in src/shared/ (not in a numbered step) so both steps import it
 * without creating a backwards step-to-step dependency: the architecture forbids
 * a step reading a later step's export, and step 10 runs before step 12.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

/**
 * Read and parse a JSON file null-tolerantly.
 *
 * Returns null when the file is absent, unreadable, or malformed, warning once on
 * a parse/read failure. Pure with respect to the filesystem contents (no writes);
 * the only side effect is a console.warn on failure, which goes to stderr and
 * never into generated output, so callers stay byte-neutral.
 *
 * @param filepath - Absolute or cwd-relative path to the JSON file.
 * @returns The parsed value typed as T, or null on any absence/read/parse error.
 */
export async function readJsonFileSafe<T>(filepath: string): Promise<T | null> {
  if (!existsSync(filepath)) {
    return null;
  }
  try {
    const content = await readFile(filepath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (err) {
    console.warn(`  Warning: Could not parse ${filepath}: ${(err as Error).message}`);
    return null;
  }
}
