/**
 * construct-side tool tests.
 *
 * Pins the src/08 half of the MIGRATION-FLAG system: the null-tolerant read of
 * exports/migration-flags.json (RESEARCH A4), the constant reviewMigrationFlag
 * tag appended AFTER filterAndRemapTags in the same diagnostic slot as
 * migration_check_id, and the strictly-one-way activated:false override
 * for the zero-signal deactivated subset only.
 *
 * Driven entirely by synthetic in-memory data plus one committed malformed
 * fixture. No network, no wall-clock, no randomness, no file writes at runtime.
 * The three DD_TAGS_* variables are snapshot / cleared / restored in before /
 * after hooks because generateBrowserCheckCode calls filterAndRemapTags at call
 * time (browser.test.ts idiom).
 *
 * CHECKLY_ACCOUNT_NAME is set as the FIRST statement, before any src import, so
 * no import chain can reach the interactive account-name prompt.
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  generateBrowserCheckCode,
  deriveFlagState,
  readMigrationFlagState,
} from '../../src/08-generate-browser-constructs.ts';
import type { MigrationFlagsFile } from '../../src/shared/migration-flags.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * BrowserTest is file-local to src/08. Derive the exact input shape from the
 * exported generator's first parameter (browser.test.ts derives step types the
 * same way via Parameters<...>).
 */
type BrowserTestInput = Parameters<typeof generateBrowserCheckCode>[0];

const SPEC_FILENAME = 'syn-browser-flow.spec.ts';

/**
 * Build a synthetic live BrowserTest. Invented values only: syn- public ids,
 * example.com hosts, names 25 chars or fewer, env:synthetic tags. The private
 * variant carries a non-empty privateLocations array so both the public and the
 * private branch of the one shared function are exercised.
 */
function mkTest(overrides: Partial<BrowserTestInput> = {}): BrowserTestInput {
  const base = {
    public_id: 'syn-aaa-111',
    name: 'Synthetic flow',
    status: 'live',
    tags: ['env:synthetic'],
    locations: ['us-east-1'],
    privateLocations: [] as string[],
    originalLocations: ['aws:us-east-1'],
    options: { tick_every: 900 },
    config: {},
  };
  return { ...base, ...overrides } as BrowserTestInput;
}

/**
 * generateBrowserCheckCode calls filterAndRemapTags, which reads DD_TAGS_EXCLUDE,
 * DD_TAGS_EXCLUDE_ALL, and DD_TAGS_REMAP at call time. Snapshot and clear all
 * three before the tests and restore them exactly afterwards (determinism rule).
 */
const DD_TAG_VARS = ['DD_TAGS_EXCLUDE', 'DD_TAGS_EXCLUDE_ALL', 'DD_TAGS_REMAP'] as const;
let savedTagEnv: Record<string, string | undefined> = {};

before(() => {
  savedTagEnv = {};
  for (const name of DD_TAG_VARS) {
    savedTagEnv[name] = process.env[name];
    delete process.env[name];
  }
});

after(() => {
  for (const name of DD_TAG_VARS) {
    if (savedTagEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = savedTagEnv[name];
    }
  }
});

describe('deriveFlagState: shape tolerance (RESEARCH A4)', () => {
  it('Test 1: null, undefined, empty object, or a non-array flags field yields two empty Sets and never throws', () => {
    const inputs: Array<MigrationFlagsFile | null | undefined> = [
      null,
      undefined,
      {} as unknown as MigrationFlagsFile,
      { flags: undefined } as unknown as MigrationFlagsFile,
      { flags: 'not-an-array' } as unknown as MigrationFlagsFile,
      { flags: 42 } as unknown as MigrationFlagsFile,
    ];
    for (const input of inputs) {
      const state = deriveFlagState(input);
      assert.ok(state.flaggedIds instanceof Set, 'flaggedIds must be a Set');
      assert.ok(state.deactivatedIds instanceof Set, 'deactivatedIds must be a Set');
      assert.equal(state.flaggedIds.size, 0, 'flaggedIds must be empty for a malformed shape');
      assert.equal(state.deactivatedIds.size, 0, 'deactivatedIds must be empty for a malformed shape');
    }
  });

  it('Test 2: derives flagged from every record and deactivated from records with deactivates strictly true; skips empty/missing publicId', () => {
    const file: MigrationFlagsFile = {
      flags: [
        { reason: 'locator-unresolvable', publicId: 'syn-aaa-111', stepIndex: 0, message: 'no locator', deactivates: true },
        { reason: 'wait-value-invalid', publicId: 'syn-bbb-222', stepIndex: 1, message: 'bad wait' },
        // Records with no usable publicId must be skipped, never thrown on.
        { reason: 'wait-value-invalid', publicId: '', stepIndex: 2, message: 'empty id' },
        { reason: 'wait-value-invalid', stepIndex: 3, message: 'missing id' } as unknown as MigrationFlagsFile['flags'][number],
      ],
      flaggedCheckIds: [],
      deactivatedCheckIds: [],
    };
    const state = deriveFlagState(file);
    assert.ok(state.flaggedIds.has('syn-aaa-111'), 'deactivating record id must be flagged');
    assert.ok(state.flaggedIds.has('syn-bbb-222'), 'non-deactivating record id must be flagged');
    assert.equal(state.flaggedIds.size, 2, 'only the two records with a usable publicId are flagged');
    assert.ok(state.deactivatedIds.has('syn-aaa-111'), 'the deactivates:true record must be deactivated');
    assert.ok(!state.deactivatedIds.has('syn-bbb-222'), 'a non-deactivating record must not be deactivated');
    assert.equal(state.deactivatedIds.size, 1, 'only the deactivates:true record is deactivated');
  });
});

