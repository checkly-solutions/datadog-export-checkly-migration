/**
 * Generation tests for the multi-step pipeline seam.
 *
 * Calls the exported generateSpecFile from step 05 (aliased to
 * generateMultiStepSpec, since step 07 exports the same name) and
 * generateMultiStepCheckCode from step 06 directly, asserting structurally on
 * the returned strings. No subprocess, no file writes; structural
 * assertions only, never snapshots.
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  generateSpecFile as generateMultiStepSpec,
  generateRequestCode,
  generateComparisonCode,
  generateAssertionCode,
  generateStepCode,
  extractVariableContent,
} from '../../src/05-generate-multi-step-specs.ts';
import { generateMultiStepCheckCode } from '../../src/06-generate-multi-step-constructs.ts';
import { uniqueLogicalId } from '../../src/shared/utils.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const multiStepFixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'unit', 'multi-step-test.json'), 'utf-8')
);

const multiStepRegexFixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'unit', 'multi-step-regex-test.json'), 'utf-8')
);

/**
 * generateMultiStepCheckCode calls filterAndRemapTags, which reads
 * DD_TAGS_EXCLUDE, DD_TAGS_EXCLUDE_ALL, and DD_TAGS_REMAP at call time.
 * Snapshot and clear all three before the tests and restore them exactly
 * afterwards.
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

describe('step 05 generateSpecFile: two-step spec with extractedValues wiring', () => {
  it('emits the Playwright test wrapper with the test name', () => {
    const spec = generateMultiStepSpec(multiStepFixture);
    assert.ok(spec.includes('import { test, expect } from "@playwright/test"'), 'must import playwright test');
    assert.ok(spec.includes('test.describe("Unit Multi Login Flow"'), 'describe block must carry the test name');
    assert.ok(spec.includes('async ({ request })'), 'multi-step specs use the request fixture, not a browser page');
  });

  it('emits both steps with their step comments and requests', () => {
    const spec = generateMultiStepSpec(multiStepFixture);
    assert.ok(spec.includes('// Step 1: Get auth token'), 'step 1 comment must appear');
    assert.ok(spec.includes('// Step 2: Fetch profile'), 'step 2 comment must appear');
    assert.ok(spec.includes('await request.post(`https://auth.example.com/token`'), 'step 1 POST must appear');
    assert.ok(spec.includes('await request.get(`https://api.example.com/v1/profile`'), 'step 2 GET must appear');
  });

  it('declares the extracted variable at function scope and extracts it in step 1', () => {
    const spec = generateMultiStepSpec(multiStepFixture);
    assert.ok(spec.includes("let AUTH_TOKEN = '';"), 'extracted variable must be declared at function scope');
    assert.ok(
      spec.includes("AUTH_TOKEN = _extractJson0?.access_token ?? '';"),
      'step 1 must extract AUTH_TOKEN from its response body'
    );
  });

  it('wires the extractedValue name from step 1 into step 2 as a local reference', () => {
    const spec = generateMultiStepSpec(multiStepFixture);
    assert.ok(
      spec.includes('"Authorization": `Bearer ${AUTH_TOKEN}`'),
      'step 2 header must reference the local AUTH_TOKEN variable, not process.env'
    );
    assert.ok(
      !spec.includes('process.env.AUTH_TOKEN'),
      'extracted variable must never be read from process.env'
    );
  });
});

/**
 * Specification tests for the constructor-form regex emission. Expected strings are
 * plain literals in the test source, never derived via .replace. At file-text level
 * the emitted pattern carries exactly one JS-string escaping layer from
 * JSON.stringify: two backslashes before the d, never four.
 */
describe('step 05 generateComparisonCode: constructor-form regex emission', () => {
  it('emits constructor form for a bare digit-class matches target', () => {
    const result = generateComparisonCode('expect(body0)', 'matches', '\\d{3}-[a-z]+');
    assert.equal(result, 'expect(body0).toMatch(new RegExp("\\\\d{3}-[a-z]+"));');
  });

  it('emits the .not.toMatch constructor form for doesNotMatch', () => {
    const result = generateComparisonCode('expect(body0)', 'doesNotMatch', '\\d{3}-[a-z]+');
    assert.equal(result, 'expect(body0).not.toMatch(new RegExp("\\\\d{3}-[a-z]+"));');
  });

  it('strips slash wrappers and emits flags as a second constructor argument', () => {
    const result = generateComparisonCode('expect(body0)', 'matches', '/\\d+/i');
    assert.equal(result, 'expect(body0).toMatch(new RegExp("\\\\d+", "i"));');
  });

  it('keeps the stringified-target fallback for non-string matches targets', () => {
    const result = generateComparisonCode('expect(body0)', 'matches', 200);
    assert.equal(result, 'expect(body0).toMatch(200);');
  });
});

