/**
 * End-to-end promotion generation test.
 *
 * This capstone joins the outputs of the whole promotion path into one integration
 * assertion: a regex-bearing API test fixture is run through the shared transform
 * (`promoteApiTestToMultiStep` + `detectPromotionReasons`), then fed to step 05
 * `generateSpecFile` (replay + native-RegExp emission) and step 06
 * `generateMultiStepCheckCode` (marker tag + check-level fidelity).
 *
 * Structural assertions only, never snapshots. Expected regex substrings
 * are plain literals in the test source, never derived via .replace
 * (RESEARCH.md). No subprocess, no file writes.
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  promoteApiTestToMultiStep,
  detectPromotionReasons,
} from '../../src/shared/promote-api-to-multistep.ts';
import { generateSpecFile } from '../../src/05-generate-multi-step-specs.ts';
import { generateMultiStepCheckCode } from '../../src/06-generate-multi-step-constructs.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): any {
  return JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'unit', name), 'utf-8'));
}

const regexBodyFixture = loadFixture('api-test-regex-body.json');
const regexStatusCodeFixture = loadFixture('api-test-regex-statuscode.json');

/**
 * Promote a fixture the exact way the pipeline does: detect reasons, then feed
 * both into the transform. Returns the one-step multi-step test.
 */
function promote(fixture: any): any {
  const reasons = detectPromotionReasons(fixture);
  return promoteApiTestToMultiStep(fixture, reasons);
}

