/**
 * Fixture integrity gate (backstop).
 *
 * Scans every committed file under tool-tests/fixtures/ (and, when present,
 * tool-tests/golden/tree/) against a denylist of patterns that indicate
 * real-world identifying data: non-example URLs, routable IPs, non-zero UUIDs,
 * long unbroken tokens, and emails at non-example domains.
 *
 * Resolution rule: any denylist hit in a fixture means fix the fixture, never
 * loosen the pattern. Only product documentation hosts may ever be added to
 * the URL allowlist, each with an inline comment explaining why.
 *
 * This gate is a backstop. The primary defense is that fixtures are authored
 * synthetic from scratch using only invented values (example.com hosts,
 * RFC-5737 IPs, all-zeros UUIDs, synthetic public IDs).
 *
 * Scan scope is deliberately limited to the two directories above. This test
 * file itself contains planted bad samples for the self-test and must never
 * be scanned.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');
const GOLDEN_TREE_DIR = join(__dirname, 'golden', 'tree');

// Product documentation hosts allowed in URLs. These are product constants
// that legitimately appear in generated output as documentation links; they
// are not customer identifying data. Nothing else may ever join this list.
const PRODUCT_DOC_HOSTS = [
  'checklyhq\\.com', // Checkly product documentation links embedded in generated code
  'datadoghq\\.com', // Datadog product host; appears as the export "site" and in doc links
  'playwright\\.dev', // Playwright documentation links embedded in generated specs
];

// URL hosts that are always allowed: example.com/org/net and subdomains,
// RFC-2606 reserved TLDs, localhost, and the product doc hosts above.
const URL_ALLOWLIST_LOOKAHEAD = [
  `(?:[a-z0-9-]+\\.)*example\\.(?:com|org|net)(?:[/:"']|$)`,
  `[a-z0-9.-]+\\.(?:test|invalid|example|localhost)(?:[/:"']|$)`,
  `localhost(?:[/:"']|$)`,
  `(?:[a-z0-9-]+\\.)*(?:${PRODUCT_DOC_HOSTS.join('|')})(?:[/:"']|$)`,
].join('|');

const DENYLIST: Array<{ label: string; pattern: RegExp }> = [
  {
    label: 'URL with non-example/non-reserved host',
    pattern: new RegExp(
      `https?:\\/\\/(?!${URL_ALLOWLIST_LOOKAHEAD})[^\\s"']+`,
      'i'
    ),
  },
  {
    // Hyphen deliberately excluded from the character class so long
    // hyphenated logical IDs in generated code do not false-positive.
    // UUIDs are covered by their own pattern below.
    label: 'Long unbroken alphanumeric string (possible key/token/hash)',
    pattern: /\b[A-Za-z0-9_]{32,}\b/,
  },
  {
    label: 'Email with non-example domain',
    pattern: /[a-zA-Z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  },
  {
    label: 'Non-RFC-5737 IPv4 address',
    pattern: /\b(?!192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|0\.0\.0\.0|127\.0\.0\.1)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  },
  {
    // The negative lookahead exempts the sanctioned all-zeros placeholder
    // (0 is in [0-9a-f], so without it the placeholder itself would match).
    label: 'UUID other than all-zeros',
    pattern: /\b(?!00000000-0000-0000-0000-000000000000)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  },
];

/** Recursively collect every file (any type) under a directory. */
function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

const scanDirs = [FIXTURES_DIR];
if (existsSync(GOLDEN_TREE_DIR)) {
  scanDirs.push(GOLDEN_TREE_DIR);
}

const scannedFiles = scanDirs.flatMap(dir => collectFiles(dir)).sort();

describe('fixture integrity: committed corpus contains no identifying data', () => {
  it('finds at least one fixture file to scan', () => {
    assert.ok(scannedFiles.length > 0, `no files found under ${FIXTURES_DIR}`);
  });

  for (const filePath of scannedFiles) {
    const relPath = relative(join(__dirname, '..'), filePath);
    it(`${relPath} passes every denylist pattern`, () => {
      const content = readFileSync(filePath, 'utf-8');
      for (const { label, pattern } of DENYLIST) {
        const match = content.match(pattern);
        assert.ok(
          !match,
          `${relPath} contains identifying data: [${label}] matched "${match?.[0]}". ` +
            'Fix the fixture, never loosen the pattern.'
        );
      }
    });
  }
});

// In-memory known-bad samples, one per denylist entry. These prove the gate
// can actually catch what it claims to catch. They exist only in this file,
// which is intentionally outside the scan scope.
const KNOWN_BAD_SAMPLES: Record<string, string> = {
  'URL with non-example/non-reserved host': 'https://portal.acme-widgets.io/admin/login',
  'Long unbroken alphanumeric string (possible key/token/hash)': 'A1b2C3d4'.repeat(5),
  'Email with non-example domain': 'alice@acme-widgets.io',
  'Non-RFC-5737 IPv4 address': '10.1.2.3',
  'UUID other than all-zeros': 'deadbeef-dead-beef-dead-beefdeadbeef',
};

describe('fixture integrity: self-test, every pattern detects its known-bad sample', () => {
  for (const { label, pattern } of DENYLIST) {
    it(`[${label}] detects the planted sample`, () => {
      const sample = KNOWN_BAD_SAMPLES[label];
      assert.ok(sample !== undefined, `no known-bad sample registered for "${label}"`);
      assert.ok(pattern.test(sample), `pattern for "${label}" failed to detect "${sample}"`);
    });
  }

  it('sanctioned placeholder values pass every pattern', () => {
    const sanctioned = [
      'https://api.example.com/v1/status',
      'https://www.checklyhq.com/docs/',
      'user@example.com',
      '192.0.2.10',
      '127.0.0.1',
      '00000000-0000-0000-0000-000000000000',
    ].join(' ');
    for (const { label, pattern } of DENYLIST) {
      assert.ok(
        !pattern.test(sanctioned),
        `pattern for "${label}" false-positives on sanctioned values`
      );
    }
  });
});
