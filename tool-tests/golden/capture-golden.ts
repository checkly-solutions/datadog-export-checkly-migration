/**
 * Golden capture harness (capture + verify modes).
 *
 * Runs the migration pipeline as subprocesses against the committed synthetic
 * fixture corpus (tool-tests/fixtures/exports-seed/), fully isolated in a
 * mkdtemp working directory outside the repo tree, then normalizes known
 * volatile timestamp fields and either:
 *
 *   capture: replaces tool-tests/golden/tree/ with the normalized output tree
 *   verify:  byte-compares a fresh normalized capture against the committed
 *            tree and exits nonzero on any difference
 *
 * This is a standalone script, deliberately NOT matched by the
 * tool-tests/**\/*.test.ts glob: the default test path must never spawn
 * subprocesses (decision). Invoke via npm run golden:capture or
 * npm run golden:verify.
 *
 * Importing this module runs nothing; mode dispatch happens only when the
 * file is the direct CLI entry point with an explicit mode argument.
 *
 * Isolation invariants (decision):
 *   - cwd for every subprocess is a fresh temp dir under os.tmpdir(), so the
 *     cwd-relative .account-name cache and checkly-migrated/ output root
 *     (see src/shared/output-config.ts) never touch the repo tree.
 *   - CHECKLY_ACCOUNT_NAME is set explicitly on every spawn, so the
 *     interactive account-name prompt can never fire.
 *   - The subprocess env is minimal and EXPLICIT (never spread from
 *     process.env): inherited DD_TAGS_EXCLUDE / DD_TAGS_EXCLUDE_ALL /
 *     DD_TAGS_REMAP or CHECKLY_TCP_PROJECT_NAME / CHECKLY_DNS_PROJECT_NAME
 *     would silently change the captured bytes.
 *   - stdin is 'ignore' so any accidental prompt fails fast on EOF instead
 *     of hanging the runner.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');

// Node resolves --import specifiers relative to the CWD, so from the temp
// working directory the bare specifier "jiti/register" does NOT resolve.
// Every spawn must pass the ABSOLUTE path to jiti's register hook instead.
const JITI_REGISTER = join(REPO, 'node_modules', 'jiti', 'lib', 'jiti-register.mjs');

const FIXTURE_SEED_DIR = join(REPO, 'tool-tests', 'fixtures', 'exports-seed');
const GOLDEN_TREE_DIR = join(REPO, 'tool-tests', 'golden', 'tree');

// Account name used for every capture run. Output lands under
// <tmp>/checkly-migrated/golden/ and nowhere else.
const ACCOUNT_NAME = 'golden';

/**
 * Pipeline steps captured in the golden baseline, in strict pipeline order.
 *
 * Excluded steps, with reasons:
 *   - 01 (initial-datadog-export): needs live Datadog network access.
 *   - 03 (filter-multi-step): outside the refactor list and
 *     unnecessary here because the committed fixtures are pre-split
 *     (api-tests.json contains no multi subtype; multi-step-tests.json is
 *     committed directly).
 *   - 09 (convert-global-variables) and 10 (add-default-resources): outside
 *     the refactor list; both import dotenv/config at module level.
 *   - 10a (check-datadog-test-status): module-level dotenv AND needs live
 *     Datadog API access, so it cannot run offline. Its behavior
 *     preservation is proven by mechanical-diff review plus the
 *     import-side-effect test in, not by capture.
 *   - 10b (deactivate-missing-secrets): outside the refactor list.
 */
export const GOLDEN_STEPS = [
  '02-convert-datadog-api-to-json.ts',
  '04-generate-api-check-constructs-from-json.ts',
  '04b-generate-tcp-monitor-constructs.ts',
  '04c-generate-dns-monitor-constructs.ts',
  '05-generate-multi-step-specs.ts',
  '06-generate-multi-step-constructs.ts',
  '07-generate-browser-specs.ts',
  '08-generate-browser-constructs.ts',
  '11-generate-groups.ts',
  '12-generate-migration-report.ts',
] as const;

