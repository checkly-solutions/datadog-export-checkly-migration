/**
 * Contract test for the MIGRATION-FLAG cross-phase module.
 *
 * This is the executable spec that src/shared/migration-flags.ts must satisfy.
 * Authored test-first: it fails with an unresolved-module error until
 * the module exists, then goes green unchanged.
 *
 * It locks:
 * - the exact FLAG_REASONS tuple in locked order: the locator/residue codes
 *   (shadow-dom-locator, negative-assertion-degraded, assertion-operator-unknown)
 *   appended after secret-value-required, then the assertion/secret codes
 *   (date-token-unknown, possible-plaintext-secret), then
 *   user-locator-pin-unresolvable, then the three multi-browser codes
 *   (pwcs-device-unmapped, pwcs-engines-deduped, pwcs-private-location-agent-version)
 *   appended last
 * - the inline marker grammar: two-space-indented `// MIGRATION-FLAG:` line with
 *   a one-based `(step N)` render, colon separator, and an optional
 *   `// DD original:` second line, all embedded text routed through escapeString
 *   so hostile DD input cannot break out of the line comment
 * - the FlagCollector one-seam semantics (emitFlag both records and returns the
 *   marker), the dedupe/deactivation id sets, runtime union enforcement, and
 *   instance isolation
 * - the plain-JSON MigrationFlagsFile shape toFile() produces
 *
 * Expected escaped text derives from escapeString itself (the single canonical
 * escaper), asserting ROUTING rather than duplicating the escape table
 * (reuse-don't-fork). Test 6 anchors the escaping non-tautologically with
 * hard-coded raw-in / escaped-out assertions.
 *
 * Determinism per the Testing SOP: no clock, randomness, timers, subprocess,
 * network, or file writes. All inline values are synthetic (syn- public ids,
 * example.com family hosts, short invented messages, names at or under 25 chars).
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLAG_REASONS,
  formatInlineMarker,
  FlagCollector,
} from '../../src/shared/migration-flags.ts';
import type { MigrationFlag, MigrationFlagsFile } from '../../src/shared/migration-flags.ts';
import { escapeString } from '../../src/shared/utils.ts';

/**
 * The locked reason codes in locked order. Hard-coded here so this file is the
 * visible contract-evolution point: any later change that appends a code updates
 * this tuple in the same change. The three after secret-value-required
 * (shadow-dom-locator, negative-assertion-degraded, assertion-operator-unknown) are
 * the locator/residue additions; the two after those (date-token-unknown,
 * possible-plaintext-secret) are the assertion/secret additions; the next one
 * (user-locator-pin-unresolvable) is the pin-authority addition; the final three
 * (pwcs-device-unmapped, pwcs-engines-deduped, pwcs-private-location-agent-version)
 * are the multi-browser additions, appended last. Everything up to
 * secret-value-required is byte-identical to the original order.
 */
const EXPECTED_REASONS = [
  'locator-unresolvable',
  'unconvertible-locator',
  'xpath-positional',
  'zero-assertion',
  'wait-value-invalid',
  'key-unmapped',
  'unsupported-step-type',
  'weak-fallback-chain',
  'secret-value-required',
  'shadow-dom-locator',
  'negative-assertion-degraded',
  'assertion-operator-unknown',
  'date-token-unknown',
  'possible-plaintext-secret',
  'user-locator-pin-unresolvable',
  'pwcs-device-unmapped',
  'pwcs-engines-deduped',
  'pwcs-private-location-agent-version',
];

/**
 * Build a minimal valid flag with synthetic values. Callers override fields.
 */
function makeFlag(overrides: Partial<MigrationFlag> = {}): MigrationFlag {
  return {
    reason: 'zero-assertion',
    publicId: 'syn-flag-000-aaa',
    stepIndex: null,
    message: 'no assertion found',
    ...overrides,
  };
}

describe('FLAG_REASONS', () => {
  it('deep-equals the exact seventeen-element tuple in locked order', () => {
    assert.deepStrictEqual([...FLAG_REASONS], EXPECTED_REASONS);
  });

  it('appends the locator/residue, assertion/secret, pin-authority, and multi-browser codes after secret-value-required (append-only)', () => {
    const secretIdx = FLAG_REASONS.indexOf('secret-value-required');
    assert.ok(secretIdx >= 0, 'secret-value-required must still be present');
    assert.deepStrictEqual(
      [...FLAG_REASONS].slice(secretIdx),
      [
        'secret-value-required',
        'shadow-dom-locator',
        'negative-assertion-degraded',
        'assertion-operator-unknown',
        'date-token-unknown',
        'possible-plaintext-secret',
        'user-locator-pin-unresolvable',
        'pwcs-device-unmapped',
        'pwcs-engines-deduped',
        'pwcs-private-location-agent-version',
      ],
      'the locator/residue, assertion/secret, pin-authority, and multi-browser codes must follow secret-value-required in this exact order',
    );
  });
});

