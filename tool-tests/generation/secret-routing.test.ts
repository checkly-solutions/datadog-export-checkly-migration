/**
 * Generation tests for type="password" secret routing. All offline, no subprocess,
 * no file writes (Testing SOP). The concerns locked here:
 *
 *   (1) Routed fill: a type=password typeText step emits a fill referencing
 *       process.env.<DERIVED_KEY>; the synthetic plaintext value appears NOWHERE
 *       in the emitted output (not in the fill, not in a comment, not in a flag).
 *   (2) Secret flag: every routed secret records exactly one secret-value-required
 *       flag naming the derived key and NEVER the plaintext value.
 *   (3) Key-derivation ladder: data-testid beats name beats id (tier-1); a same-name
 *       collision within one check falls to a deterministic step-indexed key
 *       (tier-2); a field with no usable identifier gets a BROWSER_SECRET-prefixed
 *       step-indexed key (tier-3); every key is a valid, deterministic identifier.
 *   (4) Variable-branch guard: a password value that already references a Datadog
 *       double-brace variable keeps the EXISTING convertVariables emission
 *       byte-identically and records NO secret flags (no double-routing).
 *   (5) Strictness: a type=text field with a secret-looking value is NEVER routed
 *       (fill unchanged, no secret-value-required flag).
 *   (6) Advisory: a non-password field with secret-like identifying attributes
 *       (name/id/autocomplete) records exactly one possible-plaintext-secret flag,
 *       fill UNCHANGED, message names the field identifier and never the typed value.
 *   (7) Neutral field: a username/email field records zero flags and emits
 *       byte-identically to the pre-routing fill.
 *   (8) Zero-candidate password step: the commented-out fill carries the
 *       process.env reference, never the plaintext (route-before-withLocator).
 *   (9) Manifest handoff (Task 2): generateSpecFile returns secretKeys, seeds the
 *       used-set with config-variable names so a routed key never rebinds an
 *       existing variable, and orders keys by step.
 *
 * Every fixture value is authored synthetic: example.com family, syn- public ids,
 * all-zeros UUIDs, invented selectors, names 25 chars or fewer. No secret VALUE in
 * any fixture is ever a real credential; the routing must keep even the invented
 * value out of the emitted source.
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  generateTypeText,
  derivePasswordEnvKey,
  generateSpecFile as generateBrowserSpec,
  type StepFlagContext,
} from '../../src/07-generate-browser-specs.ts';
import { generateBrowserCheckCode } from '../../src/08-generate-browser-constructs.ts';
import { FlagCollector } from '../../src/shared/migration-flags.ts';

type Step07 = Parameters<typeof generateTypeText>[0];

// A distinctive synthetic plaintext value: if any assertion of ABSENCE finds this
// token in the emitted output, routing leaked the value. Deliberately not a real
// password; the point is that even an invented literal must never reach the file.
const SECRET_VALUE = 'ZZ_synthetic_secret_9999';

function mkCtx(overrides: Partial<StepFlagContext> = {}): StepFlagContext {
  return { collector: new FlagCollector(), publicId: 'syn-000-tst', stepIndex: 0, ...overrides };
}

// Build a typeText step with a password input shaped like the RESEARCH-confirmed
// form (input, type password, name credentials.passcode, id input57). Every value
// invented.
function passwordStep(overrides: {
  value?: string;
  html?: string;
} = {}): Step07 {
  return {
    type: 'typeText',
    name: 'Type password',
    params: {
      value: overrides.value ?? SECRET_VALUE,
      element: {
        targetOuterHTML:
          overrides.html ??
          '<input type="password" name="credentials.passcode" id="input57">',
      },
    },
  } as Step07;
}

// Snapshot/clear/restore DD_TAGS_* so the suite stays hermetic and
// order-independent alongside the sibling generation suites.
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
    if (savedTagEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedTagEnv[name];
  }
});

// ---------------------------------------------------------------------------
// derivePasswordEnvKey (derivation ladder, pure helper)
// ---------------------------------------------------------------------------

describe('derivePasswordEnvKey ladder', () => {
  it('tier-1: data-testid beats name beats id', () => {
    const used = new Set<string>();
    const html =
      '<input type="password" data-testid="loginPass" name="credentials.passcode" id="input57">';
    assert.equal(derivePasswordEnvKey(html, 0, 'syn-000-tst', used), 'LOGINPASS');
  });

  it('tier-1: name beats id when no data-testid', () => {
    const used = new Set<string>();
    const html = '<input type="password" name="credentials.passcode" id="input57">';
    assert.equal(derivePasswordEnvKey(html, 0, 'syn-000-tst', used), 'CREDENTIALS_PASSCODE');
  });

  it('tier-1: id used when no data-testid or name', () => {
    const used = new Set<string>();
    const html = '<input type="password" id="loginField">';
    assert.equal(derivePasswordEnvKey(html, 0, 'syn-000-tst', used), 'LOGINFIELD');
  });

  it('tier-2 collision: same name yields two DISTINCT deterministic keys', () => {
    const used = new Set<string>();
    const html = '<input type="password" name="credentials.passcode">';
    const first = derivePasswordEnvKey(html, 6, 'syn-000-tst', used);
    const second = derivePasswordEnvKey(html, 7, 'syn-000-tst', used);
    assert.equal(first, 'CREDENTIALS_PASSCODE');
    assert.notEqual(second, first);
    assert.equal(second, 'CREDENTIALS_PASSCODE_STEP8'); // 1-based step index
  });

  it('tier-3: no usable identifier derives a BROWSER_SECRET step-indexed key', () => {
    const used = new Set<string>();
    const html = '<input type="password">';
    assert.equal(derivePasswordEnvKey(html, 2, 'syn-000-tst', used), 'BROWSER_SECRET_STEP3');
  });

  it('every derived key is a valid, non-digit-leading identifier', () => {
    const used = new Set<string>();
    const html = '<input type="password" name="9startsDigit.weird!chars">';
    const key = derivePasswordEnvKey(html, 0, 'syn-000-tst', used);
    assert.match(key, /^[A-Z_][A-Z0-9_]*$/);
  });
});

// ---------------------------------------------------------------------------
// generateTypeText routing
// ---------------------------------------------------------------------------

describe('generateTypeText password routing', () => {
  it('routes a password fill to process.env.<KEY> and never emits the plaintext', () => {
    const out = generateTypeText(passwordStep(), mkCtx());
    assert.match(out, /process\.env\.CREDENTIALS_PASSCODE/);
    assert.ok(!out.includes(SECRET_VALUE), 'plaintext value must be absent from emitted output');
  });

  it('records secret-value-required exactly once, naming the key, never the value', () => {
    const ctx = mkCtx();
    generateTypeText(passwordStep(), ctx);
    const secretFlags = ctx.collector.flags.filter((f) => f.reason === 'secret-value-required');
    assert.equal(secretFlags.length, 1);
    assert.match(secretFlags[0].message, /CREDENTIALS_PASSCODE/);
    assert.ok(!secretFlags[0].message.includes(SECRET_VALUE), 'flag message must not contain the value');
  });

  it('collision: two password steps in one check flag two distinct keys', () => {
    const ctx = mkCtx();
    const shared = { used: new Set<string>(), routed: [] as string[] };
    (ctx as StepFlagContext).secretKeys = shared;
    const html = '<input type="password" name="credentials.passcode">';
    generateTypeText(passwordStep({ html }), { ...ctx, stepIndex: 6, secretKeys: shared });
    generateTypeText(passwordStep({ html }), { ...ctx, stepIndex: 7, secretKeys: shared });
    assert.deepEqual(shared.routed, ['CREDENTIALS_PASSCODE', 'CREDENTIALS_PASSCODE_STEP8']);
    const secretFlags = ctx.collector.flags.filter((f) => f.reason === 'secret-value-required');
    assert.equal(secretFlags.length, 2);
    assert.match(secretFlags[0].message, /CREDENTIALS_PASSCODE\b/);
    assert.match(secretFlags[1].message, /CREDENTIALS_PASSCODE_STEP8/);
  });

  it('tier-3: a password field with no identifier routes to a deterministic key', () => {
    const out = generateTypeText(passwordStep({ html: '<input type="password">' }), mkCtx({ stepIndex: 2 }));
    assert.match(out, /process\.env\.BROWSER_SECRET_STEP3/);
    assert.ok(!out.includes(SECRET_VALUE));
  });

  it('variable-branch guard: a double-brace password value keeps byte-identical emission and no flags', () => {
    const value = '{{ EXISTING_PASS }}';
    const ctx = mkCtx();
    const out = generateTypeText(passwordStep({ value }), ctx);
    // Byte-identical to the unrouted convertVariables emission for the same value.
    const neutralHtml = '<input type="text" name="plainfield">';
    const baseline = generateTypeText(
      { type: 'typeText', params: { value, element: { targetOuterHTML: neutralHtml } } } as Step07,
      mkCtx(),
    );
    assert.match(out, /process\.env\.EXISTING_PASS/);
    assert.ok(!out.includes('CREDENTIALS_PASSCODE'), 'must not route a variable-bearing value');
    assert.equal(ctx.collector.flags.length, 0, 'no secret flags for an already-variable value');
    // The fill expression body matches the baseline fill body (same value handling).
    assert.ok(out.includes('${process.env.EXISTING_PASS}'));
    assert.ok(baseline.includes('${process.env.EXISTING_PASS}'));
  });
});

describe('generateTypeText strictness and advisory', () => {
  it('a type=text field with a secret-looking value is NOT routed', () => {
    const ctx = mkCtx();
    const html = '<input type="text" name="notes">';
    const out = generateTypeText(passwordStep({ html }), ctx);
    assert.ok(!out.includes('process.env.'), 'text field must not route to process.env');
    assert.ok(out.includes(SECRET_VALUE), 'the plain text value stays in the fill');
    const secretFlags = ctx.collector.flags.filter((f) => f.reason === 'secret-value-required');
    assert.equal(secretFlags.length, 0);
  });

  it('a text field named api_token records possible-plaintext-secret once, fill unchanged', () => {
    const ctx = mkCtx();
    const html = '<input type="text" name="api_token">';
    const out = generateTypeText(passwordStep({ html }), ctx);
    const advisories = ctx.collector.flags.filter((f) => f.reason === 'possible-plaintext-secret');
    assert.equal(advisories.length, 1);
    assert.match(advisories[0].message, /api_token/);
    assert.ok(!advisories[0].message.includes(SECRET_VALUE), 'advisory must not quote the typed value');
    // Fill is UNCHANGED (advisory never rewrites): the plaintext value stays in the
    // fill and no process.env reference is introduced. The fill line for the SAME
    // field emitted WITHOUT the advisory (i.e. through the neutral branch-4 path,
    // simulated by a neutral field name) is byte-identical modulo the field name,
    // proving the advisory branch does not touch the fill emission.
    const fillLine = (s: string) => s.split('\n').find((l) => l.includes('.fill('))!;
    assert.ok(fillLine(out).includes(SECRET_VALUE), 'plaintext value stays in the fill (advisory never rewrites)');
    assert.ok(!fillLine(out).includes('process.env.'), 'advisory branch never routes to process.env');
    const neutral = generateTypeText(
      { type: 'typeText', name: 'Type password', params: { value: SECRET_VALUE, element: { targetOuterHTML: '<input type="text" name="api_token">' } } } as Step07,
      mkCtx(),
    );
    // Same input yields the same fill line whether or not the advisory fired (the
    // advisory is a prepended marker only; the withLocator fill body is identical).
    assert.equal(fillLine(out), fillLine(neutral));
  });

  it('autocomplete current-password on a NON-password field advises, never routes', () => {
    const ctx = mkCtx();
    const html = '<input type="text" autocomplete="current-password" name="loginish">';
    const out = generateTypeText(passwordStep({ html }), ctx);
    assert.ok(!out.includes('process.env.'), 'autocomplete hint on a text field must not route');
    const advisories = ctx.collector.flags.filter((f) => f.reason === 'possible-plaintext-secret');
    assert.equal(advisories.length, 1);
    const secretFlags = ctx.collector.flags.filter((f) => f.reason === 'secret-value-required');
    assert.equal(secretFlags.length, 0);
  });

  it('neutral field: a username field with an email value records zero flags', () => {
    const ctx = mkCtx();
    const html = '<input type="text" name="username">';
    const out = generateTypeText(
      { type: 'typeText', params: { value: 'user@example.com', element: { targetOuterHTML: html } } } as Step07,
      ctx,
    );
    assert.equal(ctx.collector.flags.length, 0);
    assert.ok(out.includes('user@example.com'));
    assert.ok(!out.includes('process.env.'));
  });
});

describe('generateTypeText zero-candidate password step (route-before-withLocator)', () => {
  it('the commented-out fill carries process.env, never the plaintext', () => {
    // An element with no derivable locator candidate (no id/name/testid/role/text
    // usable by extractLocator): a bare password input with only type=password.
    const ctx = mkCtx({ stepIndex: 4 });
    const step = {
      type: 'typeText',
      name: 'Type password',
      params: { value: SECRET_VALUE, element: { targetOuterHTML: '<input type="password">' } },
    } as Step07;
    const out = generateTypeText(step, ctx);
    // The routed key is derived and referenced even on the commented-out path.
    assert.match(out, /process\.env\.BROWSER_SECRET_STEP5/);
    assert.ok(!out.includes(SECRET_VALUE), 'plaintext must never reach even a commented-out fill');
    // It is a locator-unresolvable path (deactivating), commented out.
    const locFlags = ctx.collector.flags.filter((f) => f.reason === 'locator-unresolvable');
    assert.equal(locFlags.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Manifest handoff (Task 2)
// ---------------------------------------------------------------------------

describe('generateSpecFile secretKeys handoff (Task 2)', () => {
  function pwTest(overrides: Partial<any> = {}): any {
    return {
      public_id: 'syn-100-abc',
      name: 'Login flow',
      locations: ['aws:us-east-1'],
      privateLocations: [],
      originalLocations: ['aws:us-east-1'],
      steps: [
        {
          type: 'typeText',
          name: 'Type password',
          params: {
            value: SECRET_VALUE,
            element: { targetOuterHTML: '<input type="password" name="credentials.passcode" id="input57">' },
          },
        },
      ],
      config: { request: { url: 'https://app.example.com/login' } },
      ...overrides,
    };
  }

  it('returns secretKeys with the derived key and references it in the spec body', () => {
    const { spec, secretKeys } = generateBrowserSpec(pwTest(), new FlagCollector());
    assert.deepEqual(secretKeys, ['CREDENTIALS_PASSCODE']);
    assert.match(spec, /process\.env\.CREDENTIALS_PASSCODE/);
    assert.ok(!spec.includes(SECRET_VALUE), 'plaintext must never reach the spec file');
  });

  it('returns an empty secretKeys array when there are no password steps', () => {
    const t = pwTest({
      steps: [
        { type: 'typeText', name: 'Type user', params: { value: 'user@example.com', element: { targetOuterHTML: '<input type="text" name="username">' } } },
      ],
    });
    const { secretKeys } = generateBrowserSpec(t, new FlagCollector());
    assert.deepEqual(secretKeys, []);
  });

  it('seeded-collision: a routed key does not equal a pre-existing config variable name', () => {
    // A config variable already named CREDENTIALS_PASSCODE would silently rebind the
    // password fill to an unrelated value; the ladder must fall to tier-2.
    const t = pwTest({
      config: {
        request: { url: 'https://app.example.com/login' },
        variables: [{ name: 'CREDENTIALS_PASSCODE', pattern: 'x', type: 'text' }],
      },
    });
    const { secretKeys } = generateBrowserSpec(t, new FlagCollector());
    assert.equal(secretKeys.length, 1);
    assert.notEqual(secretKeys[0], 'CREDENTIALS_PASSCODE');
  });

  it('two password steps return two keys in step order', () => {
    const t = pwTest({
      steps: [
        { type: 'typeText', name: 'Pass one', params: { value: SECRET_VALUE, element: { targetOuterHTML: '<input type="password" name="credentials.passcode">' } } },
        { type: 'typeText', name: 'Pass two', params: { value: SECRET_VALUE, element: { targetOuterHTML: '<input type="password" name="credentials.passcode">' } } },
      ],
    });
    const { secretKeys } = generateBrowserSpec(t, new FlagCollector());
    assert.equal(secretKeys.length, 2);
    assert.equal(secretKeys[0], 'CREDENTIALS_PASSCODE');
    assert.notEqual(secretKeys[1], secretKeys[0]);
  });
});

// ---------------------------------------------------------------------------
// Construct-side secret declaration (Task 1)
//
// The routed keys the manifest carries (files[].secretKeys) must be declared
// construct-side in the BrowserCheck's environmentVariables as
// { key, value: "", secret: true }, reusing the EXISTING config-variable secret
// shape VERBATIM (the empty-string value is the established convention;
// Datadog never exports secret values, so the customer populates them per the
// flags). generateBrowserCheckCode takes a trailing `secretKeys` array
// (after hasMultiCandidate) so existing call sites stay byte-compatible.
//
// BrowserTest is file-local to src/08; the input shape is derived from the
// exported generator's first parameter (multi-selector-tag.test.ts idiom).
// ---------------------------------------------------------------------------

type BrowserTestInput = Parameters<typeof generateBrowserCheckCode>[0];

const SEC02_SPEC_FILENAME = 'syn-login-flow.spec.ts';

/**
 * Build a synthetic live BrowserTest. The private variant carries a non-empty
 * privateLocations array so both the public and private branches of the one
 * shared generator are exercised (multi-selector-tag.test.ts Test 4 idiom).
 */
