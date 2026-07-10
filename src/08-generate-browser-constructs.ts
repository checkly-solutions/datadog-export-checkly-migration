/**
 * Generates Checkly BrowserCheck constructs from Datadog browser tests.
 *
 * Reads: exports/browser-tests.json (for metadata: tags, locations, frequency, etc.)
 * Reads: checkly-migrated/tests/browser/_manifest.json (for spec file mappings)
 * Outputs: checkly-migrated/__checks__/browser/*.check.ts
 *
 * Each BrowserCheck construct references its corresponding .spec.ts file.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { sanitizeFilename, uniqueLogicalId, normalizePublicChecklyLocations, convertFrequency, convertConfigVariables, escapeString, filterAndRemapTags, priorityTag, PLAYWRIGHT_ENGINE_ORDER } from './shared/utils.ts';
import { trackConfigVariableConversions, loadExistingVariableUsage, writeVariableUsageReport } from './shared/variable-tracker.ts';
import { getOutputRoot, getExportsDir } from './shared/output-config.ts';
import type { MigrationFlagsFile } from './shared/migration-flags.ts';
// Relative path from __checks__/browser/{public,private} to tests/browser/{public,private}
const SPECS_RELATIVE_PATH = '../../../tests/browser';

interface BrowserTest {
  public_id: string;
  name: string;
  // Pre-processed by step 01:
  locations: string[];           // Mapped public Checkly locations
  privateLocations: string[];    // Checkly private location slugs (derived from Datadog pl:xxx)
  originalLocations: string[];   // Original Datadog locations for reference
  status?: string;
  tags?: string[];
  options?: {
    tick_every?: number;
    retry?: {
      count?: number;
      interval?: number;
    };
    monitor_priority?: number;
  };
  config?: {
    steps?: unknown[];
    configVariables?: Array<{
      type: string;
      name: string;
      pattern?: string;
      example?: string;
      secure?: boolean;
      id?: string;
    }>;
  };
}

interface ManifestFile {
  logicalId: string;
  name: string;
  filename: string;
  hasIframes?: boolean;
  // hasMultiCandidate: written by src/07 (plan 08-03) when a spec resolved at
  // least one step with two or more firstMatch candidates. Optional and
  // null-tolerant: older manifests without the field behave as false. Drives
  // the reviewMultiSelector construct tag (D-06), mirroring hasIframes exactly.
  hasMultiCandidate?: boolean;
  // secretKeys: written by src/07 (plan 09-05, SEC-01 routing) as the step-order
  // list of env-var key names a spec routed its type="password" fills to (each a
  // uppercase, valid, non-digit-leading identifier). Optional and null-tolerant:
  // older manifests without the field behave as an empty array. Drives the
  // construct-side environmentVariables secret declaration (SEC-02 / D-02),
  // mirroring hasMultiCandidate transport exactly.
  secretKeys?: string[];
  // pwEngines: written by src/07 (plan 10-02, PWCS-03) as the deduped, canonical
  // PLAYWRIGHT_ENGINE_ORDER-ordered Playwright engine set derived from the test's
  // options.device_ids. Optional and null-tolerant: older manifests without the
  // field behave as an empty array. Drives the PlaywrightCheck-vs-BrowserCheck
  // branch here (length > 1 => PlaywrightCheck + companion playwright.config.ts;
  // length <= 1 => the unchanged BrowserCheck path), mirroring secretKeys transport.
  pwEngines?: string[];
}

interface Manifest {
  generatedAt: string;
  outputDir: string;
  locationType: string;
  files: ManifestFile[];
}

interface GeneratedFile {
  logicalId: string;
  name: string;
  filename: string;
}

interface GenerationResult {
  successCount: number;
  errorCount: number;
  skippedCount: number;
}

/**
 * The two public_id sets the MIGRATION-FLAG system needs at construct time.
 *
 * flaggedIds drives the reviewMigrationFlag tag (D-04); deactivatedIds drives
 * the strictly-one-way activated:false override for the FLAG-04 zero-signal
 * subset only (D-05, bounded by D-06). Both are plain string Sets so membership
 * checks in generateBrowserCheckCode stay O(1).
 */
export interface MigrationFlagState {
  flaggedIds: Set<string>;
  deactivatedIds: Set<string>;
}

