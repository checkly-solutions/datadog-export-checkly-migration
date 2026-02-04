/**
 * Shared utility functions for Datadog to Checkly migration
 */

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
 * Generate a slug from the check name for use as logicalId
 */
export function generateLogicalId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 64);
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