describe('readMigrationFlagState: null-tolerant IO (RESEARCH A4)', () => {
  it('Test 3: a deterministic nonexistent directory resolves to empty sets without throwing (missing-file path)', async () => {
    const missingDir = join(__dirname, 'syn-directory-that-never-exists');
    const state = await readMigrationFlagState(missingDir);
    assert.equal(state.flaggedIds.size, 0, 'missing directory must yield empty flaggedIds');
    assert.equal(state.deactivatedIds.size, 0, 'missing directory must yield empty deactivatedIds');
  });

  it('Test 4: the committed malformed fixture directory resolves to empty sets without throwing (parse-failure path)', async () => {
    const malformedDir = join(__dirname, '..', 'fixtures', 'unit', 'malformed-exports');
    const state = await readMigrationFlagState(malformedDir);
    assert.equal(state.flaggedIds.size, 0, 'malformed JSON must yield empty flaggedIds');
    assert.equal(state.deactivatedIds.size, 0, 'malformed JSON must yield empty deactivatedIds');
  });
});

describe('generateBrowserCheckCode: deactivation + tag', () => {
  it('Test 5: a deactivated public_id emits activated: false and the reviewMigrationFlag tag even for a live check, for both public and private locationType', () => {
    const flagState = {
      flaggedIds: new Set(['syn-aaa-111']),
      deactivatedIds: new Set(['syn-aaa-111']),
    };

    const publicTest = mkTest({ public_id: 'syn-aaa-111', status: 'live', privateLocations: [] });
    const publicOut = generateBrowserCheckCode(publicTest, SPEC_FILENAME, 'public', false, flagState);
    assert.ok(publicOut.includes('activated: false'), 'a deactivated check must emit activated: false even when live');
    assert.ok(!publicOut.includes('activated: true'), 'the deactivated live check must not remain active');
    assert.ok(publicOut.includes('reviewMigrationFlag'), 'a deactivated check must carry the reviewMigrationFlag tag');

    const privateTest = mkTest({
      public_id: 'syn-aaa-111',
      status: 'live',
      locations: [],
      privateLocations: ['syn-private-loc-one'],
    });
    const privateOut = generateBrowserCheckCode(privateTest, SPEC_FILENAME, 'private', false, flagState);
    assert.ok(privateOut.includes('activated: false'), 'the private branch must also emit activated: false (public/private sync)');
    assert.ok(privateOut.includes('reviewMigrationFlag'), 'the private branch must also carry the reviewMigrationFlag tag');
    assert.ok(privateOut.includes('privateLocations:'), 'the private variant must emit a privateLocations line');
  });

  it('Test 6: a flagged-but-not-deactivated live check emits the tag and preserves activated: true', () => {
    const flagState = {
      flaggedIds: new Set(['syn-bbb-222']),
      deactivatedIds: new Set<string>(),
    };
    const test = mkTest({ public_id: 'syn-bbb-222', status: 'live' });
    const out = generateBrowserCheckCode(test, SPEC_FILENAME, 'public', false, flagState);
    assert.ok(out.includes('reviewMigrationFlag'), 'a flagged check must carry the reviewMigrationFlag tag');
    assert.ok(out.includes('activated: true'), 'a non-deactivating flag must leave a live check active');
    assert.ok(!out.includes('activated: false'), 'a non-deactivating flag must not force the check off');
  });

  it('Test 7: the 4-argument call shape emits no reviewMigrationFlag and activated follows Datadog status (call-compat)', () => {
    const liveOut = generateBrowserCheckCode(mkTest({ status: 'live' }), SPEC_FILENAME, 'public', false);
    assert.ok(!liveOut.includes('reviewMigrationFlag'), 'no flagState means no review tag');
    assert.ok(liveOut.includes('activated: true'), 'a live check with no flagState maps to activated: true');

    const pausedOut = generateBrowserCheckCode(mkTest({ status: 'paused' }), SPEC_FILENAME, 'public', false);
    assert.ok(!pausedOut.includes('reviewMigrationFlag'), 'no flagState means no review tag on a paused check either');
    assert.ok(pausedOut.includes('activated: false'), 'a paused check with no flagState maps to activated: false');
  });

  it('Test 8: DD_TAGS_EXCLUDE_ALL=true cannot strip reviewMigrationFlag or migration_check_id', () => {
    const prior = process.env.DD_TAGS_EXCLUDE_ALL;
    process.env.DD_TAGS_EXCLUDE_ALL = 'true';
    try {
      const flagState = {
        flaggedIds: new Set(['syn-aaa-111']),
        deactivatedIds: new Set(['syn-aaa-111']),
      };
      const out = generateBrowserCheckCode(mkTest({ public_id: 'syn-aaa-111' }), SPEC_FILENAME, 'public', false, flagState);
      assert.ok(out.includes('reviewMigrationFlag'), 'the review tag is appended after filterAndRemapTags and survives exclude-all');
      assert.ok(out.includes('migration_check_id:syn-aaa-111'), 'the traceability tag survives exclude-all alongside it');
    } finally {
      if (prior === undefined) {
        delete process.env.DD_TAGS_EXCLUDE_ALL;
      } else {
        process.env.DD_TAGS_EXCLUDE_ALL = prior;
      }
    }
  });
});