/**
 * Derive the flagged and deactivated public_id sets from a MigrationFlagsFile.
 *
 * Pure and total: it never throws on a malformed shape (RESEARCH A4). The
 * always-valid base derivation is the flags records array, defaulting to an
 * empty array when absent or not an array: flaggedIds collects every record
 * whose publicId is a non-empty string (anything else is skipped), and
 * deactivatedIds collects the publicIds of records whose deactivates field is
 * strictly true. The precomputed flaggedCheckIds / deactivatedCheckIds arrays
 * that plan 07-01 also ships are unioned in defensively, never required, so
 * step 08 works against any writer variant and against older exports.
 */
export function deriveFlagState(file: MigrationFlagsFile | null | undefined): MigrationFlagState {
  const flaggedIds = new Set<string>();
  const deactivatedIds = new Set<string>();

  const records = Array.isArray(file?.flags) ? file!.flags : [];
  for (const record of records) {
    const publicId = record?.publicId;
    if (typeof publicId !== 'string' || publicId.length === 0) {
      continue;
    }
    flaggedIds.add(publicId);
    if (record?.deactivates === true) {
      deactivatedIds.add(publicId);
    }
  }

  // Defensive union with the precomputed id arrays, if the writer supplied them.
  if (Array.isArray(file?.flaggedCheckIds)) {
    for (const id of file!.flaggedCheckIds) {
      if (typeof id === 'string' && id.length > 0) flaggedIds.add(id);
    }
  }
  if (Array.isArray(file?.deactivatedCheckIds)) {
    for (const id of file!.deactivatedCheckIds) {
      if (typeof id === 'string' && id.length > 0) deactivatedIds.add(id);
    }
  }

  return { flaggedIds, deactivatedIds };
}

/**
 * Read exports/migration-flags.json null-tolerantly and derive its flag state.
 *
 * Performs IO only when called (no top-level side effects, so the import-guard
 * test stays green). When the file is absent, logs one informational line and
 * degrades to empty sets, keeping step 08 runnable against older exports
 * directories that predate the artifact (RESEARCH A4). Any read or parse error
 * is caught, logged via console.warn, and degrades to empty sets: a malformed,
 * truncated, or missing artifact never crashes construct generation (T-07-41).
 */
export async function readMigrationFlagState(exportsDir: string): Promise<MigrationFlagState> {
  const flagsPath = path.join(exportsDir, 'migration-flags.json');

  if (!existsSync(flagsPath)) {
    console.log(`  No migration flags file found at ${flagsPath}; skipping flag tagging and deactivation.`);
    return deriveFlagState(null);
  }

  try {
    const parsed = JSON.parse(await readFile(flagsPath, 'utf-8')) as MigrationFlagsFile;
    return deriveFlagState(parsed);
  } catch (err) {
    console.warn(`  Could not read migration flags file ${flagsPath}: ${(err as Error).message}. Skipping flag tagging and deactivation.`);
    return deriveFlagState(null);
  }
}

/**
 * Convert Datadog retry config to Checkly retry strategy
 */
export function generateRetryStrategy(ddRetry?: { count?: number; interval?: number }): string {
  if (!ddRetry || ddRetry.count === 0) {
    return 'RetryStrategyBuilder.noRetries()';
  }

  const intervalSeconds = Math.ceil((ddRetry.interval || 10000) / 1000);

  return `RetryStrategyBuilder.linearStrategy({
    baseBackoffSeconds: ${intervalSeconds},
    maxRetries: ${ddRetry.count || 2},
    maxDurationSeconds: 600,
    sameRegion: true,
  })`;
}

/**
 * The check-level properties both browser emitters (BrowserCheck via
 * generateBrowserCheckCode and PlaywrightCheck via generatePlaywrightCheckCode)
 * compute identically before they diverge into construct-specific templates.
 */
interface BrowserCheckLevelProps {
  logicalId: string;
  frequency: string;
  activated: boolean;
  allTags: string[];
  envVarsCode: string;
}

