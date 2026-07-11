/**
 * Unit coverage for the multi-browser (PWCS) contract substrate.
 *
 * Two subjects:
 *   1. deviceFamily + deriveEnginesFromDeviceIds + PLAYWRIGHT_ENGINE_ORDER in
 *      src/shared/utils.ts: the shared family-parse rule (single source of truth,
 *      reused by src/07) plus the pure device_ids -> Playwright engine-set
 *      derivation primitive with the edge->chromium mapping and the
 *      dedupe/canonical-order semantics.
 *   2. The three appended PWCS FlagReason codes in src/shared/migration-flags.ts:
 *      the closed FLAG_REASONS union gains the three PWCS codes as its final three
 *      entries (append-only) and emitFlag accepts them at runtime.
 *   3. threading: options.device_ids survives step 01's
 *      transformTestLocations spread untouched.
 *
 * Determinism per the Testing SOP: no clock, randomness, timers, subprocess,
 * network, or file writes. All inline values are synthetic (syn- public ids,
 * example.com family hosts, short invented messages, names at or under 25 chars).
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveEnginesFromDeviceIds,
  deviceFamily,
  PLAYWRIGHT_ENGINE_ORDER,
} from '../../src/shared/utils.ts';
import { FLAG_REASONS, FlagCollector } from '../../src/shared/migration-flags.ts';
import { transformTestLocations } from '../../src/01-initial-datadog-export.ts';
import type { DatadogTest } from '../../src/shared/types.ts';

describe('PLAYWRIGHT_ENGINE_ORDER', () => {
  it('is the canonical three-engine tuple in order (chromium, firefox, webkit)', () => {
    assert.deepStrictEqual([...PLAYWRIGHT_ENGINE_ORDER], ['chromium', 'firefox', 'webkit']);
  });
});

describe('deviceFamily', () => {
  it('is the single source of truth for the family parse rule (lowercased token before first dot)', () => {
    assert.strictEqual(deviceFamily('chrome.laptop_large'), 'chrome');
    assert.strictEqual(deviceFamily('EDGE.LAPTOP_LARGE'), 'edge');
    assert.strictEqual(deviceFamily('  firefox.mobile '), 'firefox');
    assert.strictEqual(deviceFamily('chrome'), 'chrome');
  });

  it('is total: coerces non-string and empty input without throwing', () => {
    assert.strictEqual(deviceFamily(''), '');
    assert.strictEqual(deviceFamily(undefined), 'undefined');
    assert.strictEqual(deviceFamily('synthetics:mobile:device:iphone'), 'synthetics:mobile:device:iphone');
  });
});

describe('deriveEnginesFromDeviceIds', () => {
  it('returns empty derivation for undefined, null, and []', () => {
    const empty = { engines: [], mappedDeviceIds: [], unmappedDeviceIds: [] };
    assert.deepStrictEqual(deriveEnginesFromDeviceIds(undefined), empty);
    assert.deepStrictEqual(deriveEnginesFromDeviceIds(null), empty);
    assert.deepStrictEqual(deriveEnginesFromDeviceIds([]), empty);
  });

  it('maps a single chrome device to chromium', () => {
    const result = deriveEnginesFromDeviceIds(['chrome.laptop_large']);
    assert.deepStrictEqual(result.engines, ['chromium']);
    assert.deepStrictEqual(result.mappedDeviceIds, ['chrome.laptop_large']);
    assert.deepStrictEqual(result.unmappedDeviceIds, []);
  });

  it('maps the real three-browser shape to [chromium, firefox] with edge folded to chromium', () => {
    const result = deriveEnginesFromDeviceIds([
      'chrome.laptop_large',
      'firefox.laptop_large',
      'edge.laptop_large',
    ]);
    assert.deepStrictEqual(result.engines, ['chromium', 'firefox']);
    assert.strictEqual(result.mappedDeviceIds.length, 3);
    assert.deepStrictEqual(result.unmappedDeviceIds, []);
  });

  it('dedupes same-engine device families (edge + chrome -> single chromium)', () => {
    const result = deriveEnginesFromDeviceIds(['edge.laptop_large', 'chrome.mobile_small']);
    assert.deepStrictEqual(result.engines, ['chromium']);
    assert.strictEqual(result.mappedDeviceIds.length, 2);
  });

  it('emits canonical order regardless of input order', () => {
    const result = deriveEnginesFromDeviceIds(['firefox.laptop_large', 'chrome.laptop_large']);
    assert.deepStrictEqual(result.engines, ['chromium', 'firefox']);
  });

  it('quarantines the mobile synthetics syntax as unmapped', () => {
    const result = deriveEnginesFromDeviceIds(['synthetics:mobile:device:iphone_15_ios_17']);
    assert.deepStrictEqual(result.engines, []);
    assert.deepStrictEqual(result.unmappedDeviceIds, ['synthetics:mobile:device:iphone_15_ios_17']);
    assert.deepStrictEqual(result.mappedDeviceIds, []);
  });

  it('maps a bare family (no dot) and is case-insensitive', () => {
    assert.deepStrictEqual(deriveEnginesFromDeviceIds(['chrome']).engines, ['chromium']);
    assert.deepStrictEqual(deriveEnginesFromDeviceIds(['EDGE.LAPTOP_LARGE']).engines, ['chromium']);
  });

  it('maps safari and webkit families to webkit', () => {
    assert.deepStrictEqual(deriveEnginesFromDeviceIds(['safari.laptop_large']).engines, ['webkit']);
    assert.deepStrictEqual(deriveEnginesFromDeviceIds(['webkit.tablet']).engines, ['webkit']);
  });

  it('quarantines empty strings and non-string entries without throwing', () => {
    const hostile = ['', 123, null, undefined, {}] as unknown as string[];
    const result = deriveEnginesFromDeviceIds(hostile);
    assert.deepStrictEqual(result.engines, []);
    assert.strictEqual(result.unmappedDeviceIds.length, hostile.length);
  });
});

describe('PWCS FLAG_REASONS extension', () => {
  it('has the three PWCS codes appended last in order (append-only)', () => {
    // The plan drafted against a 14-code pre-Phase-10 tuple (14 + 3 = 17);
    // landed user-locator-pin-unresolvable as code 15 after the plan was written, so
    // the real total is 18 with the PWCS codes at positions 16-18. The invariant that
    // matters is order-relative append, not an absolute count: assert the three PWCS
    // codes are the final three, whatever the codes before them.
    assert.strictEqual(FLAG_REASONS.length, 18);
    assert.deepStrictEqual(
      [...FLAG_REASONS].slice(-3),
      ['pwcs-device-unmapped', 'pwcs-engines-deduped', 'pwcs-private-location-agent-version']
    );
  });

  it('emitFlag accepts a PWCS reason code without throwing', () => {
    const collector = new FlagCollector();
    assert.doesNotThrow(() =>
      collector.emitFlag({
        reason: 'pwcs-engines-deduped',
        publicId: 'syn-000-tst',
        stepIndex: null,
        message: 'x',
      })
    );
  });
});

describe('threading (options.device_ids survives step 01 transform)', () => {
  const emptyMap = () => new Map<string, string>();
  const emptyUsage = () => new Map<string, number>();

  it('carries options.device_ids deep-equal through transformTestLocations', () => {
    const input: DatadogTest = {
      public_id: 'syn-001-thd',
      name: 'Threading Check',
      type: 'browser',
      locations: ['aws:us-east-1'],
      options: { tick_every: 300, device_ids: ['chrome.laptop_large', 'firefox.laptop_large'] },
    };

    const result = transformTestLocations(input, emptyMap(), emptyUsage());

    assert.deepStrictEqual(result.options?.device_ids, ['chrome.laptop_large', 'firefox.laptop_large']);
    assert.ok(Array.isArray(result.locations), 'locations is populated');
    assert.ok(Array.isArray(result.privateLocations), 'privateLocations is populated');
    assert.deepStrictEqual(result.originalLocations, ['aws:us-east-1'], 'originalLocations preserved');
  });

  it('transforms a test with no options at all without throwing', () => {
    const input: DatadogTest = {
      public_id: 'syn-002-noo',
      name: 'No Options Check',
      type: 'browser',
      locations: ['aws:us-east-1'],
    };

    const result = transformTestLocations(input, emptyMap(), emptyUsage());
    assert.strictEqual(result.options, undefined);
    assert.deepStrictEqual(result.originalLocations, ['aws:us-east-1']);
  });
});
