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
 * Sanitize a string to be a valid filename (DEPLOY-08 / D-07).
 *
 * This is the file-write sibling of the DEPLOY-01 logical-ID fix. Per D-07 the
 * `uniqueId` (the Datadog public_id) tail is ALWAYS appended when provided, not
 * only when the slug exceeds MAX_LEN. Without this, two short same-named Datadog
 * tests (e.g. two "Synthetic Browser Flow" tests) slugged to the identical
 * filename and the second writeFile silently overwrote the first, so two source
 * tests produced one on-disk construct while migration-mapping.csv still listed
 * both. The tail is derived by the shared publicIdSlugTail helper, the exact same
 * formula uniqueLogicalId uses, so the filename discriminator and the logical-ID
 * discriminator can never drift. Pure and stateless: no cross-write collision
 * tracking, the tail alone guarantees distinctness.
 *
 * When the combined slug + '-' + tail exceeds MAX_LEN, the HEAD slug is truncated
 * (trailing dashes trimmed) so the full tail is preserved and the result fits the
 * cap. A filter-empty join mirrors uniqueLogicalId's filter(Boolean).join('-')
 * idiom, so an all-punctuation name (empty slug) yields just the tail with no
 * leading dash. When uniqueId is absent, prior behavior is preserved unchanged.
 */
export function sanitizeFilename(str: string, uniqueId?: string): string {
  const MAX_LEN = 50;

  const slug = str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  if (!uniqueId) {
    return slug.slice(0, MAX_LEN);
  }

  const tail = publicIdSlugTail(uniqueId);
  if (!tail) {
    // Degenerate uniqueId that even the hex fallback could not derive from
    // (only possible for a truly empty id); fall back to the no-tail behavior.
    return slug.slice(0, MAX_LEN);
  }

  // Reserve room for the tail plus one separator dash, then truncate the head
  // slug to fit and trim any dash left dangling at the truncation boundary.
  const headBudget = MAX_LEN - tail.length - 1;
  const head = headBudget > 0 ? slug.slice(0, headBudget).replace(/-+$/, '') : '';

  return [head, tail].filter(Boolean).join('-');
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
 * Derive a Checkly-safe slug tail from a Datadog public_id (D-01, D-02, D-07).
 *
 * This is the single tail-derivation formula shared by BOTH uniqueLogicalId (the
 * construct/CSV logical-ID writer) and sanitizeFilename (the on-disk filename
 * writer), so the two can never drift: a check's logical-ID discriminator and
 * its filename discriminator are produced from the exact same helper.
 *
 * It lowercases the raw id, coerces every run of non-alphanumeric characters to a
 * single dash, and trims leading/trailing dashes. The result contains only
 * lowercase letters, digits, and single dashes.
 *
 * WR-01: a non-empty publicId is the uniqueness anchor and must never be silently
 * dropped. Real syn- ids always slug to a non-empty tail, so the fallback branch
 * never runs for production data and callers stay byte-identical. It only fires
 * on degenerate all-punctuation publicIds (e.g. "@@@"), where the normal slug
 * reduces to empty: there we derive a short, stable, collision-resistant hex tail
 * from the raw id's char codes so distinct ids stay distinct and the result never
 * collapses to empty. Deterministic (no randomness, no wall-clock).
 */
export function publicIdSlugTail(raw: string): string {
  const source = raw || '';
  let tail = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!tail && source) {
    let hash = 0;
    for (let i = 0; i < source.length; i++) {
      hash = (Math.imul(hash, 31) + source.charCodeAt(i)) | 0;
    }
    tail = 'x' + (hash >>> 0).toString(16);
  }

  return tail;
}

/**
 * Build a project-unique logical ID from a construct-type prefix, the check
 * name, and the Datadog public_id (D-01, D-02).
 *
 * This is the single source of truth for construct emit sites AND the step-12
 * CSV writer, so the two can never drift: a logical ID emitted into a
 * *.check.ts construct and the same ID recorded in migration-mapping.csv are
 * produced by this one function. The public_id tail (via the shared
 * publicIdSlugTail helper) guarantees uniqueness even when two checks share a
 * name.
 *
 * The output stays inside Checkly's LOGICAL_ID_PATTERN (/^[A-Za-z0-9_\-/#.]+$/,
 * verified against installed checkly@8.13.0 dist/constants.js). Composition from
 * generateLogicalId plus the coerced lowercase-and-dash tail already guarantees
 * the charset, so no separate validator is hand-rolled: the result contains only
 * lowercase letters, digits, and single dashes, a strict subset of the pattern.
 */