/**
 * Compute the check-level properties shared by BrowserCheck and PlaywrightCheck
 * emission, making the two constructs' parity structural rather than assumed
 * (D-02). Both generateBrowserCheckCode and generatePlaywrightCheckCode call
 * this and destructure only the fields their template needs, so a future tag or
 * activation change touches ONE place and can never silently drift between the
 * two emitters.
 *
 * Internal to this module (never exported); the computation below is moved
 * verbatim from generateBrowserCheckCode, whose fuller explanatory comments are
 * kept as the canonical version. The construct-specific properties
 * (BrowserCheck's retryStrategy / specsPath, PlaywrightCheck's
 * playwrightConfigPath / pwProjects) stay in their respective callers.
 */
function computeBrowserCheckLevelProps(
  test: BrowserTest,
  hasIframes: boolean,
  flagState: MigrationFlagState | undefined,
  hasMultiCandidate: boolean,
  secretKeys: string[]
): BrowserCheckLevelProps {
  const { public_id, name, tags, options } = test;

  const logicalId = uniqueLogicalId('browser', name, public_id);
  const frequency = convertFrequency(options?.tick_every);
  // Preserves paused status from Datadog. FLAG-04 (D-05) may later force this to
  // false for a zero-signal deactivated check; the override is strictly one-way.
  let activated = test.status === 'live';

  // Filter and remap Datadog-origin tags, then add migration traceability tag
  const allTags = filterAndRemapTags(tags || []);
  allTags.push(`migration_check_id:${public_id}`);

  // MIGRATION-FLAG review tag (D-04): a check whose spec generation hit a flag is
  // greppable at the construct level and folds into the step-12 review grouping.
  // Pushed in the same post-filter slot as migration_check_id so DD_TAGS_EXCLUDE,
  // DD_TAGS_EXCLUDE_ALL, and DD_TAGS_REMAP cannot strip it. publicId values from
  // the flags file are used only for Set membership, never interpolated here.
  if (
    (flagState?.flaggedIds.has(public_id) || flagState?.deactivatedIds.has(public_id)) &&
    !allTags.includes('reviewMigrationFlag')
  ) {
    allTags.push('reviewMigrationFlag');
  }

  // FLAG-04 deactivation (D-05, D-06): only the zero-signal deactivated subset is
  // forced off. The override may only replace the computed value with false and
  // can never activate a check, preserving safe-by-default activation.
  if (flagState?.deactivatedIds.has(public_id)) {
    activated = false;
  }

  // Preserve Datadog monitor priority (P1-P5) as a tag for filtering in Checkly
  const ptag = priorityTag(options?.monitor_priority);
  if (ptag) allTags.push(ptag);

  // Add "iframe" tag if the spec uses iframe handling
  if (hasIframes && !allTags.includes('iframe')) {
    allTags.push('iframe');
  }

  // Multi-selector review tag (D-06): a check whose spec emitted a multi-candidate
  // firstMatch() self-healing chain is greppable at the construct level for a
  // per-check verification pass. The whole multi-candidate class is tagged because
  // generation time cannot know which candidate resolves at runtime. Pushed in the
  // same post-filter slot as the iframe tag so DD_TAGS_EXCLUDE, DD_TAGS_EXCLUDE_ALL,
  // and DD_TAGS_REMAP cannot strip it. The tag is a fixed literal set in this
  // generated .check.ts code, never applied via API (D-08: the next MaC deploy would
  // overwrite an API-applied tag). It NEVER touches the activated value: the class
  // stays ACTIVE (deactivation is exclusively the FLAG-04 zero-candidate slice).
  if (hasMultiCandidate && !allTags.includes('reviewMultiSelector')) {
    allTags.push('reviewMultiSelector');
  }

  // Convert configVariables to environmentVariables, then union in the routed
  // browser-step secrets (SEC-02 / D-02). Each routed key is declared name-only
  // as { key, value: "", secret: true } reusing the EXISTING config-variable
  // secret shape VERBATIM (D-02: Datadog never exports secret values, so the
  // empty-string value is the established convention). A routed key that already
  // exists as a config-variable env key is skipped (existing entry wins); the
  // upstream used-set seeding makes this rare, so this dedup is belt-and-suspenders
  // against duplicate env-var keys in one construct (T-09-06-03).
  const envVars = convertConfigVariables(test.config?.configVariables);
  const existingKeys = new Set(envVars.map(v => v.key));
  for (const key of secretKeys) {
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    envVars.push({ key, value: '', secret: true });
  }
  const envVarsCode = envVars.length > 0
    ? `\n  environmentVariables: [\n${envVars.map(v =>
        v.secret
          ? `    { key: "${escapeString(v.key)}", value: "", secret: true }`
          : `    { key: "${escapeString(v.key)}", value: "${escapeString(v.value)}" }`
      ).join(',\n')},\n  ],`
    : '';

  return { logicalId, frequency, activated, allTags, envVarsCode };
}

