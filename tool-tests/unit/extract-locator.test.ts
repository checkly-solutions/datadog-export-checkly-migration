/**
 * Unit tests for the Phase 8 ordered-candidate locator layer (LOC-01, LOC-03,
 * LOC-04, LOC-05, LOC-06, LOC-07) in src/07-generate-browser-specs.ts.
 *
 * This suite pins the pure extraction and per-candidate derivation contract:
 * the six new derivation helpers (Task 1), the ordered extractLocator candidate
 * list (Task 2), and the widened generateLocatorCode builders (Task 3). All
 * fixtures are authored synthetic from scratch against the code's own local
 * interfaces: example.com hosts, syn- ids, invented class hashes, and invented
 * xpath shapes. No customer value appears. Element/Locator are LOCAL interfaces
 * in src/07 (not exported as named types), so parameter shapes are derived via
 * Parameters<typeof ...> where a named type is unavailable.
 *
 * The candidate ORDER encoded here is a census-grounded engineering decision
 * (08-RESEARCH §4.2), never a claim about a documented Datadog ordering.
 */
process.env.CHECKLY_ACCOUNT_NAME ??= 'tool-tests';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractLocator,
  generateLocatorCode,
  deriveRoleCandidate,
  deriveRoRoleCandidate,
  deriveStableAttrCandidates,
  isDynamicId,
  DYNAMIC_ID_PATTERNS,
  rewriteUserLocatorValue,
  pickContentText,
  type StepFlagContext,
} from '../../src/07-generate-browser-specs.ts';
import { FlagCollector } from '../../src/shared/migration-flags.ts';

/** The single resolved-locator shape, derived from a public consumer's signature. */
type Locator = ReturnType<typeof extractLocator>[number];
/** The ElementLocator argument shape, derived from extractLocator's own signature. */
type Element = NonNullable<Parameters<typeof extractLocator>[0]>;

function mkCtx(overrides: Partial<StepFlagContext> = {}): StepFlagContext {
  return { collector: new FlagCollector(), publicId: 'syn-000-tst', stepIndex: 0, ...overrides };
}

// ---------------------------------------------------------------------------
// Task 1: pure derivation helpers
// ---------------------------------------------------------------------------

describe('DYNAMIC_ID_PATTERNS: extensible denylist const', () => {
  it('is a non-empty array of RegExp', () => {
    assert.ok(Array.isArray(DYNAMIC_ID_PATTERNS), 'must be an array');
    assert.ok(DYNAMIC_ID_PATTERNS.length > 0, 'must carry at least one pattern');
    assert.ok(DYNAMIC_ID_PATTERNS.every((p) => p instanceof RegExp), 'every entry must be a RegExp');
  });
});

describe('isDynamicId (LOC-06 denylist): rejects dynamic ids, keeps semantic ids', () => {
  it('rejects an Okta input-digit id', () => {
    assert.equal(isDynamicId('input92'), true);
  });
  it('rejects an rc-menu uuid prefix id', () => {
    assert.equal(isDynamicId('rc-menu-uuid-4-1'), true);
  });
  it('rejects a pendo-prefixed id', () => {
    assert.equal(isDynamicId('pendo-button-x'), true);
  });
  it('rejects a full-GUID id', () => {
    assert.equal(isDynamicId('a1b2c3d4-0000-0000-0000-000000000000'), true);
  });
  it('rejects a ten-plus-digit run id', () => {
    assert.equal(isDynamicId('x-1234567890-y'), true);
  });
  it('keeps a plain semantic id (email)', () => {
    assert.equal(isDynamicId('email'), false);
  });
  it('keeps a plain semantic id (password)', () => {
    assert.equal(isDynamicId('password'), false);
  });
  it('keeps a hyphenated semantic id (submit-button)', () => {
    assert.equal(isDynamicId('submit-button'), false);
  });
});

describe('deriveRoleCandidate (LOC-05): role only from targetOuterHTML, name required', () => {
  it('explicit role plus aria-label yields role and name', () => {
    const html = '<div role="tab" aria-label="Reports Tab">x</div>';
    assert.deepEqual(deriveRoleCandidate(html), { role: 'tab', name: 'Reports Tab' });
  });

  it('a button tag with inner text yields role button with original-case text as name', () => {
    const html = '<button>Sign In</button>';
    assert.deepEqual(deriveRoleCandidate(html), { role: 'button', name: 'Sign In' });
  });

  it('an input with no derivable accessible name yields null (nameless role is skipped)', () => {
    const html = '<input type="text" />';
    assert.equal(deriveRoleCandidate(html), null);
  });

  it('an a[href] tag derives the link role with its text name', () => {
    const html = '<a href="/next">Continue</a>';
    assert.deepEqual(deriveRoleCandidate(html), { role: 'link', name: 'Continue' });
  });

  it('empty targetOuterHTML yields null', () => {
    assert.equal(deriveRoleCandidate(''), null);
  });
});