/**
 * JSON keys whose string values are wall-clock timestamps written by the
 * pipeline (src/02 convertedAt, src/05 and src/07 manifest generatedAt,
 * src/shared/variable-tracker.ts generatedAt, src/12 generatedAt, plus
 * exportedAt echoed from input and checkedAt/fetchedAt from status data).
 * Every occurrence, at any depth in any captured .json file, is replaced
 * with the sentinel NORMALIZED before writing or comparing.
 *
 * This is the auditable, documented volatile-field list. If a golden:verify
 * run fails showing ONLY ISO-8601 timestamp diffs or "Generated:" style
 * line diffs, that means a volatile field is missing from this list (or
 * from MARKDOWN_TIMESTAMP_LINE_PREFIXES below): extend the list, re-capture,
 * and re-verify. The failure mode is fail-safe by design (assumption A1):
 * an incomplete list causes a spurious failure to investigate, never a
 * silent pass.
 */
export const NORMALIZED_TIMESTAMP_KEYS = [
  'convertedAt',
  'generatedAt',
  'exportedAt',
  'checkedAt',
  'fetchedAt',
] as const;

/**
 * Line prefixes in migration-report.md whose value portion is wall-clock
 * (src/12 writes them via toLocaleString()). The value after the prefix is
 * replaced with NORMALIZED.
 */
export const MARKDOWN_TIMESTAMP_LINE_PREFIXES = [
  '**Generated:**',
  '**Export Date:**',
  '**Checked at:**',
] as const;

const SENTINEL = 'NORMALIZED';

/** Run one pipeline step as a subprocess from the isolated temp cwd. */
function runStep(step: string, workDir: string): void {
  const result = spawnSync(
    process.execPath,
    ['--import', JITI_REGISTER, join(REPO, 'src', step)],
    {
      cwd: workDir,
      env: {
        // Minimal EXPLICIT env. Never spread process.env: inherited
        // DD_TAGS_* or CHECKLY_TCP/DNS_PROJECT_NAME silently change output.
        PATH: process.env.PATH ?? '',
        CHECKLY_ACCOUNT_NAME: ACCOUNT_NAME,
        TZ: 'UTC',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
      },
      // stdin 'ignore': an accidental interactive prompt fails fast on EOF
      // instead of hanging the runner.
      stdio: ['ignore', 'inherit', 'inherit'],
    }
  );
  if (result.error) {
    throw new Error(`Step ${step} failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Step ${step} exited with status ${result.status}`);
  }
}

/** Recursively collect every file under a directory, as relative paths. */
function collectFiles(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(root, full));
    } else if (entry.isFile()) {
      out.push(relative(root, full));
    }
  }
  return out.sort();
}

/**
 * Replace the string value of every normalized timestamp key in raw JSON
 * text. Operates on the raw text (not parse + re-stringify) so the file's
 * original formatting is preserved byte for byte.
 */
export function normalizeJsonText(text: string): string {
  const keyGroup = NORMALIZED_TIMESTAMP_KEYS.join('|');
  const pattern = new RegExp(`"(${keyGroup})"(\\s*:\\s*)"[^"]*"`, 'g');
  return text.replace(pattern, `"$1"$2"${SENTINEL}"`);
}

/**
 * Replace the value portion of known timestamp lines in the markdown
 * migration report.
 */
export function normalizeMarkdownText(text: string): string {
  return text
    .split('\n')
    .map(line => {
      for (const prefix of MARKDOWN_TIMESTAMP_LINE_PREFIXES) {
        if (line.startsWith(prefix)) {
          return `${prefix} ${SENTINEL}`;
        }
      }
      return line;
    })
    .join('\n');
}