/**
 * Generate a BrowserCheck construct for a test
 */
export function generateBrowserCheckCode(test: BrowserTest, specFilename: string, locationType: string, hasIframes: boolean = false, flagState?: MigrationFlagState, hasMultiCandidate: boolean = false, secretKeys: string[] = []): string {
  const { public_id, name, options, locations, privateLocations } = test;

  const { logicalId, frequency, activated, allTags, envVarsCode } = computeBrowserCheckLevelProps(test, hasIframes, flagState, hasMultiCandidate, secretKeys);
  const retryStrategy = generateRetryStrategy(options?.retry);
  const specsPath = `${SPECS_RELATIVE_PATH}/${locationType}`;

  const code = `/**
 * Migrated from Datadog Synthetic: ${public_id}
 */
import {
  BrowserCheck,
  Frequency,
  RetryStrategyBuilder,
} from "checkly/constructs";

new BrowserCheck("${logicalId}", {
  name: "${escapeString(name)}",
  tags: ${JSON.stringify(allTags)},
  code: {
    entrypoint: "${specsPath}/${specFilename}",
  },
  frequency: Frequency.${frequency},
  locations: ${JSON.stringify(normalizePublicChecklyLocations(locations))},${privateLocations.length > 0 ? `\n  privateLocations: ${JSON.stringify(privateLocations)},` : ''}${envVarsCode}
  activated: ${activated},
  muted: false,
  retryStrategy: ${retryStrategy},
  runParallel: true,
});
`;

  return code;
}

/**
 * Datadog device family (via Playwright engine) to the Playwright-documented
 * device preset a companion playwright.config.ts project should use.
 *
 * The three engines mirror PLAYWRIGHT_ENGINE_ORDER (the vocabulary of record);
 * the preset strings are Playwright's own built-in device descriptors
 * (playwright.dev/docs/api/class-testoptions#test-options-device). Same
 * closed-vocabulary-lookup idiom as the shared DEVICE_FAMILY_TO_ENGINE map, so
 * no raw device_ids string ever reaches config emission.
 */
const ENGINE_TO_DEVICE_PRESET: Readonly<Record<string, string>> = {
  chromium: 'Desktop Chrome',
  firefox: 'Desktop Firefox',
  webkit: 'Desktop Safari',
};

/**
 * Generate a companion playwright.config.ts body declaring one Playwright project
 * per distinct engine (plan 10-03, PWCS-02; testDir/testMatch fix plan 10-06, CR-01).
 *
 * The input engines are sorted into canonical PLAYWRIGHT_ENGINE_ORDER order
 * before emission, so the config never trusts caller-supplied ordering and the
 * project names are input-order independent. Each project's name is the engine
 * name itself, which is exactly the value generatePlaywrightCheckCode places in
 * pwProjects (both come from the SAME engines array at the call site), so the
 * two can never drift: Checkly's own guidance warns that a pwProjects value not
 * matching a config project name deploys but runs zero tests.
 *
 * testDir + testMatch make the config discover its ONE spec. The config is
 * written into __checks__/browser/<locationType>/ (beside the .check.ts), but the
 * generated .spec.ts lives three directories away in tests/browser/<locationType>/
 * (src/07 writes there; the BrowserCheck path encodes the same distance as
 * SPECS_RELATIVE_PATH). Playwright/Checkly default testDir to the config file's
 * OWN directory, which holds zero specs, so without testDir the migrated
 * PlaywrightCheck bundles nothing and runs zero tests (CR-01). testDir is emitted
 * as SPECS_RELATIVE_PATH + '/' + locationType so it resolves (via path.resolve in
 * checkly's PlaywrightConfig, verified against checkly@8.13.0) to the spec dir,
 * mirroring the BrowserCheck entrypoint exactly. testMatch is the bare spec
 * filename so discovery is scoped to THIS check's single spec and never sweeps in
 * sibling browser specs sharing that directory (checkly's file matcher prepends
 * '**' + '/' to a non-'**'-prefixed pattern, so the bare filename matches).
 *
 * Pure, no I/O. No em-dashes in the emitted header comment (repo output rule).
 *
 * @param engines - The distinct Playwright engine names (a subset of PLAYWRIGHT_ENGINE_ORDER).
 * @param locationType - 'public' or 'private'; selects the tests/browser/<locationType> spec dir.
 * @param specFilename - Bare filename of this check's generated .spec.ts (testMatch scopes to it).
 * @returns The playwright.config.ts file body as a string.
 */