describe('deriveStableAttrCandidates (LOC): name, href, non-empty aria-label', () => {
  it('a name attribute yields a [name="..."] attr candidate', () => {
    const cands = deriveStableAttrCandidates('<input name="q" />');
    assert.ok(
      cands.some((c) => c.value === '[name="q"]'),
      'must include the name-attribute selector'
    );
  });

  it('a non-empty aria-label yields an [aria-label="..."] candidate', () => {
    const cands = deriveStableAttrCandidates('<div aria-label="Close panel">x</div>');
    assert.ok(cands.some((c) => c.value === '[aria-label="Close panel"]'), 'must include aria-label selector');
  });

  it('an empty aria-label yields no aria-label candidate (32 empties in the census)', () => {
    const cands = deriveStableAttrCandidates('<div aria-label="">x</div>');
    assert.ok(!cands.some((c) => c.value.startsWith('[aria-label=')), 'empty aria-label must not emit');
  });

  it('an href yields an [href="..."] candidate', () => {
    const cands = deriveStableAttrCandidates('<a href="/home">Home</a>');
    assert.ok(cands.some((c) => c.value === '[href="/home"]'), 'must include the href selector');
  });

  it('every returned candidate carries the attr source', () => {
    const cands = deriveStableAttrCandidates('<a href="/home" name="q">Home</a>');
    assert.ok(cands.length > 0, 'must derive at least one candidate');
    assert.ok(cands.every((c) => c.source === 'attr'), 'stable-attr candidates carry source attr');
  });
});

describe('rewriteUserLocatorValue (D-03): class-list join, bare-tag skip, verbatim passthrough', () => {
  it('a multi-token bare class list becomes a dotted class selector', () => {
    assert.equal(rewriteUserLocatorValue('btn primary large'), '.btn.primary.large');
  });

  it('a single bare standard tag returns null (skip the rung)', () => {
    assert.equal(rewriteUserLocatorValue('h1'), null);
  });

  it('real selector syntax passes through verbatim', () => {
    assert.equal(rewriteUserLocatorValue('#login .field'), '#login .field');
  });

  it('a single non-standard bare token (possible custom element) passes through verbatim', () => {
    assert.equal(rewriteUserLocatorValue('descope-wc'), 'descope-wc');
  });
});

describe('pickContentText (LOC-04 input): textType preference and trimming', () => {
  it('prefers directText over innerText', () => {
    const entries = [
      { text: 'inner blob', textType: 'innerText' },
      { text: 'Save', textType: 'directText' },
    ];
    assert.equal(pickContentText(entries), 'Save');
  });

  it('accepts an alt textType (second-account surface)', () => {
    const entries = [{ text: 'Company logo', textType: 'alt' }];
    assert.equal(pickContentText(entries), 'Company logo');
  });

  it('trims surrounding whitespace', () => {
    const entries = [{ text: '  Sign In  ', textType: 'directText' }];
    assert.equal(pickContentText(entries), 'Sign In');
  });

  it('skips entries empty after trim and falls to the next usable one', () => {
    const entries = [
      { text: '   ', textType: 'directText' },
      { text: 'Next', textType: 'innerText' },
    ];
    assert.equal(pickContentText(entries), 'Next');
  });

  it('returns null when no usable text exists', () => {
    assert.equal(pickContentText([{ text: '   ', textType: 'directText' }]), null);
    assert.equal(pickContentText([]), null);
  });
});

// ---------------------------------------------------------------------------
// Task 2: ordered extractLocator candidate list
// ---------------------------------------------------------------------------