/** Normalize all volatile fields in the captured tree, in place. */
async function normalizeTree(root: string): Promise<void> {
  for (const rel of collectFiles(root)) {
    const full = join(root, rel);
    if (rel.endsWith('.json')) {
      const text = await readFile(full, 'utf-8');
      const normalized = normalizeJsonText(text);
      if (normalized !== text) {
        await writeFile(full, normalized, 'utf-8');
      }
    } else if (rel.endsWith('migration-report.md')) {
      const text = await readFile(full, 'utf-8');
      const normalized = normalizeMarkdownText(text);
      if (normalized !== text) {
        await writeFile(full, normalized, 'utf-8');
      }
    }
  }
}

/**
 * Run the pipeline against the fixture seed in an isolated temp dir and
 * return the path of the normalized output tree (the account dir).
 */
async function captureToTemp(workDir: string): Promise<string> {
  const accountDir = join(workDir, 'checkly-migrated', ACCOUNT_NAME);
  const exportsDir = join(accountDir, 'exports');
  await mkdir(exportsDir, { recursive: true });
  await cp(FIXTURE_SEED_DIR, exportsDir, { recursive: true });

  for (const step of GOLDEN_STEPS) {
    console.log(`Running ${step} ...`);
    runStep(step, workDir);
  }

  await normalizeTree(accountDir);
  return accountDir;
}

/** capture mode: replace the committed golden tree with a fresh capture. */
async function capture(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), 'golden-'));
  try {
    const accountDir = await captureToTemp(workDir);
    await rm(GOLDEN_TREE_DIR, { recursive: true, force: true });
    await cp(accountDir, GOLDEN_TREE_DIR, { recursive: true });
    console.log(`Golden tree captured to ${relative(REPO, GOLDEN_TREE_DIR)}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * verify mode: fresh capture must match the committed golden tree byte for
 * byte after normalization. Reports every missing, extra, and differing
 * file; exits 1 on any difference.
 */
async function verify(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), 'golden-'));
  try {
    const accountDir = await captureToTemp(workDir);

    const goldenFiles = collectFiles(GOLDEN_TREE_DIR);
    const freshFiles = collectFiles(accountDir);
    const goldenSet = new Set(goldenFiles);
    const freshSet = new Set(freshFiles);

    const problems: string[] = [];

    for (const rel of goldenFiles) {
      if (!freshSet.has(rel)) {
        problems.push(`MISSING from fresh capture: ${rel}`);
      }
    }
    for (const rel of freshFiles) {
      if (!goldenSet.has(rel)) {
        problems.push(`EXTRA in fresh capture (not in golden tree): ${rel}`);
      }
    }
    for (const rel of goldenFiles) {
      if (!freshSet.has(rel)) continue;
      const goldenBuf = readFileSync(join(GOLDEN_TREE_DIR, rel));
      const freshBuf = readFileSync(join(accountDir, rel));
      if (!goldenBuf.equals(freshBuf)) {
        problems.push(`DIFFERS: ${rel}`);
      }
    }

    if (problems.length > 0) {
      console.error('golden:verify FAILED. Differences after normalization:');
      for (const p of problems) {
        console.error(`  ${p}`);
      }
      console.error(
        'If every difference is a timestamp-shaped field, extend ' +
          'NORMALIZED_TIMESTAMP_KEYS or MARKDOWN_TIMESTAMP_LINE_PREFIXES, ' +
          're-capture, and re-verify.'
      );
      process.exit(1);
    }

    console.log(
      `golden:verify OK. ${goldenFiles.length} files byte-identical after normalization.`
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// Mode dispatch: only when this file is the direct CLI entry point with an
// explicit mode argument. Importing the module never runs the pipeline.
const isDirectInvocation =
  typeof process.argv[1] === 'string' &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isDirectInvocation) {
  const mode = process.argv[2];
  const run = mode === 'capture' ? capture : mode === 'verify' ? verify : null;
  if (!run) {
    console.error('Usage: capture-golden.ts <capture|verify>');
    process.exit(1);
  }
  run().catch(err => {
    console.error('Error:', (err as Error).message);
    process.exit(1);
  });
}
