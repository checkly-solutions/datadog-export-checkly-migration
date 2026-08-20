/**
 * Generates check group files for public and private locations.
 *
 * Outputs:
 * - checkly-migrated/__checks__/groups/private/group.check.ts
 * - checkly-migrated/__checks__/groups/public/group.check.ts
 *
 * These groups are automatically loaded by the Checkly CLI based on the
 * checkMatch pattern in the config files, ensuring each config only loads
 * its corresponding group.
 */

import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { getOutputRoot } from './shared/output-config.ts';

let OUTPUT_BASE = '';

export const PRIVATE_GROUP = `import { CheckGroupV2 } from "checkly/constructs";

export const private_locations_group = new CheckGroupV2(
  "datadog-migrated-private-checks",
  {
    name: "Datadog Migrated Private Checks",
    activated: false,
    tags: ["migrated", "private"],
  }
);
`;

export const PUBLIC_GROUP = `import { CheckGroupV2 } from "checkly/constructs";

export const public_locations_group = new CheckGroupV2(
  "datadog-migrated-public-checks",
  {
    name: "Datadog Migrated Public Checks",
    activated: false,
    tags: ["migrated", "public"],
  }
);
`;

async function main(): Promise<void> {
  OUTPUT_BASE = `${await getOutputRoot()}/__checks__/groups`;

  console.log('='.repeat(60));
  console.log('Generate Check Groups');
  console.log('='.repeat(60));

  // Create directories
  const privateDir = `${OUTPUT_BASE}/private`;
  const publicDir = `${OUTPUT_BASE}/public`;

  if (!existsSync(privateDir)) {
    await mkdir(privateDir, { recursive: true });
    console.log(`Created: ${privateDir}`);
  }

  if (!existsSync(publicDir)) {
    await mkdir(publicDir, { recursive: true });
    console.log(`Created: ${publicDir}`);
  }

  // Write group files
  await writeFile(`${privateDir}/group.check.ts`, PRIVATE_GROUP, 'utf-8');
  console.log(`Generated: ${privateDir}/group.check.ts`);

  await writeFile(`${publicDir}/group.check.ts`, PUBLIC_GROUP, 'utf-8');
  console.log(`Generated: ${publicDir}/group.check.ts`);

  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log('  Groups generated: 2');
  console.log('    - private_locations_group (for private location checks)');
  console.log('    - public_locations_group (for public location checks)');
  console.log('\nThese groups are loaded automatically by checkMatch patterns.');
  console.log('Done!');
}

// ESM main-guard: only run if this file is the direct entry point
const __filename = fileURLToPath(import.meta.url);
if (typeof process.argv[1] === 'string' && path.resolve(__filename) === path.resolve(process.argv[1])) {
  main().catch(err => {
    console.error('Error:', (err as Error).message);
    process.exit(1);
  });
}
