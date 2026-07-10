/**
 * Characterization tests for the shared helpers in src/shared/utils.ts (D-08).
 *
 * RULE: these tests pin the CURRENT observed behavior of the helpers,
 * including known bugs. They are not a wishlist. If an expectation here
 * surprises you, do NOT modify src/shared/utils.ts; update the expectation
 * to the observed reality instead.
 *
 * EXCEPTION: the sanitizeIdentifier, uniqueLogicalId, and
 * normalizePublicChecklyLocations describes below assert NEW correct behavior
 * landed in Phase 6 (Blocking Deployability). The former TRKB-03 digit-guard
 * bug is fixed here, so those cases now run as real assertions rather than
 * characterization pins. Every other expected value was derived by reading the
 * implementation and confirmed by executing it.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertFrequency,
  sanitizeIdentifier,
  sanitizeFilename,
  publicIdSlugTail,
  uniqueLogicalId,
  normalizePublicChecklyLocations,
  escapeString,
  escapeRegex,
  parseDatadogRegex,
  filterAndRemapTags,
  convertConfigVariables,
} from '../../src/shared/utils.ts';

/**
 * filterAndRemapTags reads process.env.DD_TAGS_EXCLUDE, DD_TAGS_EXCLUDE_ALL,
 * and DD_TAGS_REMAP at call time. Every describe below that touches them
 * snapshots all three vars in a before hook and restores them exactly in an
 * after hook (deleting any var that was undefined), so a developer shell with
 * DD_TAGS_* set cannot bleed into or out of these tests (RESEARCH.md Pattern 3).
 */
const DD_TAG_VARS = ['DD_TAGS_EXCLUDE', 'DD_TAGS_EXCLUDE_ALL', 'DD_TAGS_REMAP'] as const;

function snapshotTagEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const name of DD_TAG_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  return saved;
}

