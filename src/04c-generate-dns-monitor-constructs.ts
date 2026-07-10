/**
 * Generates Checkly DnsMonitor constructs from Datadog DNS synthetic tests.
 *
 * Two output modes:
 *
 *   1) Inline (default) — writes DNS files into the main migration project at
 *      <outputRoot>/__checks__/dns/{public,private}/.
 *
 *   2) Standalone project — set CHECKLY_DNS_PROJECT_NAME=<slug>. Writes a fully
 *      self-contained Checkly project to ./checkly-migrated/<slug>/ with its own
 *      configs, package.json, README, alertChannels, variables, and update-mapping
 *      script. Use this when you want to deploy DNS monitors as a separate Checkly
 *      project, isolated from the rest of the migration.
 *
 * Datadog DNS test → Checkly DnsMonitor mapping:
 *   config.request.host                          → request.query
 *   config.request.dnsServer (if non-empty)      → request.nameServer
 *   (always)                                     → request.recordType: 'A'
 *   config.assertions[responseTime lessThan T]   → maxResponseTime: T
 *                                                  degradedResponseTime: floor(T * 0.8)
 *   config.assertions[recordSome is V]           → DnsAssertionBuilder.textAnswer().contains(V)
 *   config.assertions[recordEvery matches P]     → DnsAssertionBuilder.textAnswer(<regex>).notEquals('')
 *                                                  (downgrade: "every" → "some"; comment added)
 *   options.tick_every                           → frequency
 *   options.retry                                → retryStrategy (linear)
 *   options.monitor_priority                     → priority:P<n> tag
 *   status === 'live'                            → activated: true
 *   locations / privateLocations                 → locations / privateLocations
 *
 * Notes:
 *   - Datadog DNS tests query record type A by default; no other record types
 *     are represented in the source data, so recordType is hardcoded to 'A'.
 *   - config.request.timeout has no DnsMonitor equivalent and is dropped (a
 *     comment is added to the generated file when timeout was set in DD).
 */

