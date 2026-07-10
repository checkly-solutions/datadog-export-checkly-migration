/**
 * Unit tests for the moment-token date formatter inside convertPatternToJs
 * (Phase 9, plan 09-04, ASRT-04 / D-07 / D-08).
 *
 * The prior date sub-block split the args on EVERY comma (dropping everything
 * after the format's own comma) and chained bare .replace() calls (corrupting
 * MMM via the MM replacement), turning date(0d,MMM D, YYYY) into garbage like
 * "07M D". This suite locks the replacement: a longest-match-first tokenizer
 * with first-comma-only arg splitting, an explicit moment-token table, literal
 * bracket escaping, JSON.stringify-quoted literal chunks (injection-safe), and a
 * date-token-unknown out-param for tokens outside the mapped table (surfaced,
 * never silent).
 *
 * Determinism (Testing SOP): every assertion is on the emitted EXPRESSION TEXT,
 * never on an evaluated Date. No network, no wall-clock, no randomness. Fixtures
 * are synthetic (example.com URLs, syn- public ids, names 25 chars or fewer).
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertPatternToJs,
  generateSpecFile,
} from '../../src/07-generate-browser-specs.ts';
import { FlagCollector } from '../../src/shared/migration-flags.ts';

// -------------------------------------------------------------------------
// Task 1: the tokenizer itself
// -------------------------------------------------------------------------

describe('convertPatternToJs date(): RCA comma case (ASRT-04)', () => {
  it('date(0d,MMM D, YYYY) preserves the post-comma year segment (no comma-split drop)', () => {
    const expr = convertPatternToJs('{{ date(0d,MMM D, YYYY) }}');
    // Short month accessor (en-US) present.
    assert.ok(
      expr.includes("d.toLocaleString('en-US',{month:'short'})"),
      'MMM must map to the en-US short-month accessor',
    );
    // Day accessor present.
    assert.ok(expr.includes('d.getDate()'), 'D must map to getDate()');
    // The post-comma segment survives: getFullYear() is emitted.
    assert.ok(
      expr.includes('d.getFullYear()'),
      'YYYY after the format comma must survive (not dropped by comma-splitting)',
    );
    // The format's own literal comma-space between day and year is preserved as a
    // JSON.stringify-quoted literal chunk.
    assert.ok(expr.includes('", "'), 'the literal comma-space must be a quoted literal chunk');
    // It must NOT contain the corrupted "07M" shape: the raw literal "M D" left
    // after a bare MM/M replace never appears.
    assert.ok(!/\bM D\b/.test(expr) || expr.includes('getMonth'), 'no corrupted bare-M passthrough');
  });
});

describe('convertPatternToJs date(): longest-match-first tokenization', () => {
  it('MMMM maps to the long-month accessor with no stray literal M', () => {
    const expr = convertPatternToJs('{{ date(0d,MMMM) }}');
    assert.ok(
      expr.includes("d.toLocaleString('en-US',{month:'long'})"),
      'MMMM must map to the en-US long-month accessor',
    );
    // No corrupted partial: the long-month accessor must be the only month piece,
    // no leftover short-month accessor from a greedy MMM sub-match.
    assert.ok(
      !expr.includes("d.toLocaleString('en-US',{month:'short'})"),
      'MMMM must not be corrupted into an MMM short-month match',
    );
  });

  it('MM pads the month; M does not', () => {
    const padded = convertPatternToJs('{{ date(0d,MM) }}');
    assert.ok(padded.includes("String(d.getMonth()+1).padStart(2,'0')"), 'MM must pad the month');

    const bare = convertPatternToJs('{{ date(0d,M) }}');
    assert.ok(bare.includes('String(d.getMonth()+1)'), 'M must emit the un-padded month');
    assert.ok(!bare.includes("padStart(2,'0')"), 'M must NOT pad');
  });
});

describe('convertPatternToJs date(): time tokens', () => {
  it('HH:mm:ss maps to padded hour/minute/second accessors with literal colons', () => {
    const expr = convertPatternToJs('{{ date(0d,HH:mm:ss) }}');
    assert.ok(expr.includes("String(d.getHours()).padStart(2,'0')"), 'HH padded hour');
    assert.ok(expr.includes("String(d.getMinutes()).padStart(2,'0')"), 'mm padded minute');
    assert.ok(expr.includes("String(d.getSeconds()).padStart(2,'0')"), 'ss padded second');
    assert.ok(expr.includes('":"'), 'the literal colon must be a quoted literal chunk');
  });

  it('h A maps to a 12-hour expression and an AM/PM ternary', () => {
    const expr = convertPatternToJs('{{ date(0d,h A) }}');
    // 12-hour: hours mapped into 1..12 (the (getHours()+11)%12+1 formula gives a
    // 12 fallback for midnight/noon). Assert the mod-12 arithmetic is present.
    assert.ok(/%\s*12\)\s*\+\s*1/.test(expr), 'h must use the mod-12 + 1 twelve-hour formula');
    // A: AM/PM ternary on hours.
    assert.ok(/getHours\(\)\s*<\s*12/.test(expr), 'A must branch on getHours() < 12');
    assert.ok(/'AM'|'PM'|"AM"|"PM"/.test(expr), 'A must emit an AM/PM literal');
  });
});

describe('convertPatternToJs date(): bracketed literal escaping', () => {
  it('[on] MMM renders the bracket inner text verbatim (brackets stripped) plus the month accessor', () => {
    const expr = convertPatternToJs('{{ date(0d,[on] MMM) }}');
    assert.ok(expr.includes('"on"'), 'bracket inner text must be a quoted literal "on"');
    assert.ok(!expr.includes('['), 'the opening bracket must be stripped from the output');
    assert.ok(
      expr.includes("d.toLocaleString('en-US',{month:'short'})"),
      'the trailing MMM must still map to the short-month accessor',
    );
  });
});

describe('convertPatternToJs date(): unknown-token passthrough and out-param (D-08)', () => {
  it('Q is pushed into unknownTokens and passes through literally', () => {
    const unknown: string[] = [];
    const expr = convertPatternToJs('{{ date(0d,Q MMM) }}', unknown);
    assert.deepEqual(unknown, ['Q'], 'Q must be reported as an unknown token');
    // Q is not a regex-matched token, so it is emitted inside the literal chunk
    // that precedes MMM (here "Q "). Assert a quoted literal containing Q survives.
    assert.ok(/"Q /.test(expr), 'Q must pass through inside a quoted literal chunk');
    // MMM still maps.
    assert.ok(expr.includes("d.toLocaleString('en-US',{month:'short'})"), 'MMM still maps alongside Q');
  });

  it('recognized-but-unmapped Do behaves as unknown (reported and passed through)', () => {
    const unknown: string[] = [];
    const expr = convertPatternToJs('{{ date(0d,Do) }}', unknown);
    assert.deepEqual(unknown, ['Do'], 'Do is recognized but unmapped: reported as unknown');
    assert.ok(expr.includes('"Do"'), 'Do must pass through as a quoted literal');
  });

  it('a fully-mapped format leaves unknownTokens empty', () => {
    const unknown: string[] = [];
    convertPatternToJs('{{ date(0d,MMM D, YYYY) }}', unknown);
    assert.deepEqual(unknown, [], 'a fully-mapped format reports no unknown tokens');
  });

  it('a repeated unknown token is deduped within one pattern', () => {
    const unknown: string[] = [];
    convertPatternToJs('{{ date(0d,Q Q) }}', unknown);
    assert.deepEqual(unknown, ['Q'], 'the same unknown token is reported once per pattern');
  });
});

describe('convertPatternToJs date(): offset semantics and no-format fallback', () => {
  it('date(-1d,MMM) embeds the negative-day offset arithmetic', () => {
    const expr = convertPatternToJs('{{ date(-1d,MMM) }}');
    assert.ok(expr.includes('-1 * 86400000'), 'the negative-day offset arithmetic must be preserved');
  });

  it('a date() with no format returns the ISO-split fallback byte-identically', () => {
    const expr = convertPatternToJs('{{ date(0d) }}');
    assert.equal(
      expr,
      "'' + new Date(Date.now() + 0 * 86400000).toISOString().split('T')[0] + ''",
      'the no-format branch must stay byte-identical to the ISO-split fallback',
    );
  });
});

describe('convertPatternToJs date(): hostile literal escaping (T-09-04-01)', () => {
  it("a format containing a quote and a backslash yields JSON.stringify-quoted literal chunks", () => {
    // A hostile literal chunk between tokens: a single quote and a backslash.
    const expr = convertPatternToJs("{{ date(0d,MMM 'x\\y) }}");
    // The month accessor still maps.
    assert.ok(expr.includes("d.toLocaleString('en-US',{month:'short'})"), 'MMM still maps');
    // The literal chunk is JSON.stringify-quoted: the backslash is escaped as \\
    // and the embedded quote cannot terminate the string. Assert the raw chunk
    // does not appear unescaped (no bare `'x\y` sequence in the emitted source).
    assert.ok(!expr.includes("'x\\y"), 'the raw hostile chunk must not appear unescaped');
    // The JSON.stringify form of the hostile chunk appears (double-escaped backslash).
    assert.ok(expr.includes(JSON.stringify(" 'x\\y")), 'the hostile chunk must be JSON.stringify-quoted');
  });
});

describe('convertPatternToJs: non-date branches stay intact', () => {
  it('uuid branch is unchanged', () => {
    assert.equal(convertPatternToJs('{{ uuid }}'), "'' + crypto.randomUUID() + ''");
  });

  it('timestamp branch is unchanged', () => {
    const expr = convertPatternToJs('{{ timestamp(5) }}');
    assert.ok(expr.includes('Date.now() + 5000'), 'timestamp offset arithmetic preserved');
  });
});

// -------------------------------------------------------------------------
// Task 2: date-token-unknown flag emission at the local-variables call site
// -------------------------------------------------------------------------

function mkBrowserTestWithVar(pattern: string) {
  return {
    public_id: 'syn-004-dat',
    name: 'Date Var Flow',
    locations: ['aws:us-east-1'],
    privateLocations: [],
    originalLocations: ['aws:us-east-1'],
    config: {
      request: { url: 'https://app.example.com/login' },
      variables: [{ name: 'STAMP', pattern, type: 'text' }],
    },
    steps: [
      {
        name: 'Assert page has text',
        type: 'assertPageContains',
        params: { value: 'Welcome' },
      },
    ],
  };
}

describe('generateSpecFile: date-token-unknown flag at the local-variables site (D-08)', () => {
  it('emits exactly one date-token-unknown flag for a variable with an unknown token', () => {
    const collector = new FlagCollector();
    const { spec } = generateSpecFile(mkBrowserTestWithVar('{{ date(0d,Q MMM) }}') as any, collector);

    const dateFlags = collector.flags.filter((f) => f.reason === 'date-token-unknown');
    assert.equal(dateFlags.length, 1, 'exactly one date-token-unknown flag for the one affected variable');

    const flag = dateFlags[0];
    assert.equal(flag.stepIndex, null, 'the date-token flag is spec-level (stepIndex null)');
    assert.ok(flag.message.includes('STAMP'), 'the flag message names the variable');
    assert.ok(flag.message.includes('Q'), 'the flag message names the unknown token');

    // The MIGRATION-FLAG marker line appears in the spec, above the const line.
    assert.ok(spec.includes('// MIGRATION-FLAG: date-token-unknown'), 'the inline marker is present');
    const markerIdx = spec.indexOf('// MIGRATION-FLAG: date-token-unknown');
    const constIdx = spec.indexOf('const STAMP =');
    assert.ok(markerIdx >= 0 && constIdx >= 0, 'both the marker and the const line are present');
    assert.ok(markerIdx < constIdx, 'the marker must appear ABOVE the const declaration');
  });

  it('records zero date-token-unknown flags for a fully-mapped pattern', () => {
    const collector = new FlagCollector();
    const { spec } = generateSpecFile(mkBrowserTestWithVar('{{ date(0d,MMM D, YYYY) }}') as any, collector);

    const dateFlags = collector.flags.filter((f) => f.reason === 'date-token-unknown');
    assert.equal(dateFlags.length, 0, 'a fully-mapped pattern raises no date-token-unknown flag');
    assert.ok(!spec.includes('// MIGRATION-FLAG: date-token-unknown'), 'no date-token marker for a mapped pattern');
    // The const still emits and is runnable.
    assert.ok(spec.includes('const STAMP ='), 'the variable const still emits');
  });

  it('emits one flag (not one-per-token) for a variable with two distinct unknown tokens', () => {
    const collector = new FlagCollector();
    generateSpecFile(mkBrowserTestWithVar('{{ date(0d,Q Do) }}') as any, collector);

    const dateFlags = collector.flags.filter((f) => f.reason === 'date-token-unknown');
    assert.equal(dateFlags.length, 1, 'one flag per affected variable, not per unknown token');
    assert.ok(dateFlags[0].message.includes('Q'), 'message names the first unknown token');
    assert.ok(dateFlags[0].message.includes('Do'), 'message names the second unknown token');
  });
});
