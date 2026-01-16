/**
 * Converts Datadog global variables to Checkly environment variables format.
 *
 * Reads: exports/global-variables.json
 * Outputs:
 *   - checkly-migrated/variables/env-variables.json (clean, non-secure vars)
 *   - checkly-migrated/variables/secrets.json (clean, secure vars - needs manual values)
 *   - checkly-migrated/variables/create-variables.sh (API create script)
 *   - checkly-migrated/variables/delete-variables.sh (API delete script)
 *
 * Datadog attributes used:
 *   - name → key
 *   - value.value → value
 *   - value.secure → determines if secret (locked in Checkly)
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';

const INPUT_FILE = './exports/global-variables.json';
const OUTPUT_DIR = './checkly-migrated/variables';

interface DatadogVariable {
  name: string;
  value?: {
    value?: string;
    secure?: boolean;
  };
}

interface ChecklyVariable {
  key: string;
  value: string;
  locked: boolean;
}

/**
 * Main conversion function
 */
async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Datadog Global Variables → Checkly Environment Variables');
  console.log('='.repeat(60));

  // Check input file exists
  if (!existsSync(INPUT_FILE)) {
    console.error(`Error: Input file not found: ${INPUT_FILE}`);
    console.error('Run "npm run export" first to export global variables.');
    process.exit(1);
  }

  console.log(`\nReading: ${INPUT_FILE}`);
  const data = JSON.parse(await readFile(INPUT_FILE, 'utf-8')) as { variables: DatadogVariable[] };

  const variables = data.variables || [];
  console.log(`Found ${variables.length} global variables`);

  // Separate secure vs non-secure
  const envVariables: ChecklyVariable[] = [];
  const secrets: ChecklyVariable[] = [];

  for (const variable of variables) {
    const name = variable.name;
    const isSecure = variable.value?.secure === true;
    const value = variable.value?.value;

    if (isSecure) {
      // Secure variables don't expose their values in Datadog export
      secrets.push({
        key: name,
        value: '', // Must be filled in manually
        locked: true,
      });
    } else {
      envVariables.push({
        key: name,
        value: value || '',
        locked: false,
      });
    }
  }

  console.log(`  Non-secure variables: ${envVariables.length}`);
  console.log(`  Secure variables (secrets): ${secrets.length}`);

  // Create output directory
  if (!existsSync(OUTPUT_DIR)) {
    await mkdir(OUTPUT_DIR, { recursive: true });
    console.log(`Created directory: ${OUTPUT_DIR}`);
  }

  // Write clean env-variables.json (just key/value/locked)
  await writeFile(
    `${OUTPUT_DIR}/env-variables.json`,
    JSON.stringify(envVariables, null, 2),
    'utf-8'
  );
  console.log(`\nWritten: ${OUTPUT_DIR}/env-variables.json`);

  // Write clean secrets.json (needs manual value entry)
  await writeFile(
    `${OUTPUT_DIR}/secrets.json`,
    JSON.stringify(secrets, null, 2),
    'utf-8'
  );
  console.log(`Written: ${OUTPUT_DIR}/secrets.json`);

  // Generate create script
  const allVars = [...envVariables, ...secrets];
  const createScript = generateCreateScript(allVars);
  await writeFile(`${OUTPUT_DIR}/create-variables.sh`, createScript, 'utf-8');
  console.log(`Written: ${OUTPUT_DIR}/create-variables.sh`);

  // Generate delete script
  const deleteScript = generateDeleteScript(allVars);
  await writeFile(`${OUTPUT_DIR}/delete-variables.sh`, deleteScript, 'utf-8');
  console.log(`Written: ${OUTPUT_DIR}/delete-variables.sh`);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Conversion Summary');
  console.log('='.repeat(60));
  console.log(`  Total variables: ${variables.length}`);
  console.log(`  Non-secure (env-variables.json): ${envVariables.length}`);
  console.log(`  Secure (secrets.json): ${secrets.length}`);
  console.log(`  Output directory: ${OUTPUT_DIR}`);

  console.log('\nGenerated files:');
  console.log('  - env-variables.json   (non-secure, values included)');
  console.log('  - secrets.json         (secure, FILL IN VALUES MANUALLY)');
  console.log('  - create-variables.sh  (creates all vars via API)');
  console.log('  - delete-variables.sh  (deletes all vars via API)');

  console.log('\nNext steps:');
  console.log('  1. Add CHECKLY_API_KEY and CHECKLY_ACCOUNT_ID to .env file');
  console.log('  2. Fill in secret values in secrets.json');
  console.log('  3. Run: chmod +x create-variables.sh && ./create-variables.sh');
  console.log('\nDone!');
}