describe('FlagCollector.emitFlag locator and residue reason codes', () => {
  const PHASE_8_REASONS: MigrationFlag['reason'][] = [
    'shadow-dom-locator',
    'negative-assertion-degraded',
    'assertion-operator-unknown',
  ];

  for (const reason of PHASE_8_REASONS) {
    it(`accepts ${reason} without throwing and returns a marker naming it`, () => {
      const collector = new FlagCollector();
      const flag = makeFlag({ reason, publicId: 'syn-flag-p8-000-aaa', stepIndex: 3, message: 'phase 8 degrade' });
      const marker = collector.emitFlag(flag);
      assert.ok(marker.includes(reason), `the inline marker must contain the reason string ${reason}`);
      assert.deepStrictEqual(collector.flags[0], flag, 'the raw flag is recorded');
    });
  }
});

describe('FlagCollector.emitFlag assertion and secret reason codes', () => {
  const PHASE_9_REASONS: MigrationFlag['reason'][] = [
    'date-token-unknown',
    'possible-plaintext-secret',
  ];

  for (const reason of PHASE_9_REASONS) {
    it(`accepts ${reason} without throwing and returns a marker naming it`, () => {
      const collector = new FlagCollector();
      const flag = makeFlag({ reason, publicId: 'syn-flag-p9-000-aaa', stepIndex: 5, message: 'phase 9 gap' });
      const marker = collector.emitFlag(flag);
      assert.ok(marker.includes(reason), `the inline marker must contain the reason string ${reason}`);
      assert.deepStrictEqual(collector.flags[0], flag, 'the raw flag is recorded');
    });
  }
});

describe('FlagCollector.emitFlag.5 reason code', () => {
  it('accepts user-locator-pin-unresolvable without throwing and returns a marker naming it', () => {
    const collector = new FlagCollector();
    const flag = makeFlag({
      reason: 'user-locator-pin-unresolvable',
      publicId: 'syn-flag-p95-000-aaa',
      stepIndex: 2,
      message: 'pin could not be derived; self-healing chain emitted instead',
    });
    const marker = collector.emitFlag(flag);
    assert.ok(marker.includes('user-locator-pin-unresolvable'), 'the inline marker must contain the reason string');
    assert.deepStrictEqual(collector.flags[0], flag, 'the raw flag is recorded');
    assert.ok(!flag.deactivates, 'the pin-unresolvable flag never deactivates (chain stays live)');
  });
});

describe('formatInlineMarker', () => {
  it('renders (step 3) for a zero-based stepIndex of 2', () => {
    const marker = formatInlineMarker(
      makeFlag({ reason: 'wait-value-invalid', stepIndex: 2, message: 'wait too big' })
    );
    const line1 = marker.split('\n')[0];
    assert.ok(line1.includes('(step 3)'), `line1 should contain "(step 3)": ${line1}`);
  });

  it('renders (step 1) for a stepIndex of 0 (strict null check, not truthiness)', () => {
    const marker = formatInlineMarker(
      makeFlag({ reason: 'key-unmapped', stepIndex: 0, message: 'key missing' })
    );
    const line1 = marker.split('\n')[0];
    assert.ok(line1.includes('(step 1)'), `line1 should contain "(step 1)": ${line1}`);
  });

  it('emits no (step substring and a well-formed line for stepIndex null', () => {
    const marker = formatInlineMarker(
      makeFlag({ reason: 'zero-assertion', stepIndex: null, message: 'spec has no expect' })
    );
    assert.ok(!marker.includes('(step'), 'null stepIndex must not render a (step marker');
    const line1 = marker.split('\n')[0];
    assert.ok(
      line1.startsWith('    // MIGRATION-FLAG: '),
      `line1 must start with four spaces then the marker: ${JSON.stringify(line1)}`
    );
  });

  it('emits exactly two newline-joined lines when ddStepText is provided, one otherwise', () => {
    const withDd = formatInlineMarker(
      makeFlag({ reason: 'unsupported-step-type', stepIndex: 1, message: 'unsupported' }),
      'Click the login button'
    );
    const lines = withDd.split('\n');
    assert.strictEqual(lines.length, 2, 'ddStepText present -> exactly two lines');
    assert.strictEqual(
      lines[1],
      '    // DD original: ' + escapeString('Click the login button'),
      'line 2 must be four spaces + // DD original: + escaped text'
    );

    const withoutDd = formatInlineMarker(
      makeFlag({ reason: 'unsupported-step-type', stepIndex: 1, message: 'unsupported' })
    );
    assert.ok(!withoutDd.includes('\n'), 'no ddStepText -> single line, no trailing newline');
  });

  it('routes hostile message and ddStepText through escapeString so no line escapes the comment', () => {
    const hostileMessage = 'bad "quote" \\ and\nnewline';
    const hostileStep = 'step "x" \\ y\nz';
    const marker = formatInlineMarker(
      makeFlag({ reason: 'unconvertible-locator', stepIndex: 4, message: hostileMessage }),
      hostileStep
    );

    // Every physical line stays inside a line comment.
    for (const line of marker.split('\n')) {
      assert.ok(line.startsWith('    //'), `every line must start with four spaces then //: ${JSON.stringify(line)}`);
    }

    // Expected text is exactly what the canonical escaper yields (routing, not duplication).
    assert.ok(marker.includes(escapeString(hostileMessage)), 'message must be escaped via escapeString');
    assert.ok(marker.includes(escapeString(hostileStep)), 'ddStepText must be escaped via escapeString');

    // Non-tautological anchor: a raw newline surfaces as backslash-then-n, never a real break.
    assert.ok(marker.includes('\\n'), 'raw newline must surface as the two-character sequence \\n');
    assert.strictEqual(marker.split('\n').length, 2, 'the only real newline is the line-1/line-2 join');
  });

  it('uses a colon-space separator and contains no U+2014 dash (repo output rule)', () => {
    const marker = formatInlineMarker(
      makeFlag({ reason: 'xpath-positional', stepIndex: 0, message: 'positional xpath only' }),
      'Click //div[3]'
    );
    assert.ok(!marker.includes(String.fromCharCode(0x2014)), 'marker must not contain a U+2014 em dash');
    assert.ok(
      marker.split('\n')[0].endsWith(': ' + escapeString('positional xpath only')),
      'the separator before the message is a colon plus one space'
    );
  });
});