function restoreTagEnv(saved: Record<string, string | undefined>): void {
  for (const name of DD_TAG_VARS) {
    if (saved[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = saved[name];
    }
  }
}

describe('convertFrequency', () => {
  it('maps 60 seconds to EVERY_1M', () => {
    assert.strictEqual(convertFrequency(60), 'EVERY_1M');
  });

  it('maps 120 seconds to EVERY_2M', () => {
    assert.strictEqual(convertFrequency(120), 'EVERY_2M');
  });

  it('maps 300 seconds to EVERY_5M', () => {
    assert.strictEqual(convertFrequency(300), 'EVERY_5M');
  });

  it('maps 900 seconds to EVERY_15M', () => {
    assert.strictEqual(convertFrequency(900), 'EVERY_15M');
  });

  it('maps 3600 seconds to EVERY_1H', () => {
    assert.strictEqual(convertFrequency(3600), 'EVERY_1H');
  });

  it('maps 86400 seconds to EVERY_24H', () => {
    assert.strictEqual(convertFrequency(86400), 'EVERY_24H');
  });

  it('rounds a between-bucket value up to the next bucket (450 -> EVERY_10M)', () => {
    assert.strictEqual(convertFrequency(450), 'EVERY_10M');
  });

  it('maps 14400 seconds (4h) to EVERY_6H because Checkly has no EVERY_4H', () => {
    assert.strictEqual(convertFrequency(14400), 'EVERY_6H');
  });

  // Characterization: undefined falls into the `tickEvery || 300` default,
  // which resolves to EVERY_5M. The in-repo docs that claim an EVERY_10M
  // default for undefined do not match the code; EVERY_10M is only the
  // fallback for values above every mapped bucket (see next test).
  it('defaults undefined to EVERY_5M via the 300-second fallback', () => {
    assert.strictEqual(convertFrequency(undefined), 'EVERY_5M');
  });

  it('defaults 0 (falsy) to EVERY_5M via the 300-second fallback', () => {
    assert.strictEqual(convertFrequency(0), 'EVERY_5M');
  });

  it('falls back to EVERY_10M for values above the largest bucket (100000)', () => {
    assert.strictEqual(convertFrequency(100000), 'EVERY_10M');
  });
});

describe('sanitizeIdentifier', () => {
  it('keeps a plain alphanumeric-with-space name, replacing the space with an underscore', () => {
    assert.strictEqual(sanitizeIdentifier('My Check'), 'My_Check');
  });

  it('collapses runs of special characters and spaces into single underscores', () => {
    assert.strictEqual(sanitizeIdentifier('api--v2  check'), 'api_v2_check');
  });

  // The digit guard runs AFTER the trailing-underscore strip, so '2fa login!'
  // (which slugs to a digit-leading '2fa_login') gains a leading underscore.
  // This case pins that ordering: the guard is applied last and survives.
  it('applies the digit guard after the trailing-underscore strip (2fa login! -> _2fa_login)', () => {
    assert.strictEqual(sanitizeIdentifier('2fa login!'), '_2fa_login');
  });

  // TRKB-03 is fixed in Phase 6 (this change). The old sanitizeIdentifier
  // ordering ran replace(/^_|_$/g,'') AFTER the digit guard, stripping the
  // leading underscore the guard had just added, so digit-only and all-special
  // inputs came out invalid for TypeScript. The fix moves the guard to last.
  // The TRKB-03 reference is kept for traceability.
  it('preserves leading underscore for digit-only input', () => {
    assert.strictEqual(sanitizeIdentifier('123'), '_123');
  });

  it('returns non-empty string for all-special-char input', () => {
    assert.ok(sanitizeIdentifier('---').length > 0, 'must not return empty string');
  });
});

/**
 * Specification tests for sanitizeFilename after the DEPLOY-08 / D-07 fix.
 *
 * This is the file-write sibling of the DEPLOY-01 logical-ID fix. Per D-07 the
 * public_id tail is now ALWAYS appended (not only when the slug exceeds 50
 * chars), so two short same-named Datadog tests can never slug to the same
 * filename and silently overwrite each other on disk. The tail is derived by the
 * shared publicIdSlugTail helper, the same formula uniqueLogicalId uses, so the
 * two can never drift. These assert NEW correct behavior (not characterization).
 * All inputs are invented synthetic values (syn- public ids, <=25-char names).
 */
describe('sanitizeFilename DEPLOY-08 / D-07: always-append public_id tail', () => {
  it('WR-02: two short same-names with distinct public_ids get DISTINCT filenames', () => {
    const a = sanitizeFilename('Synthetic Browser Flow', 'syn-006-pqr');
    const b = sanitizeFilename('Synthetic Browser Flow', 'syn-206-tuv');
    assert.notStrictEqual(a, b, 'same name + distinct public_id must not collide on disk');
    assert.ok(a.endsWith('syn-006-pqr'), `a must end with its own dashed tail: ${a}`);
    assert.ok(b.endsWith('syn-206-tuv'), `b must end with its own dashed tail: ${b}`);
    assert.ok(a.length <= 50 && b.length <= 50, 'both must respect the 50-char cap');
  });

  it('appends the full dashed tail to a short slug (no truncation needed)', () => {
    assert.strictEqual(
      sanitizeFilename('Synthetic Browser Flow', 'syn-006-pqr'),
      'synthetic-browser-flow-syn-006-pqr',
    );
  });

  it('truncates the HEAD slug (trailing dashes trimmed) so slug + tail fits 50 chars', () => {
    // slug is well over 50 chars; tail "syn-006-pqr" is 11 chars, plus one
    // separator dash, so the head is truncated to 50 - 11 - 1 = 38 chars with
    // trailing dashes trimmed, then joined with the full dashed tail.
    const longName = 'A very long synthetic browser regression flow name that definitely exceeds fifty characters';
    const result = sanitizeFilename(longName, 'syn-006-pqr');
    assert.ok(result.length <= 50, `must be at most 50 chars: ${result} (${result.length})`);
    assert.ok(result.endsWith('-syn-006-pqr'), `tail must be the full dashed public_id: ${result}`);
    assert.doesNotMatch(result, /--/, 'no doubled dashes at the head/tail seam');
    const head = result.slice(0, result.length - '-syn-006-pqr'.length);
    assert.doesNotMatch(head, /-$/, 'the truncated head must have trailing dashes trimmed');
    assert.ok(
      longName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').startsWith(head),
      'the head must be a prefix of the full slug',
    );
  });

  it('preserves prior behavior exactly when no uniqueId is provided', () => {
    // short slug passthrough
    assert.strictEqual(sanitizeFilename('Synthetic Browser Flow'), 'synthetic-browser-flow');
    // long slug truncated to 50, no tail
    const longName = 'A very long synthetic browser regression flow name that definitely exceeds fifty characters';
    const noId = sanitizeFilename(longName);
    assert.strictEqual(noId.length, 50, 'no uniqueId: long slug truncated to exactly 50');
    assert.strictEqual(
      noId,
      longName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50),
    );
  });

  it('a degenerate all-punctuation name yields just the tail with no leading dash', () => {
    // empty slug + non-empty tail: filter-empty join gives the bare tail.
    assert.strictEqual(sanitizeFilename('!!!', 'syn-006-pqr'), 'syn-006-pqr');
    assert.doesNotMatch(sanitizeFilename('!!!', 'syn-006-pqr'), /^-/, 'no leading dash');
  });

  it('a degenerate all-punctuation uniqueId still yields a non-empty deterministic tail, distinct per id', () => {
    const a = sanitizeFilename('Some Name', '@@@');
    const b = sanitizeFilename('Some Name', '###');
    assert.ok(a.length > 0 && b.length > 0, 'both must be non-empty');
    assert.notStrictEqual(a, b, 'distinct degenerate uniqueIds must yield distinct tails');
    // determinism: same input twice yields the same output.
    assert.strictEqual(sanitizeFilename('Some Name', '@@@'), a);
  });
});