describe('step 05 generateAssertionCode: statusCode String coercion for regex operators', () => {
  it('String-coerces the status() receiver when operator is matches', () => {
    const { code, needsJsonBody } = generateAssertionCode(
      { type: 'statusCode', operator: 'matches', target: '200' },
      'response0',
      'body0',
      'jsonBody0'
    );
    assert.equal(code, 'expect(String(response0.status())).toMatch(new RegExp("200"));');
    assert.equal(needsJsonBody, false);
  });

  it('keeps the plain status() receiver for the is operator', () => {
    const { code } = generateAssertionCode(
      { type: 'statusCode', operator: 'is', target: 200 },
      'response0',
      'body0',
      'jsonBody0'
    );
    assert.equal(code, 'expect(response0.status()).toBe(200);');
  });
});

describe('step 05 generateSpecFile: constructor-form regex assertions end to end', () => {
  it('String-coerces the statusCode matches receiver in the emitted spec', () => {
    const spec = generateMultiStepSpec(multiStepRegexFixture);
    assert.ok(
      spec.includes('expect(String(response0.status())).toMatch(new RegExp("200"));'),
      'statusCode matches must emit a String-coerced receiver with constructor form'
    );
  });

  it('emits constructor-form matches and doesNotMatch for body assertions', () => {
    const spec = generateMultiStepSpec(multiStepRegexFixture);
    assert.ok(
      spec.includes('.toMatch(new RegExp("\\\\d{3}-[a-z]+"))'),
      'body matches must embed the digit-class pattern verbatim with one escaping layer'
    );
    assert.ok(
      spec.includes('.not.toMatch(new RegExp('),
      'body doesNotMatch must emit the .not.toMatch constructor form'
    );
  });

  it('never emits a slash-delimited toMatch regex literal', () => {
    const spec = generateMultiStepSpec(multiStepRegexFixture);
    assert.ok(
      !spec.includes('toMatch(/'),
      'no slash-delimited regex literal may be built from data'
    );
  });
});

describe('step 06 generateMultiStepCheckCode: construct baseline', () => {
  const specFilename = 'unit-multi-login-flow.spec.ts';

  it('emits a MultiStepCheck constructor call with the derived logical id', () => {
    const output = generateMultiStepCheckCode(multiStepFixture, specFilename, 'public');
    assert.ok(output.includes('new MultiStepCheck("multi-unit-multi-login-flow-syn-105-mno", {'), 'must instantiate MultiStepCheck');
  });

  it('references the spec filename in the code entrypoint', () => {
    const output = generateMultiStepCheckCode(multiStepFixture, specFilename, 'public');
    assert.ok(
      output.includes('entrypoint: "../../../tests/multi/public/unit-multi-login-flow.spec.ts"'),
      'entrypoint must point at the spec file under the locationType directory'
    );
  });

  it('appends the migration_check_id traceability tag and preserves live activation', () => {
    const output = generateMultiStepCheckCode(multiStepFixture, specFilename, 'public');
    assert.ok(output.includes('migration_check_id:syn-105-mno'), 'traceability tag must carry the public_id');
    assert.ok(output.includes('activated: true,'), 'live status must map to activated: true');
  });
});

/**
 * the multi logical ID must carry the Datadog public_id tail so
 * two same-name multi-step tests never collapse to one ID. the
 * construct name literal must be escaped through escapeString. Variant inputs are
 * in-test spread-clones with synthetic-only overrides; no fixture JSON is edited
 *.
 */
