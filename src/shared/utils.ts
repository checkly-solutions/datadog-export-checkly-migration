/**
 * Shared utility functions for Datadog to Checkly migration
 */

import type { DatadogConfigVariable } from './types.ts';

/**
 * Datadog tick_every (seconds) to Checkly frequency mapping
 */
export const FREQUENCY_MAP: Record<number, string> = {
  60: 'EVERY_1M',
  120: 'EVERY_2M',
  300: 'EVERY_5M',
  600: 'EVERY_10M',
  900: 'EVERY_15M',
  1800: 'EVERY_30M',
  3600: 'EVERY_1H',
  7200: 'EVERY_2H',
  14400: 'EVERY_6H', // Checkly doesn't have EVERY_4H, using closest
  21600: 'EVERY_6H',
  43200: 'EVERY_12H',
  86400: 'EVERY_24H',
};

/**
 * Sanitize a string to be a valid filename
 */
export function sanitizeFilename(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
}

/**
 * Generate a slug from the check name for use as logicalId.
 */
export function generateLogicalId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/-+/g, '-'); // collapse multiple dashes
}

/**
 * Determine if a test/check uses private locations
 * Works with any object that has a privateLocations array
 */
export function hasPrivateLocations(item: { privateLocations?: string[] }): boolean {
  return item.privateLocations !== undefined && item.privateLocations.length > 0;
}

/**
 * Map Datadog tick_every to Checkly frequency
 */
export function convertFrequency(tickEvery?: number): string {
  const tick = tickEvery || 300;
  // Find closest frequency
  const frequencies = Object.keys(FREQUENCY_MAP).map(Number).sort((a, b) => a - b);

  for (const freq of frequencies) {
    if (tick <= freq) {
      return FREQUENCY_MAP[freq];
    }
  }

  // Default to closest available
  return FREQUENCY_MAP[tick] || 'EVERY_10M';
}

/**
 * Sanitize a string to be a valid TypeScript identifier
 */
export function sanitizeIdentifier(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^(\d)/, '_$1')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Escape a string for use in a template literal
 */
export function escapeTemplateLiteral(str: string): string {
  if (!str) return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

/**
 * Escape a string for use in a regular string
 */
export function escapeString(str: string): string {
  if (!str) return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Derive a Checkly-friendly slug from a Datadog private location ID.
 *
 * Datadog format: pl:niq-aks-eastus2-private-location-4f05fbbffeea9ce3c90caee1c58e7883
 * Checkly slug:   niq-aks-eastus2
 *
 * Pattern: pl:{meaningful-name}-private-location-{hash}
 * We extract the meaningful-name part.
 */
export function deriveChecklySlugFromDatadogPrivateLocation(datadogId: string): string {
  // Remove 'pl:' prefix if present
  let id = datadogId.startsWith('pl:') ? datadogId.slice(3) : datadogId;

  // Try to find and remove the '-private-location-{hash}' suffix
  const privateLocationPattern = /-private-location-[a-f0-9]+$/i;
  if (privateLocationPattern.test(id)) {
    id = id.replace(privateLocationPattern, '');
  }

  // Sanitize: only allow lowercase alphanumeric and hyphens
  id = id.toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  // Limit length for Checkly compatibility
  return id.substring(0, 64);
}

/**
 * Private location mapping with Checkly slug and usage tracking
 */
export interface PrivateLocationMapping {
  datadogId: string;
  checklySlug: string;
  name?: string;
  usageCount: number;
}

/**
 * Normalize the Datadog request body field.
 *
 * Datadog can return the body in two formats:
 *   - String: "grant_type=client_credentials&..."
 *   - Object: { "type": "application/x-www-form-urlencoded", "content": "grant_type=..." }
 *
 * This function always returns the body content as a string (or undefined).
 */
export function normalizeDatadogBody(body: unknown): string | undefined {
  if (!body) return undefined;
  if (typeof body === 'string') return body;
  if (typeof body === 'object' && body !== null && 'content' in body) {
    const content = (body as Record<string, unknown>).content;
    return typeof content === 'string' ? content : JSON.stringify(content);
  }
  // Fallback: stringify unexpected formats so they aren't silently lost
  return JSON.stringify(body);
}

/**
 * Convert Datadog configVariables to Checkly environmentVariable entries.
 *
 * Conversion rules:
 *   - type: "text", secure: false/absent → { key: name, value: pattern ?? '' }
 *   - type: "text", secure: true         → { key: name, value: '', secret: true }
 *   - type: "global"                     → skipped (handled at account level by step 09)
 *   - any other type                     → skipped
 *
 * @param configVars - Raw Datadog configVariables array from test config
 * @returns Array of Checkly-compatible environment variable objects. Empty when input
 *          is empty, null, undefined, or contains only non-text variables.
 */
export function convertConfigVariables(
  configVars: DatadogConfigVariable[] | undefined | null
): Array<{ key: string; value: string; secret?: boolean }> {
  if (!configVars || configVars.length === 0) return [];

  const result: Array<{ key: string; value: string; secret?: boolean }> = [];

  for (const v of configVars) {
    if (v.type !== 'text') continue;

    if (v.secure) {
      result.push({ key: v.name, value: '', secret: true });
    } else {
      result.push({ key: v.name, value: v.pattern ?? '' });
    }
  }

  return result;
}

/**
 * Detect the Checkly bodyType from request headers.
 *
 * Inspects the Content-Type header (case-insensitive) to determine the
 * appropriate Checkly BodyType value:
 *   - application/json            → 'JSON'
 *   - application/x-www-form-urlencoded → 'FORM'
 *   - application/graphql         → 'GRAPHQL'
 *   - anything else with a body   → 'RAW'
 *   - no body                     → 'NONE'
 *
 * @param headers - Request headers as Record<string, string> or KeyValuePair[]
 * @param hasBody - Whether the request has a body
 * @returns Checkly BodyType string
 */
export function detectBodyType(
  headers: Record<string, string> | Array<{ key: string; value: string }> | undefined,
  hasBody: boolean
): 'JSON' | 'FORM' | 'RAW' | 'GRAPHQL' | 'NONE' {
  if (!hasBody) return 'NONE';

  let contentType = '';

  if (Array.isArray(headers)) {
    const ct = headers.find(h => h.key.toLowerCase() === 'content-type');
    if (ct) contentType = ct.value.toLowerCase();
  } else if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === 'content-type') {
        contentType = value.toLowerCase();
        break;
      }
    }
  }

  if (contentType.includes('application/json')) return 'JSON';
  if (contentType.includes('application/x-www-form-urlencoded')) return 'FORM';
  if (contentType.includes('application/graphql')) return 'GRAPHQL';

  return 'RAW';
}