/**
 * Generate a shell script to create variables via Checkly API
 * Reads from the JSON files at runtime
 */
function generateCreateScript(allVars: ChecklyVariable[]): string {
  const lines = [
    '#!/bin/bash',
    '',
    '# Checkly Environment Variables - CREATE Script',
    '# Reads from env-variables.json and secrets.json',
    '# Loads credentials from .env file in project root',
    '#',
    '# Usage: ./create-variables.sh',
    '',
    'set -e',
    '',
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'PROJECT_ROOT="$SCRIPT_DIR/../.."',
    '',
    '# Load .env file from project root',
    'if [ -f "$PROJECT_ROOT/.env" ]; then',
    '  echo "Loading credentials from .env..."',
    '  export $(grep -v "^#" "$PROJECT_ROOT/.env" | grep -E "^CHECKLY_" | xargs)',
    'fi',
    '',
    'if [ -z "$CHECKLY_API_KEY" ]; then',
    '  echo "Error: CHECKLY_API_KEY not set. Add it to .env file."',
    '  exit 1',
    'fi',
    '',
    'if [ -z "$CHECKLY_ACCOUNT_ID" ]; then',
    '  echo "Error: CHECKLY_ACCOUNT_ID not set. Add it to .env file."',
    '  exit 1',
    'fi',
    '',
    'API_URL="https://api.checklyhq.com/v1/variables"',
    '',
    'create_variable() {',
    '  local key="$1"',
    '  local value="$2"',
    '  local locked="$3"',
    '',
    '  echo "Creating: $key"',
    '  response=$(curl -s -w "\\n%{http_code}" -X POST "$API_URL" \\',
    '    -H "Authorization: Bearer $CHECKLY_API_KEY" \\',
    '    -H "X-Checkly-Account: $CHECKLY_ACCOUNT_ID" \\',
    '    -H "Content-Type: application/json" \\',
    '    -d "{\\"key\\": \\"$key\\", \\"value\\": \\"$value\\", \\"locked\\": $locked}")',
    '',
    '  http_code=$(echo "$response" | tail -n1)',
    '  body=$(echo "$response" | sed \'$d\')',
    '',
    '  if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then',
    '    echo "  ✓ Created successfully"',
    '  else',
    '    echo "  ✗ Failed (HTTP $http_code): $body"',
    '  fi',
    '}',
    '',
    'echo "=========================================="',
    'echo "Creating Checkly Environment Variables"',
    'echo "=========================================="',
    'echo ""',
    '',
    '# Process env-variables.json',
    'if [ -f "$SCRIPT_DIR/env-variables.json" ]; then',
    '  echo "Processing env-variables.json..."',
    '  count=$(jq length "$SCRIPT_DIR/env-variables.json")',
    '  for i in $(seq 0 $((count - 1))); do',
    '    key=$(jq -r ".[$i].key" "$SCRIPT_DIR/env-variables.json")',
    '    value=$(jq -r ".[$i].value" "$SCRIPT_DIR/env-variables.json" | sed \'s/"/\\\\"/g\')',
    '    locked=$(jq -r ".[$i].locked" "$SCRIPT_DIR/env-variables.json")',
    '    create_variable "$key" "$value" "$locked"',
    '  done',
    '  echo ""',
    'fi',
    '',
    '# Process secrets.json',
    'if [ -f "$SCRIPT_DIR/secrets.json" ]; then',
    '  echo "Processing secrets.json..."',
    '  count=$(jq length "$SCRIPT_DIR/secrets.json")',
    '  for i in $(seq 0 $((count - 1))); do',
    '    key=$(jq -r ".[$i].key" "$SCRIPT_DIR/secrets.json")',
    '    value=$(jq -r ".[$i].value" "$SCRIPT_DIR/secrets.json" | sed \'s/"/\\\\"/g\')',
    '    locked=$(jq -r ".[$i].locked" "$SCRIPT_DIR/secrets.json")',
    '    if [ -z "$value" ]; then',
    '      echo "Skipping $key: empty value (fill in secrets.json first)"',
    '    else',
    '      create_variable "$key" "$value" "$locked"',
    '    fi',
    '  done',
    '  echo ""',
    'fi',
    '',
    'echo "=========================================="',
    'echo "Done!"',
    'echo "=========================================="',
  ];

  return lines.join('\n');
}