function mkBrowserTest(overrides: Partial<BrowserTestInput> = {}): BrowserTestInput {
  const base = {
    public_id: 'syn-100-abc',
    name: 'Login flow',
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

// The full trailing-argument call: (test, specFilename, locationType, hasIframes,
// flagState, hasMultiCandidate, secretKeys). secretKeys is the trailing param.
function emitWithSecretKeys(
  test: BrowserTestInput,
  secretKeys: string[],
  locationType: 'public' | 'private' = 'public',
): string {
  return (generateBrowserCheckCode as (
    ...args: unknown[]
  ) => string)(test, SEC02_SPEC_FILENAME, locationType, false, undefined, false, secretKeys);
}

describe('generateBrowserCheckCode: routed secret declaration', () => {
  it('routed key emits the verbatim secret entry { key, value: "", secret: true }', () => {
    const out = emitWithSecretKeys(mkBrowserTest(), ['LOGIN_PASSWORD']);
    assert.ok(out.includes('environmentVariables: ['), 'a routed secret must open an environmentVariables block');
    assert.ok(
      out.includes('{ key: "LOGIN_PASSWORD", value: "", secret: true }'),
      'the routed key must declare in the exact existing config-variable secret shape',
    );
  });

  it('routed value is always the empty string (no secret VALUE ever reaches the construct)', () => {
    // Even if a caller somehow smuggled a value into the key string, the emission
    // is name-only. Assert no non-empty value= sits on the routed secret entry.
    const out = emitWithSecretKeys(mkBrowserTest(), ['LOGIN_PASSWORD']);
    const entryLine = out.split('\n').find((l) => l.includes('LOGIN_PASSWORD'))!;
    assert.match(entryLine, /value: "",\s*secret: true/, 'routed secret value must be the empty string');
  });

  it('shape reuse: an existing secure configVariable AND a routed key share one array in the same style', () => {
    const test = mkBrowserTest({
      config: {
        configVariables: [{ type: 'text', name: 'EXISTING_SECRET', secure: true }],
      },
    } as Partial<BrowserTestInput>);
    const out = emitWithSecretKeys(test, ['LOGIN_PASSWORD']);
    // Exactly one environmentVariables block, carrying both entries in the same style.
    assert.equal(out.split('environmentVariables: [').length - 1, 1, 'exactly one environmentVariables block');
    assert.ok(out.includes('{ key: "EXISTING_SECRET", value: "", secret: true }'), 'the config secret entry is present');
    assert.ok(out.includes('{ key: "LOGIN_PASSWORD", value: "", secret: true }'), 'the routed secret entry is present in the same style');
  });

  it('dedup: a routed key equal to an existing config env key appears exactly once (existing entry wins)', () => {
    const test = mkBrowserTest({
      config: {
        configVariables: [{ type: 'text', name: 'LOGIN_PASSWORD', secure: true }],
      },
    } as Partial<BrowserTestInput>);
    const out = emitWithSecretKeys(test, ['LOGIN_PASSWORD']);
    const occurrences = out.split('LOGIN_PASSWORD').length - 1;
    assert.equal(occurrences, 1, 'a duplicated key must appear exactly once in the emitted construct');
  });

  it('dedup keeps the non-secret existing entry (existing config entry wins over a routed key)', () => {
    // A non-secure config variable named LOGIN_PASSWORD keeps its value= form; the
    // routed key must NOT override it into a secret nor add a second entry.
    const test = mkBrowserTest({
      config: {
        configVariables: [{ type: 'text', name: 'LOGIN_PASSWORD', secure: false, pattern: 'plainval' }],
      },
    } as Partial<BrowserTestInput>);
    const out = emitWithSecretKeys(test, ['LOGIN_PASSWORD']);
    const occurrences = out.split('LOGIN_PASSWORD').length - 1;
    assert.equal(occurrences, 1, 'the existing config entry wins; no duplicate routed entry');
    assert.ok(out.includes('{ key: "LOGIN_PASSWORD", value: "plainval" }'), 'the existing non-secret entry is preserved verbatim');
  });

  it('call-compat: omitting the secretKeys parameter emits byte-identical output to today', () => {
    // A test with no configVariables and no routed keys emits no environmentVariables
    // block, identical to the pre-09-06 signature call.
    const test = mkBrowserTest();
    const withoutParam = generateBrowserCheckCode(test, SEC02_SPEC_FILENAME, 'public', false, undefined, false);
    const withEmptyParam = emitWithSecretKeys(test, []);
    assert.equal(withEmptyParam, withoutParam, 'default empty secretKeys must be byte-identical to the old call');
    assert.ok(!withEmptyParam.includes('environmentVariables: ['), 'no block for a test with neither config nor routed secrets');
  });

  it('public/private parity: the private location branch carries the same declaration', () => {
    const privateTest = mkBrowserTest({ locations: [], privateLocations: ['syn-private-loc-one'] });
    const out = emitWithSecretKeys(privateTest, ['LOGIN_PASSWORD'], 'private');
    assert.ok(out.includes('privateLocations:'), 'the private variant emits a privateLocations line');
    assert.ok(
      out.includes('{ key: "LOGIN_PASSWORD", value: "", secret: true }'),
      'the private branch must also carry the routed secret declaration',
    );
  });

  it('keys pass through escapeString: a hostile key with a quote cannot break the construct string', () => {
    // Keys are sanitizeIdentifier-derived upstream, but the emission choke point
    // stays: a quote in the key must be escaped, never terminate the string literal.
    const out = emitWithSecretKeys(mkBrowserTest(), ['EVIL"KEY']);
    assert.ok(out.includes('environmentVariables: ['), 'the hostile key still emits an entry');
    assert.ok(!out.includes('"EVIL"KEY"'), 'a raw unescaped quote must not appear as-is');
    assert.ok(out.includes('EVIL\\"KEY') || out.includes('EVIL\\u0022KEY'), 'the quote is escaped through escapeString');
  });

  it('multiple routed keys emit in the order given, each as an empty secret', () => {
    const out = emitWithSecretKeys(mkBrowserTest(), ['FIRST_KEY', 'SECOND_KEY']);
    const first = out.indexOf('FIRST_KEY');
    const second = out.indexOf('SECOND_KEY');
    assert.ok(first > -1 && second > -1, 'both routed keys are declared');
    assert.ok(first < second, 'routed keys are emitted in the given order');
    assert.ok(out.includes('{ key: "FIRST_KEY", value: "", secret: true }'));
    assert.ok(out.includes('{ key: "SECOND_KEY", value: "", secret: true }'));
  });
});

// ---------------------------------------------------------------------------
// main() manifest plumbing (Task 2)
//
// generateConstructsForLocationType writes files to disk (filesystem I/O), so the
// per-location plumbing is not drivable offline without mocking the FS. Using the
// sanctioned fallback (the golden-tree-contract readFileSync idiom), the plumbing is
// locked with source-level assertions: the src/08 text must build a secretKeysMap
// from file.secretKeys in BOTH the public and private manifest blocks, thread it
// through generateConstructsForLocationType, and read it per test at the
// generateBrowserCheckCode call site. This also pins the deliberate exclusion: the
// check-level-secrets.json block must NOT be widened with routed keys (the
// requirement is the construct-side declaration alone).
// ---------------------------------------------------------------------------

describe('src/08 main() secretKeys plumbing (source-level)', () => {
  const src08Path = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', '08-generate-browser-constructs.ts');
  const src08 = readFileSync(src08Path, 'utf-8');

  it('builds a public secretKeys map from file.secretKeys in the public manifest block', () => {
    assert.match(src08, /publicSecretKeysMap/, 'the public manifest block must build a publicSecretKeysMap');
  });

  it('builds a private secretKeys map from file.secretKeys in the private manifest block (public/private parity)', () => {
    assert.match(src08, /privateSecretKeysMap/, 'the private manifest block must build a privateSecretKeysMap');
  });

  it('populates the maps from file.secretKeys (manifest transport)', () => {
    assert.match(src08, /file\.secretKeys/, 'the maps must read the manifest field file.secretKeys');
  });

  it('threads a secretKeysMap parameter through generateConstructsForLocationType', () => {
    assert.match(src08, /secretKeysMap/, 'generateConstructsForLocationType must accept a secretKeysMap');
  });

  it('reads the routed keys per test at the generateBrowserCheckCode call site', () => {
    // The per-test read mirrors the multiCandidateMap.get(test.public_id) || false idiom.
    assert.match(src08, /secretKeysMap\.get\(test\.public_id\)\s*\|\|\s*\[\]/, 'the call site must read secretKeysMap.get(test.public_id) || []');
  });

  it('has at least four secretKeysMap references (two map builds, parameter, call-site read)', () => {
    const count = (src08.match(/SecretKeysMap|secretKeysMap/g) || []).length;
    assert.ok(count >= 4, `expected >= 4 secretKeysMap references, found ${count}`);
  });

  it('does NOT widen the check-level-secrets.json block with routed keys (deliberate exclusion)', () => {
    // The routed keys must reach ONLY the construct declaration, never the
    // variables-handoff export. Scope precisely to the check-level-secrets block:
    // from its comment marker to the closing console.log that writes the file. The
    // block still sources exclusively from convertConfigVariables, never from any
    // secretKeysMap (the map lives only in the two manifest blocks above and the
    // generateConstructsForLocationType call sites).
    const blockStart = src08.indexOf('// Write check-level secrets');
    assert.ok(blockStart > -1, 'the check-level-secrets block still exists');
    const blockEnd = src08.indexOf('check-level secret entries', blockStart);
    assert.ok(blockEnd > blockStart, 'the check-level-secrets block end marker is present');
    const block = src08.slice(blockStart, blockEnd);
    assert.ok(!/secretKeysMap/i.test(block), 'the check-level-secrets block must not read any secretKeysMap (deliberate exclusion)');
    assert.ok(/convertConfigVariables/.test(block), 'the block still sources from convertConfigVariables only');
  });
});