describe('extractLocator (LOC-01): returns an ordered Locator[]', () => {
  it('returns [] for an undefined element', () => {
    assert.deepEqual(extractLocator(undefined), []);
  });

  it('returns [] when no candidate is derivable', () => {
    const el: Element = { targetOuterHTML: '<div>plain</div>', multiLocator: {} };
    assert.deepEqual(extractLocator(el), []);
  });

  it('userLocator is index 0 and trusted (D-03) even when a dynamic-id shape appears in it', () => {
    const el: Element = {
      targetOuterHTML: '<div id="input92">x</div>',
      userLocator: { values: [{ type: 'css', value: '#input92' }] },
      multiLocator: {},
    };
    const cands = extractLocator(el);
    assert.equal(cands[0].source, 'userLocator', 'userLocator must be first');
    assert.equal(cands[0].value, '#input92', 'the human-pinned selector is used verbatim');
  });

  it('a userLocator with a bare standard tag is skipped, and the chain self-heals', () => {
    const el: Element = {
      targetOuterHTML: '<button>Go</button>',
      userLocator: { values: [{ type: 'css', value: 'h1' }] },
      multiLocator: {},
    };
    const cands = extractLocator(el);
    assert.ok(
      !cands.some((c) => c.source === 'userLocator'),
      'a bare-tag userLocator rewrites to null and is skipped'
    );
    assert.ok(cands.length > 0, 'the chain must still self-heal to a derived candidate');
  });

  it('a data-testid-only element yields exactly one candidate, source testId, no id (LOC-07)', () => {
    const el: Element = { targetOuterHTML: '<div data-testid="save-btn">x</div>', multiLocator: {} };
    const cands = extractLocator(el);
    assert.equal(cands.length, 1, 'exactly one candidate');
    assert.equal(cands[0].source, 'testId', 'the sole candidate is the testId');
    assert.ok(!cands.some((c) => c.source === 'id'), 'no id candidate may leak from data-testid');
  });

  it('testId is ordered before a raw id extraction (LOC-07)', () => {
    const el: Element = { targetOuterHTML: '<div data-testid="save" id="wrap">x</div>', multiLocator: {} };
    const cands = extractLocator(el);
    const testIdx = cands.findIndex((c) => c.source === 'testId');
    const idIdx = cands.findIndex((c) => c.source === 'id');
    assert.ok(testIdx !== -1 && idIdx !== -1, 'both candidates present');
    assert.ok(testIdx < idIdx, 'testId must precede the id rung');
  });

  it('role precedes text precedes attr precedes id in the ordered list', () => {
    const el: Element = {
      targetOuterHTML: '<button id="submitBtn" name="go">Sign In</button>',
      multiLocator: { co: JSON.stringify([{ text: 'sign in', textType: 'directText' }]) },
    };
    const cands = extractLocator(el);
    const idxOf = (s: string) => cands.findIndex((c) => c.source === s);
    assert.ok(idxOf('role') !== -1, 'role candidate present');
    assert.ok(idxOf('text') !== -1, 'text candidate present');
    assert.ok(idxOf('attr') !== -1, 'attr candidate present');
    assert.ok(idxOf('id') !== -1, 'id candidate present');
    assert.ok(idxOf('role') < idxOf('text'), 'role before text');
    assert.ok(idxOf('text') < idxOf('attr'), 'text before attr');
    assert.ok(idxOf('attr') < idxOf('id'), 'attr before id');
  });

  it('the text candidate value is the RAW trimmed original text, no regex assembly', () => {
    const el: Element = {
      targetOuterHTML: '<div>x</div>',
      multiLocator: { co: JSON.stringify([{ text: 'no account?', textType: 'directText' }]) },
    };
    const cands = extractLocator(el);
    const text = cands.find((c) => c.source === 'text');
    assert.ok(text, 'text candidate present');
    assert.equal(text!.value, 'no account?', 'raw text preserved; escaping is generateLocatorCode job');
  });

  it('a dynamic id with a semantic co text yields the text candidate and NO id candidate (LOC-06)', () => {
    const el: Element = {
      targetOuterHTML: '<div id="input92">x</div>',
      multiLocator: { co: JSON.stringify([{ text: 'submit', textType: 'directText' }]) },
    };
    const cands = extractLocator(el);
    assert.ok(cands.some((c) => c.source === 'text'), 'the text rung survives');
    assert.ok(!cands.some((c) => c.source === 'id'), 'the dynamic id is rejected');
  });

  it('an element with ONLY a dynamic id and an ab xpath yields [ab] (id rejected, chain survives)', () => {
    const el: Element = {
      targetOuterHTML: '<div id="rc-menu-uuid-4-1">x</div>',
      multiLocator: { ab: '/*[local-name()="div"][2]' },
    };
    const cands = extractLocator(el);
    assert.equal(cands.length, 1, 'exactly the structural rung survives');
    assert.equal(cands[0].source, 'ab', 'the ab xpath rung is the sole survivor');
    assert.ok(!cands.some((c) => c.source === 'id'), 'the dynamic id must not emit');
  });

  it('a semantic id survives, demoted below role and text', () => {
    const el: Element = {
      targetOuterHTML: '<button id="submit-button">Sign In</button>',
      multiLocator: { co: JSON.stringify([{ text: 'sign in', textType: 'directText' }]) },
    };
    const cands = extractLocator(el);
    const idCand = cands.find((c) => c.source === 'id');
    assert.ok(idCand, 'the semantic id survives');
    assert.equal(idCand!.value, '#submit-button', 'the id selector is hash-prefixed');
    const idxOf = (s: string) => cands.findIndex((c) => c.source === s);
    assert.ok(idxOf('id') > idxOf('role'), 'id demoted below role');
    assert.ok(idxOf('id') > idxOf('text'), 'id demoted below text');
  });

  it('a hashed-class first token is rejected while clt still emits when present', () => {
    const el: Element = {
      targetOuterHTML: '<div>x</div>',
      multiLocator: {
        cl: 'contains(concat(" ", normalize-space(@class), " "), " sc-abQrsT ")',
        clt: '/descendant::*[contains(@class, "x") and text()="go"]',
      },
    };
    const cands = extractLocator(el);
    assert.ok(!cands.some((c) => c.source === 'class'), 'a hashed-class first token is rejected');
    assert.ok(cands.some((c) => c.source === 'clt'), 'the clt rung still emits');
  });

  it('a semantic class emits a class candidate', () => {
    const el: Element = {
      targetOuterHTML: '<div>x</div>',
      multiLocator: { cl: 'contains(concat(" ", normalize-space(@class), " "), " ant-btn ")' },
    };
    const cands = extractLocator(el);
    const cls = cands.find((c) => c.source === 'class');
    assert.ok(cls, 'a semantic class emits');
    assert.equal(cls!.value, '.ant-btn', 'the class selector is dot-prefixed');
  });

  it('at emits only when it carries an attribute predicate (@)', () => {
    const withPred: Element = { multiLocator: { at: '/descendant::*[@name="q"]' } };
    const noPred: Element = { multiLocator: { at: '/*[local-name()="div"][1]' } };
    assert.ok(extractLocator(withPred).some((c) => c.source === 'at'), 'attribute-predicated at emits');
    assert.ok(!extractLocator(noPred).some((c) => c.source === 'at'), 'a bare-path at is skipped');
  });

  it('a step with userLocator plus co plus ab yields candidates in that relative order', () => {
    const el: Element = {
      targetOuterHTML: '<div>x</div>',
      userLocator: { values: [{ type: 'css', value: '#pinned' }] },
      multiLocator: {
        co: JSON.stringify([{ text: 'save', textType: 'directText' }]),
        ab: '/*[local-name()="div"][3]',
      },
    };
    const cands = extractLocator(el);
    const idxOf = (s: string) => cands.findIndex((c) => c.source === s);
    assert.ok(idxOf('userLocator') < idxOf('text'), 'userLocator before text');
    assert.ok(idxOf('text') < idxOf('ab'), 'text before ab');
  });

  it('candidates are deduplicated by type-plus-value (ro id never duplicates the outerHTML id)', () => {
    const el: Element = {
      targetOuterHTML: '<div id="userSearch">x</div>',
      multiLocator: { ro: '//*[@id="userSearch"]' },
    };
    const cands = extractLocator(el);
    const idCands = cands.filter((c) => c.type === 'id' && c.value === '#userSearch');
    assert.equal(idCands.length, 1, 'the id from outerHTML and ro must dedup to a single candidate');
  });

  it('sd presence changes nothing about the returned list (extractLocator stays pure, no ctx)', () => {
    const withSd: Element = {
      targetOuterHTML: '<button>Go</button>',
      multiLocator: { sd: { nested: true } as unknown },
    };
    const withoutSd: Element = { targetOuterHTML: '<button>Go</button>', multiLocator: {} };
    assert.deepEqual(extractLocator(withSd), extractLocator(withoutSd), 'sd must not alter the list');
  });
});

