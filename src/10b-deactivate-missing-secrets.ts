/**
 * Deactivates checks that reference secret variables with missing values.
 *
 * When migrating from Datadog, secret variable values are not exported (masked).
 * Step 09 creates secrets.json with empty values. This step detects checks that
 * reference those secrets and proactively deactivates them so they don't fail
 * on deployment.
 *
 * Logic:
 *   1. Read <outputRoot>/variables/secrets.json to get secret keys
 *   2. Read <exportsDir>/variable-usage.json to get variable → check mappings
 *   3. Find checks that reference any secret variable
 *   4. Scan .check.ts files and deactivate affected checks
 *   5. Write missing-secrets-report.json
 *
 * Reads: variables/secrets.json, exports/variable-usage.json
 * Modifies: __checks__/{api,multi,browser}/{public,private}/*.check.ts
 * Writes: exports/missing-secrets-report.json
 */

import { readFile, writeFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { getOutputRoot, getExportsDir } from './shared/output-config.ts';
import type { VariableUsageReport } from './shared/variable-tracker.ts';

const CHECK_TYPES = ['api', 'multi', 'browser'];
const LOCATION_TYPES = ['public', 'private'];
const TAG = 'missingSecretsFromDatadog';

interface SecretVariable {
  key: string;
  value: string;
  locked: boolean;
}

interface AffectedCheck {
  checkName: string;
  missingSecrets: string[];
}

interface MissingSecretsReport {
  generatedAt: string;
  totalSecrets: number;
  secretsWithEmptyValues: number;
  checksAffected: number;
  filesModified: number;
  filesSkipped: number;
  errors: number;
  affectedChecks: AffectedCheck[];
}

/**
 * Read secrets.json and return keys that have empty values
 */
async function getEmptySecretKeys(outputRoot: string): Promise<string[]> {
  const secretsPath = path.join(outputRoot, 'variables', 'secrets.json');

  if (!existsSync(secretsPath)) {
    console.log('  secrets.json not found — no secrets to check.');
    return [];
  }

  const content = await readFile(secretsPath, 'utf-8');
  const secrets: SecretVariable[] = JSON.parse(content);

  const emptyKeys = secrets
    .filter(s => !s.value || s.value.trim() === '')
    .map(s => s.key);

  console.log(`  Found ${secrets.length} secret(s), ${emptyKeys.length} with empty values`);
  return emptyKeys;
}

/**
 * Read variable-usage.json and find checks that reference any of the given secret keys
 */
async function findAffectedChecks(
  exportsDir: string,
  secretKeys: string[]
): Promise<AffectedCheck[]> {
  const usagePath = path.join(exportsDir, 'variable-usage.json');

  if (!existsSync(usagePath)) {
    console.log('  variable-usage.json not found — cannot determine variable usage.');
    return [];
  }

  const content = await readFile(usagePath, 'utf-8');
  const report: VariableUsageReport = JSON.parse(content);

  // Build check → missing secrets mapping
  const checkSecretsMap = new Map<string, string[]>();
  const secretSet = new Set(secretKeys);

  for (const [varName, usage] of Object.entries(report.variables)) {
    if (!secretSet.has(varName)) continue;

    for (const checkName of usage.checks) {
      const existing = checkSecretsMap.get(checkName) || [];
      existing.push(varName);
      checkSecretsMap.set(checkName, existing);
    }
  }

  const affected: AffectedCheck[] = [];
  for (const [checkName, missingSecrets] of checkSecretsMap) {
    affected.push({ checkName, missingSecrets: missingSecrets.sort() });
  }

  return affected.sort((a, b) => a.checkName.localeCompare(b.checkName));
}

/**
 * Modify a check file to deactivate it and add the missingSecretsFromDatadog tag.
 */
async function deactivateCheckFile(
  filepath: string,
  missingSecrets: string[]
): Promise<boolean> {
  const content = await readFile(filepath, 'utf-8');

  // Idempotency: skip if already tagged
  if (content.includes(TAG)) {
    return false;
  }

  let newContent = content;

  // Only change activated: true → activated: false (don't touch already-false)
  newContent = newContent.replace(
    /activated:\s*true/,
    'activated: false'
  );

  // Add tag to the tags array
  const tagsPattern = /tags:\s*\[([^\]]*)\]/;
  const tagsMatch = newContent.match(tagsPattern);

  if (tagsMatch) {
    const existingTags = tagsMatch[1].trim();
    let newTags: string;

    if (existingTags === '') {
      newTags = `tags: ["${TAG}"]`;
    } else {
      newTags = `tags: [${existingTags}, "${TAG}"]`;
    }

    newContent = newContent.replace(tagsPattern, newTags);
  }

  // Add comment after the "Migrated from Datadog" comment line
  const secretsList = missingSecrets.join(', ');
  const migratedCommentPattern = /(\/\/\s*Migrated from Datadog Synthetic:.*)/;
  if (migratedCommentPattern.test(newContent)) {
    newContent = newContent.replace(
      migratedCommentPattern,
      `$1\n// Deactivated: Missing secret values from Datadog export (${secretsList})`
    );
  }

  if (newContent !== content) {
    await writeFile(filepath, newContent, 'utf-8');
    return true;
  }

  return false;
}