/**
 * generateMultiStepCheckCode calls filterAndRemapTags, which reads
 * DD_TAGS_EXCLUDE, DD_TAGS_EXCLUDE_ALL, and DD_TAGS_REMAP at call time.
 * Snapshot and clear all three before the tests and restore them exactly
 * afterwards (determinism rule; threat).
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

describe('regex promotion end to end: transform -> step 05 spec', () => {
  it('detects the regex reason for a body-regex API test', () => {
    assert.deepEqual(detectPromotionReasons(regexBodyFixture), ['regex']);
  });

  it('emits constructor-form toMatch for the matches body assertion', () => {
    const spec = generateSpecFile(promote(regexBodyFixture));
    assert.ok(
      spec.includes('.toMatch(new RegExp('),
      'body matches must emit native RegExp constructor form'
    );
  });

  it('emits the .not.toMatch constructor form for the doesNotMatch body assertion (negation)', () => {
    const spec = generateSpecFile(promote(regexBodyFixture));
    assert.ok(
      spec.includes('.not.toMatch(new RegExp('),
      'body doesNotMatch must emit the negated .not.toMatch constructor form'
    );
  });

  it('never emits a slash-delimited toMatch regex literal built from data', () => {
    const spec = generateSpecFile(promote(regexBodyFixture));
    assert.ok(!spec.includes('toMatch(/'), 'no slash-delimited regex literal may be built from data');
  });

  it('replays Basic auth as a runtime-base64 Authorization header', () => {
    const spec = generateSpecFile(promote(regexBodyFixture));
    assert.ok(spec.includes('"Authorization": `Basic ${Buffer.from('), 'must emit a runtime-base64 Basic auth header');
    assert.ok(spec.includes('synuser:synth-pass'), 'the credential pair must be embedded in the runtime base64 expression');
    assert.ok(spec.includes('.toString("base64")'), 'base64 must be computed at runtime, not at generation time');
  });

  it('replays the query Record as a per-call params option in the same spec', () => {
    const spec = generateSpecFile(promote(regexBodyFixture));
    assert.ok(spec.includes('params: { "limit": "10", "page": "2" }'), 'a non-empty query Record must emit a per-call params option');
  });

  it('carries Authorization and params together in the one emitted spec', () => {
    const spec = generateSpecFile(promote(regexBodyFixture));
    assert.ok(
      spec.includes('Authorization') && spec.includes('params:'),
      'the single promoted spec must replay both Basic auth and query in one request'
    );
  });

  it('emits exactly one request call: the promoted test is a single step', () => {
    const spec = generateSpecFile(promote(regexBodyFixture));
    const requestCalls = spec.match(/await request\./g) ?? [];
    assert.equal(requestCalls.length, 1, 'a promoted single-step test must emit exactly one request call');
  });

  it('holds ALL source assertions in the one step', () => {
    const spec = generateSpecFile(promote(regexBodyFixture));
    // matches (body), doesNotMatch (body), and the statusCode is 200 assertion
    assert.ok(spec.includes('.toMatch(new RegExp('), 'the matches assertion must be present');
    assert.ok(spec.includes('.not.toMatch(new RegExp('), 'the doesNotMatch assertion must be present');
    assert.ok(spec.includes('expect(response0.status()).toBe(200);'), 'the statusCode is 200 assertion must be present');
  });

  it('uses the request fixture (HTTP replay), never a browser page', () => {
    const spec = generateSpecFile(promote(regexBodyFixture));
    assert.ok(spec.includes('async ({ request })'), 'promoted specs replay via the request fixture');
    assert.ok(spec.includes('await request.post(`https://api.example.com/v1/orders`'), 'the original POST request must be replayed');
  });
});

describe('regex promotion end to end: transform -> step 06 construct', () => {
  const specFilename = 'reg-body-promote.spec.ts';

  it('appends both traceability tags: migration_check_id and promotedFromApiCheck', () => {
    const output = generateMultiStepCheckCode(promote(regexBodyFixture), specFilename, 'public');
    assert.ok(output.includes('migration_check_id:syn-reg-body-000'), 'must carry the Datadog public_id link tag');
    assert.ok(output.includes('promotedFromApiCheck'), 'promoted checks must carry the promotion marker tag');
  });

  it('preserves the source frequency, retries, locations, and live activation', () => {
    const output = generateMultiStepCheckCode(promote(regexBodyFixture), specFilename, 'public');
    assert.ok(output.includes('Frequency.EVERY_5M'), 'tick_every 300 must map to EVERY_5M');
    assert.ok(output.includes('maxRetries: 2'), 'the source retry count must be preserved');
    assert.ok(output.includes('"us-east-1"'), 'the normalized Checkly location must be emitted');
    assert.ok(!output.includes('aws:us-east-1'), 'no un-normalized aws:-prefixed location may reach the construct');
    assert.ok(output.includes('activated: true'), 'a live Datadog test must map to activated: true');
  });

  it('instantiates a MultiStepCheck construct pointing at the promoted spec', () => {
    const output = generateMultiStepCheckCode(promote(regexBodyFixture), specFilename, 'public');
    assert.ok(output.includes('new MultiStepCheck('), 'must instantiate a MultiStepCheck construct');
    assert.ok(output.includes(specFilename), 'the construct entrypoint must reference the promoted spec file');
  });
});

describe('regex promotion end to end: statusCode+MATCHES recovery', () => {
  it('promotes the statusCode-regex fixture (previously dropped combo)', () => {
    assert.deepEqual(detectPromotionReasons(regexStatusCodeFixture), ['regex']);
  });

  it('emits String(...status()) coercion with a native RegExp toMatch', () => {
    const spec = generateSpecFile(promote(regexStatusCodeFixture));
    assert.ok(
      spec.includes('expect(String(response0.status())).toMatch(new RegExp("200"));'),
      'statusCode matches must String-coerce the status() receiver and assert with a native RegExp'
    );
  });

  it('carries the promotion marker on the statusCode-regex construct too', () => {
    const output = generateMultiStepCheckCode(
      promote(regexStatusCodeFixture),
      'reg-code-promote.spec.ts',
      'public'
    );
    assert.ok(output.includes('migration_check_id:syn-reg-code-000'), 'must carry the public_id link tag');
    assert.ok(output.includes('promotedFromApiCheck'), 'must carry the promotion marker tag');
  });
});
