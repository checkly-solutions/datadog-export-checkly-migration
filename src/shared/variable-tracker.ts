/**
 * Tracks environment variable usage across checks during migration.
 *
 * Extracts variable references from:
 * - Datadog format: {{ VAR_NAME }}
 * - Process.env format: ${process.env.VAR_NAME}
 *
 * Produces a usage report showing which variables are used by which checks.
 */

import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';

const OUTPUT_FILE = './exports/variable-usage.json';

export interface VariableUsage {
  usageCount: number;
  checks: string[];
}

export interface VariableUsageReport {
  generatedAt: string;
  totalVariablesReferenced: number;
  variables: Record<string, VariableUsage>;
}

// In-memory store for variable usage during generation
const variableUsage: Record<string, Set<string>> = {};

/**
 * Regex patterns to match variable references
 */
const DATADOG_VAR_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;
const PROCESS_ENV_PATTERN = /\$\{process\.env\.(\w+)\}/g;

/**
 * Extract all variable names from a string
 */
export function extractVariableNames(str: string | undefined | null): string[] {
  if (!str) return [];

  const variables = new Set<string>();

  // Match Datadog format: {{ VAR_NAME }}
  let match;
  while ((match = DATADOG_VAR_PATTERN.exec(str)) !== null) {
    variables.add(match[1]);
  }
  DATADOG_VAR_PATTERN.lastIndex = 0; // Reset regex state

  // Match process.env format: ${process.env.VAR_NAME}
  while ((match = PROCESS_ENV_PATTERN.exec(str)) !== null) {
    variables.add(match[1]);
  }
  PROCESS_ENV_PATTERN.lastIndex = 0; // Reset regex state

  return Array.from(variables);
}

/**
 * Record variable usage for a check
 * @param checkName - The name or identifier of the check
 * @param content - The content to scan for variables (can be URL, body, header value, etc.)
 */
export function trackVariables(checkName: string, content: string | undefined | null): void {
  const variables = extractVariableNames(content);

  for (const varName of variables) {
    if (!variableUsage[varName]) {
      variableUsage[varName] = new Set();
    }
    variableUsage[varName].add(checkName);
  }
}

/**
 * Record variable usage for a check from multiple content sources
 * @param checkName - The name or identifier of the check
 * @param contents - Array of content strings to scan
 */
export function trackVariablesFromMultiple(checkName: string, contents: (string | undefined | null)[]): void {
  for (const content of contents) {
    trackVariables(checkName, content);
  }
}

/**
 * Get the current variable usage data
 */
export function getVariableUsage(): Record<string, VariableUsage> {
  const result: Record<string, VariableUsage> = {};

  for (const [varName, checks] of Object.entries(variableUsage)) {
    result[varName] = {
      usageCount: checks.size,
      checks: Array.from(checks).sort(),
    };
  }

  return result;
}

/**
 * Write the variable usage report to disk
 */
export async function writeVariableUsageReport(): Promise<void> {
  const usage = getVariableUsage();

  const report: VariableUsageReport = {
    generatedAt: new Date().toISOString(),
    totalVariablesReferenced: Object.keys(usage).length,
    variables: usage,
  };

  // Sort by usage count (descending) for the output
  const sortedVariables: Record<string, VariableUsage> = {};
  const sortedKeys = Object.keys(usage).sort((a, b) => usage[b].usageCount - usage[a].usageCount);

  for (const key of sortedKeys) {
    sortedVariables[key] = usage[key];
  }
  report.variables = sortedVariables;

  await writeFile(OUTPUT_FILE, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`  Written: ${OUTPUT_FILE}`);
}

/**
 * Load existing variable usage report (for merging across generator runs)
 */
export async function loadExistingVariableUsage(): Promise<void> {
  if (!existsSync(OUTPUT_FILE)) {
    return;
  }

  try {
    const content = await readFile(OUTPUT_FILE, 'utf-8');
    const report = JSON.parse(content) as VariableUsageReport;

    // Merge existing data into in-memory store
    for (const [varName, usage] of Object.entries(report.variables)) {
      if (!variableUsage[varName]) {
        variableUsage[varName] = new Set();
      }
      for (const check of usage.checks) {
        variableUsage[varName].add(check);
      }
    }
  } catch (err) {
    // Ignore errors - start fresh
  }
}

/**
 * Clear the in-memory variable usage store
 */
export function clearVariableUsage(): void {
  for (const key of Object.keys(variableUsage)) {
    delete variableUsage[key];
  }
}
