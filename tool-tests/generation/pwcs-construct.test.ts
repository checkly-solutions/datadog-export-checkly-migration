/**
 * Generation tests for the PWCS construct branch in step 08 (PWCS-02, plan 10-03).
 *
 * Drives the two new step-08 exports directly, no subprocess and no file writes:
 *   - generatePlaywrightCheckCode: the sibling emitter beside generateBrowserCheckCode
 *     that emits a PlaywrightCheck (never a BrowserCheck) for a multi-engine test.
 *   - generatePlaywrightConfigCode: the companion playwright.config.ts codegen.
 *
 * The load-bearing invariant these tests pin is the pwProjects / config-name
 * equality: Checkly's own bundled guidance (configure-playwright-checks.md) warns
 * "Values must match the Playwright project name ... Wrong names can deploy but
 * run zero tests." So pwProjects on the construct and projects[].name in the
 * companion config MUST come from ONE shared engines array and can never drift.
 * The construct also omits engine and runtimeId entirely (CONTEXT.md D-10): engine
 * selects the JS runtime (Engine.node/Engine.bun), deliberately omitted so the
 * Checkly CLI auto-detects (Node.js 22 default), and runtimeId is a BrowserCheck
 * knob that must never be ported onto this construct (the RCA bug class).
 *
 * All fixtures are authored synthetic from scratch against the code's own input
 * interfaces: syn- publicIds, example.com family hosts, names 25 chars or fewer.
 * No network, no wall clock, no randomness, no filesystem access anywhere here.
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  generateBrowserCheckCode,
  generatePlaywrightCheckCode,
  generatePlaywrightConfigCode,
} from '../../src/08-generate-browser-constructs.ts';

/** Minimal synthetic BrowserTest fixture (public-only, no private locations). */
function mkTest(overrides: Record<string, unknown> = {}) {
  return {
    public_id: 'syn-501-pwc',
    name: 'PWCS Construct Test',
    status: 'paused',
    tags: ['env:synthetic'],
    locations: ['us-east-1'],
    privateLocations: [] as string[],
    originalLocations: ['aws:us-east-1'],
    options: { tick_every: 300 },
    config: { steps: [], configVariables: [] },
    ...overrides,
  } as any;
}

/**
 * Extract projects[].name values from a generated playwright.config.ts body,
 * in emission order, via a simple regex (mirrors how a reader would parse the
 * config; the config never trusts caller ordering, it sorts canonically).
 */
