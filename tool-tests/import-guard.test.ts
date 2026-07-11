/**
 * Import-side-effect guard for the refactored pipeline scripts.
 *
 * Proves that importing any of the 10 non-dotenv refactored numbered scripts
 * (02, 04, 04b, 04c, 05, 06, 07, 08, 11, 12) executes no pipeline step and
 * writes no file: the ESM main-guard added in plans 01-03 through 01-05 must
 * keep main() from running when the module is imported rather than invoked
 * directly.
 *
 * src/10a is deliberately NOT imported here. Its module-level
 * `import 'dotenv/config'` loads the repo .env into process.env, so it gets
 * its own dedicated test file (import-guard-10a.test.ts); node:test runs each
 * file in its own process, which contains that pollution.
 *
 * CHECKLY_ACCOUNT_NAME is set as the FIRST module statement, before any src
 * import, so a hypothetically missing guard fails fast on a file-read error
 * instead of hanging on the interactive account-name prompt.
 */

process.env.CHECKLY_ACCOUNT_NAME = 'import-guard';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Where a runaway main() would create the output root: ./checkly-migrated/<name>
// relative to the repo root (the cwd of npm run test:tool).
const OUTPUT_ROOT_IF_MAIN_RAN = join(__dirname, '..', 'checkly-migrated', 'import-guard');

describe('import-guard: importing refactored scripts runs no pipeline step', () => {
  it('src/02 resolves and exports convertTest as a function', async () => {
    const mod = await import('../src/02-convert-datadog-api-to-json.ts');
    assert.strictEqual(typeof mod.convertTest, 'function');
  });

  it('src/04 resolves and exports generateApiCheckCode as a function', async () => {
    const mod = await import('../src/04-generate-api-check-constructs-from-json.ts');
    assert.strictEqual(typeof mod.generateApiCheckCode, 'function');
  });

  it('src/04 exposes NO sanitizer export; the canonical copy lives in src/shared/utils.ts', async () => {
    const mod = await import('../src/04-generate-api-check-constructs-from-json.ts');
    assert.strictEqual(
      typeof (mod as Record<string, unknown>).sanitizeIdentifier,
      'undefined',
      'src/04 must not re-export sanitizeIdentifier; the single canonical definition is in src/shared/utils.ts'
    );
  });

  it('src/04b resolves and exports generateTcpMonitorCode as a function', async () => {
    const mod = await import('../src/04b-generate-tcp-monitor-constructs.ts');
    assert.strictEqual(typeof mod.generateTcpMonitorCode, 'function');
  });

  it('src/04c resolves and exports generateDnsMonitorCode as a function', async () => {
    const mod = await import('../src/04c-generate-dns-monitor-constructs.ts');
    assert.strictEqual(typeof mod.generateDnsMonitorCode, 'function');
  });

  it('src/05 resolves and exports generateSpecFile as a function', async () => {
    // Aliased namespace: src/05 and src/07 both export generateSpecFile.
    const mod05 = await import('../src/05-generate-multi-step-specs.ts');
    assert.strictEqual(typeof mod05.generateSpecFile, 'function');
  });

  it('src/06 resolves and exports generateMultiStepCheckCode as a function', async () => {
    const mod = await import('../src/06-generate-multi-step-constructs.ts');
    assert.strictEqual(typeof mod.generateMultiStepCheckCode, 'function');
  });

  it('src/07 resolves and exports generateSpecFile as a function', async () => {
    // Aliased namespace: src/05 and src/07 both export generateSpecFile.
    const mod07 = await import('../src/07-generate-browser-specs.ts');
    assert.strictEqual(typeof mod07.generateSpecFile, 'function');
  });

  it('src/08 resolves and exports generateBrowserCheckCode as a function', async () => {
    const mod = await import('../src/08-generate-browser-constructs.ts');
    assert.strictEqual(typeof mod.generateBrowserCheckCode, 'function');
  });

  it('src/11 resolves; PRIVATE_GROUP and PUBLIC_GROUP are strings preserving safe-by-default', async () => {
    const mod = await import('../src/11-generate-groups.ts');
    assert.strictEqual(typeof mod.PRIVATE_GROUP, 'string');
    assert.strictEqual(typeof mod.PUBLIC_GROUP, 'string');
    assert.ok(mod.PRIVATE_GROUP.includes('CheckGroupV2'), 'PRIVATE_GROUP must emit a CheckGroupV2');
    assert.ok(mod.PUBLIC_GROUP.includes('CheckGroupV2'), 'PUBLIC_GROUP must emit a CheckGroupV2');
    assert.ok(mod.PRIVATE_GROUP.includes('activated: false'), 'PRIVATE_GROUP must stay activated: false');
    assert.ok(mod.PUBLIC_GROUP.includes('activated: false'), 'PUBLIC_GROUP must stay activated: false');
  });

  it('src/12 resolves and exports generateMarkdownReport as a function', async () => {
    const mod = await import('../src/12-generate-migration-report.ts');
    assert.strictEqual(typeof mod.generateMarkdownReport, 'function');
  });

  it('no output root was created by any import (no main() ran)', () => {
    assert.strictEqual(
      existsSync(OUTPUT_ROOT_IF_MAIN_RAN),
      false,
      `importing the scripts must not create ${OUTPUT_ROOT_IF_MAIN_RAN}; ` +
        'its existence means a main() executed at import time'
    );
  });
});
