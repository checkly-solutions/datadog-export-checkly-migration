/**
 * Generation tests for the API check pipeline seam (VAL-01, D-04).
 *
 * Chains the exported convertTest from step 02 into generateApiCheckCode from
 * step 04, so no hand-authored ChecklyCheck shape is needed and the two
 * contracts stay consistent. All assertions are structural (key lines present
 * or absent in the returned string), never full-string snapshots (D-03).
 * No subprocess, no file writes: the generators are called in-process and
 * their return values are asserted directly.
 *
 * Baseline scope note: these tests prove the seam works and pin core emission
 * behavior. Work-order behavioral cases (redirects-off, allow-insecure, regex
 * promotion, etc.) land with their fixes in phases 2-5.
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convertTest } from '../../src/02-convert-datadog-api-to-json.ts';
import { generateApiCheckCode } from '../../src/04-generate-api-check-constructs-from-json.ts';
import { uniqueLogicalId } from '../../src/shared/utils.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): any {
  return JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', 'unit', name), 'utf-8')
  );
}

const baselineFixture = loadFixture('api-test-baseline.json');
const privatePausedFixture = loadFixture('api-test-private-paused.json');

/**
 * generateApiCheckCode calls filterAndRemapTags, which reads DD_TAGS_EXCLUDE,
 * DD_TAGS_EXCLUDE_ALL, and DD_TAGS_REMAP at call time. Snapshot and clear all
 * three before the tests and restore them exactly afterwards so tag
 * assertions are stable on any machine (threat T-01-14).
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

describe('generateApiCheckCode(convertTest(...)): public live baseline', () => {
  it('emits an ApiCheck constructor call with the derived logical id', () => {
    const output = generateApiCheckCode(convertTest(baselineFixture));
    assert.ok(output.includes('new ApiCheck("api-unit-api-baseline-syn-101-abc", {'), 'must instantiate ApiCheck with logical id');
  });

  it('emits the check name', () => {
    const output = generateApiCheckCode(convertTest(baselineFixture));
    assert.ok(output.includes('name: "Unit API Baseline"'), 'name must appear in output');
  });

  it('maps tick_every 300 to Frequency.EVERY_5M', () => {
    const output = generateApiCheckCode(convertTest(baselineFixture));
    assert.ok(output.includes('frequency: Frequency.EVERY_5M'), 'tick_every 300 must map to EVERY_5M');
  });

  it('appends the migration_check_id traceability tag with the fixture public_id', () => {
    const output = generateApiCheckCode(convertTest(baselineFixture));
    assert.ok(
      output.includes('migration_check_id:syn-101-abc'),
      'traceability tag must carry the Datadog public_id'
    );
  });

  it('preserves original Datadog tags after filtering', () => {
    const output = generateApiCheckCode(convertTest(baselineFixture));
    assert.ok(output.includes('env:synthetic'), 'original tag env:synthetic must survive');
    assert.ok(output.includes('team:example'), 'original tag team:example must survive');
  });

  it('carries monitor_priority 3 as a priority:P3 tag', () => {
    const output = generateApiCheckCode(convertTest(baselineFixture));
    assert.ok(output.includes('priority:P3'), 'monitor_priority must become a priority tag');
  });

  it('emits activated: true for a live test', () => {
    const output = generateApiCheckCode(convertTest(baselineFixture));
    assert.ok(output.includes('activated: true,'), 'live status must map to activated: true');
  });

  it('emits the request url and an AssertionBuilder chain', () => {
    const output = generateApiCheckCode(convertTest(baselineFixture));
    assert.ok(output.includes('url: "https://api.example.com/v1/status"'), 'request url must appear');
    assert.ok(output.includes('AssertionBuilder.statusCode().equals(200)'), 'statusCode assertion must convert');
    assert.ok(output.includes('AssertionBuilder.textBody().contains("ok")'), 'body contains assertion must convert');
  });

  it('does not emit a privateLocations property for a public-only test', () => {
    const output = generateApiCheckCode(convertTest(baselineFixture));
    assert.ok(!output.includes('privateLocations:'), 'public-only test must not emit privateLocations');
    assert.ok(output.includes('locations: ["us-east-1"]'), 'public location must appear');
  });
});

describe('generateApiCheckCode(convertTest(...)): private paused fixture (safe-by-default)', () => {
  it('emits activated: false, preserving the paused state, never "fixing" it', () => {
    const output = generateApiCheckCode(convertTest(privatePausedFixture));
    assert.ok(output.includes('activated: false,'), 'paused status must map to activated: false');
  });

  it('references the example-private private location', () => {
    const output = generateApiCheckCode(convertTest(privatePausedFixture));
    assert.ok(
      output.includes('privateLocations: ["example-private"]'),
      'private location slug must appear in privateLocations'
    );
  });

  it('appends the migration_check_id traceability tag for the private test', () => {
    const output = generateApiCheckCode(convertTest(privatePausedFixture));
    assert.ok(output.includes('migration_check_id:syn-102-def'), 'traceability tag must carry the public_id');
  });
});

describe('Phase 3: request redirect and TLS option fidelity (FID-01/02/03)', () => {
  it('FID-01: follow_redirects false emits a followRedirects: false request line', () => {
    const fixture = structuredClone(baselineFixture);
    fixture.options.follow_redirects = false;
    const output = generateApiCheckCode(convertTest(fixture));
    assert.ok(output.includes('followRedirects: false'), 'explicit false must emit followRedirects: false');
  });

  it('FID-02: follow_redirects true omits the followRedirects field (Checkly default already follows)', () => {
    const fixture = structuredClone(baselineFixture);
    fixture.options.follow_redirects = true;
    const output = generateApiCheckCode(convertTest(fixture));
    assert.ok(!output.includes('followRedirects'), 'explicit true must omit followRedirects entirely');
  });

  it('FID-02: absent follow_redirects omits the followRedirects field', () => {
    const output = generateApiCheckCode(convertTest(baselineFixture));
    assert.ok(!output.includes('followRedirects'), 'absent follow_redirects must omit followRedirects entirely');
  });

  it('FID-03: allow_insecure true emits a skipSSL: true request line', () => {
    const fixture = structuredClone(baselineFixture);
    fixture.options.allow_insecure = true;
    const output = generateApiCheckCode(convertTest(fixture));
    assert.ok(output.includes('skipSSL: true'), 'explicit true must emit skipSSL: true');
  });

  it('FID-03: allow_insecure false omits the skipSSL field (Checkly default already verifies)', () => {
    const fixture = structuredClone(baselineFixture);
    fixture.options.allow_insecure = false;
    const output = generateApiCheckCode(convertTest(fixture));
    assert.ok(!output.includes('skipSSL'), 'explicit false must omit skipSSL entirely');
  });

  it('FID-03: absent allow_insecure omits the skipSSL field', () => {
    const output = generateApiCheckCode(convertTest(baselineFixture));
    assert.ok(!output.includes('skipSSL'), 'absent allow_insecure must omit skipSSL entirely');
  });
});

describe('step 04 REGX-10: regex targets are no longer downgraded', () => {
  // Inline synthetic raw API test (Pattern 5 invented values). Its only string
  // assertion is a body + matches whose target carries regex metacharacters
  // (a digit-class-plus-hyphen pattern). The removed heuristic used to strip the
  // metacharacters and downgrade the operator to a substring contains; this pins
  // that both behaviors are gone. Expected substrings are plain literals.
  function regexMatchesFixture(): any {
    return {
      public_id: 'syn-110-rgx',
      name: 'Unit API Regex',
      type: 'api',
      subtype: 'http',
      status: 'live',
      tags: ['env:synthetic'],
      locations: ['us-east-1'],
      privateLocations: [],
      originalLocations: ['aws:us-east-1'],
      config: {
        request: {
          url: 'https://api.example.com/v1/status',
          method: 'GET',
          headers: { Accept: 'application/json' },
        },
        assertions: [
          { type: 'body', operator: 'matches', target: '\\d+-\\d+' },
        ],
      },
      options: {
        tick_every: 300,
        retry: { count: 1, interval: 300 },
        monitor_priority: 3,
      },
      message: 'Unit regex alert',
      monitor_id: 2110,
    };
  }

  it('does not emit a .contains( derived from the regex target', () => {
    const output = generateApiCheckCode(convertTest(regexMatchesFixture()));
    assert.ok(
      !output.includes('.contains('),
      'a matches regex target must never be downgraded to a substring contains'
    );
  });

  it('does not emit the metacharacter-stripped literal form of the target', () => {
    const output = generateApiCheckCode(convertTest(regexMatchesFixture()));
    // The old strip heuristic turned "\d+-\d+" into the literal "\d-\d".
    assert.ok(
      !output.includes('\\d-\\d'),
      'the metacharacter-stripping heuristic must be gone (no stripped-literal target)'
    );
  });
});

/**
 * DEPLOY-01 (D-05): the api logical ID must carry the Datadog public_id tail so
 * two same-name tests never collapse to one ID and abort the whole checkly test
 * run. DEPLOY-05 (D-07): the construct name literal must be escaped through
 * escapeString, closing the backslash/newline escape-out gap. All variant inputs
 * are in-test spread-clones of the loaded fixture with synthetic-only overrides;
 * no fixture JSON file is edited (VAL-09).
 */
