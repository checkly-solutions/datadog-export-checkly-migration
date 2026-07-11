/**
 * Routing test for the step 03 promotion seam.
 *
 * Exercises the exported pure partitionForPromotion from step 03 over a mixed
 * array of single-step API tests: two regex-bearing fixtures (from)
 * and one plain no-regex test. Asserts that the regex tests land in `promoted`
 * as one-step multi-step tests with a _promotionReason, that the plain test
 * stays in `keptApi`, that a promoted test's public/private location routing is
 * preserved verbatim, and that no promoted public_id survives in
 * keptApi (no duplicate ApiCheck). Structural assertions only, no file
 * writes, no subprocess.
 *
 * partitionForPromotion routes on shouldPromote / promoteApiTestToMultiStep,
 * neither of which reads DD_TAGS_*, so no tag env save/restore hooks are needed.
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { partitionForPromotion } from '../../src/03-filter-multi-step-from-api-json.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', 'unit', name), 'utf-8')
  );
}

const regexBodyTest = loadFixture('api-test-regex-body.json');
const regexStatusCodeTest = loadFixture('api-test-regex-statuscode.json');

/**
 * A plain single-step API test with no regex assertion. Inline literal so its
 * shape stays obvious next to the assertions. Uses only invented values.
 */
const plainApiTest = {
  public_id: 'syn-plain-000',
  name: 'Plain No Regex',
  type: 'api',
  subtype: 'http',
  status: 'live',
  tags: ['env:synthetic'],
  locations: ['aws:us-east-1'],
  privateLocations: [],
  options: { tick_every: 300 },
  config: {
    request: {
      method: 'GET',
      url: 'https://api.example.com/v1/ping',
      headers: { Accept: 'application/json' },
    },
    assertions: [{ type: 'statusCode', operator: 'is', target: 200 }],
  },
  monitor_id: 3303,
};

describe('step 03 partitionForPromotion: regex tests promote, plain tests stay', () => {
  it('partitions regex-bearing tests into promoted and plain tests into keptApi', () => {
    const { promoted, keptApi } = partitionForPromotion([
      regexBodyTest,
      plainApiTest,
      regexStatusCodeTest,
    ] as never);

    assert.equal(promoted.length, 2, 'both regex fixtures must be promoted');
    assert.equal(keptApi.length, 1, 'only the plain test must remain in keptApi');

    const promotedIds = promoted.map((t: Record<string, unknown>) => t.public_id).sort();
    assert.deepEqual(
      promotedIds,
      ['syn-reg-body-000', 'syn-reg-code-000'],
      'promoted set must be exactly the two regex fixtures'
    );
    assert.equal(
      (keptApi[0] as Record<string, unknown>).public_id,
      'syn-plain-000',
      'the plain no-regex test must be the kept ApiCheck test'
    );
  });

  it('reshapes each promoted test into a single-step multi-step test with a _promotionReason', () => {
    const { promoted } = partitionForPromotion([regexBodyTest, regexStatusCodeTest] as never);

    for (const test of promoted) {
      const record = test as Record<string, unknown>;
      const config = record.config as Record<string, unknown>;
      const steps = config.steps as unknown[];
      assert.ok(Array.isArray(steps), 'promoted test must carry a config.steps array');
      assert.equal(steps.length, 1, 'promotion produces exactly one step (one unit)');
      assert.equal(record._promotionReason, 'regex', '_promotionReason must record the regex reason');
    }
  });

  it('preserves a promoted test public/private location routing verbatim', () => {
    const { promoted } = partitionForPromotion([regexBodyTest] as never);
    const promotedTest = promoted[0] as Record<string, unknown>;

    assert.deepEqual(
      promotedTest.locations,
      regexBodyTest.locations,
      'public locations must survive promotion unchanged'
    );
    assert.deepEqual(
      promotedTest.privateLocations,
      regexBodyTest.privateLocations,
      'private locations must survive promotion unchanged'
    );
  });

  it('leaves no promoted public_id in keptApi (no duplicate ApiCheck)', () => {
    const { promoted, keptApi } = partitionForPromotion([
      regexBodyTest,
      plainApiTest,
      regexStatusCodeTest,
    ] as never);

    const keptIds = new Set(keptApi.map((t: Record<string, unknown>) => t.public_id));
    for (const test of promoted) {
      const id = (test as Record<string, unknown>).public_id;
      assert.ok(
        !keptIds.has(id),
        `promoted test ${String(id)} must not remain in keptApi as a duplicate ApiCheck`
      );
    }
  });
});
