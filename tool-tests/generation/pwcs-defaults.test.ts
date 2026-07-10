/**
 * Step-10 tests for the PWCS completeness fixes (PWCS-02, plan 10-03 Task 3).
 *
 * Two step-10 gaps a naive construct branch silently leaves open:
 *   1. updateCheckFile's checkPatterns whitelist (ApiCheck/BrowserCheck/
 *      MultiStepCheck) did not include PlaywrightCheck, so a PWCS .check.ts would
 *      never get alertChannels/group/location-tag wired in.
 *   2. The generated project's package.json never declared @playwright/test, a
 *      package Checkly's own bundler require.resolve()s and throws hard on.
 *
 * This suite drives the two step-10 exports directly:
 *   - updateCheckFile (a read-file-mutate-file contract; this ONE describe block
 *     is permitted to touch a mkdtemp scratch dir under os.tmpdir per the plan).
 *   - detectPlaywrightCheckSuites (pure manifest read; the threshold is the SAME
 *     engines.length > 1 the src/08 branch used, so detection and emission never
 *     disagree).
 *
 * All fixtures synthetic (syn- ids, example.com family, names <= 25 chars). No
 * network, no wall clock, no randomness. Scratch files are created and removed in
 * before/after hooks so the suite stays deterministic and re-runnable.
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  updateCheckFile,
  detectPlaywrightCheckSuites,
  generateProjectFiles,
} from '../../src/10-add-default-resources.ts';

/** A minimal generated PlaywrightCheck .check.ts body (matches src/08 emission). */
const PLAYWRIGHT_CHECK_SRC = `/**
 * Migrated from Datadog Synthetic: syn-501-pwc
 */
import {
  PlaywrightCheck,
  Frequency,
} from "checkly/constructs";

new PlaywrightCheck("browser-pwcs-construct-test-syn-501-pwc", {
  name: "PWCS Construct Test",
  tags: ["env:synthetic","migration_check_id:syn-501-pwc"],
  playwrightConfigPath: "pwcs-construct-test-syn-501-pwc.playwright.config.ts",
  pwProjects: ["chromium","firefox"],
  frequency: Frequency.EVERY_10M,
  locations: ["us-east-1"],
  activated: false,
  muted: false,
});
`;

/** A minimal generated BrowserCheck .check.ts body (the non-regression control). */
const BROWSER_CHECK_SRC = `/**
 * Migrated from Datadog Synthetic: syn-006-pqr
 */
import {
  BrowserCheck,
  Frequency,
  RetryStrategyBuilder,
} from "checkly/constructs";

new BrowserCheck("browser-synthetic-flow-syn-006-pqr", {
  name: "Synthetic Flow",
  tags: ["env:synthetic","migration_check_id:syn-006-pqr"],
  code: {
    entrypoint: "../../../tests/browser/public/synthetic-flow-syn-006-pqr.spec.ts",
  },
  frequency: Frequency.EVERY_15M,
  locations: ["us-east-1"],
  activated: false,
  muted: false,
  retryStrategy: RetryStrategyBuilder.noRetries(),
  runParallel: true,
});
`;

describe('step 10 updateCheckFile recognizes PlaywrightCheck', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gsd-pwcs-defaults-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('wires alertChannels/group/location-tag into a PlaywrightCheck file', async () => {
    const filepath = join(dir, 'pwcs.check.ts');
    await writeFile(filepath, PLAYWRIGHT_CHECK_SRC, 'utf-8');

    const result = await updateCheckFile(filepath, 'browser', 'public');
    assert.equal(result.skipped, false, `should not skip a PlaywrightCheck (${result.reason ?? ''})`);

    const content = await readFile(filepath, 'utf-8');
    assert.ok(content.includes('alertChannels'), 'alertChannels wired in');
    assert.ok(content.includes('group:'), 'group wired in');
    assert.ok(content.includes('"public"'), 'location-type tag added to tags array');
  });

  it('still wires a BrowserCheck file (non-regression on the existing construct types)', async () => {
    const filepath = join(dir, 'browser.check.ts');
    await writeFile(filepath, BROWSER_CHECK_SRC, 'utf-8');

    const result = await updateCheckFile(filepath, 'browser', 'public');
    assert.equal(result.skipped, false, `should not skip a BrowserCheck (${result.reason ?? ''})`);

    const content = await readFile(filepath, 'utf-8');
    assert.ok(content.includes('alertChannels'), 'alertChannels wired in');
    assert.ok(content.includes('group:'), 'group wired in');
    assert.ok(content.includes('"public"'), 'location-type tag added to tags array');
  });
});