import { readFile, writeFile, mkdir, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import {
  sanitizeFilename,
  uniqueLogicalId,
  hasPrivateLocations,
  convertFrequency,
  escapeString,
  filterAndRemapTags,
  priorityTag,
  normalizePublicChecklyLocations,
} from './shared/utils.ts';
import { getOutputRoot, getExportsDir } from './shared/output-config.ts';

interface DatadogAssertion {
  type: string;
  operator: string;
  property?: string;
  target?: number | string;
}

interface DatadogRetry {
  count?: number;
  interval?: number;
}

interface DatadogDnsTest {
  public_id: string;
  name: string;
  type: string;
  subtype?: string;
  status?: string;
  tags?: string[];
  locations: string[];
  privateLocations: string[];
  originalLocations: string[];
  config?: {
    request?: {
      host?: string;
      dnsServer?: string;
      timeout?: number;
    };
    assertions?: DatadogAssertion[];
  };
  options?: {
    tick_every?: number;
    retry?: DatadogRetry;
    monitor_priority?: number;
  };
  message?: string;
  monitor_id?: number;
}

interface ApiTestsFile {
  exportedAt: string;
  site: string;
  count: number;
  tests: DatadogDnsTest[];
}

interface GeneratedFile {
  name: string;
  filename: string;
}

interface GenerateOptions {
  withAlertChannels?: boolean;
}

const CHECKLY_DNS_MAX_RESPONSE_TIME_LIMIT = 5000;

export function deriveResponseTimes(assertions: DatadogAssertion[] | undefined): {
  maxResponseTime?: number;
  degradedResponseTime?: number;
} {
  if (!assertions) return {};
  const responseTimeAssertion = assertions.find(
    a => a.type === 'responseTime' && (a.operator === 'lessThan' || a.operator === 'lessThanOrEqual')
  );
  if (!responseTimeAssertion || typeof responseTimeAssertion.target !== 'number') {
    return {};
  }
  const max = Math.min(responseTimeAssertion.target, CHECKLY_DNS_MAX_RESPONSE_TIME_LIMIT);
  const degraded = Math.max(1, Math.floor(max * 0.8));
  return { maxResponseTime: max, degradedResponseTime: degraded };
}

export function generateRetryStrategy(retry: DatadogRetry | undefined): string {
  if (!retry || !retry.count) {
    return 'RetryStrategyBuilder.noRetries()';
  }
  const opts: string[] = [`maxRetries: ${retry.count}`];
  if (typeof retry.interval === 'number' && retry.interval > 0) {
    const baseBackoffSeconds = Math.max(1, Math.round(retry.interval / 1000));
    opts.push(`baseBackoffSeconds: ${baseBackoffSeconds}`);
  }
  return `RetryStrategyBuilder.linearStrategy({
    ${opts.join(',\n    ')},
  })`;
}

/**
 * Translate Datadog's record-content assertions to DnsAssertionBuilder calls.
 * Returns:
 *   { lines: string[]            // assertion-builder TS expressions to inline
 *     notes: string[]            // warning comments to render above the request block
 *     recordEveryDowngraded: bool }
 *
 * Datadog "*" in target patterns is treated as a regex ".*"; other characters
 * are passed through. We avoid escaping dots so existing patterns like "10.247.1*"
 * become "10.247.1.*" — close enough to the user's intent in practice. The user
 * is told via a comment that recordEvery semantics were not preserved.
 */
export function generateRecordAssertions(assertions: DatadogAssertion[] | undefined): {
  lines: string[];
  notes: string[];
  recordEveryDowngraded: boolean;
} {
  const lines: string[] = [];
  const notes: string[] = [];
  let recordEveryDowngraded = false;
  if (!assertions) return { lines, notes, recordEveryDowngraded };

  for (const a of assertions) {
    if (a.type === 'recordSome' && a.operator === 'is' && typeof a.target === 'string') {
      // "at least one record equals target" → textAnswer().contains(target)
      lines.push(`DnsAssertionBuilder.textAnswer().contains("${escapeString(a.target)}")`);
    } else if (a.type === 'recordEvery' && a.operator === 'matches' && typeof a.target === 'string') {
      // "every record matches glob pattern" → no Checkly equivalent.
      // Best effort: convert glob → regex, assert "some answer matches" via textAnswer(regex).notEquals('').
      recordEveryDowngraded = true;
      const regex = a.target.replace(/\*/g, '.*');
      lines.push(`DnsAssertionBuilder.textAnswer("${escapeString(regex)}").notEquals("")`);
      notes.push(
        `// WARNING: Datadog assertion "recordEvery matches ${a.target}" (property=${a.property ?? 'A'}) `
          + `was downgraded — Checkly's textAnswer(regex) tests whether ANY record matches, not EVERY record. `
          + `Tighten this assertion by hand if "every record matches" is a hard requirement.`,
      );
    }
    // responseTime is folded into maxResponseTime by deriveResponseTimes(); skip here.
  }
  return { lines, notes, recordEveryDowngraded };
}

/**
 * Generate a single DnsMonitor construct.
 */
export function generateDnsMonitorCode(test: DatadogDnsTest, opts: GenerateOptions = {}): string {
  const host = test.config?.request?.host;
  if (!host) {
    throw new Error(`Missing host in DNS test config (publicId=${test.public_id})`);
  }
  const rawDnsServer = test.config?.request?.dnsServer || '';
  const dnsServer = rawDnsServer.trim() || undefined;
  const timeoutWasSet = typeof test.config?.request?.timeout === 'number';

  const logicalId = uniqueLogicalId('dns', test.name, test.public_id);

  const processedTags = filterAndRemapTags(test.tags || []);
  processedTags.push(`migration_check_id:${test.public_id}`);
  const ptag = priorityTag(test.options?.monitor_priority);
  if (ptag) processedTags.push(ptag);

  const { maxResponseTime, degradedResponseTime } = deriveResponseTimes(test.config?.assertions);
  const { lines: recordAssertions, notes: recordNotes } = generateRecordAssertions(test.config?.assertions);
  const frequency = convertFrequency(test.options?.tick_every);
  const cleanLocations = normalizePublicChecklyLocations(test.locations || []);
  const privateLocations = test.privateLocations || [];
  const activated = (test.status || 'live') === 'live';

  const responseTimeLines: string[] = [];
  if (degradedResponseTime !== undefined) {
    responseTimeLines.push(`degradedResponseTime: ${degradedResponseTime},`);
  }
  if (maxResponseTime !== undefined) {
    responseTimeLines.push(`maxResponseTime: ${maxResponseTime},`);
  }

  const alertChannelsImport = opts.withAlertChannels
    ? '\nimport { alertChannels } from "../../../default_resources/alertChannels";\n'
    : '';
  const alertChannelsProp = opts.withAlertChannels ? '  alertChannels,\n' : '';

  const fileNotes: string[] = [...recordNotes];
  if (timeoutWasSet) {
    fileNotes.push(
      `// NOTE: Datadog config.request.timeout=${test.config!.request!.timeout}ms was dropped — `
        + `DnsMonitor has no request-level timeout. The maxResponseTime property below is the effective deadline.`,
    );
  }
  const notesBlock = fileNotes.length > 0 ? '\n' + fileNotes.join('\n') + '\n' : '';

  const requestLines: string[] = [
    `recordType: "A"`,
    `query: "${escapeString(host)}"`,
  ];
  if (dnsServer) requestLines.push(`nameServer: "${escapeString(dnsServer)}"`);
  if (recordAssertions.length > 0) {
    requestLines.push(`assertions: [
      ${recordAssertions.join(',\n      ')},
    ]`);
  }

  const code = `/**
 * Migrated from Datadog Synthetic: ${test.public_id}
 */
import {
  DnsMonitor,
  DnsAssertionBuilder,
  Frequency,
  RetryStrategyBuilder,
} from "checkly/constructs";${alertChannelsImport}
${notesBlock}
new DnsMonitor("${logicalId}", {
  name: "${escapeString(test.name)}",
  tags: ${JSON.stringify(processedTags)},
  request: {
    ${requestLines.join(',\n    ')},
  },
  frequency: Frequency.${frequency},
  locations: ${JSON.stringify(cleanLocations)},${privateLocations.length > 0 ? `\n  privateLocations: ${JSON.stringify(privateLocations)},` : ''}
${responseTimeLines.length > 0 ? '  ' + responseTimeLines.join('\n  ') + '\n' : ''}  activated: ${activated}, // Preserves paused status from Datadog (status !== 'live' -> activated: false)
  muted: false,
  retryStrategy: ${generateRetryStrategy(test.options?.retry)},
${alertChannelsProp}});
`;

  return code;
}

export function generateIndexFile(generatedFiles: GeneratedFile[]): string {
  const imports = generatedFiles.map(f => {
    const checkFilename = f.filename.replace('.ts', '');
    return `import "./${checkFilename}";`;
  });

  return `/**
 * Auto-generated index file for all DNS monitors
 * Generated from Datadog export
 */

${imports.join('\n')}
`;
}

/**
 * Build a TCP-style migration-mapping.csv from the DNS tests being processed.
 * Header matches step 12's schema so update-mapping.ts can consume either.
 */
export function csvEscapeField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildMappingCsvForDns(tests: DatadogDnsTest[]): string {
  const header = 'datadog_public_id,datadog_name,checkly_logical_id,checkly_uuid,check_type,location_type,dd_locations,checkly_locations,filename';
  const rows: string[] = [header];
  for (const test of tests) {
    const filename = `${sanitizeFilename(test.name, test.public_id)}.check.ts`;
    // Same shared helper as the emit site, so the standalone mapping CSV can never
    // drift from the emitted DnsMonitor logical id (D-02).
    const checklyId = uniqueLogicalId('dns', test.name, test.public_id);
    const locationType = test.privateLocations && test.privateLocations.length > 0 ? 'private' : 'public';
    const ddLocs = csvEscapeField((test.originalLocations || []).join(';'));
    const checklyLocs = csvEscapeField([...(test.locations || []), ...(test.privateLocations || [])].join(';'));
    rows.push(`${test.public_id},${csvEscapeField(test.name)},${checklyId},FILL_AFTER_DEPLOY,dns,${locationType},${ddLocs},${checklyLocs},${filename}`);
  }
  return rows.join('\n') + '\n';
}

const STANDALONE_SCAFFOLDING = {
  alertChannels: `import { EmailAlertChannel } from "checkly/constructs";

/**
 * Default Alert Channels for the DNS monitors project.
 *
 * Add your alert channels here and include them in the alertChannels array below.
 * Supported channel types:
 * - EmailAlertChannel
 * - SlackAlertChannel
 * - WebhookAlertChannel
 * - OpsgenieAlertChannel
 * - PagerdutyAlertChannel
 * - MSTeamsAlertChannel
 */

export const emailChannel = new EmailAlertChannel("email-channel-1", {
  address: "alerts@example.com",
});

export const alertChannels = [emailChannel];
`,

  checklyConfig: (projectName: string, logicalId: string) =>
    `import { defineConfig } from "checkly";

const config = defineConfig({
  projectName: \`${projectName} - all DNS monitors\`,
  logicalId: \`${logicalId}\`,
  repoUrl: "",
  checks: {
    activated: true,
    muted: false,
    runtimeId: "2025.04",
    checkMatch: "__checks__/**/**/*.check.ts",
    ignoreDirectoriesMatch: [],
  },
  cli: {
    runLocation: "us-west-1",
  },
});

export default config;
`,

  checklyPrivateConfig: (projectName: string, logicalId: string) =>
    `import { defineConfig } from "checkly";

const config = defineConfig({
  projectName: \`${projectName} - private DNS monitors\`,
  logicalId: \`${logicalId}-private\`,
  repoUrl: "",
  checks: {
    activated: true,
    muted: false,
    runtimeId: "2025.04",
    checkMatch: "__checks__/**/private/*.check.ts",
    ignoreDirectoriesMatch: [],
  },
  cli: {
    privateRunLocation: "some-private-location-slug",
  },
});

export default config;
`,

  checklyPublicConfig: (projectName: string, logicalId: string) =>
    `import { defineConfig } from "checkly";

const config = defineConfig({
  projectName: \`${projectName} - public DNS monitors\`,
  logicalId: \`${logicalId}-public\`,
  repoUrl: "",
  checks: {
    activated: true,
    muted: false,
    runtimeId: "2025.04",
    checkMatch: "__checks__/**/public/*.check.ts",
    ignoreDirectoriesMatch: [],
  },
  cli: {
    runLocation: "us-west-1",
  },
});

export default config;
`,

  packageJson: (projectName: string) =>
    `${JSON.stringify(
      {
        name: `checkly-${projectName}`,
        private: true,
        scripts: {
          'test:private': 'npx checkly test --config=./checkly.private.config.ts --record',
          'test:public': 'npx checkly test --config=./checkly.public.config.ts --record',
          'deploy:private': 'npx checkly deploy --config=./checkly.private.config.ts --force',
          'deploy:public': 'npx checkly deploy --config=./checkly.public.config.ts --force',
          'create-variables': 'ts-node variables/create-variables.ts',
          'delete-variables': 'ts-node variables/delete-variables.ts',
          'update-mapping': 'ts-node update-mapping.ts',
        },
        devDependencies: {
          checkly: '^7.12.0',
          'ts-node': '^10.9.2',
          typescript: '^5.9.3',
        },
      },
      null,
      2,
    )}\n`,

  readme: (projectName: string, sourceProjectName: string, counts: { public: number; private: number }) =>
    `# ${projectName} — Checkly DNS Monitors

This directory contains a **standalone Checkly project** with DNS monitors migrated from Datadog Synthetic ${'`dns`'} subtype tests. It was split out from the main migration (\`${sourceProjectName}\`) so DNS can be deployed independently — useful when you don't want to re-deploy the rest of the migrated checks.

## Contents

- **Public DNS monitors:** ${counts.public}
- **Private DNS monitors:** ${counts.private}

## Directory Structure

\`\`\`
├── __checks__/
│   └── dns/{public,private}/         # DnsMonitor constructs
├── default_resources/
│   └── alertChannels.ts              # Alert channel configuration
├── variables/
│   ├── env-variables.json            # (empty — DNS monitors don't use variables)
│   ├── secrets.json                  # (empty)
│   ├── create-variables.ts           # Variable importer (no-op for DNS)
│   └── delete-variables.ts           # Variable remover (no-op for DNS)
├── checkly.config.ts                 # All checks config
├── checkly.private.config.ts         # Private checks only config
├── checkly.public.config.ts          # Public checks only config
├── package.json                      # Project scripts
├── migration-mapping.csv             # Datadog-to-Checkly ID mapping (DNS only)
└── update-mapping.ts                 # Post-deploy script to backfill Checkly UUIDs
\`\`\`

## Deployment

### 1. Create Private Locations

If any DNS monitors target a private location, create the corresponding location in Checkly first. The slug is in each \`.check.ts\` file's \`privateLocations\` array.

### 2. Configure Alert Channels (optional)

Edit \`default_resources/alertChannels.ts\` to set up notifications.

### 3. Authenticate

\`\`\`bash
npm install -g checkly
npx checkly login
\`\`\`

Or set \`CHECKLY_API_KEY\` and \`CHECKLY_ACCOUNT_ID\`.

### 4. Test (dry run)

\`\`\`bash
npm run test:public    # only if there are public DNS monitors
npm run test:private
\`\`\`

### 5. Deploy

\`\`\`bash
npm run deploy:public  # only if there are public DNS monitors
npm run deploy:private
\`\`\`

Deploying here creates a **separate Checkly project** from the main migration, so the other migrated checks are not touched.

### 6. Backfill Checkly UUIDs (optional)

\`\`\`bash
npm run update-mapping
\`\`\`

Populates the \`checkly_uuid\` column in \`migration-mapping.csv\`.

## Caveats

- Datadog \`recordEvery matches <pattern>\` assertions are downgraded to "some record matches" via Checkly's \`textAnswer(regex).notEquals('')\`. Files that had this assertion include a WARNING comment block at the top.
- Datadog \`config.request.timeout\` is dropped — DnsMonitor has no equivalent. The \`maxResponseTime\` property is the effective deadline.

## Resources

- [Checkly DNS Monitor docs](https://www.checklyhq.com/docs/constructs/dns-monitor/)
- [Checkly CLI Reference](https://www.checklyhq.com/docs/cli/)
`,
};

export async function writeStandaloneScaffolding(
  destRoot: string,
  projectName: string,
  logicalId: string,
  sourceRoot: string,
  sourceProjectName: string,
  counts: { public: number; private: number },
  dnsTests: DatadogDnsTest[],
): Promise<string[]> {
  const written: string[] = [];

  const writeIfMissing = async (relPath: string, content: string) => {
    const full = path.join(destRoot, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf-8');
    written.push(relPath);
  };

  await writeIfMissing('checkly.config.ts', STANDALONE_SCAFFOLDING.checklyConfig(projectName, logicalId));
  await writeIfMissing('checkly.private.config.ts', STANDALONE_SCAFFOLDING.checklyPrivateConfig(projectName, logicalId));
  await writeIfMissing('checkly.public.config.ts', STANDALONE_SCAFFOLDING.checklyPublicConfig(projectName, logicalId));
  await writeIfMissing('default_resources/alertChannels.ts', STANDALONE_SCAFFOLDING.alertChannels);
  await writeIfMissing('package.json', STANDALONE_SCAFFOLDING.packageJson(projectName));
  await writeIfMissing('README.md', STANDALONE_SCAFFOLDING.readme(projectName, sourceProjectName, counts));

  await writeIfMissing('variables/env-variables.json', '[]\n');
  await writeIfMissing('variables/secrets.json', '[]\n');
  const sourceCreateVars = path.join(sourceRoot, 'variables', 'create-variables.ts');
  const sourceDeleteVars = path.join(sourceRoot, 'variables', 'delete-variables.ts');
  if (existsSync(sourceCreateVars)) {
    await mkdir(path.join(destRoot, 'variables'), { recursive: true });
    await copyFile(sourceCreateVars, path.join(destRoot, 'variables', 'create-variables.ts'));
    written.push('variables/create-variables.ts');
  }
  if (existsSync(sourceDeleteVars)) {
    await copyFile(sourceDeleteVars, path.join(destRoot, 'variables', 'delete-variables.ts'));
    written.push('variables/delete-variables.ts');
  }

  const sourceUpdateMapping = path.join(sourceRoot, 'update-mapping.ts');
  if (existsSync(sourceUpdateMapping)) {
    await copyFile(sourceUpdateMapping, path.join(destRoot, 'update-mapping.ts'));
    written.push('update-mapping.ts');
  }

  // Build the mapping CSV directly from the DNS tests being processed — don't
  // try to filter the source's migration-mapping.csv. In standalone mode the
  // source project has no DNS files on disk, so step 12 (gated on on-disk
  // presence) intentionally omits DNS rows there. Generating from the in-memory
  // test data is the only correct source.
  await writeIfMissing('migration-mapping.csv', buildMappingCsvForDns(dnsTests));

  return written;
}

async function main(): Promise<void> {
  const sourceRoot = await getOutputRoot();
  const exportsDir = await getExportsDir();
  const INPUT_FILE = path.join(exportsDir, 'api-tests.json');

  const standaloneProjectName = process.env.CHECKLY_DNS_PROJECT_NAME?.trim() || '';
  const standalone = standaloneProjectName.length > 0;
  const destRoot = standalone
    ? path.join('./checkly-migrated', standaloneProjectName)
    : sourceRoot;
  const OUTPUT_BASE = path.join(destRoot, '__checks__', 'dns');
  const OUTPUT_DIR_PUBLIC = path.join(OUTPUT_BASE, 'public');
  const OUTPUT_DIR_PRIVATE = path.join(OUTPUT_BASE, 'private');

  console.log('='.repeat(60));
  console.log('Checkly DNS Monitor Generator');
  console.log('='.repeat(60));
  if (standalone) {
    console.log(`Mode: standalone project`);
    console.log(`Source migration: ${sourceRoot}`);
    console.log(`Destination project: ${destRoot}`);
  } else {
    console.log(`Mode: inline (DNS files added to source migration project)`);
    console.log(`Output root: ${destRoot}`);
  }

  if (!existsSync(INPUT_FILE)) {
    console.log(`\nSkipping: Input file not found: ${INPUT_FILE}`);
    console.log('Run "npm run export" first.');
    return;
  }

  const data = JSON.parse(await readFile(INPUT_FILE, 'utf-8')) as ApiTestsFile;
  const dnsTests = data.tests.filter(t => t.subtype === 'dns');

  if (dnsTests.length === 0) {
    console.log('\nNo DNS tests found in export. Nothing to generate.');
    return;
  }

  console.log(`\nFound ${dnsTests.length} DNS test(s) to convert`);

  const publicTests = dnsTests.filter(t => !hasPrivateLocations(t));
  const privateTests = dnsTests.filter(t => hasPrivateLocations(t));

  console.log(`  - Public location DNS monitors: ${publicTests.length}`);
  console.log(`  - Private location DNS monitors: ${privateTests.length}`);

  if (publicTests.length > 0 && !existsSync(OUTPUT_DIR_PUBLIC)) {
    await mkdir(OUTPUT_DIR_PUBLIC, { recursive: true });
  }
  if (privateTests.length > 0 && !existsSync(OUTPUT_DIR_PRIVATE)) {
    await mkdir(OUTPUT_DIR_PRIVATE, { recursive: true });
  }

  let errorCount = 0;
  let recordEveryDowngradeCount = 0;
  const publicFiles: GeneratedFile[] = [];
  const privateFiles: GeneratedFile[] = [];

  const writeAll = async (tests: DatadogDnsTest[], dir: string, files: GeneratedFile[]) => {
    for (const test of tests) {
      try {
        // Quick pre-check for the downgrade counter (logic re-runs inside generate).
        for (const a of (test.config?.assertions || [])) {
          if (a.type === 'recordEvery' && a.operator === 'matches') recordEveryDowngradeCount++;
        }
        const code = generateDnsMonitorCode(test, { withAlertChannels: standalone });
        const filename = `${sanitizeFilename(test.name, test.public_id)}.check.ts`;
        const filepath = path.join(dir, filename);
        await writeFile(filepath, code, 'utf-8');
        files.push({ name: test.name, filename });
      } catch (err) {
        console.error(`  Error generating ${test.public_id}: ${(err as Error).message}`);
        errorCount++;
      }
    }
  };

  await writeAll(publicTests, OUTPUT_DIR_PUBLIC, publicFiles);
  await writeAll(privateTests, OUTPUT_DIR_PRIVATE, privateFiles);

  if (publicFiles.length > 0) {
    await writeFile(path.join(OUTPUT_DIR_PUBLIC, 'index.ts'), generateIndexFile(publicFiles), 'utf-8');
  }
  if (privateFiles.length > 0) {
    await writeFile(path.join(OUTPUT_DIR_PRIVATE, 'index.ts'), generateIndexFile(privateFiles), 'utf-8');
  }

  if (standalone) {
    const sourceProjectName = path.basename(sourceRoot);
    const logicalId = standaloneProjectName.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    const written = await writeStandaloneScaffolding(
      destRoot,
      standaloneProjectName,
      logicalId,
      sourceRoot,
      sourceProjectName,
      { public: publicFiles.length, private: privateFiles.length },
      dnsTests,
    );
    console.log(`\nStandalone scaffolding written: ${written.length} file(s)`);
    for (const f of written) console.log(`  - ${f}`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('Generation Summary');
  console.log('='.repeat(60));
  console.log(`  Public DNS monitors generated: ${publicFiles.length} → ${OUTPUT_DIR_PUBLIC}`);
  console.log(`  Private DNS monitors generated: ${privateFiles.length} → ${OUTPUT_DIR_PRIVATE}`);
  if (recordEveryDowngradeCount > 0) {
    console.log(`  Assertions downgraded (recordEvery → some): ${recordEveryDowngradeCount} (see WARNING comments in generated files)`);
  }
  console.log(`  Errors: ${errorCount}`);

  if (errorCount > 0) process.exit(1);
}

// ESM main-guard: only run if this file is the direct entry point
const __filename = fileURLToPath(import.meta.url);
if (typeof process.argv[1] === 'string' && path.resolve(__filename) === path.resolve(process.argv[1])) {
  main().catch(err => {
    console.error('Error:', (err as Error).message);
    process.exit(1);
  });
}