/**
 * Generate a shell script to delete variables via Checkly API
 */
function generateDeleteScript(allVars: ChecklyVariable[]): string {
  const lines = [
    '#!/bin/bash',
    '',
    '# Checkly Environment Variables - DELETE Script',
    '# Reads keys from env-variables.json and secrets.json',
    '# Loads credentials from .env file in project root',
    '#',
    '# Usage: ./delete-variables.sh',
    '',
    'set -e',
    '',
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'PROJECT_ROOT="$SCRIPT_DIR/../.."',
    '',
    '# Load .env file from project root',
    'if [ -f "$PROJECT_ROOT/.env" ]; then',
    '  echo "Loading credentials from .env..."',
    '  export $(grep -v "^#" "$PROJECT_ROOT/.env" | grep -E "^CHECKLY_" | xargs)',
    'fi',
    '',
    'if [ -z "$CHECKLY_API_KEY" ]; then',
    '  echo "Error: CHECKLY_API_KEY not set. Add it to .env file."',
    '  exit 1',
    'fi',
    '',
    'if [ -z "$CHECKLY_ACCOUNT_ID" ]; then',
    '  echo "Error: CHECKLY_ACCOUNT_ID not set. Add it to .env file."',
    '  exit 1',
    'fi',
    '',
    'API_URL="https://api.checklyhq.com/v1/variables"',
    '',
    'delete_variable() {',
    '  local key="$1"',
    '',
    '  echo "Deleting: $key"',
    '  response=$(curl -s -w "\\n%{http_code}" -X DELETE "$API_URL/$key" \\',
    '    -H "Authorization: Bearer $CHECKLY_API_KEY" \\',
    '    -H "X-Checkly-Account: $CHECKLY_ACCOUNT_ID")',
    '',
    '  http_code=$(echo "$response" | tail -n1)',
    '  body=$(echo "$response" | sed \'$d\')',
    '',
    '  if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then',
    '    echo "  ✓ Deleted successfully"',
    '  elif [ "$http_code" -eq 404 ]; then',
    '    echo "  - Not found (already deleted?)"',
    '  else',
    '    echo "  ✗ Failed (HTTP $http_code): $body"',
    '  fi',
    '}',
    '',
    'echo "=========================================="',
    'echo "Deleting Checkly Environment Variables"',
    'echo "=========================================="',
    'echo ""',
    'echo "WARNING: This will delete all variables listed in the JSON files!"',
    'read -p "Are you sure? (y/N) " confirm',
    'if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then',
    '  echo "Aborted."',
    '  exit 0',
    'fi',
    'echo ""',
    '',
    '# Process env-variables.json',
    'if [ -f "$SCRIPT_DIR/env-variables.json" ]; then',
    '  echo "Processing env-variables.json..."',
    '  count=$(jq length "$SCRIPT_DIR/env-variables.json")',
    '  for i in $(seq 0 $((count - 1))); do',
    '    key=$(jq -r ".[$i].key" "$SCRIPT_DIR/env-variables.json")',
    '    delete_variable "$key"',
    '  done',
    '  echo ""',
    'fi',
    '',
    '# Process secrets.json',
    'if [ -f "$SCRIPT_DIR/secrets.json" ]; then',
    '  echo "Processing secrets.json..."',
    '  count=$(jq length "$SCRIPT_DIR/secrets.json")',
    '  for i in $(seq 0 $((count - 1))); do',
    '    key=$(jq -r ".[$i].key" "$SCRIPT_DIR/secrets.json")',
    '    delete_variable "$key"',
    '  done',
    '  echo ""',
    'fi',
    '',
    'echo "=========================================="',
    'echo "Done!"',
    'echo "=========================================="',
  ];

  return lines.join('\n');
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
