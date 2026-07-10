/**
 * Generates Checkly TcpMonitor constructs from Datadog TCP synthetic tests.
 *
 * Two output modes:
 *
 *   1) Inline (default) — writes TCP files into the main migration project alongside
 *      api/multi/browser checks at <outputRoot>/__checks__/tcp/{public,private}/.
 *
 *   2) Standalone project — set CHECKLY_TCP_PROJECT_NAME=<slug>. Writes a fully
 *      self-contained Checkly project to ./checkly-migrated/<slug>/ with its own
 *      configs, package.json, README, alertChannels, variables, and update-mapping
 *      script. Use this when you want to deploy TCP monitors as a separate Checkly
 *      project, isolated from the rest of the migration. The source migration is
 *      read from <CHECKLY_ACCOUNT_NAME> as usual.
 *
 * Datadog TCP test → Checkly TcpMonitor mapping:
 *   config.request.host                          → request.hostname
 *   config.request.port                          → request.port
 *   config.assertions[responseTime lessThan T]   → maxResponseTime: T (semantically identical)
 *                                                  degradedResponseTime: floor(T * 0.8)
 *   options.tick_every                           → frequency
 *   options.retry                                → retryStrategy (linear)
 *   options.monitor_priority                     → priority:P<n> tag
 *   status === 'live'                            → activated: true
 *   locations / privateLocations                 → locations / privateLocations
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
  target?: number | string;
}

interface DatadogRetry {
  count?: number;
  interval?: number;
}

interface DatadogTcpTest {
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
      port?: number;
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
  tests: DatadogTcpTest[];
}

interface GeneratedFile {
  name: string;
  filename: string;
}

interface GenerateOptions {
  /** Include `alertChannels` import + property in the generated check file. */
  withAlertChannels?: boolean;
}

const CHECKLY_TCP_MAX_RESPONSE_TIME_LIMIT = 5000;

/**
 * Derive maxResponseTime + degradedResponseTime from Datadog's responseTime assertion.
 * Datadog responseTime assertions are in milliseconds; same units as Checkly.
 */
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
  const max = Math.min(responseTimeAssertion.target, CHECKLY_TCP_MAX_RESPONSE_TIME_LIMIT);
  const degraded = Math.max(1, Math.floor(max * 0.8));
  return { maxResponseTime: max, degradedResponseTime: degraded };
}

/**
 * Map Datadog retry options to a Checkly LinearRetryStrategy.
 * Datadog retry.interval is in milliseconds; Checkly baseBackoffSeconds is in seconds.
 */
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
 * Generate a single TcpMonitor construct.
 */