export function uniqueLogicalId(prefix: string, name: string, publicId: string): string {
  const slug = generateLogicalId(name);
  const tail = publicIdSlugTail(publicId);

  return [prefix, slug, tail].filter(Boolean).join('-');
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
 * Sanitize a string to be a valid TypeScript identifier.
 *
 * Postconditions (DEPLOY-02, D-04): the result is always a valid TypeScript
 * identifier, never empty, and never digit-leading. The digit guard runs LAST,
 * after the leading/trailing underscore trim; the previous ordering trimmed the
 * guard underscore off right after adding it, which was the DEPLOY-02 root cause.
 *
 * Ordering: coerce every character outside letters, digits, and underscore to
 * underscore; collapse underscore runs; trim leading and trailing underscores;
 * fall back to a single underscore when the result is empty; then prefix an
 * underscore when the first character is a digit.
 */
export function sanitizeIdentifier(str: string): string {
  const base = str
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  if (base === '') return '_';

  return base.replace(/^(\d)/, '_$1');
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
 * Escape a literal string for safe embedding in a RegExp pattern.
 */
export function escapeRegex(str: string): string {
  if (!str) return '';
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize a Datadog regex string. Accepts bare patterns ("\\d+") and
 * slash-wrapped patterns with flags ("/\\d+/gi"). The pattern source is
 * preserved verbatim; only the wrapper is removed.
 */
export function parseDatadogRegex(raw: string): { source: string; flags: string } {
  const m = raw.match(/^\/(.+)\/([gimsuy]*)$/s);
  if (m) return { source: m[1], flags: m[2] };
  return { source: raw, flags: '' };
}

/**
 * Normalize a list of public Checkly location codes.
 *
 * Valid Checkly public locations are AWS region codes like us-east-1. Datadog
 * can carry provider-prefixed values: azure:*, gcp:* have no Checkly equivalent
 * and are dropped; aws: prefixes are stripped to the bare region code. Only the
 * public locations field should be passed here. NEVER pass private-location
 * slugs (pl:*): this filter would drop them, and private locations belong in a
 * separate privateLocations field.
 *
 * The result is deduped after the aws: collapse (D-06): once "aws:us-east-1"
 * and "us-east-1" both reduce to "us-east-1", only the first is kept, in order.
 *
 * Single public-locations normalizer for steps 04 (ApiCheck), 04b (TcpMonitor),
 * 04c (DnsMonitor), 06 (MultiStepCheck), and 08 (BrowserCheck), so every path
 * stays in sync (WR-03). The 04b/04c forks are removed in plan 06-03 and step 08
 * routes through it in plan 06-04.
 */
export function normalizePublicChecklyLocations(locations: string[]): string[] {
  const collapsed = locations
    .filter(loc => !loc.includes(':') || loc.startsWith('aws:'))
    .map(loc => loc.replace(/^aws:/, ''));
  return [...new Set(collapsed)];
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

/**
 * Build a Checkly tag from Datadog's `options.monitor_priority` (1–5).
 * Returns `priority:P<n>` for valid 1–5 values, or null when missing/invalid.
 * Mirrors Datadog's "P1–P5" UI convention so users can still filter by priority in Checkly.
 */
export function priorityTag(monitorPriority?: number | null): string | null {
  if (typeof monitorPriority !== 'number') return null;
  if (!Number.isInteger(monitorPriority)) return null;
  if (monitorPriority < 1 || monitorPriority > 5) return null;
  return `priority:P${monitorPriority}`;
}

/**
 * Canonical Playwright engine vocabulary for multi-browser (PWCS) routing.
 *
 * The order is locked and load-bearing: deriveEnginesFromDeviceIds sorts its
 * output by index into this tuple so the emitted engine set is input-order
 * independent. The three engines mirror Checkly's bundled
 * configure-playwright-checks.md pwProjects example (checkly@8.13.0), which is
 * the vocabulary source of record for the generated playwright.config.ts.
 */
export const PLAYWRIGHT_ENGINE_ORDER = ['chromium', 'firefox', 'webkit'] as const;

/**
 * A single Playwright engine name drawn from PLAYWRIGHT_ENGINE_ORDER.
 */
export type PlaywrightEngine = (typeof PLAYWRIGHT_ENGINE_ORDER)[number];

/**
 * The result of deriving a Playwright engine set from Datadog device_ids.
 */
export interface DeviceEngineDerivation {
  /** Distinct engines in canonical PLAYWRIGHT_ENGINE_ORDER order. */
  engines: PlaywrightEngine[];
  /** The raw device_ids entries that mapped to an engine, in input order. */
  mappedDeviceIds: string[];
  /** The raw device_ids entries with no engine mapping, in input order. */
  unmappedDeviceIds: string[];
}

/**
 * Datadog device-family to Playwright engine map (D-03, D-04).
 *
 * The family is the token before the first dot in a Datadog device id
 * (chrome.laptop_large -> chrome). Edge folds to chromium unconditionally and
 * permanently because Edge is Chromium-based (D-03); safari folds to webkit
 * because Playwright drives Safari through the WebKit engine. Any family not
 * listed here (including the mobile synthetics:mobile:device:* syntax, whose
 * split-on-dot family is 'synthetics:mobile:device:iphone_15_ios_17' with no
 * dot, so the whole string is the family) is treated as unmapped.
 */
const DEVICE_FAMILY_TO_ENGINE: Readonly<Record<string, PlaywrightEngine>> = {
  chrome: 'chromium',
  edge: 'chromium',
  firefox: 'firefox',
  safari: 'webkit',
  webkit: 'webkit',
};

/**
 * Extract the Datadog device-id "family" token used for Playwright engine mapping.
 *
 * The family is the lowercased, trimmed token before the first dot of a Datadog
 * device id (chrome.laptop_large -> chrome). This is the single definition of the
 * family-parsing rule: deriveEnginesFromDeviceIds keys DEVICE_FAMILY_TO_ENGINE on
 * it, and src/07 uses it to detect whether a deduped set declared an edge profile.
 * Total: coerces any input to a string, never throws.
 *
 * @param entry - A raw options.device_ids entry (or any value).
 * @returns The lowercased family token (empty string when there is no leading token).
 */
export function deviceFamily(entry: unknown): string {
  return String(entry).split('.')[0].trim().toLowerCase();
}

/**
 * Derive the distinct Playwright engine set from a Datadog options.device_ids list.
 *
 * Producer: step 01's export carries options.device_ids off the raw Datadog test
 * (the field lives at options.device_ids, never config.device_ids). Consumers:
 * src/07 generateSpecFile derives the engine set here and emits PWCS flags when a
 * device is unmapped or engines are deduped; src/08 branches BrowserCheck vs
 * PlaywrightCheck on the manifest-transported result of this function.
 *
 * Mapping rule: family = deviceFamily(entry) (the lowercased token before the first dot).
 * chrome and edge map to chromium (D-03: Edge is Chromium-based, unconditional and
 * permanent); firefox maps to firefox; safari and webkit map to webkit. Everything
 * else (the mobile synthetics:mobile:device:* syntax, empty strings, non-string
 * entries) is quarantined in unmappedDeviceIds. engines is deduplicated and sorted
 * by PLAYWRIGHT_ENGINE_ORDER index (D-04: more device profiles than distinct
 * engines is a real reduction that must be surfaced, never silent), so the output
 * is canonical and independent of input order.
 *
 * Pure, total, no I/O: hostile input (null, undefined, non-string entries) routes
 * to unmappedDeviceIds and never throws.
 *
 * @param deviceIds - The raw options.device_ids array, or undefined/null.
 * @returns The engine set plus the mapped/unmapped partition of the input.
 */
export function deriveEnginesFromDeviceIds(
  deviceIds: string[] | undefined | null
): DeviceEngineDerivation {
  const mappedDeviceIds: string[] = [];
  const unmappedDeviceIds: string[] = [];
  const engineSet = new Set<PlaywrightEngine>();

  for (const entry of deviceIds ?? []) {
    const family = deviceFamily(entry);
    const engine = DEVICE_FAMILY_TO_ENGINE[family];
    if (engine) {
      mappedDeviceIds.push(entry as string);
      engineSet.add(engine);
    } else {
      unmappedDeviceIds.push(entry as string);
    }
  }

  const engines = PLAYWRIGHT_ENGINE_ORDER.filter((e) => engineSet.has(e));

  return { engines, mappedDeviceIds, unmappedDeviceIds };
}