describe('step 10 detectPlaywrightCheckSuites', () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'gsd-pwcs-detect-'));
    await mkdir(join(root, 'tests', 'browser', 'public'), { recursive: true });
    await mkdir(join(root, 'tests', 'browser', 'private'), { recursive: true });
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns false when no browser manifests exist', async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), 'gsd-pwcs-empty-'));
    try {
      assert.equal(await detectPlaywrightCheckSuites(emptyRoot), false);
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  it('returns false when manifests have no multi-engine (pwEngines.length > 1) entry', async () => {
    const manifest = {
      generatedAt: '',
      outputDir: '',
      locationType: 'public',
      files: [
        { logicalId: 'syn-006-pqr', name: 'A', filename: 'a.spec.ts', pwEngines: [] },
        { logicalId: 'syn-206-tuv', name: 'B', filename: 'b.spec.ts', pwEngines: ['chromium'] },
      ],
    };
    await writeFile(join(root, 'tests', 'browser', 'public', '_manifest.json'), JSON.stringify(manifest), 'utf-8');
    assert.equal(await detectPlaywrightCheckSuites(root), false);
  });

  it('returns true when at least one manifest entry has pwEngines.length > 1', async () => {
    const manifest = {
      generatedAt: '',
      outputDir: '',
      locationType: 'public',
      files: [
        { logicalId: 'syn-006-pqr', name: 'A', filename: 'a.spec.ts', pwEngines: [] },
        { logicalId: 'syn-501-pwc', name: 'B', filename: 'b.spec.ts', pwEngines: ['chromium', 'firefox'] },
      ],
    };
    await writeFile(join(root, 'tests', 'browser', 'public', '_manifest.json'), JSON.stringify(manifest), 'utf-8');
    assert.equal(await detectPlaywrightCheckSuites(root), true);
  });

  it('reads the private manifest too (a multi-engine private test triggers detection)', async () => {
    // Reset public to a single-engine-only manifest, put the multi-engine test in private.
    const publicManifest = {
      generatedAt: '', outputDir: '', locationType: 'public',
      files: [{ logicalId: 'syn-006-pqr', name: 'A', filename: 'a.spec.ts', pwEngines: ['chromium'] }],
    };
    const privateManifest = {
      generatedAt: '', outputDir: '', locationType: 'private',
      files: [{ logicalId: 'syn-777-prv', name: 'P', filename: 'p.spec.ts', pwEngines: ['chromium', 'webkit'] }],
    };
    await writeFile(join(root, 'tests', 'browser', 'public', '_manifest.json'), JSON.stringify(publicManifest), 'utf-8');
    await writeFile(join(root, 'tests', 'browser', 'private', '_manifest.json'), JSON.stringify(privateManifest), 'utf-8');
    assert.equal(await detectPlaywrightCheckSuites(root), true);
  });

  it('tolerates a manifest entry with an absent pwEngines field (defensive read)', async () => {
    const manifest = {
      generatedAt: '', outputDir: '', locationType: 'public',
      files: [{ logicalId: 'syn-006-pqr', name: 'A', filename: 'a.spec.ts' }],
    };
    await writeFile(join(root, 'tests', 'browser', 'public', '_manifest.json'), JSON.stringify(manifest), 'utf-8');
    // Clear the private manifest set by the previous test so only this shape is read.
    await writeFile(join(root, 'tests', 'browser', 'private', '_manifest.json'), JSON.stringify({ generatedAt: '', outputDir: '', locationType: 'private', files: [] }), 'utf-8');
    assert.equal(await detectPlaywrightCheckSuites(root), false);
  });
});

/**
 * Generated-project devDependency pins (WR-01, plan 10-06).
 *
 * checkly is pinned ^8.13.0 UNCONDITIONALLY: Phase 10 emits PlaywrightCheck (a
 * Checkly CLI v8+ construct), so the earlier ^7.11.0 pin could resolve a checkly
 * that never exports PlaywrightCheck. Every generated project (PWCS or not) now
 * gets the same v8 baseline. @playwright/test stays gated on needsPlaywright (its
 * bundler require.resolve()s the package and throws hard when absent, but a
 * non-PWCS project has no need of it).
 *
 * generateProjectFiles writes into a mkdtemp scratch dir (sanctioned scratch IO,
 * like the updateCheckFile block above); read the emitted package.json back and
 * assert the pins. Offline, deterministic, cleaned up in after().
 */
describe('step 10 generated package.json devDependency pins (WR-01)', () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'gsd-pwcs-pins-'));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function readDevDeps(needsPlaywright: boolean): Promise<Record<string, string>> {
    const dir = await mkdtemp(join(root, 'proj-'));
    await generateProjectFiles(dir, 'gsd-pins', needsPlaywright);
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8'));
    return pkg.devDependencies as Record<string, string>;
  }

  it('pins checkly ^8.13.0 unconditionally when needsPlaywright is true', async () => {
    const dev = await readDevDeps(true);
    assert.equal(dev.checkly, '^8.13.0', 'PWCS project must pin checkly ^8.13.0');
    assert.equal(dev['@playwright/test'], '^1.61.1', 'PWCS project must declare @playwright/test');
  });

  it('pins checkly ^8.13.0 unconditionally when needsPlaywright is false', async () => {
    const dev = await readDevDeps(false);
    assert.equal(dev.checkly, '^8.13.0', 'non-PWCS project must ALSO pin checkly ^8.13.0 (unconditional bump)');
    assert.ok(!('@playwright/test' in dev), 'non-PWCS project must NOT declare @playwright/test');
  });

  it('never pins a checkly version below 8 (no residual ^7 baseline)', async () => {
    for (const needsPlaywright of [true, false]) {
      const dev = await readDevDeps(needsPlaywright);
      assert.ok(!/\^7\./.test(dev.checkly), `checkly pin must not be a v7 range (needsPlaywright=${needsPlaywright})`);
    }
  });
});