export function generateTcpMonitorCode(test: DatadogTcpTest, opts: GenerateOptions = {}): string {
  const host = test.config?.request?.host;
  const port = test.config?.request?.port;
  if (!host || typeof port !== 'number') {
    throw new Error(`Missing host/port in TCP test config (publicId=${test.public_id})`);
  }

  const logicalId = uniqueLogicalId('tcp', test.name, test.public_id);

  const processedTags = filterAndRemapTags(test.tags || []);
  processedTags.push(`migration_check_id:${test.public_id}`);
  const ptag = priorityTag(test.options?.monitor_priority);
  if (ptag) processedTags.push(ptag);

  const { maxResponseTime, degradedResponseTime } = deriveResponseTimes(test.config?.assertions);
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

  const code = `/**
 * Migrated from Datadog Synthetic: ${test.public_id}
 */
import {
  TcpMonitor,
  Frequency,
  RetryStrategyBuilder,
} from "checkly/constructs";${alertChannelsImport}

new TcpMonitor("${logicalId}", {
  name: "${escapeString(test.name)}",
  tags: ${JSON.stringify(processedTags)},
  request: {
    hostname: "${escapeString(host)}",
    port: ${port},
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

/**
 * Generate an index file that re-exports all checks in a directory.
 */
export function generateIndexFile(generatedFiles: GeneratedFile[]): string {
  const imports = generatedFiles.map(f => {
    const checkFilename = f.filename.replace('.ts', '');
    return `import "./${checkFilename}";`;
  });

  return `/**
 * Auto-generated index file for all TCP monitors
 * Generated from Datadog export
 */

${imports.join('\n')}
`;
}

/**
 * Build a migration-mapping.csv from the TCP tests being processed. The schema
 * matches what step 12 emits, so update-mapping.ts can consume either.
 *
 * We do NOT filter the source's migration-mapping.csv: in standalone-only mode,
 * step 12 (gated on on-disk presence) intentionally omits TCP rows from the
 * source CSV because the source folder has no TCP files. Generating from the
 * in-memory test data is the only correct source.
 */
export function csvEscapeField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildMappingCsvForTcp(tests: DatadogTcpTest[]): string {
  const header = 'datadog_public_id,datadog_name,checkly_logical_id,checkly_uuid,check_type,location_type,dd_locations,checkly_locations,filename';
  const rows: string[] = [header];
  for (const test of tests) {
    const filename = `${sanitizeFilename(test.name, test.public_id)}.check.ts`;
    // Same shared helper as the emit site, so the standalone mapping CSV can never
    // drift from the emitted TcpMonitor logical id (D-02).
    const checklyId = uniqueLogicalId('tcp', test.name, test.public_id);
    const locationType = test.privateLocations && test.privateLocations.length > 0 ? 'private' : 'public';
    const ddLocs = csvEscapeField((test.originalLocations || []).join(';'));
    const checklyLocs = csvEscapeField([...(test.locations || []), ...(test.privateLocations || [])].join(';'));
    rows.push(`${test.public_id},${csvEscapeField(test.name)},${checklyId},FILL_AFTER_DEPLOY,tcp,${locationType},${ddLocs},${checklyLocs},${filename}`);
  }
  return rows.join('\n') + '\n';
}

const STANDALONE_SCAFFOLDING = {
  alertChannels: `import { EmailAlertChannel } from "checkly/constructs";

/**
 * Default Alert Channels for the TCP monitors project.
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
  projectName: \`${projectName} - all TCP monitors\`,
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
  projectName: \`${projectName} - private TCP monitors\`,
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
  projectName: \`${projectName} - public TCP monitors\`,
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
    `# ${projectName} — Checkly TCP Monitors

This directory contains a **standalone Checkly project** with TCP monitors migrated from Datadog Synthetic ${'`tcp`'} subtype tests. It was split out from the main migration (\`${sourceProjectName}\`) so TCP can be deployed independently — useful when you don't want to re-deploy the rest of the migrated checks.

## Contents

- **Public TCP monitors:** ${counts.public}
- **Private TCP monitors:** ${counts.private}

## Directory Structure

\`\`\`
├── __checks__/
│   └── tcp/{public,private}/         # TcpMonitor constructs
├── default_resources/
│   └── alertChannels.ts              # Alert channel configuration
├── variables/
│   ├── env-variables.json            # (empty — TCP monitors don't use variables)
│   ├── secrets.json                  # (empty — TCP monitors don't use secrets)
│   ├── create-variables.ts           # Variable importer (no-op for TCP)
│   └── delete-variables.ts           # Variable remover (no-op for TCP)
├── checkly.config.ts                 # All checks config
├── checkly.private.config.ts         # Private checks only config
├── checkly.public.config.ts          # Public checks only config
├── package.json                      # Project scripts
├── migration-mapping.csv             # Datadog-to-Checkly ID mapping (TCP only)
└── update-mapping.ts                 # Post-deploy script to backfill Checkly UUIDs
\`\`\`

## Deployment

### 1. Create Private Locations

If any TCP monitors target a private location, create the corresponding location in Checkly first. The slug is in each \`.check.ts\` file's \`privateLocations\` array.

### 2. Configure Alert Channels (optional)

Edit \`default_resources/alertChannels.ts\` to set up notifications. The placeholder is an email channel.

### 3. Authenticate

\`\`\`bash
npm install -g checkly
npx checkly login
\`\`\`

Or set \`CHECKLY_API_KEY\` and \`CHECKLY_ACCOUNT_ID\`.

### 4. Test (dry run)

\`\`\`bash
npm run test:public    # only if there are public TCP monitors
npm run test:private
\`\`\`

### 5. Deploy

\`\`\`bash
npm run deploy:public  # only if there are public TCP monitors
npm run deploy:private
\`\`\`

Deploying here creates a **separate Checkly project** from the main migration, so the other migrated checks are not touched.

### 6. Backfill Checkly UUIDs (optional)

\`\`\`bash
npm run update-mapping
\`\`\`

Populates the \`checkly_uuid\` column in \`migration-mapping.csv\`.

## Resources

- [Checkly TCP Monitor docs](https://www.checklyhq.com/docs/constructs/tcp-monitor/)
- [Checkly CLI Reference](https://www.checklyhq.com/docs/cli/)
`,
};

/**
 * Write the full standalone-project scaffolding into destRoot.
 * Returns the list of files written for logging.
 */
export async function writeStandaloneScaffolding(
  destRoot: string,
  projectName: string,
  logicalId: string,
  sourceRoot: string,
  sourceProjectName: string,
  counts: { public: number; private: number },
  tcpTests: DatadogTcpTest[],
): Promise<string[]> {
  const written: string[] = [];

  const writeIfMissing = async (relPath: string, content: string) => {
    const full = path.join(destRoot, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf-8');
    written.push(relPath);
  };

  // Configs
  await writeIfMissing('checkly.config.ts', STANDALONE_SCAFFOLDING.checklyConfig(projectName, logicalId));
  await writeIfMissing('checkly.private.config.ts', STANDALONE_SCAFFOLDING.checklyPrivateConfig(projectName, logicalId));
  await writeIfMissing('checkly.public.config.ts', STANDALONE_SCAFFOLDING.checklyPublicConfig(projectName, logicalId));

  // Alert channels
  await writeIfMissing('default_resources/alertChannels.ts', STANDALONE_SCAFFOLDING.alertChannels);

  // package.json
  await writeIfMissing('package.json', STANDALONE_SCAFFOLDING.packageJson(projectName));

  // README
  await writeIfMissing('README.md', STANDALONE_SCAFFOLDING.readme(projectName, sourceProjectName, counts));

  // Variables — copy create/delete scripts verbatim from source if available, else skip.
  // TCP monitors don't reference variables, so the JSON files are intentionally empty arrays.
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

  // update-mapping.ts — copy from source if available.
  const sourceUpdateMapping = path.join(sourceRoot, 'update-mapping.ts');
  if (existsSync(sourceUpdateMapping)) {
    await copyFile(sourceUpdateMapping, path.join(destRoot, 'update-mapping.ts'));
    written.push('update-mapping.ts');
  }

  // migration-mapping.csv — build directly from the TCP tests being processed
  // (don't filter source CSV; see buildMappingCsvForTcp comment for rationale).
  await writeIfMissing('migration-mapping.csv', buildMappingCsvForTcp(tcpTests));

  return written;
}

async function main(): Promise<void> {
  const sourceRoot = await getOutputRoot();
  const exportsDir = await getExportsDir();
  const INPUT_FILE = path.join(exportsDir, 'api-tests.json');

  // Standalone project mode: write a fully self-contained project to a sibling folder.
  const standaloneProjectName = process.env.CHECKLY_TCP_PROJECT_NAME?.trim() || '';
  const standalone = standaloneProjectName.length > 0;
  const destRoot = standalone
    ? path.join('./checkly-migrated', standaloneProjectName)
    : sourceRoot;
  const OUTPUT_BASE = path.join(destRoot, '__checks__', 'tcp');
  const OUTPUT_DIR_PUBLIC = path.join(OUTPUT_BASE, 'public');
  const OUTPUT_DIR_PRIVATE = path.join(OUTPUT_BASE, 'private');

  console.log('='.repeat(60));
  console.log('Checkly TCP Monitor Generator');
  console.log('='.repeat(60));
  if (standalone) {
    console.log(`Mode: standalone project`);
    console.log(`Source migration: ${sourceRoot}`);
    console.log(`Destination project: ${destRoot}`);
  } else {
    console.log(`Mode: inline (TCP files added to source migration project)`);
    console.log(`Output root: ${destRoot}`);
  }

  if (!existsSync(INPUT_FILE)) {
    console.log(`\nSkipping: Input file not found: ${INPUT_FILE}`);
    console.log('Run "npm run export" first.');
    return;
  }

  const data = JSON.parse(await readFile(INPUT_FILE, 'utf-8')) as ApiTestsFile;
  const tcpTests = data.tests.filter(t => t.subtype === 'tcp');

  if (tcpTests.length === 0) {
    console.log('\nNo TCP tests found in export. Nothing to generate.');
    return;
  }

  console.log(`\nFound ${tcpTests.length} TCP test(s) to convert`);

  const publicTests = tcpTests.filter(t => !hasPrivateLocations(t));
  const privateTests = tcpTests.filter(t => hasPrivateLocations(t));

  console.log(`  - Public location TCP monitors: ${publicTests.length}`);
  console.log(`  - Private location TCP monitors: ${privateTests.length}`);

  if (publicTests.length > 0 && !existsSync(OUTPUT_DIR_PUBLIC)) {
    await mkdir(OUTPUT_DIR_PUBLIC, { recursive: true });
  }
  if (privateTests.length > 0 && !existsSync(OUTPUT_DIR_PRIVATE)) {
    await mkdir(OUTPUT_DIR_PRIVATE, { recursive: true });
  }

  let errorCount = 0;
  const publicFiles: GeneratedFile[] = [];
  const privateFiles: GeneratedFile[] = [];

  const writeAll = async (tests: DatadogTcpTest[], dir: string, files: GeneratedFile[]) => {
    for (const test of tests) {
      try {
        const code = generateTcpMonitorCode(test, { withAlertChannels: standalone });
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

  // Standalone scaffolding (configs, package.json, README, etc.)
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
      tcpTests,
    );
    console.log(`\nStandalone scaffolding written: ${written.length} file(s)`);
    for (const f of written) console.log(`  - ${f}`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('Generation Summary');
  console.log('='.repeat(60));
  console.log(`  Public TCP monitors generated: ${publicFiles.length} → ${OUTPUT_DIR_PUBLIC}`);
  console.log(`  Private TCP monitors generated: ${privateFiles.length} → ${OUTPUT_DIR_PRIVATE}`);
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
