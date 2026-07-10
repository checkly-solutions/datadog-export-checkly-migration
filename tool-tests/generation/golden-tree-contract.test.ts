/**
 * DEPLOY-08 / WR-02 permanent regression guard over the COMMITTED golden tree.
 *
 * The exports-seed carries two browser tests that share the exact name
 * "Synthetic Browser Flow" (public_ids syn-006-pqr and syn-206-tuv). Before the
 * Phase 8 sanitizeFilename tail fix (08-01, D-07), both slugified to one
 * synthetic-browser-flow.check.ts, so the second write silently overwrote the
 * first: two Datadog tests in, ONE Checkly construct out. Phase 6 pulled the pair
 * from the golden seed rather than let the oracle bless that data loss (a fidelity
 * tool's golden must never certify a lossy migration as correct); plan 08-07
 * re-added it and recaptured. This test locks the fix at the SUITE level so any
 * future filename-collision regression fails npm run test:tool, not only
 * golden:verify.
 *
 * It reads the committed tree directory listings only (readdirSync, no
 * subprocess, no capture, no writes), so it runs inside the default offline glob
 * and is deterministic (no network, no wall-clock, no randomness). The golden tree
 * is produced solely by golden:capture; this test never mutates it.
 *
 * The guard is scoped to the same-named COLLISION PAIR (the synthetic-browser-flow-
 * prefix), not the whole browser directory: plan 10-05 added a third,
 * differently-named browser test (PWCS Multi Browser Flow, syn-306-mbf, which emits
 * a PlaywrightCheck plus a companion playwright.config.ts) to exercise the PWCS
 * pipeline end-to-end. That test does not share the pair's name, so it is
 * deliberately excluded from these collision assertions; counting the pair by its
 * shared prefix keeps this guard testing exactly the DEPLOY-08 overwrite it exists
 * to catch, independent of how many unrelated browser tests the seed later grows.
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_TREE = join(__dirname, '..', 'golden', 'tree');

const BROWSER_SPEC_DIR = join(GOLDEN_TREE, 'tests', 'browser', 'public');
const BROWSER_CHECK_DIR = join(GOLDEN_TREE, '__checks__', 'browser', 'public');
const BROWSER_INDEX = join(BROWSER_CHECK_DIR, 'index.ts');

// The two same-named browser tests in the exports-seed and the public-id tails the
// 08-01 sanitizeFilename fix appends to each on-disk filename.
const PAIR_TAILS = ['syn-006-pqr', 'syn-206-tuv'] as const;
const SHARED_PREFIX = 'synthetic-browser-flow-';

/** Files in a golden dir matching a suffix (spec.ts / check.ts), sorted. */
function filesWithSuffix(dir: string, suffix: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .sort();
}

/**
 * Files belonging to the same-named collision PAIR only (shared prefix + suffix),
 * excluding any other browser test the seed carries (e.g. the PWCS entry).
 */
function pairFilesWithSuffix(dir: string, suffix: string): string[] {
  return filesWithSuffix(dir, suffix).filter((f) => f.startsWith(SHARED_PREFIX));
}

describe('golden tree contract: same-named browser pair emits two distinct on-disk files (DEPLOY-08)', () => {
  it('the same-named pair emits exactly two .spec.ts files (excluding unrelated browser tests)', () => {
    const specs = pairFilesWithSuffix(BROWSER_SPEC_DIR, '.spec.ts');
    assert.equal(
      specs.length,
      2,
      `expected two distinct browser spec files for the same-named pair, found ${specs.length}: ${specs.join(', ')}`
    );
  });

  it('the same-named pair emits exactly two .check.ts files (excluding unrelated browser tests)', () => {
    const checks = pairFilesWithSuffix(BROWSER_CHECK_DIR, '.check.ts');
    assert.equal(
      checks.length,
      2,
      `expected two distinct browser check files for the same-named pair, found ${checks.length}: ${checks.join(', ')}`
    );
  });

  it('each spec filename shares the synthetic-browser-flow- prefix and ends in a distinct public-id tail', () => {
    const specs = filesWithSuffix(BROWSER_SPEC_DIR, '.spec.ts');
    for (const tail of PAIR_TAILS) {
      const expected = `${SHARED_PREFIX}${tail}.spec.ts`;
      assert.ok(
        specs.includes(expected),
        `expected spec file ${expected} on disk; found: ${specs.join(', ')}`
      );
    }
    // The two filenames must be distinct (the whole point: no silent overwrite).
    assert.equal(new Set(specs).size, specs.length, 'spec filenames must be distinct, never collide');
  });

  it('each check filename shares the synthetic-browser-flow- prefix and ends in a distinct public-id tail', () => {
    const checks = filesWithSuffix(BROWSER_CHECK_DIR, '.check.ts');
    for (const tail of PAIR_TAILS) {
      const expected = `${SHARED_PREFIX}${tail}.check.ts`;
      assert.ok(
        checks.includes(expected),
        `expected check file ${expected} on disk; found: ${checks.join(', ')}`
      );
    }
    assert.equal(new Set(checks).size, checks.length, 'check filenames must be distinct, never collide');
  });

  it('index.ts imports two distinct module paths for the same-named pair, one per public-id tail', () => {
    const index = readFileSync(BROWSER_INDEX, 'utf-8');
    // Scope to the collision pair's shared prefix; other browser tests (e.g. the
    // PWCS entry) legitimately add their own import line and are not counted here.
    const pairImportLines = index
      .split('\n')
      .filter((l) => l.includes('.check') && l.includes(SHARED_PREFIX));
    const distinctPairImports = new Set(pairImportLines.map((l) => l.trim()));
    assert.equal(
      distinctPairImports.size,
      2,
      `index.ts must import two distinct pair check modules, found ${distinctPairImports.size}: ${[...distinctPairImports].join(' | ')}`
    );
    for (const tail of PAIR_TAILS) {
      assert.ok(
        index.includes(`${SHARED_PREFIX}${tail}.check`),
        `index.ts must import the ${tail} module path`
      );
    }
  });

  it('the two check files carry distinct BrowserCheck logical ids', () => {
    const ids = PAIR_TAILS.map((tail) => {
      const content = readFileSync(join(BROWSER_CHECK_DIR, `${SHARED_PREFIX}${tail}.check.ts`), 'utf-8');
      const match = content.match(/new BrowserCheck\("([^"]+)"/);
      assert.ok(match, `the ${tail} check file must instantiate a BrowserCheck with a logical id`);
      return match![1];
    });
    assert.notEqual(ids[0], ids[1], 'the two same-named checks must carry distinct logical ids, never collide');
  });

  it('the syn-006-pqr spec preserves its full four-step flow (no overwrite by the one-step pair member)', () => {
    const spec = readFileSync(
      join(BROWSER_SPEC_DIR, `${SHARED_PREFIX}syn-006-pqr.spec.ts`),
      'utf-8'
    );
    for (let step = 1; step <= 4; step++) {
      assert.ok(spec.includes(`// Step ${step}:`), `the syn-006-pqr spec must retain Step ${step} of its four-step flow`);
    }
  });
});
