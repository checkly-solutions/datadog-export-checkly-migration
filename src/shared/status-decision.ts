/**
 * Pure status-correlation decision seam (Phase 04, STAT-03).
 *
 * This module is intentionally side-effect free: it loads no env config, no
 * fetch layer, and touches no filesystem or environment. That is what keeps the
 * decision rule offline unit-testable (STAT-03) and lets the status-check step
 * consume it without inheriting the module-level env-config pollution that
 * makes that step itself unsafe to import from tests.
 *
 * `classifyStatus` implements the LOCKED D-04/D-06 truth table verbatim.
 * `applyOutcomeToSource` is the pure extraction of 10a's `.check.ts` text
 * mutation, gated so the `activated` flip only runs for real deactivations.
 */

/** Monitor/search state as reported by Datadog (signal #2). */
export type MonitorSearchState = 'OK' | 'Alert' | 'No Data' | 'Unknown';

/** The test's own exported config status (signal #1); undefined = absent/unknown. */
export type TestConfigStatus = 'live' | 'paused' | undefined;

/**
 * The outcome of classifying a single test's status.
 */
export interface StatusOutcome {
  /** true -> flip `activated: true` to `activated: false`; false -> leave `activated` untouched (D-08). */
  deactivate: boolean;
  /** Diagnostic/review tag to append; null -> no tag and no change (OK / Unknown). */
  tag: string | null;
  /** Convenience flag: true when `tag` starts with `review` (D-02 review-queue signal). */
  isReview: boolean;
}

/**
 * Classify a test's deactivation/tag outcome from the two locked inputs
 * (D-03/D-05): the monitor/search state and the test's exported config status.
 *
 * Implements the LOCKED D-04/D-06 truth table. The ONLY case that keeps a
 * `No Data` check active is `configStatus === 'live'` (D-05); both `paused` and
 * absent/unknown config statuses deactivate, differing only in which tag they
 * carry. Do NOT reintroduce the superseded ARCHITECTURE.md `!paused` formula,
 * which wrongly leaves absent-status checks active (04-RESEARCH.md Pitfall 1).
 *
 * @param searchState - Datadog monitor/search state ('OK' | 'Alert' | 'No Data' | 'Unknown' | anything else).
 * @param configStatus - The test's exported config status ('live' | 'paused' | undefined/absent).
 * @returns The deactivation flag, tag, and review flag for this test.
 */
export function classifyStatus(searchState: string, configStatus?: string): StatusOutcome {
  let deactivate: boolean;
  let tag: string | null;

  if (searchState === 'Alert') {
    // Alert -> deactivate, failingInDatadog (unchanged behavior).
    deactivate = true;
    tag = 'failingInDatadog';
  } else if (searchState === 'No Data') {
    if (configStatus === 'live') {
      // Live in Datadog but mislabeled No Data: the bug. Keep active, review-tag it (D-04 row 1, STAT-01).
      deactivate = false;
      tag = 'reviewNoDataInDatadog';
    } else if (configStatus === 'paused') {
      // Genuinely paused: keep the existing deactivation (D-04 row 2, STAT-02, unchanged).
      deactivate = true;
      tag = 'noDataInDatadog';
    } else {
      // Absent/unknown config status: still deactivate (safe-by-default) but flag for review (D-06).
      deactivate = true;
      tag = 'reviewNoDataInDatadog';
    }
  } else {
    // OK, Unknown (monitor not found), or anything else: unchanged, active, untagged (D-05, Pitfall 4).
    deactivate = false;
    tag = null;
  }

  return { deactivate, tag, isReview: tag?.startsWith('review') ?? false };
}

/**
 * Apply a StatusOutcome to the text of an emitted `.check.ts` source file.
 *
 * This is the pure extraction of step 10a's `deactivateCheckFile` string
 * mutation (the STAT-04 seam): it mutates the already-emitted check source,
 * whose tags already passed through `filterAndRemapTags` in step 04, so the
 * appended tag lands AFTER user tag filtering and cannot be stripped by
 * DD_TAGS_EXCLUDE/DD_TAGS_REMAP (D-12).
 *
 * Behavior:
 * - `outcome.tag === null` -> return source unchanged.
 * - source already contains `outcome.tag` -> return unchanged (per-tag idempotency;
 *   no cross-tag reconciliation, D-11/Pitfall 2 - stale mistags are remedied by a full regen).
 * - the `activated: true` -> `activated: false` flip runs ONLY when `outcome.deactivate`
 *   is true (D-08/Pitfall 3 - the review-active case must never touch `activated`).
 * - the tag is appended to the `tags: [...]` array using the existing 10a idiom.
 * - a diagnostic comment is inserted after the `Migrated from Datadog Synthetic:` line,
 *   with copy that branches on the outcome (deactivation vs review).
 *
 * @param source - The emitted `.check.ts` source text.
 * @param outcome - The outcome from `classifyStatus`.
 * @returns The transformed source (or the original source when no change applies).
 */
export function applyOutcomeToSource(source: string, outcome: StatusOutcome): string {
  if (outcome.tag === null) {
    return source;
  }

  // Per-tag idempotency: skip if this exact tag is already present.
  if (source.includes(outcome.tag)) {
    return source;
  }

  let newContent = source;

  // Gate the activation flip behind outcome.deactivate (D-08): the review-active
  // case must never flip a live check off. Only change `activated: true`.
  if (outcome.deactivate) {
    newContent = newContent.replace(/activated:\s*true/, 'activated: false');
  }

  // Append the tag to the tags array (same idiom as 10a's deactivateCheckFile).
  const tagsPattern = /tags:\s*\[([^\]]*)\]/;
  const tagsMatch = newContent.match(tagsPattern);
  if (tagsMatch) {
    const existingTags = tagsMatch[1].trim();
    const newTags = existingTags === ''
      ? `tags: ["${outcome.tag}"]`
      : `tags: [${existingTags}, "${outcome.tag}"]`;
    newContent = newContent.replace(tagsPattern, newTags);
  }

  // Insert a diagnostic comment after the "Migrated from Datadog Synthetic:" line.
  // All generators emit this as a JSDoc continuation ( * Migrated ...); also
  // tolerate a // style line. The comment copy branches on the outcome.
  const commentBody = outcome.deactivate
    ? `Deactivated: ${deactivationReason(outcome.tag)}`
    : 'Review: live in Datadog but monitor/search reported No Data; left active. Verify recent run health in Datadog.';

  const jsdocPattern = /^([ \t]*)\*(\s*Migrated from Datadog Synthetic:.*)$/m;
  const slashPattern = /(\/\/\s*Migrated from Datadog Synthetic:.*)/;
  if (jsdocPattern.test(newContent)) {
    newContent = newContent.replace(jsdocPattern, `$1*$2\n$1* ${commentBody}`);
  } else if (slashPattern.test(newContent)) {
    newContent = newContent.replace(slashPattern, `$1\n// ${commentBody}`);
  }

  return newContent;
}

/**
 * Derive the human-readable deactivation reason from the outcome tag.
 * Kept internal (not exported) so the module surface stays the two pure
 * transforms plus the StatusOutcome type.
 */
function deactivationReason(tag: string): string {
  if (tag === 'failingInDatadog') {
    return 'This test was failing (Alert) in Datadog at migration time';
  }
  if (tag === 'reviewNoDataInDatadog') {
    return 'This test reported No Data with absent/unknown config status in Datadog at migration time; verify in Datadog';
  }
  return 'This test had no data (paused/not running) in Datadog at migration time';
}