/**
 * publicIdSlugTail (DEPLOY-08 / D-07) is the shared tail-derivation helper
 * extracted from uniqueLogicalId so sanitizeFilename and uniqueLogicalId cannot
 * drift. It lowercases, coerces non-alphanumeric runs to single dashes, trims,
 * and falls back to a stable char-code hex tail (WR-01) for degenerate all-
 * punctuation input so a non-empty raw always contributes a non-empty tail.
 */
describe('publicIdSlugTail', () => {
  it('dash-coerces and lowercases a normal syn- public_id', () => {
    assert.strictEqual(publicIdSlugTail('syn-006-pqr'), 'syn-006-pqr');
    assert.strictEqual(publicIdSlugTail('SYN_ABC'), 'syn-abc');
  });

  it('returns an empty tail for empty input', () => {
    assert.strictEqual(publicIdSlugTail(''), '');
  });

  it('falls back to a non-empty deterministic hex tail for all-punctuation input, distinct per id', () => {
    const a = publicIdSlugTail('@@@');
    const b = publicIdSlugTail('###');
    assert.ok(a.length > 0 && b.length > 0, 'degenerate input must still yield a non-empty tail');
    assert.notStrictEqual(a, b, 'distinct degenerate inputs must yield distinct tails');
    assert.match(a, /^x[0-9a-f]+$/, 'the fallback tail is the x-prefixed hex form');
  });
});

/**
 * Specification tests for uniqueLogicalId (D-01/D-02). This is the single
 * source of truth for construct emit sites AND the step-12 CSV writer, so
 * every check gets a project-unique logical ID derived from its name plus its
 * Datadog public_id. Output stays inside Checkly's LOGICAL_ID_PATTERN
 * (/^[A-Za-z0-9_\-/#.]+$/, verified against installed checkly@8.13.0
 * dist/constants.js); the tail sanitization here produces a strict subset of
 * that pattern (lowercase letters, digits, single dashes).
 */