describe('step 06: unique logical id and name escaping', () => {
  const specFilename = 'unit-multi-login-flow.spec.ts';

  it('derives the logical id from prefix, name slug, and public_id (matches the shared helper)', () => {
    const output = generateMultiStepCheckCode(multiStepFixture, specFilename, 'public');
    const expected = uniqueLogicalId('multi', multiStepFixture.name, multiStepFixture.public_id);
    assert.equal(expected, 'multi-unit-multi-login-flow-syn-105-mno', 'sanity: helper produces the pinned id');
    assert.ok(output.includes(`new MultiStepCheck("${expected}", {`), 'emitted id must equal the shared-helper output');
  });

  it('same-name tests differing only in public_id emit distinct logical ids', () => {
    const a = structuredClone(multiStepFixture);
    const b = structuredClone(multiStepFixture);
    a.public_id = 'syn-205-aaa';
    b.public_id = 'syn-206-bbb';
    const outA = generateMultiStepCheckCode(a, specFilename, 'public');
    const outB = generateMultiStepCheckCode(b, specFilename, 'public');
    const idA = outA.match(/new MultiStepCheck\("([^"]+)"/)?.[1];
    const idB = outB.match(/new MultiStepCheck\("([^"]+)"/)?.[1];
    assert.ok(idA && idB, 'both constructs must carry a logical id');
    assert.notEqual(idA, idB, 'same-name tests must not collapse to one logical id');
    assert.equal(idA, 'multi-unit-multi-login-flow-syn-205-aaa', 'first id carries its own public_id tail');
    assert.equal(idB, 'multi-unit-multi-login-flow-syn-206-bbb', 'second id carries its own public_id tail');
  });

  it('escapes a backslash and a newline in the construct name via escapeString', () => {
    const fixture = structuredClone(multiStepFixture);
    fixture.name = 'a\\b\nc name';
    const output = generateMultiStepCheckCode(fixture, specFilename, 'public');
    const nameLine = output.split('\n').find(l => l.trimStart().startsWith('name: '));
    assert.ok(nameLine, 'a name line must be emitted');
    assert.ok(nameLine!.includes('\\\\'), 'backslash must be emitted as an escaped backslash sequence');
    assert.ok(nameLine!.includes('\\n'), 'newline must be emitted as an escaped newline sequence');
    assert.ok(!nameLine!.includes('\n'), 'the name line must not contain a raw newline inside the string literal');
  });
});

/**
 * per-step redirect and TLS fidelity. A multi-step
 * step whose request.follow_redirects === false emits the per-call Playwright
 * option maxRedirects: 0 (return the 3xx instead of following it); a step whose
 * request.allow_insecure === true emits ignoreHTTPSErrors: true on that step's
 * call. Absent fields emit neither option. Per-call form only (Playwright
 * 1.51.1 on Checkly runtime 2025.04); never context-level newContext
 * maxRedirects, which is 1.52+.
 */
describe('per-step redirect and TLS fidelity', () => {
  it('emits per-call maxRedirects: 0 when follow_redirects === false', () => {
    const { code } = generateRequestCode(
      { method: 'GET', url: 'https://api.example.com/probe', follow_redirects: false },
      0
    );
    assert.ok(code.includes('maxRedirects: 0'), 'follow_redirects false must emit the per-call maxRedirects zero option');
    assert.ok(!code.includes('ignoreHTTPSErrors'), 'TLS option must not appear when allow_insecure is unset');
    assert.ok(!code.includes('newContext'), 'must use the per-call form, never context-level newContext');
  });

  it('emits per-call ignoreHTTPSErrors: true when allow_insecure === true', () => {
    const { code } = generateRequestCode(
      { method: 'GET', url: 'https://api.example.com/probe', allow_insecure: true },
      0
    );
    assert.ok(code.includes('ignoreHTTPSErrors: true'), 'allow_insecure true must emit the per-call ignoreHTTPSErrors option');
    assert.ok(!code.includes('maxRedirects'), 'redirect option must not appear when follow_redirects is unset');
  });

  it('emits neither option when both fields are absent', () => {
    const { code } = generateRequestCode(
      { method: 'GET', url: 'https://api.example.com/probe' },
      0
    );
    assert.ok(!code.includes('maxRedirects'), 'absent follow_redirects must omit the redirect option');
    assert.ok(!code.includes('ignoreHTTPSErrors'), 'absent allow_insecure must omit the TLS option');
  });

  it('emits neither option for explicit follow_redirects true and allow_insecure false', () => {
    const { code } = generateRequestCode(
      { method: 'GET', url: 'https://api.example.com/probe', follow_redirects: true, allow_insecure: false },
      0
    );
    assert.ok(!code.includes('maxRedirects'), 'follow_redirects true must not emit the redirect option (Playwright default follows)');
    assert.ok(!code.includes('ignoreHTTPSErrors'), 'allow_insecure false must not emit the TLS option');
  });

  it('carries both per-step options through the full generated spec (generateSpecFile)', () => {
    const mutated = structuredClone(multiStepFixture);
    mutated.config.steps[0].request.follow_redirects = false;
    mutated.config.steps[1].request.allow_insecure = true;
    const spec = generateMultiStepSpec(mutated);
    assert.ok(spec.includes('maxRedirects: 0'), 'step 1 (follow_redirects false) must emit maxRedirects: 0 in the spec');
    assert.ok(spec.includes('ignoreHTTPSErrors: true'), 'step 2 (allow_insecure true) must emit ignoreHTTPSErrors: true in the spec');
    assert.ok(!spec.includes('newContext'), 'the spec must use per-call options, never context-level newContext');
  });

  it('emits neither option in the spec for the unmutated baseline fixture', () => {
    const spec = generateMultiStepSpec(multiStepFixture);
    assert.ok(!spec.includes('maxRedirects'), 'baseline fixture has no follow_redirects, so no redirect option may appear');
    assert.ok(!spec.includes('ignoreHTTPSErrors'), 'baseline fixture has no allow_insecure, so no TLS option may appear');
  });
});