describe('step 04 DEPLOY-01/DEPLOY-05: unique logical id and name escaping', () => {
  it('derives the logical id from prefix, name slug, and public_id (matches the shared helper)', () => {
    const output = generateApiCheckCode(convertTest(baselineFixture));
    const expected = uniqueLogicalId('api', baselineFixture.name, baselineFixture.public_id);
    assert.equal(expected, 'api-unit-api-baseline-syn-101-abc', 'sanity: helper produces the pinned id');
    assert.ok(output.includes(`new ApiCheck("${expected}", {`), 'emitted id must equal the shared-helper output');
  });

  it('same-name tests differing only in public_id emit distinct logical ids (DEPLOY-01)', () => {
    const a = structuredClone(baselineFixture);
    const b = structuredClone(baselineFixture);
    a.public_id = 'syn-201-aaa';
    b.public_id = 'syn-202-bbb';
    const outA = generateApiCheckCode(convertTest(a));
    const outB = generateApiCheckCode(convertTest(b));
    const idA = outA.match(/new ApiCheck\("([^"]+)"/)?.[1];
    const idB = outB.match(/new ApiCheck\("([^"]+)"/)?.[1];
    assert.ok(idA && idB, 'both constructs must carry a logical id');
    assert.notEqual(idA, idB, 'same-name tests must not collapse to one logical id');
    assert.equal(idA, 'api-unit-api-baseline-syn-201-aaa', 'first id carries its own public_id tail');
    assert.equal(idB, 'api-unit-api-baseline-syn-202-bbb', 'second id carries its own public_id tail');
  });

  it('escapes a backslash and a newline in the construct name via escapeString (DEPLOY-05)', () => {
    const fixture = structuredClone(baselineFixture);
    // 25 chars or fewer; JSON encodes the literal backslash and newline.
    fixture.name = 'a\\b\nc name';
    const output = generateApiCheckCode(convertTest(fixture));
    const nameLine = output.split('\n').find(l => l.trimStart().startsWith('name: '));
    assert.ok(nameLine, 'a name line must be emitted');
    // The escaped two-character sequences must be present.
    assert.ok(nameLine!.includes('\\\\'), 'backslash must be emitted as an escaped backslash sequence');
    assert.ok(nameLine!.includes('\\n'), 'newline must be emitted as an escaped newline sequence');
    // No raw newline may remain inside the emitted name string literal.
    assert.ok(!nameLine!.includes('\n'), 'the name line must not contain a raw newline inside the string literal');
  });
});