function extractProjectNames(configBody: string): string[] {
  return [...configBody.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
}

describe('PWCS construct branch (generatePlaywrightCheckCode)', () => {
  it('Test 1: multi-engine emits PlaywrightCheck, never BrowserCheck', () => {
    const code = generatePlaywrightCheckCode(
      mkTest(),
      'public',
      false,
      undefined,
      false,
      [],
      ['chromium', 'firefox'],
      'pwcs-construct-test-syn-501-pwc.playwright.config.ts'
    );
    assert.match(code, /new PlaywrightCheck\(/);
    assert.ok(!code.includes('new BrowserCheck('), 'must not emit a BrowserCheck');
  });

  it('Test 2: single/zero-engine BrowserCheck path is unchanged (non-regression)', () => {
    const code = generateBrowserCheckCode(mkTest(), 'flow.spec.ts', 'public');
    assert.match(code, /new BrowserCheck\(/);
  });

  it('Test 3: PlaywrightCheck omits retryStrategy, doubleCheck, runtimeId, engine, and never imports RetryStrategyBuilder/Engine (D-10)', () => {
    const code = generatePlaywrightCheckCode(
      mkTest(),
      'public',
      false,
      undefined,
      false,
      [],
      ['chromium', 'firefox'],
      'pwcs-construct-test-syn-501-pwc.playwright.config.ts'
    );
    assert.ok(!code.includes('retryStrategy'), 'must omit retryStrategy');
    assert.ok(!code.includes('doubleCheck'), 'must omit doubleCheck');
    assert.ok(!code.includes('runtimeId'), 'must omit runtimeId');
    // Guard the prop specifically so the legitimate `engines` identifier / the
    // pwProjects/config engine names cannot false-positive: no `engine:` key and
    // no `Engine` import.
    assert.ok(!/\bengine\s*:/.test(code), 'must not set an engine prop (D-10)');
    assert.ok(!/\bRetryStrategyBuilder\b/.test(code), 'must not import RetryStrategyBuilder');
    assert.ok(!/\bEngine\b/.test(code), 'must not import Engine');
  });

  it('Test 4: pwProjects equals the config projects[].name values, canonical order, never drifts', () => {
    const engines = ['chromium', 'firefox'];
    const code = generatePlaywrightCheckCode(
      mkTest(),
      'public',
      false,
      undefined,
      false,
      [],
      engines,
      'pwcs-construct-test-syn-501-pwc.playwright.config.ts'
    );
    assert.ok(code.includes('pwProjects: ["chromium","firefox"]'), 'pwProjects must be the exact engines array');

    const configBody = generatePlaywrightConfigCode(engines, 'public', 'flow.spec.ts');
    assert.deepEqual(extractProjectNames(configBody), ['chromium', 'firefox'], 'config project names must match pwProjects exactly');
  });

  it('Test 5: playwrightConfigPath is a same-directory relative .playwright.config.ts reference', () => {
    const configFilename = 'pwcs-construct-test-syn-501-pwc.playwright.config.ts';
    const code = generatePlaywrightCheckCode(
      mkTest(),
      'public',
      false,
      undefined,
      false,
      [],
      ['chromium', 'firefox'],
      configFilename
    );
    const m = code.match(/playwrightConfigPath:\s*"([^"]+)"/);
    assert.ok(m, 'playwrightConfigPath must be present');
    const p = m![1];
    assert.ok(p.endsWith('.playwright.config.ts'), 'must end in .playwright.config.ts');
    assert.ok(!p.startsWith('/'), 'must not be an absolute path');
    assert.ok(!p.includes('..'), 'a same-directory companion needs no parent-dir traversal');
  });

  it('Test 6: private-location parity (D-06) — privateLocations emitted exactly as BrowserCheck would', () => {
    const test = mkTest({ privateLocations: ['synthetic-pl-east'], locations: [] });
    const pwc = generatePlaywrightCheckCode(
      test,
      'private',
      false,
      undefined,
      false,
      [],
      ['chromium', 'firefox'],
      'pwcs-construct-test-syn-501-pwc.playwright.config.ts'
    );
    const bc = generateBrowserCheckCode(test, 'flow.spec.ts', 'private');
    assert.ok(pwc.includes('privateLocations: ["synthetic-pl-east"]'), 'PlaywrightCheck must emit privateLocations');
    // Structural parity: both construct types emit the identical privateLocations line shape.
    const pwLine = pwc.split('\n').find((l) => l.includes('privateLocations:'));
    const bcLine = bc.split('\n').find((l) => l.includes('privateLocations:'));
    assert.equal(pwLine?.trim(), bcLine?.trim(), 'privateLocations line shape must match BrowserCheck');
  });

  it('Test 7: check-level settings parity (D-02) — frequency, tags, activated, env/secrets match a BrowserCheck for the same fixture', () => {
    const flagState = { flaggedIds: new Set(['syn-501-pwc']), deactivatedIds: new Set<string>() };
    const secretKeys = ['SYNTHETIC_SECRET'];
    const test = mkTest({ status: 'live', tags: ['env:synthetic', 'team:qa'] });

    const pwc = generatePlaywrightCheckCode(
      test,
      'public',
      false,
      flagState,
      false,
      secretKeys,
      ['chromium', 'firefox'],
      'pwcs-construct-test-syn-501-pwc.playwright.config.ts'
    );
    const bc = generateBrowserCheckCode(test, 'flow.spec.ts', 'public', false, flagState, false, secretKeys);

    // Same frequency.
    const freqOf = (s: string) => s.match(/frequency:\s*Frequency\.(\w+)/)?.[1];
    assert.equal(freqOf(pwc), freqOf(bc), 'frequency must match');

    // Same tags array (migration_check_id + reviewMigrationFlag included identically).
    const tagsOf = (s: string) => s.match(/tags:\s*(\[[^\]]*\])/)?.[1];
    assert.equal(tagsOf(pwc), tagsOf(bc), 'tags array must match');
    assert.ok(pwc.includes('"migration_check_id:syn-501-pwc"'), 'migration_check_id tag present');
    assert.ok(pwc.includes('"reviewMigrationFlag"'), 'reviewMigrationFlag tag present when flagged');

    // Same activated value (live => true, paused-state preserving).
    const actOf = (s: string) => s.match(/activated:\s*(true|false)/)?.[1];
    assert.equal(actOf(pwc), actOf(bc), 'activated must match');

    // Same secret env-var declaration.
    assert.ok(pwc.includes('{ key: "SYNTHETIC_SECRET", value: "", secret: true }'), 'routed secret declared');
    assert.ok(bc.includes('{ key: "SYNTHETIC_SECRET", value: "", secret: true }'), 'BrowserCheck routed secret declared');
  });
});

describe('PWCS companion config (generatePlaywrightConfigCode)', () => {
  it('Test 8: imports defineConfig/devices from @playwright/test and emits one project per engine', () => {
    const single = generatePlaywrightConfigCode(['chromium'], 'public', 'flow.spec.ts');
    assert.match(single, /import\s*\{\s*defineConfig,\s*devices\s*\}\s*from\s*'@playwright\/test'/);
    assert.match(single, /defineConfig\(/);
    assert.match(single, /devices\[/);
    assert.equal(extractProjectNames(single).length, 1, 'exactly one project for one engine');
    assert.deepEqual(extractProjectNames(single), ['chromium']);
  });

  it('Test 9: canonical PLAYWRIGHT_ENGINE_ORDER order, never caller input order', () => {
    const body = generatePlaywrightConfigCode(['firefox', 'chromium'], 'public', 'flow.spec.ts');
    assert.deepEqual(extractProjectNames(body), ['chromium', 'firefox'], 'config sorts to canonical order, chromium before firefox');
  });
});

/**
 * Config-to-spec resolution (WR-02 / CR-01 regression guard).
 *
 * The blocker CR-01 was that the companion config declared only projects[] with
 * NO testDir/testMatch, so Playwright/Checkly defaulted testDir to the config's
 * own directory (__checks__/browser/<lt>/), which holds zero .spec.ts files, and
 * the migrated PlaywrightCheck ran nothing. These tests assert the emitted config
 * now provably discovers its ONE spec: testDir must resolve (via path arithmetic,
 * exactly how checkly@8.13.0's PlaywrightConfig resolves it with path.resolve
 * against the config directory) to the on-disk tests/browser/<lt> spec directory,
 * and testMatch must equal the generated spec filename. No Playwright run, no
 * filesystem access: pure path math, offline and deterministic.
 *
 * The on-disk layout the fix must bridge (both real in the golden tree):
 *   config: __checks__/browser/<lt>/<base>.playwright.config.ts
 *   spec:   tests/browser/<lt>/<base>.spec.ts
 */
describe('PWCS config discovers its spec (WR-02: config-to-spec resolution)', () => {
  /** Pull the single-quoted value of a top-level config key from the emitted body. */
  function extractConfigValue(configBody: string, key: string): string | undefined {
    return configBody.match(new RegExp(`${key}:\\s*'([^']+)'`))?.[1];
  }

  for (const locationType of ['public', 'private']) {
    it(`resolves testDir + testMatch to the generated spec for ${locationType}`, () => {
      const specFilename = 'pwcs-multi-browser-flow-syn-306-mbf.spec.ts';
      const configBody = generatePlaywrightConfigCode(['chromium', 'firefox'], locationType, specFilename);

      const testDir = extractConfigValue(configBody, 'testDir');
      const testMatch = extractConfigValue(configBody, 'testMatch');
      assert.ok(testDir, 'config must declare a testDir (CR-01: default testDir finds zero specs)');
      assert.ok(testMatch, 'config must declare a testMatch');

      // The config lives at __checks__/browser/<lt>/; the spec lives at
      // tests/browser/<lt>/. Resolve testDir relative to the config directory the
      // SAME way checkly's PlaywrightConfig does (path.resolve(configDir, testDir)),
      // then assert it lands on the generated spec's actual directory.
      const configDir = path.posix.join('__checks__', 'browser', locationType);
      const resolvedTestDir = path.posix.resolve('/', configDir, testDir!);
      const expectedSpecDir = path.posix.resolve('/', 'tests', 'browser', locationType);
      assert.equal(resolvedTestDir, expectedSpecDir,
        `testDir must resolve to tests/browser/${locationType}, not the config's spec-less own dir`);

      // testMatch must pin exactly this check's spec filename, so discovery never
      // sweeps in sibling browser specs sharing the directory.
      assert.equal(testMatch, specFilename, 'testMatch must equal the generated spec filename');

      // Full effective glob (checkly prepends '**' + '/' to a non-'**' pattern):
      // the on-disk spec path must satisfy it.
      const onDiskSpec = path.posix.join(expectedSpecDir, specFilename);
      assert.ok(onDiskSpec.endsWith(`/${testMatch}`),
        'the generated spec path must end with the testMatch filename (discoverable)');
    });
  }
});