/**
 * request-replay fidelity for promoted API tests. A promoted
 * step whose request.basicAuth.type is not 'web' emits an Authorization: Basic
 * header whose base64 is computed at runtime (Buffer.from), so any {{ VARS }}
 * in the credentials interpolate through process.env at run time. type 'web' is
 * a Datadog browser/form login, never a Basic header, so no Authorization is
 * emitted. A non-empty query Record emits a Playwright per-call params option.
 * Expected substrings are plain literals, never derived via .replace.
 */
describe('step 05 generateRequestCode: Basic auth and query replay', () => {
  it('emits a runtime-base64 Authorization header for basicAuth type "basic"', () => {
    const { code } = generateRequestCode(
      {
        method: 'GET',
        url: 'https://api.example.com/probe',
        basicAuth: { username: 'svc-user', password: 'invented-pass', type: 'basic' },
      },
      0
    );
    assert.ok(code.includes('"Authorization": `Basic ${Buffer.from('), 'must emit a runtime-base64 Basic auth header');
    assert.ok(code.includes('svc-user:invented-pass'), 'the credential pair must be embedded in the runtime base64 expression');
    assert.ok(code.includes('.toString("base64")'), 'base64 must be computed at runtime, not at generation time');
    assert.ok(!code.includes('newContext'), 'must use the per-call form, never context-level newContext');
  });

  it('emits no Authorization header for basicAuth type "web"', () => {
    const { code } = generateRequestCode(
      {
        method: 'GET',
        url: 'https://api.example.com/probe',
        basicAuth: { username: 'svc-user', password: 'invented-pass', type: 'web' },
      },
      0
    );
    assert.ok(!code.includes('Authorization'), 'type web is a browser login flow and must never emit a Basic header');
    assert.ok(!code.includes('Buffer.from'), 'no runtime base64 may be emitted for type web');
  });

  it('emits a per-call params option for a non-empty static query Record', () => {
    const { code } = generateRequestCode(
      {
        method: 'GET',
        url: 'https://api.example.com/probe',
        query: { isbn: '1234', page: '23' },
      },
      0
    );
    assert.ok(code.includes('params: { "isbn": "1234", "page": "23" }'), 'a non-empty static query Record must emit a per-call params option');
    assert.ok(!code.includes('newContext'), 'query replay must use the per-call form, never newContext');
  });

  it('interpolates a {{ VAR }} query value as a process.env reference', () => {
    const { code } = generateRequestCode(
      {
        method: 'GET',
        url: 'https://api.example.com/probe',
        query: { api_key: '{{ API_KEY }}', page: '2' },
      },
      0
    );
    assert.ok(code.includes('"api_key": `${process.env.API_KEY}`'), 'a {{ VAR }} query value must become a process.env template-literal reference');
    assert.ok(code.includes('"page": "2"'), 'a static query value alongside a variable must still be emitted as a plain string');
    assert.ok(!code.includes('{{ API_KEY }}'), 'no literal Datadog {{ VAR }} syntax may survive into the emitted query params');
  });

  it('interpolates {{ VARS }} in Basic auth credentials as process.env refs', () => {
    const { code } = generateRequestCode(
      {
        method: 'GET',
        url: 'https://api.example.com/probe',
        basicAuth: { username: '{{ API_USER }}', password: '{{ API_PASS }}', type: 'basic' },
      },
      0
    );
    assert.ok(code.includes('${process.env.API_USER}'), 'a {{ VAR }} username must become a process.env reference');
    assert.ok(code.includes('${process.env.API_PASS}'), 'a {{ VAR }} password must become a process.env reference');
    assert.ok(!code.includes('{{ API_USER }}'), 'no literal Datadog {{ VAR }} syntax may survive into the emitted spec');
  });

  it('emits no params option when the query Record is absent', () => {
    const { code } = generateRequestCode(
      { method: 'GET', url: 'https://api.example.com/probe' },
      0
    );
    assert.ok(!code.includes('params:'), 'absent query must omit the params option');
    assert.ok(!code.includes('Authorization'), 'absent basicAuth must omit the Authorization header');
  });
});