export function generatePlaywrightConfigCode(engines: string[], locationType: string, specFilename: string): string {
  const ordered = PLAYWRIGHT_ENGINE_ORDER.filter((e) => engines.includes(e));
  const projects = ordered
    .map((engine) => `    { name: '${engine}', use: { ...devices['${ENGINE_TO_DEVICE_PRESET[engine]}'] } }`)
    .join(',\n');

  // testDir resolves relative to THIS config file's directory
  // (__checks__/browser/<locationType>/), matching SPECS_RELATIVE_PATH, the same
  // distance the BrowserCheck entrypoint crosses.
  const testDir = `${SPECS_RELATIVE_PATH}/${locationType}`;

  return `/**
 * Companion Playwright config for a migrated multi-browser Playwright Check Suite.
 * One project per distinct engine; the project names match the check's pwProjects.
 * testDir points at the generated spec directory; testMatch scopes discovery to
 * this check's single spec so it never sweeps in sibling browser specs.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '${testDir}',
  testMatch: '${specFilename}',
  projects: [
${projects},
  ],
});
`;
}

/**
 * Generate a PlaywrightCheck construct for a multi-engine browser test (plan
 * 10-03, PWCS-02). Sibling of generateBrowserCheckCode: it shares the exact
 * check-level computation (logical id, frequency, tag sequence, activation, env
 * var / secret union) and differs only in the construct type and its two
 * Playwright-specific properties (playwrightConfigPath, pwProjects).
 *
 * Per CONTEXT.md D-10 this construct deliberately sets neither engine nor
 * runtimeId: engine selects the JavaScript runtime and is omitted so Checkly's
 * CLI auto-detects it, and runtimeId is not a Playwright Check Suite concept.
 * retryStrategy and doubleCheck are Omit'd from PlaywrightCheckProps and are not
 * emitted; RetryStrategyBuilder is never imported.
 *
 * pwProjects is set to the SAME engines array the companion generatePlaywrightConfigCode
 * receives at the call site, so the check's project selection and the config's
 * project names can never independently drift.
 *
 * @param configFilename - Bare filename of the companion playwright.config.ts,
 *   resolved by Checkly relative to this .check.ts file (same-directory reference).
 */
export function generatePlaywrightCheckCode(test: BrowserTest, locationType: string, hasIframes: boolean = false, flagState?: MigrationFlagState, hasMultiCandidate: boolean = false, secretKeys: string[] = [], engines: string[] = [], configFilename: string = ''): string {
  const { public_id, name, locations, privateLocations } = test;

  const { logicalId, frequency, activated, allTags, envVarsCode } = computeBrowserCheckLevelProps(test, hasIframes, flagState, hasMultiCandidate, secretKeys);

  const code = `/**
 * Migrated from Datadog Synthetic: ${public_id}
 */
import {
  PlaywrightCheck,
  Frequency,
} from "checkly/constructs";

new PlaywrightCheck("${logicalId}", {
  name: "${escapeString(name)}",
  tags: ${JSON.stringify(allTags)},
  playwrightConfigPath: "${configFilename}",
  pwProjects: ${JSON.stringify(engines)},
  frequency: Frequency.${frequency},
  locations: ${JSON.stringify(normalizePublicChecklyLocations(locations))},${privateLocations.length > 0 ? `\n  privateLocations: ${JSON.stringify(privateLocations)},` : ''}${envVarsCode}
  activated: ${activated},
  muted: false,
});
`;

  return code;
}

