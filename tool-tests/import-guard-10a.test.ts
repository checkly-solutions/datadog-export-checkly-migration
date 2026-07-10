/**
 * Import-side-effect guard for src/10a, isolated in its own test file.
 *
 * src/10a has a module-level `import 'dotenv/config'` that loads the repo
 * .env (real credentials, possibly DD_TAGS_*) into process.env at import
 * time. The main-guard stops main(), but NOT the dotenv side effect, so this
 * file:
 *   - imports NO src module other than src/10a
 *   - asserts NOTHING that depends on any environment value dotenv could set
 *   - relies on node:test per-file process isolation to contain the
 *     pollution (Pitfall 3)
 *
 * CHECKLY_ACCOUNT_NAME is set as the FIRST module statement, before the src
 * import, so a hypothetically missing guard fails fast on a file-read error
 * instead of hanging on the interactive account-name prompt (D-19).
 */

process.env.CHECKLY_ACCOUNT_NAME = 'import-guard';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT_IF_MAIN_RAN = join(__dirname, '..', 'checkly-migrated', 'import-guard');

describe('import-guard (10a): importing src/10a runs no pipeline step', () => {
  it('src/10a resolves to a module namespace object without executing main()', async () => {
    const mod = await import('../src/10a-check-datadog-test-status.ts');
    assert.strictEqual(typeof mod, 'object');
    assert.notStrictEqual(mod, null);
  });

  it('no output root was created by the import (no main() ran)', () => {
    assert.strictEqual(
      existsSync(OUTPUT_ROOT_IF_MAIN_RAN),
      false,
      `importing src/10a must not create ${OUTPUT_ROOT_IF_MAIN_RAN}; ` +
        'its existence means main() executed at import time'
    );
  });
});
