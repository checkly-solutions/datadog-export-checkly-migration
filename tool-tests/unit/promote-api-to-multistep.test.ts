/**
 * Unit tests for the shared promotion transform (Phase 05, REGX-05/06/08).
 *
 * detectPromotionReasons / shouldPromote / promoteApiTestToMultiStep are pure
 * functions of their input test, reading no environment, so this file needs no
 * dotenv and no DD_TAGS_* save/restore hooks. It loads two synthetic fixtures
 * (both authored from invented values only) and asserts structural results
 * with plain literals, never values derived from the source via .replace.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  detectPromotionReasons,
  shouldPromote,
  promoteApiTestToMultiStep,
} from '../../src/shared/promote-api-to-multistep.ts';
import type { DatadogTest } from '../../src/shared/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): DatadogTest {
  return JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', 'unit', name), 'utf-8')
  ) as DatadogTest;
}

const bodyFixture = loadFixture('api-test-regex-body.json');
const statusCodeFixture = loadFixture('api-test-regex-statuscode.json');

describe('detectPromotionReasons', () => {
  it('returns [regex] for a body matches/doesNotMatch test', () => {
    assert.deepStrictEqual(detectPromotionReasons(bodyFixture), ['regex']);
  });

  it('returns [regex] for a statusCode matches test', () => {
    assert.deepStrictEqual(detectPromotionReasons(statusCodeFixture), ['regex']);
  });

  it('returns [] when no assertion uses a regex operator', () => {
    const noRegex: DatadogTest = {
      ...bodyFixture,
      config: {
        ...bodyFixture.config,
        assertions: [{ type: 'statusCode', operator: 'is', target: 200 }],
      },
    };
    assert.deepStrictEqual(detectPromotionReasons(noRegex), []);
  });

  it('does not wire the javascript reason in v1', () => {
    const jsTest: DatadogTest = {
      ...bodyFixture,
      config: {
        ...bodyFixture.config,
        assertions: [{ type: 'javascript', operator: 'executes', target: 'return true' }],
      },
    };
    assert.deepStrictEqual(detectPromotionReasons(jsTest), []);
  });
});

describe('shouldPromote', () => {
  it('is true for a single-step regex test', () => {
    assert.strictEqual(shouldPromote(bodyFixture), true);
  });

  it('is false for a subtype multi test (already handled by the split)', () => {
    const multi: DatadogTest = { ...bodyFixture, subtype: 'multi' };
    assert.strictEqual(shouldPromote(multi), false);
  });

  it('is false when no promotion reason is present', () => {
    const noRegex: DatadogTest = {
      ...bodyFixture,
      config: {
        ...bodyFixture.config,
        assertions: [{ type: 'statusCode', operator: 'is', target: 200 }],
      },
    };
    assert.strictEqual(shouldPromote(noRegex), false);
  });
});

describe('promoteApiTestToMultiStep', () => {
  const promoted = promoteApiTestToMultiStep(bodyFixture, ['regex']);
  const steps = (promoted.config as any).steps as any[];
  const step = steps[0];

  it('produces exactly one step', () => {
    assert.strictEqual(steps.length, 1);
  });

  it('drops the now-stale top-level request/assertions from the promoted config (IN-02)', () => {
    const cfg = promoted.config as any;
    assert.strictEqual(cfg.request, undefined, 'stale config.request must not survive beside steps');
    assert.strictEqual(cfg.assertions, undefined, 'stale config.assertions must not survive beside steps');
    assert.ok(Array.isArray(cfg.steps), 'the promoted config must still carry steps');
  });

  it('carries ALL of the source assertions in the single step (REGX-06)', () => {
    const sourceLen = (bodyFixture.config as any).assertions.length;
    assert.strictEqual(sourceLen, 3);
    assert.strictEqual(step.assertions.length, sourceLen);
  });

  it('sets _promotionReason to regex', () => {
    assert.strictEqual((promoted as any)._promotionReason, 'regex');
  });

  it('sets the step subtype to http so hasOnlyHttpSteps admits it', () => {
    assert.strictEqual(step.subtype, 'http');
  });

  it('names the step after the source test', () => {
    assert.strictEqual(step.name, 'Reg Body Promote');
  });

  it('replays basicAuth on the step request', () => {
    assert.deepStrictEqual(step.request.basicAuth, {
      username: 'synuser',
      password: 'synth-pass',
      type: 'basic',
    });
  });

  it('replays query params on the step request', () => {
    assert.deepStrictEqual(step.request.query, { limit: '10', page: '2' });
  });

  it('replays the client certificate on the step request', () => {
    assert.deepStrictEqual(step.request.certificate, {
      cert: { filename: 'client.pem' },
      key: { filename: 'client.key' },
    });
  });

  it('lifts follow_redirects and allow_insecure from options onto the step request', () => {
    assert.strictEqual(step.request.follow_redirects, false);
    assert.strictEqual(step.request.allow_insecure, true);
  });

  it('preserves top-level fields via spread', () => {
    assert.strictEqual(promoted.public_id, 'syn-reg-body-000');
    assert.strictEqual(promoted.status, 'live');
    assert.deepStrictEqual(promoted.tags, ['env:synthetic', 'team:synth']);
    assert.deepStrictEqual(promoted.locations, ['us-east-1']);
  });

  it('does not re-escape the regex targets (embeds verbatim, REGX-02)', () => {
    const matchTarget = step.assertions.find(
      (a: any) => a.type === 'body' && a.operator === 'matches'
    ).target;
    assert.strictEqual(matchTarget, '\\d{3}-[a-z]+');
  });
});