describe('FlagCollector.emitFlag', () => {
  it('returns exactly formatInlineMarker output and records the raw flag (single seam)', () => {
    const collector = new FlagCollector();
    const flag = makeFlag({ reason: 'wait-value-invalid', stepIndex: 2, message: 'wait invalid' });
    const ddStep = 'Wait 9999';

    const returned = collector.emitFlag(flag, ddStep);
    assert.strictEqual(returned, formatInlineMarker(flag, ddStep), 'emitFlag returns the formatter output verbatim');
    assert.deepStrictEqual(collector.flags[0], flag, 'the raw, unescaped flag is recorded');
  });

  it('adds deactivating flags to deactivatedCheckIds but keeps all in flaggedCheckIds', () => {
    const collector = new FlagCollector();
    const deactivating = makeFlag({
      reason: 'locator-unresolvable',
      publicId: 'syn-flag-001-bbb',
      stepIndex: 0,
      message: 'no locator candidate',
      deactivates: true,
    });
    const nonDeactivating = makeFlag({
      reason: 'zero-assertion',
      publicId: 'syn-flag-002-ccc',
      stepIndex: null,
      message: 'no expect call',
    });

    collector.emitFlag(deactivating);
    collector.emitFlag(nonDeactivating);

    assert.deepStrictEqual(collector.deactivatedCheckIds(), ['syn-flag-001-bbb']);
    assert.deepStrictEqual(collector.flaggedCheckIds(), ['syn-flag-001-bbb', 'syn-flag-002-ccc']);
  });

  it('dedupes a shared publicId to a single entry in first-emission order', () => {
    const collector = new FlagCollector();
    collector.emitFlag(makeFlag({ reason: 'zero-assertion', publicId: 'syn-flag-003-ddd', message: 'one' }));
    collector.emitFlag(makeFlag({ reason: 'wait-value-invalid', publicId: 'syn-flag-003-ddd', stepIndex: 1, message: 'two' }));

    assert.deepStrictEqual(collector.flaggedCheckIds(), ['syn-flag-003-ddd']);
  });

  it('throws an Error naming the offending code for a reason outside FLAG_REASONS (runtime union lock)', () => {
    const collector = new FlagCollector();
    const bogus = makeFlag({ reason: 'not-a-real-reason' as unknown as MigrationFlag['reason'] });
    assert.throws(
      () => collector.emitFlag(bogus),
      (err: unknown) => err instanceof Error && err.message.includes('not-a-real-reason'),
      'the error message must name the offending reason code'
    );
  });

  it('keeps state instance-local: a fresh collector shares nothing with a used one', () => {
    const a = new FlagCollector();
    a.emitFlag(makeFlag({ reason: 'locator-unresolvable', publicId: 'syn-flag-004-eee', stepIndex: 0, message: 'x', deactivates: true }));

    const b = new FlagCollector();
    assert.deepStrictEqual(b.flags, []);
    assert.deepStrictEqual(b.flaggedCheckIds(), []);
    assert.deepStrictEqual(b.deactivatedCheckIds(), []);
  });
});

describe('FlagCollector.toFile', () => {
  it('returns the MigrationFlagsFile shape and is plain-JSON serializable', () => {
    const collector = new FlagCollector();
    const f1 = makeFlag({ reason: 'locator-unresolvable', publicId: 'syn-flag-005-fff', stepIndex: 0, message: 'gone', deactivates: true });
    const f2 = makeFlag({ reason: 'zero-assertion', publicId: 'syn-flag-006-ggg', stepIndex: null, message: 'empty' });
    collector.emitFlag(f1);
    collector.emitFlag(f2);

    const file: MigrationFlagsFile = collector.toFile();
    assert.deepStrictEqual(file, {
      flags: [f1, f2],
      flaggedCheckIds: ['syn-flag-005-fff', 'syn-flag-006-ggg'],
      deactivatedCheckIds: ['syn-flag-005-fff'],
    });

    // No Set/Map/function leaks: the round-trip through JSON is lossless.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(collector.toFile())), collector.toFile());
  });
});