describe('extractVariableContent collects query-param variables', () => {
  it('returns a variable referenced only in a query param', () => {
    const test = {
      public_id: 'syn-qv-000',
      name: 'Query Var Only',
      locations: ['us-east-1'],
      privateLocations: [],
      originalLocations: [],
      config: {
        steps: [
          {
            name: 'step',
            subtype: 'http',
            request: {
              method: 'GET',
              url: 'https://api.example.com/probe',
              query: { token: '{{ QUERY_TOKEN }}' },
            },
            assertions: [],
          },
        ],
      },
    } as any;
    const content = extractVariableContent(test);
    assert.ok(
      content.some(c => c.includes('{{ QUERY_TOKEN }}')),
      'a query-only variable must be collected for the variable-usage report'
    );
  });
});

describe('step 06 normalizes public locations, leaves private untouched', () => {
  const DD_TAG_VARS = ['DD_TAGS_EXCLUDE', 'DD_TAGS_EXCLUDE_ALL', 'DD_TAGS_REMAP'] as const;
  let saved: Record<string, string | undefined> = {};
  before(() => {
    saved = {};
    for (const n of DD_TAG_VARS) { saved[n] = process.env[n]; delete process.env[n]; }
  });
  after(() => {
    for (const n of DD_TAG_VARS) {
      if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n];
    }
  });

  function makeTest(locations: string[], privateLocations: string[]) {
    return {
      public_id: 'syn-loc-000',
      name: 'Loc Norm',
      status: 'paused',
      tags: [],
      locations,
      privateLocations,
      originalLocations: locations,
      options: { tick_every: 300 },
      config: {},
    } as any;
  }

  it('strips an aws: prefix from a public location', () => {
    const code = generateMultiStepCheckCode(makeTest(['aws:us-east-1'], []), 'x.spec.ts', 'public');
    assert.ok(code.includes('locations: ["us-east-1"]'), 'aws: prefix must be stripped');
    assert.ok(!code.includes('aws:us-east-1'), 'no un-normalized location may survive');
  });

  it('drops azure:/gcp: public locations that have no Checkly equivalent', () => {
    const code = generateMultiStepCheckCode(makeTest(['azure:eastus', 'us-east-1', 'gcp:us-central1'], []), 'x.spec.ts', 'public');
    assert.ok(code.includes('locations: ["us-east-1"]'), 'only the valid AWS region survives');
  });

  it('never runs the public-location filter over private location slugs', () => {
    const code = generateMultiStepCheckCode(makeTest(['us-east-1'], ['niq-aks-eastus2']), 'x.spec.ts', 'private');
    assert.ok(code.includes('privateLocations: ["niq-aks-eastus2"]'), 'private location slug must be preserved verbatim');
  });
});

describe('soft assertions are threaded through generateAssertionCode', () => {
  const statusAssertion = { type: 'statusCode', operator: 'is', target: 200 } as any;

  it('emits expect.soft( for an allowFailure step', () => {
    const step = {
      name: 'soft step',
      subtype: 'http',
      request: { method: 'GET', url: 'https://api.example.com/probe' },
      assertions: [statusAssertion],
      allowFailure: true,
    } as any;
    const code = generateStepCode(step, 0);
    assert.ok(code.includes('expect.soft(response0.status()).toBe(200);'), 'an allowFailure step must emit a soft assertion');
  });

  it('emits a plain expect( for a normal step', () => {
    const step = {
      name: 'hard step',
      subtype: 'http',
      request: { method: 'GET', url: 'https://api.example.com/probe' },
      assertions: [statusAssertion],
      allowFailure: false,
    } as any;
    const code = generateStepCode(step, 0);
    assert.ok(code.includes('expect(response0.status()).toBe(200);'), 'a normal step must emit a plain assertion');
    assert.ok(!code.includes('expect.soft('), 'a normal step must never emit a soft assertion');
  });

  it('never rewrites assertions via a post-hoc expect.soft string replace', () => {
    // Guards the soft-prefix fix: soft prefixing is parameterized, not string-rewritten.
    const softStep = {
      name: 'soft', subtype: 'http',
      request: { method: 'GET', url: 'https://api.example.com/probe' },
      assertions: [{ type: 'body', operator: 'contains', target: 'ok' }],
      allowFailure: true,
    } as any;
    const code = generateStepCode(softStep, 0);
    assert.ok(code.includes('expect.soft(body0).toContain("ok");'), 'a soft body assertion must be built directly');
  });
});