/**
 * Default set of Datadog system/internal tags excluded when DD_TAGS_EXCLUDE_ALL=true.
 * These tags are generated by Datadog's infrastructure and have no value in Checkly.
 */
export const DD_TAGS_EXCLUDE_ALL_DEFAULTS =
  'browsertype:*,device:*,run_type:*,ci_execution_rule:*,type:*,resolved_ip:*,step_id:*,step_name:*,actual_retries:*,last_retry:*';

/**
 * Filter and remap tags based on DD_TAGS_EXCLUDE and DD_TAGS_REMAP env vars.
 *
 * DD_TAGS_EXCLUDE: Comma-separated tag patterns to remove. Supports prefix:* wildcards.
 *   Example: "browsertype:*,device:*,run_type:*"
 *
 * DD_TAGS_EXCLUDE_ALL: Set to "true" to automatically exclude all common Datadog system tags
 *   (browsertype:*, device:*, run_type:*, ci_execution_rule:*, type:*, resolved_ip:*,
 *   step_id:*, step_name:*, actual_retries:*, last_retry:*).
 *   If DD_TAGS_EXCLUDE is also set, its patterns are merged on top of the defaults.
 *
 * DD_TAGS_REMAP: Comma-separated old->new pairs to rename tags.
 *   Uses -> delimiter (not : which conflicts with Datadog key:value format).
 *   Example: "check_status:alert->status:alert,team_name:ops->team:ops"
 *
 * @param tags - Original Datadog tags array
 * @returns Filtered and remapped tags array
 */
export function filterAndRemapTags(tags: string[]): string[] {
  const excludeAllEnabled = process.env.DD_TAGS_EXCLUDE_ALL === 'true';
  const excludeUser = process.env.DD_TAGS_EXCLUDE || '';
  const excludeRaw = excludeAllEnabled
    ? [DD_TAGS_EXCLUDE_ALL_DEFAULTS, excludeUser].filter(Boolean).join(',')
    : excludeUser;
  const remapRaw = process.env.DD_TAGS_REMAP || '';

  let result = [...tags];

  // Apply exclusions
  if (excludeRaw.trim()) {
    const patterns = excludeRaw.split(',').map(p => p.trim()).filter(Boolean);
    result = result.filter(tag => {
      for (const pattern of patterns) {
        if (pattern.endsWith('*')) {
          // Wildcard: match prefix
          const prefix = pattern.slice(0, -1);
          if (tag.startsWith(prefix)) return false;
        } else {
          // Exact match
          if (tag === pattern) return false;
        }
      }
      return true;
    });
  }

  // Apply remapping
  if (remapRaw.trim()) {
    const pairs = remapRaw.split(',').map(p => p.trim()).filter(Boolean);
    const remapMap = new Map<string, string>();
    for (const pair of pairs) {
      const arrowIdx = pair.indexOf('->');
      if (arrowIdx === -1) {
        console.warn(`  Warning: Invalid DD_TAGS_REMAP entry (missing ->): "${pair}"`);
        continue;
      }
      const oldTag = pair.slice(0, arrowIdx).trim();
      const newTag = pair.slice(arrowIdx + 2).trim();
      if (oldTag && newTag) {
        remapMap.set(oldTag, newTag);
      }
    }
    result = result.map(tag => remapMap.get(tag) || tag);
  }

  return result;
}