describe('uniqueLogicalId', () => {
  it('composes prefix, name slug, and public_id tail with single dashes', () => {
    assert.strictEqual(
      uniqueLogicalId('browser', 'Login Flow', 'syn-abc-123'),
      'browser-login-flow-syn-abc-123'
    );
  });

  // Byte-identity pin (DEPLOY-08 refactor guard): extracting the tail-derivation
  // block into publicIdSlugTail must not change uniqueLogicalId output for any
  // input. This value is pinned from the pre-refactor implementation.
  it('is byte-identical after the publicIdSlugTail extraction (refactor guard)', () => {
    assert.strictEqual(
      uniqueLogicalId('browser', 'Synthetic Browser Flow', 'syn-006-pqr'),
      'browser-synthetic-browser-flow-syn-006-pqr'
    );
  });

  it('yields distinct IDs for same name but different public_id (DEPLOY-01 foundation)', () => {
    const a = uniqueLogicalId('browser', 'Login Flow', 'syn-abc-123');
    const b = uniqueLogicalId('browser', 'Login Flow', 'syn-xyz-789');
    assert.notStrictEqual(a, b);
  });

  it('lowercases and coerces an uppercase/underscore-bearing publicId tail', () => {
    const result = uniqueLogicalId('api', 'Health Check', 'SYN_ABC');
    assert.match(result, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(result.includes('syn-abc'), 'SYN_ABC must lowercase and dash-coerce to syn-abc');
  });

  it('handles a degenerate all-punctuation name with no doubled or trailing dashes', () => {
    const result = uniqueLogicalId('browser', '!!!', 'syn-abc-123');
    assert.strictEqual(result, 'browser-syn-abc-123');
    assert.doesNotMatch(result, /--/, 'must not contain doubled dashes');
    assert.doesNotMatch(result, /-$/, 'must not end with a dash');
  });

  it('stays within a strict subset of Checkly LOGICAL_ID_PATTERN', () => {
    const result = uniqueLogicalId('browser', 'Odd  Name -- Here!', 'SYN/ABC 789');
    // Anchored: starts with lowercase letter or digit, then only lowercase
    // letters, digits, or single dashes. This is a subset of /^[A-Za-z0-9_\-/#.]+$/.
    assert.match(result, /^[a-z0-9][a-z0-9-]*$/);
    assert.doesNotMatch(result, /--/, 'no doubled dashes');
    assert.doesNotMatch(result, /^-|-$/, 'no leading or trailing dash');
  });
});

/**
 * WR-01 hardening (VAL-09, plan 06-06). The helper's contract is that a
 * non-empty publicId always contributes a non-empty discriminator, so two
 * checks with distinct publicIds never collide, even on degenerate input.
 * Before the fix, an all-punctuation name AND an all-punctuation publicId both
 * slugged to empty and the .filter(Boolean) dropped the only disambiguator, so
 * uniqueLogicalId('api', '', '@@@') collapsed to the bare prefix 'api' and
 * distinct all-punctuation publicIds collided. Not reachable with real syn- ids
 * (they never slug empty), but it violated the uniqueness guarantee. All inputs
 * below are invented synthetic values, never real Datadog ids.
 */
describe('uniqueLogicalId WR-01 degenerate hardening', () => {
  it('never collapses to the bare prefix when publicId is non-empty', () => {
    // Was 'api' before the fix (fails-first): both name and publicId slug empty.
    assert.notStrictEqual(uniqueLogicalId('api', '', '@@@'), 'api');
  });

  it('keeps distinct non-empty publicIds distinct even when both sanitize to empty tails', () => {
    // Was a collision on 'api' before the fix (fails-first).
    assert.notStrictEqual(
      uniqueLogicalId('api', '', '@@@'),
      uniqueLogicalId('api', '', '###')
    );
  });

  it('leaves the non-degenerate path byte-identical (real syn- id regression pin)', () => {
    // The fix must not touch output when the publicId slugs to a non-empty tail.
    assert.strictEqual(
      uniqueLogicalId('browser', 'Login Flow', 'syn-001-abc'),
      'browser-login-flow-syn-001-abc'
    );
  });
});

describe('normalizePublicChecklyLocations dedup', () => {
  it('dedupes after the aws: prefix collapse (D-06)', () => {
    assert.deepStrictEqual(
      normalizePublicChecklyLocations(['aws:us-east-1', 'us-east-1']),
      ['us-east-1']
    );
  });

  it('returns an already-unique list unchanged and in order', () => {
    assert.deepStrictEqual(
      normalizePublicChecklyLocations(['us-east-1', 'eu-west-1']),
      ['us-east-1', 'eu-west-1']
    );
  });
});

describe('escapeString', () => {
  it('returns a plain string unchanged', () => {
    assert.strictEqual(escapeString('hello world'), 'hello world');
  });

  it('escapes embedded double quotes', () => {
    assert.strictEqual(escapeString('say "hi"'), 'say \\"hi\\"');
  });

  it('escapes backslashes', () => {
    assert.strictEqual(escapeString('a\\b'), 'a\\\\b');
  });

  it('escapes newlines', () => {
    assert.strictEqual(escapeString('line1\nline2'), 'line1\\nline2');
  });

  it('escapes carriage returns and tabs alongside newlines', () => {
    assert.strictEqual(escapeString('a\r\nb\tc'), 'a\\r\\nb\\tc');
  });

  it('returns an empty string for empty (falsy) input', () => {
    assert.strictEqual(escapeString(''), '');
  });
});

describe('filterAndRemapTags: DD_TAGS_EXCLUDE wildcard patterns', () => {
  let saved: Record<string, string | undefined>;

  before(() => {
    saved = snapshotTagEnv();
    process.env.DD_TAGS_EXCLUDE = 'browsertype:*,device:*';
  });

  after(() => {
    restoreTagEnv(saved);
  });

  it('removes tags matching any wildcard pattern and keeps the rest', () => {
    const result = filterAndRemapTags(['browsertype:chrome', 'team:ops', 'device:mobile']);
    assert.deepStrictEqual(result, ['team:ops']);
  });
});

describe('filterAndRemapTags: DD_TAGS_EXCLUDE exact match', () => {
  let saved: Record<string, string | undefined>;

  before(() => {
    saved = snapshotTagEnv();
    process.env.DD_TAGS_EXCLUDE = 'team:ops';
  });

  after(() => {
    restoreTagEnv(saved);
  });

  it('removes only the exact tag; a longer tag sharing the prefix survives', () => {
    const result = filterAndRemapTags(['team:ops', 'team:opsy', 'env:prod']);
    assert.deepStrictEqual(result, ['team:opsy', 'env:prod']);
  });
});

describe('filterAndRemapTags: all DD_TAGS_* vars unset', () => {
  let saved: Record<string, string | undefined>;

  before(() => {
    // snapshotTagEnv deletes all three vars, so this describe runs with a
    // guaranteed-unset state regardless of the developer shell.
    saved = snapshotTagEnv();
  });

  after(() => {
    restoreTagEnv(saved);
  });

  it('passes every tag through unchanged, including Datadog system tags', () => {
    const tags = ['browsertype:chrome', 'team:ops', 'device:mobile', 'type:api'];
    assert.deepStrictEqual(filterAndRemapTags(tags), tags);
  });

  it('returns an empty array for empty input', () => {
    assert.deepStrictEqual(filterAndRemapTags([]), []);
  });
});

describe('filterAndRemapTags: DD_TAGS_EXCLUDE_ALL=true default set', () => {
  let saved: Record<string, string | undefined>;

  before(() => {
    saved = snapshotTagEnv();
    process.env.DD_TAGS_EXCLUDE_ALL = 'true';
  });

  after(() => {
    restoreTagEnv(saved);
  });

  it('removes Datadog system tags from the default exclusion set and keeps user tags', () => {
    const result = filterAndRemapTags(['browsertype:chrome', 'team:ops', 'type:api', 'env:prod']);
    assert.deepStrictEqual(result, ['team:ops', 'env:prod']);
  });
});

describe('filterAndRemapTags: DD_TAGS_REMAP', () => {
  let saved: Record<string, string | undefined>;

  before(() => {
    saved = snapshotTagEnv();
    process.env.DD_TAGS_REMAP = 'check_status:alert->status:alert';
  });

  after(() => {
    restoreTagEnv(saved);
  });

  it('renames a remapped tag to its new key and leaves other tags alone', () => {
    const result = filterAndRemapTags(['check_status:alert', 'team:ops']);
    assert.deepStrictEqual(result, ['status:alert', 'team:ops']);
  });
});

describe('convertConfigVariables', () => {
  it('converts a plain text variable to a key/value pair using its pattern', () => {
    const result = convertConfigVariables([
      { type: 'text', name: 'HOST', pattern: 'example.com' },
    ]);
    assert.deepStrictEqual(result, [{ key: 'HOST', value: 'example.com' }]);
  });

  it('uses an empty string value when a text variable has no pattern', () => {
    const result = convertConfigVariables([{ type: 'text', name: 'HOST' }]);
    assert.deepStrictEqual(result, [{ key: 'HOST', value: '' }]);
  });

  it('marks secure text variables as secrets with an empty value', () => {
    const result = convertConfigVariables([{ type: 'text', name: 'TOKEN', secure: true }]);
    assert.deepStrictEqual(result, [{ key: 'TOKEN', value: '', secret: true }]);
  });

  it('skips global variables (handled at account level by step 09)', () => {
    const result = convertConfigVariables([
      { type: 'global', name: 'GLOBAL_VAR', id: '00000000-0000-0000-0000-000000000000' },
    ]);
    assert.deepStrictEqual(result, []);
  });

  it('converts mixed input preserving order and dropping non-text entries', () => {
    const result = convertConfigVariables([
      { type: 'text', name: 'HOST', pattern: 'example.com' },
      { type: 'global', name: 'GLOBAL_VAR' },
      { type: 'text', name: 'TOKEN', secure: true },
    ]);
    assert.deepStrictEqual(result, [
      { key: 'HOST', value: 'example.com' },
      { key: 'TOKEN', value: '', secret: true },
    ]);
  });

  it('returns an empty array for undefined, null, and empty input', () => {
    assert.deepStrictEqual(convertConfigVariables(undefined), []);
    assert.deepStrictEqual(convertConfigVariables(null), []);
    assert.deepStrictEqual(convertConfigVariables([]), []);
  });
});

/**
 * Specification tests for helpers added in Phase 2 (regex escaping
 * foundation). Unlike the characterization rule in this file's header,
 * these describes assert NEW correct behavior: the helpers were written
 * to satisfy these expectations, not the other way around.
 */
describe('escapeRegex', () => {
  it('escapes all MDN metacharacters', () => {
    assert.equal(
      escapeRegex('a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o'),
      'a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o'
    );
  });

  it('returns empty string for empty input', () => {
    assert.equal(escapeRegex(''), '');
  });

  it('round-trips: escaped literal matches itself', () => {
    const literal = 'Total: $42.50 (net)';
    assert.ok(new RegExp('^' + escapeRegex(literal)).test(literal));
  });

  it('does not escape the forward slash', () => {
    assert.equal(escapeRegex('a/b'), 'a/b');
  });

  it('passes through a string with no metacharacters unchanged', () => {
    assert.equal(escapeRegex('plain text 123'), 'plain text 123');
  });
});

describe('parseDatadogRegex', () => {
  it('returns a bare pattern verbatim with empty flags', () => {
    assert.deepEqual(parseDatadogRegex('\\d+'), { source: '\\d+', flags: '' });
  });

  it('strips the wrapper from a slash-wrapped pattern with flags', () => {
    assert.deepEqual(parseDatadogRegex('/\\b\\d{6}\\b/g'), { source: '\\b\\d{6}\\b', flags: 'g' });
  });

  it('strips the wrapper from a slash-wrapped pattern without flags', () => {
    assert.deepEqual(parseDatadogRegex('/abc/'), { source: 'abc', flags: '' });
  });

  it('leaves a value with internal slashes bare when not slash-wrapped', () => {
    assert.deepEqual(parseDatadogRegex('a/b'), { source: 'a/b', flags: '' });
  });

  it('captures internal slashes greedily inside a slash-wrapped value', () => {
    assert.deepEqual(parseDatadogRegex('/a/b/'), { source: 'a/b', flags: '' });
  });

  it('returns a bare capture-group pattern verbatim', () => {
    assert.deepEqual(parseDatadogRegex('code=(\\d{4})'), { source: 'code=(\\d{4})', flags: '' });
  });
});