/**
 * Generate an index file that imports all checks
 */
export function generateIndexFile(files: GeneratedFile[]): string {
  const imports = files.map(f => {
    const checkFilename = f.filename.replace('.ts', '');
    return `import "./${checkFilename}";`;
  });

  return `/**
 * Auto-generated index file for all Browser checks
 * Generated from Datadog export
 */

${imports.join('\n')}
`;
}

/**
 * Generate constructs for a location type
 */
export async function generateConstructsForLocationType(
  tests: BrowserTest[],
  specFileMap: Map<string, string>,
  iframeMap: Map<string, boolean>,
  outputDir: string,
  locationType: string,
  flagState?: MigrationFlagState,
  multiCandidateMap: Map<string, boolean> = new Map(),
  secretKeysMap: Map<string, string[]> = new Map(),
  pwEnginesMap: Map<string, string[]> = new Map()
): Promise<GenerationResult> {
  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  const generatedFiles: GeneratedFile[] = [];

  for (const test of tests) {
    const specFilename = specFileMap.get(test.public_id);

    if (!specFilename) {
      skippedCount++;
      continue;
    }

    try {
      const hasIframes = iframeMap.get(test.public_id) || false;
      const hasMultiCandidate = multiCandidateMap.get(test.public_id) || false;
      const secretKeys = secretKeysMap.get(test.public_id) || [];
      const engines = pwEnginesMap.get(test.public_id) || [];
      const baseName = sanitizeFilename(test.name, test.public_id);
      const filename = `${baseName}.check.ts`;
      const filepath = path.join(outputDir, filename);

      let code: string;
      if (engines.length > 1) {
        // Multi-engine (PWCS-02): emit a PlaywrightCheck plus a companion
        // playwright.config.ts that declares one project per engine. Both the
        // check's pwProjects and the config's project names come from the SAME
        // engines array, so they can never drift. The two files share the base
        // name so they pair visually in a directory listing.
        const configFilename = `${baseName}.playwright.config.ts`;
        code = generatePlaywrightCheckCode(test, locationType, hasIframes, flagState, hasMultiCandidate, secretKeys, engines, configFilename);
        // specFilename is non-empty here: the multi-engine branch is only reached
        // when specFileMap.get(test.public_id) succeeded (checked above). testMatch
        // pins the config to THIS check's spec so it discovers exactly one test.
        const configCode = generatePlaywrightConfigCode(engines, locationType, specFilename);
        await writeFile(path.join(outputDir, configFilename), configCode, 'utf-8');
      } else {
        code = generateBrowserCheckCode(test, specFilename, locationType, hasIframes, flagState, hasMultiCandidate, secretKeys);
      }

      await writeFile(filepath, code, 'utf-8');
      // Track configVariable conversions (D-10)
      trackConfigVariableConversions(test.name, test.config?.configVariables);
      successCount++;
      generatedFiles.push({
        logicalId: test.public_id,
        name: test.name,
        filename,
      });
    } catch (err) {
      console.error(`  Error generating ${test.public_id}: ${(err as Error).message}`);
      errorCount++;
    }
  }

  // Generate index file if there are files
  if (generatedFiles.length > 0) {
    const indexCode = generateIndexFile(generatedFiles);
    await writeFile(path.join(outputDir, 'index.ts'), indexCode, 'utf-8');
  }

  return { successCount, errorCount, skippedCount };
}

/**
 * Main generation function
 */