/**
 * Scan check directories and deactivate checks that reference missing secrets.
 */
async function deactivateAffectedChecks(
  checksBase: string,
  affectedChecks: AffectedCheck[]
): Promise<{ modified: number; skipped: number; errors: number }> {
  let modified = 0;
  let skipped = 0;
  let errors = 0;

  // Build a map of check name → missing secrets for quick lookup
  const checkNameMap = new Map<string, string[]>();
  for (const ac of affectedChecks) {
    checkNameMap.set(ac.checkName, ac.missingSecrets);
  }

  for (const checkType of CHECK_TYPES) {
    for (const locationType of LOCATION_TYPES) {
      const dirPath = path.join(checksBase, checkType, locationType);

      if (!existsSync(dirPath)) {
        continue;
      }

      const files = await readdir(dirPath);
      const checkFiles = files.filter(f => f.endsWith('.check.ts'));

      for (const file of checkFiles) {
        const filepath = path.join(dirPath, file);
        try {
          const content = await readFile(filepath, 'utf-8');

          // Extract check name from the construct's name field
          const nameMatch = content.match(/name:\s*['"](.+?)['"]/);
          if (!nameMatch) {
            continue;
          }

          const checkName = nameMatch[1];
          const missingSecrets = checkNameMap.get(checkName);
          if (!missingSecrets) {
            continue;
          }

          const wasModified = await deactivateCheckFile(filepath, missingSecrets);
          if (wasModified) {
            modified++;
            console.log(`  Deactivated [${TAG}]: ${locationType}/${file} (secrets: ${missingSecrets.join(', ')})`);
          } else {
            skipped++;
          }
        } catch (err) {
          console.error(`  Error processing ${file}: ${(err as Error).message}`);
          errors++;
        }
      }
    }
  }

  return { modified, skipped, errors };
}

/**
 * Main function
 */
async function main(): Promise<void> {
  const outputRoot = await getOutputRoot();
  const exportsDir = await getExportsDir();
  const checksBase = `${outputRoot}/__checks__`;

  console.log('='.repeat(60));
  console.log('Deactivate Checks with Missing Secrets');
  console.log('='.repeat(60));

  // Step 1: Get secret keys with empty values
  console.log('\nReading secrets...');
  const emptySecretKeys = await getEmptySecretKeys(outputRoot);

  if (emptySecretKeys.length === 0) {
    console.log('\nNo empty secrets found — all secret values are filled in.');
    console.log('Done!');
    return;
  }

  console.log(`\nEmpty secret keys: ${emptySecretKeys.join(', ')}`);

  // Step 2: Find affected checks
  console.log('\nFinding checks that reference missing secrets...');
  const affectedChecks = await findAffectedChecks(exportsDir, emptySecretKeys);

  if (affectedChecks.length === 0) {
    console.log('\nNo checks reference the empty secrets — nothing to deactivate.');

    // Still write report
    const report: MissingSecretsReport = {
      generatedAt: new Date().toISOString(),
      totalSecrets: emptySecretKeys.length,
      secretsWithEmptyValues: emptySecretKeys.length,
      checksAffected: 0,
      filesModified: 0,
      filesSkipped: 0,
      errors: 0,
      affectedChecks: [],
    };
    const reportPath = path.join(exportsDir, 'missing-secrets-report.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`\nWritten: ${reportPath}`);
    console.log('Done!');
    return;
  }

  console.log(`\nFound ${affectedChecks.length} check(s) referencing missing secrets:`);
  for (const ac of affectedChecks) {
    console.log(`  - ${ac.checkName} → ${ac.missingSecrets.join(', ')}`);
  }

  // Step 3: Deactivate affected check files
  let result = { modified: 0, skipped: 0, errors: 0 };

  if (!existsSync(checksBase)) {
    console.log(`\nSkipping file modifications: ${checksBase} not found.`);
    console.log('Run the migration scripts first to generate check files.');
  } else {
    console.log(`\nDeactivating ${affectedChecks.length} check(s) in check files...`);
    result = await deactivateAffectedChecks(checksBase, affectedChecks);

    console.log('\n' + '-'.repeat(40));
    console.log('File Modification Summary');
    console.log('-'.repeat(40));
    console.log(`  Files deactivated: ${result.modified}`);
    console.log(`  Files skipped (already tagged): ${result.skipped}`);
    console.log(`  Errors: ${result.errors}`);
  }

  // Step 4: Write report
  const report: MissingSecretsReport = {
    generatedAt: new Date().toISOString(),
    totalSecrets: emptySecretKeys.length,
    secretsWithEmptyValues: emptySecretKeys.length,
    checksAffected: affectedChecks.length,
    filesModified: result.modified,
    filesSkipped: result.skipped,
    errors: result.errors,
    affectedChecks,
  };

  const reportPath = path.join(exportsDir, 'missing-secrets-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\nWritten: ${reportPath}`);

  // Final summary
  console.log('\n' + '='.repeat(60));
  console.log('Done!');
  console.log('='.repeat(60));

  if (result.modified > 0) {
    console.log(`\n${result.modified} check(s) deactivated due to missing secret values.`);
    console.log(`Tagged with "${TAG}".`);
    console.log('Fill in secret values in variables/secrets.json and remove the tag to re-activate.');
  }
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