// ---------------------------------------------------------------------------
// Task 3: widened generateLocatorCode builders
// ---------------------------------------------------------------------------

describe('generateLocatorCode (LOC-04, LOC-05): per-candidate builders', () => {
  it('role case emits getByRole with a name option and no exact-match token', () => {
    const loc: Locator = { type: 'role', value: 'button', source: 'role', name: 'Sign In' };
    const out = generateLocatorCode(loc, mkCtx());
    assert.equal(out, 'page.getByRole("button", { name: "Sign In" })');
    assert.ok(!out.includes('exact'), 'getByRole name matching is already case-insensitive substring');
  });

  it('role name with quotes is escaped through escapeString', () => {
    const loc: Locator = { type: 'role', value: 'button', source: 'role', name: 'Say "hi"' };
    const out = generateLocatorCode(loc, mkCtx());
    assert.ok(out.includes('\\"hi\\"'), 'a quoted role name must escape safely');
  });

  it('testId case emits getByTestId with the bare test id value', () => {
    const loc: Locator = { type: 'testId', value: 'save-btn', source: 'testId' };
    assert.equal(generateLocatorCode(loc, mkCtx()), 'page.getByTestId("save-btn")');
  });

  it('text case emits an anchored case-insensitive RegExp routed through escapeRegex', () => {
    const loc: Locator = { type: 'text', value: 'no account?', source: 'text' };
    const out = generateLocatorCode(loc, mkCtx());
    assert.ok(out.includes('getByText(new RegExp('), 'text emits a runtime RegExp');
    assert.ok(out.includes(', "i")'), 'the RegExp must carry the case-insensitive flag');
    // The metacharacter ? must arrive escaped inside the JSON.stringify literal.
    assert.ok(out.includes('\\\\?'), 'the ? metacharacter must be escaped via escapeRegex');
    // Anchored whole-string.
    assert.ok(out.includes('^') && out.includes('$'), 'the pattern must be caret/dollar anchored');
    assert.ok(!out.includes('exact'), 'a case-sensitive exact-match option must never appear');
  });

  it('a hostile metacharacter-bearing text value cannot break out of the emitted string (T-8-01)', () => {
    const loc: Locator = { type: 'text', value: 'a") || alert(1) //', source: 'text' };
    const out = generateLocatorCode(loc, mkCtx());
    // The whole payload lives inside a JSON string literal produced by JSON.stringify,
    // so the raw closing-quote sequence never appears unescaped in the emission.
    assert.ok(out.startsWith('page.getByText(new RegExp('), 'must stay a well-formed getByText call');
    assert.ok(out.endsWith(', "i"))'), 'the call must close cleanly with the flag');
  });

  it('userLocator css case emits a page.locator string form', () => {
    const loc: Locator = { type: 'userLocator', value: '#login .field', source: 'userLocator' };
    assert.equal(generateLocatorCode(loc, mkCtx()), 'page.locator("#login .field")');
  });

  it('an xpath-typed candidate emits page.locator with an xpath= prefix', () => {
    const loc: Locator = { type: 'xpath', value: '/descendant::*[@name="q"]', source: 'at' };
    assert.equal(generateLocatorCode(loc, mkCtx()), 'page.locator("xpath=/descendant::*[@name=\\"q\\"]")');
  });

  it('id, class, name, attr cases keep the page.locator string form', () => {
    assert.equal(
      generateLocatorCode({ type: 'id', value: '#username', source: 'id' } as Locator, mkCtx()),
      'page.locator("#username")'
    );
    assert.equal(
      generateLocatorCode({ type: 'attr', value: '[name="q"]', source: 'attr' } as Locator, mkCtx()),
      'page.locator("[name=\\"q\\"]")'
    );
  });

  it('the default receiver is page; an explicit receiver replaces it', () => {
    const loc: Locator = { type: 'id', value: '#username', source: 'id' };
    assert.equal(generateLocatorCode(loc, mkCtx()), 'page.locator("#username")');
    assert.equal(generateLocatorCode(loc, mkCtx(), 'frame'), 'frame.locator("#username")');
  });

  it('a census-shaped id-anchored multiLocator.ro emits no getByRole (LOC-05)', () => {
    // LOC-05 pins role derivation to targetOuterHTML for a NON-role ro shape. The
    // census ro is always an xpath; an id-anchored ro (//*[@id=...]) is not a role,
    // so no getByRole may derive from it. (The FID-02 defensive rung fires ONLY on a
    // genuinely role-bearing ro (bare token or a local-name() predicate); that fire
    // path is covered in the "FID-02: defensive ro role rung" block below.)
    const el: Element = {
      targetOuterHTML: '<div>x</div>',
      multiLocator: {
        ro: '//*[@id="login-button"]',
        co: JSON.stringify([{ text: 'sign in', textType: 'directText' }]),
      },
    };
    const cands = extractLocator(el);
    assert.ok(!cands.some((c) => c.source === 'role'), 'a non-role ro must never derive a role candidate');
    // And nothing that emits as getByRole survives.
    const emitted = cands.map((c) => generateLocatorCode(c, mkCtx()));
    assert.ok(!emitted.some((e) => e.includes('getByRole')), 'no emitted locator may call getByRole from a non-role ro');
  });
});

