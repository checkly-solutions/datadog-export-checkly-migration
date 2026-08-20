/**
 * Generation tests for the multi-browser engine-set decision seam in src/07. All
 * offline, no subprocess, no file writes (Testing SOP). These drive the exported,
 * filesystem-free generateSpecFile directly with a fresh FlagCollector per test and
 * assert on the returned pwEngines plus collector.flags. The concerns locked here:
 *
 *   (1) Engine-set return: generateSpecFile returns pwEngines, the deduped
 *       canonical-order Playwright engine list derived from options.device_ids.
 *   (2) Dedupe flag: when Datadog declared more browser device profiles than
 *       distinct Playwright engines, exactly one pwcs-engines-deduped flag is
 *       emitted, naming the declared profiles and the resulting engines; when any
 *       declared profile is an edge.* family, the message notes Edge is
 *       Chromium-based. This fires even for BrowserCheck-bound collapses (chrome +
 *       edge -> one engine), so the reduction is always visible.
 *   (3) Private-location flag: a multi-engine test routed to a private location
 *       emits exactly one non-deactivating pwcs-private-location-agent-version flag
 *       citing Checkly Agent 6.0.3.
 *   (4) Unmapped entry: a device_ids entry with no Playwright engine mapping emits
 *       one pwcs-device-unmapped flag naming the entry; it is ignored for routing.
 *   (5) No-op cases: a single-browser test and a test with no device_ids emit zero
 *       pwcs-* flags.
 *   (6) Spec-body invariance: the returned spec string is byte-identical regardless
 *       of device_ids; the engine set influences nothing in the body.
 *
 * source: the migrator dedupes Datadog device profiles to distinct Playwright
 * engines (Edge folds to Chromium). source: Playwright Check Suites on a
 * private location require Checkly Agent 6.0.3 or newer (Context7-verified),
 * unknowable from the export. All fixtures are authored synthetic from scratch
 * against the code's own input interfaces per the Testing SOP: syn- public ids,
 * example.com hosts, names 25 chars or fewer, invented values only. No network,
 * no wall clock, no randomness, no filesystem.
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateSpecFile } from '../../src/07-generate-browser-specs.ts';
import { FlagCollector, type MigrationFlag } from '../../src/shared/migration-flags.ts';

// A minimal, deterministic browser test. steps live at the TOP level; the start
// URL is config.request.url. A single goToUrl step keeps the emitted spec body
// stable and independent of device_ids (the invariance control). Variants
// override options.device_ids and privateLocations only.
function baseTest(overrides: {
  device_ids?: string[];
  privateLocations?: string[];
} = {}): any {
  return {
    public_id: 'syn-401-pwa',
    name: 'PWCS Engine Set',
    config: { request: { url: 'https://app.example.com/' } },
    steps: [
      { type: 'goToUrl', name: 'Go to app', params: { value: 'https://app.example.com/' } },
    ],
    locations: ['us-east-1'],
    privateLocations: overrides.privateLocations ?? [],
    originalLocations: ['aws:us-east-1'],
    options: {
      tick_every: 300,
      ...(overrides.device_ids !== undefined ? { device_ids: overrides.device_ids } : {}),
    },
  };
}

// Only PWCS flags are the subject here; a minimal spec can legitimately emit an
// unrelated flag (for example zero-assertion), so scope every PWCS assertion to
// reasons that start with 'pwcs-'.
function pwcsFlags(collector: FlagCollector): MigrationFlag[] {
  return collector.flags.filter((f) => f.reason.startsWith('pwcs-'));
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

describe('generateSpecFile PWCS engine-set decision', () => {
  it('Test 1: multi-engine return is the deduped canonical engine set', () => {
    const collector = new FlagCollector();
    const result = generateSpecFile(
      baseTest({ device_ids: ['chrome.laptop_large', 'firefox.laptop_large', 'edge.laptop_large'] }),
      collector,
    );
    assert.deepEqual(result.pwEngines, ['chromium', 'firefox']);
  });

  it('Test 2: dedupe flag names declared profiles, engines, and the Edge note', () => {
    const collector = new FlagCollector();
    generateSpecFile(
      baseTest({ device_ids: ['chrome.laptop_large', 'firefox.laptop_large', 'edge.laptop_large'] }),
      collector,
    );
    const deduped = pwcsFlags(collector).filter((f) => f.reason === 'pwcs-engines-deduped');
    assert.equal(deduped.length, 1, 'exactly one pwcs-engines-deduped flag');
    const flag = deduped[0];
    assert.equal(flag.publicId, 'syn-401-pwa');
    assert.equal(flag.stepIndex, null);
    assert.notEqual(flag.deactivates, true);
    assert.ok(flag.message.includes('3'), 'message cites 3 declared profiles');
    assert.ok(flag.message.includes('chrome.laptop_large'), 'message cites a declared profile');
    assert.ok(flag.message.includes('chromium, firefox'), 'message cites the resulting engines');
    assert.ok(
      flag.message.includes('Edge is Chromium-based'),
      'edge profile triggers the Edge sentence',
    );
  });

  it('Test 3: private-location flag fires on a multi-engine private test', () => {
    const collector = new FlagCollector();
    const result = generateSpecFile(
      baseTest({
        device_ids: ['chrome.laptop_large', 'firefox.laptop_large', 'edge.laptop_large'],
        privateLocations: ['synthetic-pl-east'],
      }),
      collector,
    );
    const priv = pwcsFlags(collector).filter(
      (f) => f.reason === 'pwcs-private-location-agent-version',
    );
    assert.equal(priv.length, 1, 'exactly one pwcs-private-location-agent-version flag');
    assert.equal(priv[0].stepIndex, null);
    assert.notEqual(priv[0].deactivates, true);
    assert.ok(priv[0].message.includes('6.0.3'), 'message cites Checkly Agent 6.0.3');
    assert.deepEqual(result.pwEngines, ['chromium', 'firefox']);
  });

  it('Test 4: unmapped entry flags the raw string and is ignored for routing', () => {
    const collector = new FlagCollector();
    const result = generateSpecFile(
      baseTest({
        device_ids: ['chrome.laptop_large', 'synthetics:mobile:device:tablet_test'],
      }),
      collector,
    );
    const unmapped = pwcsFlags(collector).filter((f) => f.reason === 'pwcs-device-unmapped');
    assert.equal(unmapped.length, 1, 'exactly one pwcs-device-unmapped flag');
    assert.ok(
      unmapped[0].message.includes('synthetics:mobile:device:tablet_test'),
      'message names the unmapped entry',
    );
    assert.deepEqual(result.pwEngines, ['chromium']);
    // 1 mapped profile equals 1 engine: no dedupe reduction, so no dedupe flag.
    const deduped = pwcsFlags(collector).filter((f) => f.reason === 'pwcs-engines-deduped');
    assert.equal(deduped.length, 0, 'no pwcs-engines-deduped flag when mapped == engines');
  });

  it('Test 5: single-browser test emits zero PWCS flags', () => {
    const collector = new FlagCollector();
    const result = generateSpecFile(baseTest({ device_ids: ['chrome.laptop_large'] }), collector);
    assert.deepEqual(result.pwEngines, ['chromium']);
    assert.equal(pwcsFlags(collector).length, 0, 'no pwcs-* flags on a single-browser test');
  });

  it('Test 6: absent device_ids yields empty engine set and zero PWCS flags', () => {
    const collector = new FlagCollector();
    const result = generateSpecFile(baseTest(), collector);
    assert.deepEqual(result.pwEngines, []);
    assert.equal(pwcsFlags(collector).length, 0, 'no pwcs-* flags when device_ids is absent');
  });

  it('Test 7: spec body is byte-identical regardless of device_ids', () => {
    const multi = generateSpecFile(
      baseTest({ device_ids: ['chrome.laptop_large', 'firefox.laptop_large', 'edge.laptop_large'] }),
      new FlagCollector(),
    );
    const none = generateSpecFile(baseTest(), new FlagCollector());
    assert.equal(
      multi.spec,
      none.spec,
      'the engine set must not influence the emitted spec body',
    );
  });

  it('Test 8: chrome + edge collapses to one engine but still surfaces the dedupe', () => {
    const collector = new FlagCollector();
    const result = generateSpecFile(
      baseTest({ device_ids: ['chrome.laptop_large', 'edge.laptop_large'] }),
      collector,
    );
    // length 1: step 08 keeps a BrowserCheck for this test.
    assert.deepEqual(result.pwEngines, ['chromium']);
    const deduped = pwcsFlags(collector).filter((f) => f.reason === 'pwcs-engines-deduped');
    assert.equal(deduped.length, 1, 'the 2-profile -> 1-engine reduction is surfaced');
    assert.ok(
      deduped[0].message.includes('Edge is Chromium-based'),
      'edge profile triggers the Edge sentence on the collapse case too',
    );
  });
});