async function main(): Promise<void> {
  const outputRoot = await getOutputRoot();
  const exportsDir = await getExportsDir();
  const INPUT_FILE = `${exportsDir}/browser-tests.json`;
  const MANIFEST_FILE_PUBLIC = `${outputRoot}/tests/browser/public/_manifest.json`;
  const MANIFEST_FILE_PRIVATE = `${outputRoot}/tests/browser/private/_manifest.json`;
  const OUTPUT_DIR_PUBLIC = `${outputRoot}/__checks__/browser/public`;
  const OUTPUT_DIR_PRIVATE = `${outputRoot}/__checks__/browser/private`;

  console.log('='.repeat(60));
  console.log('BrowserCheck Construct Generator');
  console.log('='.repeat(60));

  // Load existing variable usage (for merging across generator runs)
  await loadExistingVariableUsage();

  // Read the MIGRATION-FLAG state once (null-tolerant); both location passes
  // share it so the public and private construct paths stay in sync (D-04, D-05).
  const flagState = await readMigrationFlagState(exportsDir);

  // Check input file exists
  if (!existsSync(INPUT_FILE)) {
    console.log(`\nSkipping: Input file not found: ${INPUT_FILE}`);
    console.log('No browser tests to process. Run "npm run export" first if you have browser tests.');
    return;
  }

  // Read test data
  console.log(`\nReading: ${INPUT_FILE}`);
  const data = JSON.parse(await readFile(INPUT_FILE, 'utf-8')) as { tests: BrowserTest[] };
  const tests = data.tests || [];
  console.log(`Found ${tests.length} browser tests`);

  // Create output directories
  if (!existsSync(OUTPUT_DIR_PUBLIC)) {
    await mkdir(OUTPUT_DIR_PUBLIC, { recursive: true });
  }
  if (!existsSync(OUTPUT_DIR_PRIVATE)) {
    await mkdir(OUTPUT_DIR_PRIVATE, { recursive: true });
  }

  let publicSuccess = 0, publicSkipped = 0, publicErrors = 0;
  let privateSuccess = 0, privateSkipped = 0, privateErrors = 0;

  // Process public manifest
  if (existsSync(MANIFEST_FILE_PUBLIC)) {
    console.log(`\nReading: ${MANIFEST_FILE_PUBLIC}`);
    const publicManifest = JSON.parse(await readFile(MANIFEST_FILE_PUBLIC, 'utf-8')) as Manifest;

    const publicSpecMap = new Map<string, string>();
    const publicIframeMap = new Map<string, boolean>();
    const publicMultiCandidateMap = new Map<string, boolean>();
    const publicSecretKeysMap = new Map<string, string[]>();
    const publicPwEnginesMap = new Map<string, string[]>();
    for (const file of publicManifest.files) {
      publicSpecMap.set(file.logicalId, file.filename);
      if (file.hasIframes) {
        publicIframeMap.set(file.logicalId, true);
      }
      if (file.hasMultiCandidate) {
        publicMultiCandidateMap.set(file.logicalId, true);
      }
      if (Array.isArray(file.secretKeys) && file.secretKeys.length > 0) {
        publicSecretKeysMap.set(file.logicalId, file.secretKeys);
      }
      if (Array.isArray(file.pwEngines) && file.pwEngines.length > 0) {
        publicPwEnginesMap.set(file.logicalId, file.pwEngines);
      }
    }
    console.log(`Found ${publicManifest.files.length} public spec files`);

    // Filter tests that have specs in the public manifest
    const publicTests = tests.filter(t => publicSpecMap.has(t.public_id));

    console.log('\nGenerating public constructs...');
    const publicResult = await generateConstructsForLocationType(
      publicTests, publicSpecMap, publicIframeMap, OUTPUT_DIR_PUBLIC, 'public', flagState, publicMultiCandidateMap, publicSecretKeysMap, publicPwEnginesMap
    );
    publicSuccess = publicResult.successCount;
    publicSkipped = publicResult.skippedCount;
    publicErrors = publicResult.errorCount;
  } else {
    console.log(`\nNo public manifest found at ${MANIFEST_FILE_PUBLIC}`);
  }

  // Process private manifest
  if (existsSync(MANIFEST_FILE_PRIVATE)) {
    console.log(`\nReading: ${MANIFEST_FILE_PRIVATE}`);
    const privateManifest = JSON.parse(await readFile(MANIFEST_FILE_PRIVATE, 'utf-8')) as Manifest;

    const privateSpecMap = new Map<string, string>();
    const privateIframeMap = new Map<string, boolean>();
    const privateMultiCandidateMap = new Map<string, boolean>();
    const privateSecretKeysMap = new Map<string, string[]>();
    const privatePwEnginesMap = new Map<string, string[]>();
    for (const file of privateManifest.files) {
      privateSpecMap.set(file.logicalId, file.filename);
      if (file.hasIframes) {
        privateIframeMap.set(file.logicalId, true);
      }
      if (file.hasMultiCandidate) {
        privateMultiCandidateMap.set(file.logicalId, true);
      }
      if (Array.isArray(file.secretKeys) && file.secretKeys.length > 0) {
        privateSecretKeysMap.set(file.logicalId, file.secretKeys);
      }
      if (Array.isArray(file.pwEngines) && file.pwEngines.length > 0) {
        privatePwEnginesMap.set(file.logicalId, file.pwEngines);
      }
    }
    console.log(`Found ${privateManifest.files.length} private spec files`);

    // Filter tests that have specs in the private manifest
    const privateTests = tests.filter(t => privateSpecMap.has(t.public_id));

    console.log('\nGenerating private constructs...');
    const privateResult = await generateConstructsForLocationType(
      privateTests, privateSpecMap, privateIframeMap, OUTPUT_DIR_PRIVATE, 'private', flagState, privateMultiCandidateMap, privateSecretKeysMap, privatePwEnginesMap
    );
    privateSuccess = privateResult.successCount;
    privateSkipped = privateResult.skippedCount;
    privateErrors = privateResult.errorCount;
  } else {
    console.log(`\nNo private manifest found at ${MANIFEST_FILE_PRIVATE}`);
  }

  // Write variable usage report
  await writeVariableUsageReport();

  // Write check-level secrets for downstream step 09 (D-06, D-08)
  const checkLevelSecrets: Array<{ checkName: string; key: string; value: string; locked: boolean }> = [];
  for (const test of tests) {
    const envVars = convertConfigVariables(test.config?.configVariables);
    for (const v of envVars) {
      if (v.secret) {
        checkLevelSecrets.push({
          checkName: test.name,
          key: v.key,
          value: '',
          locked: true,
        });
      }
    }
  }
  if (checkLevelSecrets.length > 0) {
    const secretsPath = path.join(exportsDir, 'check-level-secrets.json');
    let existing: typeof checkLevelSecrets = [];
    if (existsSync(secretsPath)) {
      try {
        existing = JSON.parse(await readFile(secretsPath, 'utf-8'));
      } catch { /* start fresh */ }
    }
    const merged = [...existing, ...checkLevelSecrets];
    // Deduplicate by checkName + key to prevent accumulation on re-runs
    const seen = new Set<string>();
    const deduped = merged.filter(entry => {
      const id = `${entry.checkName}::${entry.key}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    await writeFile(secretsPath, JSON.stringify(deduped, null, 2), 'utf-8');
    console.log(`  Written: ${secretsPath} (${checkLevelSecrets.length} check-level secret entries)`);
  }

  // Collect private locations for summary
  const allPrivateLocations = [...new Set(
    tests.flatMap(t => (t.locations || []).filter(l => l.startsWith('pl:')))
  )];

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Generation Summary');
  console.log('='.repeat(60));
  console.log(`  Public checks generated: ${publicSuccess} → ${OUTPUT_DIR_PUBLIC}`);
  console.log(`  Private checks generated: ${privateSuccess} → ${OUTPUT_DIR_PRIVATE}`);
  console.log(`  Skipped (no spec): ${publicSkipped + privateSkipped}`);
  console.log(`  Errors: ${publicErrors + privateErrors}`);

  if (flagState.flaggedIds.size > 0 || flagState.deactivatedIds.size > 0) {
    console.log(`  Migration-flagged checks (reviewMigrationFlag): ${flagState.flaggedIds.size}, of which deactivated: ${flagState.deactivatedIds.size}`);
  }

  if (allPrivateLocations.length > 0) {
    console.log('\nPrivate locations found (need mapping in Checkly):');
    allPrivateLocations.forEach(loc => console.log(`  - ${loc}`));
  }

  console.log('\nNext steps:');
  console.log('  1. Review generated files');
  console.log('  2. Map private locations to Checkly PrivateLocation constructs');
  console.log('  3. Run "npx checkly test" to validate');
  console.log('  4. Run "npx checkly deploy" to deploy');

  console.log('\nDone!');
}

// ESM main-guard: only run if this file is the direct entry point
const __filename = fileURLToPath(import.meta.url);
if (typeof process.argv[1] === 'string' && path.resolve(__filename) === path.resolve(process.argv[1])) {
  main().catch(err => {
    console.error('Error:', (err as Error).message);
    process.exit(1);
  });
}