// ---------------------------------------------------------------------------
// FID-02 (D-02, gated by D-07c): the defensive ro role rung
//
// Census fact (09.5-RESEARCH (c)): multiLocator.ro is NEVER a bare ARIA role in
// either captured account (0/348 acct1, 0/73 acct2); it is always an xpath in one
// of three shapes (id-anchored, class-anchored, text-anchored), often carrying a
// local-name()="tag" predicate. The Phase-8 "role from targetOuterHTML only"
// decision is CONFIRMED, not overfit. This block pins the defensive rung: it FIRES
// only when ro genuinely encodes a real role (a bare role token, or a local-name()
// predicate whose tag maps to an implicit role), and stays SILENT on every census
// shape. On today's data and the golden seed it emits nothing (emission-neutral).
//
// All fixtures are authored synthetic (invented values only, example.com family,
// syn- ids, names 25 chars or fewer); no customer value appears.
// ---------------------------------------------------------------------------

describe('deriveRoRoleCandidate (FID-02): defensive parse of multiLocator.ro', () => {
  it('FID-02 returns null for undefined input', () => {
    assert.equal(deriveRoRoleCandidate(undefined), null);
  });

  it('FID-02 returns null for empty-string input', () => {
    assert.equal(deriveRoRoleCandidate(''), null);
  });

  it('FID-02 fires on a bare role token (hypothetical third account)', () => {
    // A third account whose ro genuinely stores a bare ARIA role must not be dropped.
    assert.deepEqual(deriveRoRoleCandidate('button'), { role: 'button' });
  });

  it('FID-02 bare-token match is a member of the known-role set (combobox), no name', () => {
    assert.deepEqual(deriveRoRoleCandidate('combobox'), { role: 'combobox' });
  });

  it('FID-02 rejects a bare token that is not a known ARIA role', () => {
    assert.equal(deriveRoRoleCandidate('notarealrole'), null);
  });

  it('FID-02 fires on a local-name() predicate, mapping the tag to its implicit role', () => {
    const ro = '//*[local-name()="button"]';
    assert.deepEqual(deriveRoRoleCandidate(ro), { role: 'button' });
  });

  it('FID-02 surfaces the text() equality predicate as the accessible name', () => {
    const ro =
      '//*[local-name()="button"][text()[normalize-space(translate(., \'SIGN IN\', \'sign in\')) = "sign in"]]';
    assert.deepEqual(deriveRoRoleCandidate(ro), { role: 'button', name: 'sign in' });
  });

  it('FID-02 accepts a single-quoted local-name() tag', () => {
    const ro = "//*[local-name()='select']";
    assert.deepEqual(deriveRoRoleCandidate(ro), { role: 'combobox' });
  });

  it('FID-02 returns null when the local-name() tag has no implicit-role mapping', () => {
    // div has no implicit role in IMPLICIT_ROLE_BY_TAG, so no role derives.
    assert.equal(deriveRoRoleCandidate('//*[local-name()="div"]'), null);
  });

  it('FID-02 stays silent on the id-anchored census shape', () => {
    assert.equal(deriveRoRoleCandidate('//*[@id="login-button"]'), null);
  });

  it('FID-02 stays silent on the class-anchored census shape', () => {
    const ro = '//*[contains(concat(\' \', normalize-space(@class), \' \'), " btn-primary ")]';
    assert.equal(deriveRoRoleCandidate(ro), null);
  });

  it('FID-02 stays silent on a text-anchored census shape with no local-name predicate', () => {
    const ro = '//*[text()[normalize-space(translate(., \'SIGN IN\', \'sign in\')) = "sign in"]]';
    assert.equal(deriveRoRoleCandidate(ro), null);
  });

  it('FID-02 never returns a role value or name carrying xpath syntax', () => {
    const shapes = [
      '//*[@id="login-button"]',
      '//*[contains(concat(\' \', normalize-space(@class), \' \'), " btn-primary ")]',
      '//*[local-name()="button"][text()[normalize-space(translate(., \'GO\', \'go\')) = "go"]]',
      '//*[local-name()="select"]',
      'button',
    ];
    for (const ro of shapes) {
      const cand = deriveRoRoleCandidate(ro);
      if (cand === null) continue;
      for (const part of [cand.role, cand.name ?? '']) {
        assert.ok(!part.includes('//'), `role part must not contain // (${ro})`);
        assert.ok(!part.includes('@id'), `role part must not contain @id (${ro})`);
        assert.ok(!part.includes('contains('), `role part must not contain contains( (${ro})`);
        assert.ok(!/[/@()"']/.test(cand.role), `the role value must be free of xpath metacharacters (${ro})`);
      }
    }
  });
});

describe('FID-02: defensive ro role rung inside extractLocator', () => {
  it('FID-02 fire case 1: a bare-role ro with no HTML role adds one role-typed candidate', () => {
    const el: Element = {
      targetOuterHTML: '<span>x</span>',
      multiLocator: { ro: 'button' },
    };
    const cands = extractLocator(el);
    const roleCands = cands.filter((c) => c.type === 'role');
    assert.equal(roleCands.length, 1, 'exactly one role candidate from ro');
    assert.equal(roleCands[0].value, 'button', 'the role value is derived from ro');
    assert.equal(roleCands[0].source, 'role', 'the candidate carries source role');
    assert.equal(roleCands[0].name, undefined, 'a bare-token ro carries no accessible name');
  });

  it('FID-02 fire case 2: a local-name() ro with a text() predicate carries the name', () => {
    const el: Element = {
      targetOuterHTML: '<span>x</span>',
      multiLocator: {
        ro: '//*[local-name()="button"][text()[normalize-space(translate(., \'SIGN IN\', \'sign in\')) = "sign in"]]',
      },
    };
    const cands = extractLocator(el);
    const roleCands = cands.filter((c) => c.type === 'role');
    assert.equal(roleCands.length, 1, 'exactly one role candidate from ro');
    assert.equal(roleCands[0].value, 'button', 'the role value is mapped from the local-name tag');
    assert.equal(roleCands[0].name, 'sign in', 'the text() equality predicate surfaces as the name');
    // It emits as a real getByRole with a name option.
    const emitted = generateLocatorCode(roleCands[0], mkCtx());
    assert.equal(emitted, 'page.getByRole("button", { name: "sign in" })');
  });

  it('FID-02 silent case 1: an id-anchored ro derives no role candidate', () => {
    const el: Element = {
      targetOuterHTML: '<div>x</div>',
      multiLocator: { ro: '//*[@id="login-button"]' },
    };
    const cands = extractLocator(el);
    assert.ok(!cands.some((c) => c.type === 'role'), 'no role candidate from an id-anchored ro');
    // The existing secondary-id rung behavior at this site is unchanged: the
    // semantic id still emits as an id candidate.
    assert.ok(
      cands.some((c) => c.source === 'id' && c.value === '#login-button'),
      'the id rung still emits from the id-anchored ro'
    );
  });

  it('FID-02 silent case 2: a class-anchored ro derives no role candidate', () => {
    const el: Element = {
      targetOuterHTML: '<div>x</div>',
      multiLocator: {
        ro: '//*[contains(concat(\' \', normalize-space(@class), \' \'), " btn-primary ")]',
      },
    };
    const cands = extractLocator(el);
    assert.ok(!cands.some((c) => c.type === 'role'), 'no role candidate from a class-anchored ro');
  });

  it('FID-02 silent case 3: a text-anchored ro with no local-name predicate derives no role', () => {
    const el: Element = {
      targetOuterHTML: '<div>x</div>',
      multiLocator: {
        ro: '//*[text()[normalize-space(translate(., \'SIGN IN\', \'sign in\')) = "sign in"]]',
      },
    };
    const cands = extractLocator(el);
    assert.ok(!cands.some((c) => c.type === 'role'), 'no role candidate from a bare text-anchored ro');
  });

  it('FID-02 dedupe: an HTML-derived role button and an ro-derived role button collapse to one', () => {
    const el: Element = {
      targetOuterHTML: '<button>Sign In</button>',
      multiLocator: { ro: '//*[local-name()="button"]' },
    };
    const cands = extractLocator(el);
    const roleCands = cands.filter((c) => c.type === 'role' && c.value === 'button');
    assert.equal(roleCands.length, 1, 'the type-and-value dedupe collapses the two role buttons');
  });

  it('FID-02 garbage guard: no role candidate in the suite carries xpath syntax', () => {
    const fixtures: Element[] = [
      { targetOuterHTML: '<span>x</span>', multiLocator: { ro: 'button' } },
      {
        targetOuterHTML: '<span>x</span>',
        multiLocator: { ro: '//*[local-name()="button"][text()[normalize-space(translate(., \'GO\', \'go\')) = "go"]]' },
      },
      { targetOuterHTML: '<div>x</div>', multiLocator: { ro: '//*[@id="login-button"]' } },
      {
        targetOuterHTML: '<div>x</div>',
        multiLocator: { ro: '//*[contains(concat(\' \', normalize-space(@class), \' \'), " btn-primary ")]' },
      },
      { targetOuterHTML: '<button>Sign In</button>', multiLocator: { ro: '//*[local-name()="button"]' } },
    ];
    for (const el of fixtures) {
      for (const c of extractLocator(el)) {
        if (c.type !== 'role') continue;
        for (const part of [c.value, c.name ?? '']) {
          assert.ok(!part.includes('//'), 'no role value or name may contain //');
          assert.ok(!part.includes('@id'), 'no role value or name may contain @id');
          assert.ok(!part.includes('contains('), 'no role value or name may contain contains(');
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// FID-05 (Phase 9.5, plan 09.5-04): stale-xpath demotion (D-05, D-07d).
//
// The ab/at/clt sourced xpath rungs are Datadog-recorded breadcrumbs, not live
// pass-if-any candidates. When at least one STABLER candidate (source OUTSIDE the
// {ab, at, clt} set) exists, every ab/at/clt candidate is marked provenanceOnly
// so withLocator partitions it out of the live chain (it survives as a commented
// breadcrumb). When the ONLY derivable candidates are ab/at/clt, NONE is marked
// (last resort keeps the step live, never regressing to the zero-candidate
// deactivate path). Demotion keys STRICTLY on source membership in {ab, at, clt},
// never on type === 'xpath', so a user-pinned userLocator xpath (FID-01 authority)
// is untouched. Order is NEVER changed: candidates[0] is live by construction.
// ---------------------------------------------------------------------------

describe('FID-05: stale-xpath demotion in extractLocator (D-05, D-07d)', () => {
  it('Extraction 1 (marking): with a stable rung present, every ab/at/clt candidate is provenanceOnly, order unchanged', () => {
    // A role from targetOuterHTML (stable) plus ab, an @-predicated at, and a clt.
    const el: Element = {
      targetOuterHTML: '<button>Sign In</button>',
      multiLocator: {
        clt: '/descendant::button[contains(@class, "cta")]',
        at: '/descendant::button[@data-qa="signin"]',
        ab: '/html/body/div/button',
      },
    };
    const cands = extractLocator(el);
    const staleSources = new Set(['ab', 'at', 'clt']);

    // At least one stable (non-stale) candidate must be present to trigger marking.
    assert.ok(
      cands.some((c) => c.source && !staleSources.has(c.source)),
      'the fixture must carry a stabler candidate (role) so demotion fires'
    );

    for (const c of cands) {
      if (c.source && staleSources.has(c.source)) {
        assert.equal(
          (c as { provenanceOnly?: boolean }).provenanceOnly,
          true,
          `an ${c.source}-sourced candidate must be marked provenanceOnly when a stabler rung exists`
        );
      } else {
        assert.ok(
          !(c as { provenanceOnly?: boolean }).provenanceOnly,
          `a stable ${c.source}-sourced candidate must NEVER be marked provenanceOnly`
        );
      }
    }

    // Order is unchanged: role first, then clt, at, ab in their extraction order.
    const sources = cands.map((c) => c.source);
    assert.deepEqual(sources, ['role', 'clt', 'at', 'ab'], 'extraction order is never reordered by the marking pass');
  });

  it('Extraction 2 (last resort): when the ONLY candidates are ab/at/clt, none is provenanceOnly (they stay live)', () => {
    const el: Element = {
      // No role, no text, no stable attr, no semantic id: only structural xpath rungs.
      targetOuterHTML: '<div>x</div>',
      multiLocator: {
        at: '/descendant::div[@data-qa="only"]',
        ab: '/html/body/div',
      },
    };
    const cands = extractLocator(el);
    const staleSources = new Set(['ab', 'at', 'clt']);
    assert.ok(cands.length > 0, 'the last-resort chain must still yield candidates (no empty drop)');
    assert.ok(
      cands.every((c) => c.source && staleSources.has(c.source)),
      'this fixture must yield ONLY stale-sourced candidates'
    );
    for (const c of cands) {
      assert.ok(
        !(c as { provenanceOnly?: boolean }).provenanceOnly,
        `the sole-signal ${c.source} candidate must stay live (never provenanceOnly) as last resort`
      );
    }
  });

  it('Extraction 3 (pin exemption): a userLocator xpath pin stays live at index 0; the ab entry is marked (D-07d)', () => {
    const el: Element = {
      targetOuterHTML: '<div>x</div>',
      userLocator: { values: [{ type: 'xpath', value: '//button[@data-pin="go"]' }] },
      multiLocator: {
        ab: '/html/body/div/button',
      },
    };
    const cands = extractLocator(el);
    // The user-pinned xpath is index 0 and MUST stay live (demotion keys on source,
    // not on the xpath type; a pinned xpath is source 'userLocator', outside the set).
    assert.equal(cands[0].source, 'userLocator', 'a human-pinned locator sits at index 0');
    assert.equal(cands[0].type, 'xpath', 'the pin is an xpath type (the exemption is by SOURCE, not type)');
    assert.ok(
      !(cands[0] as { provenanceOnly?: boolean }).provenanceOnly,
      'a user-pinned xpath must NEVER be demoted (D-07d)'
    );
    // No userLocator-sourced candidate may ever carry provenanceOnly.
    for (const c of cands) {
      if (c.source === 'userLocator') {
        assert.ok(!(c as { provenanceOnly?: boolean }).provenanceOnly, 'no userLocator candidate may be provenanceOnly');
      }
    }
    // The ab rung is demoted because a stabler candidate (the pin) exists.
    const abCand = cands.find((c) => c.source === 'ab');
    assert.ok(abCand, 'the ab rung is present');
    assert.equal((abCand as { provenanceOnly?: boolean }).provenanceOnly, true, 'the ab rung is marked provenanceOnly beneath the pin');
  });

  it('Invariant lock: candidates[0] from extractLocator is NEVER provenanceOnly (residue call site reads a live primary)', () => {
    const fixtures: Element[] = [
      // Stable-led (role first).
      {
        targetOuterHTML: '<button>Sign In</button>',
        multiLocator: { at: '/descendant::button[@data-qa="x"]', ab: '/html/body/button' },
      },
      // Last-resort (stale-only): index 0 is a live stale rung.
      { targetOuterHTML: '<div>x</div>', multiLocator: { ab: '/html/body/div' } },
      // Pin-led.
      {
        targetOuterHTML: '<div>x</div>',
        userLocator: { values: [{ type: 'xpath', value: '//a[@data-pin="y"]' }] },
        multiLocator: { ab: '/html/body/a' },
      },
      // Text-led with stale followers.
      {
        targetOuterHTML: '<div>x</div>',
        multiLocator: {
          co: JSON.stringify([{ text: 'save', textType: 'directText' }]),
          clt: '/descendant::div[contains(@class, "z")]',
        },
      },
    ];
    for (const el of fixtures) {
      const cands = extractLocator(el);
      if (cands.length === 0) continue;
      assert.ok(
        !(cands[0] as { provenanceOnly?: boolean }).provenanceOnly,
        'candidates[0] must always be live so detectLocatorResidue(candidates[0]) inspects a real primary'
      );
    }
  });
});
