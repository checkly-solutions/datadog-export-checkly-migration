/**
 * The MIGRATION-FLAG cross-phase contract.
 *
 * When the browser generator cannot deterministically close a gap, it fires a
 * structured, greppable flag at the exact generation site instead of an ad-hoc
 * free-text comment. A flag surfaces in three coordinated places:
 *   1. an aggregated JSON artifact (exports/migration-flags.json) written by
 *      step 07,
 *   2. a step-12 report section grouped by reason code,
 *   3. a loud inline `// MIGRATION-FLAG:` marker in the generated .spec.ts at the
 *      exact site, with the original Datadog step preserved as an adjacent
 *      comment so whoever triages sees what Datadog intended in-context.
 *
 * This module is the one canonical seam: a single FlagCollector.emitFlag call both
 * accumulates the record for surfaces 1 and 2 and returns the inline marker text for
 * surface 3. It is a pure, filesystem-free shared module: it holds no top-level
 * mutable state, resolves no paths, and performs no I/O. Serializing the aggregate is
 * step 07's job; rendering the report is step 12's.
 *
 * Extension protocol: new reason codes are appended (never reordered) to FLAG_REASONS
 * and the contract test (tool-tests/generation/migration-flags.test.ts) is updated in
 * the same change. Ad-hoc strings are never invented. The closed, extensible union is
 * what prevents reason-code drift.
 */

import { escapeString } from './utils.ts';

/**
 * The locked reason-code vocabulary, as a readonly as-const tuple.
 *
 * jiti performs no typechecking, so this runtime tuple, not the derived type, is
 * what makes the union offline-testable and runtime-enforceable in emitFlag. It
 * is the single source of truth for FlagReason.
 *
 * The order is locked; new codes are appended (never reordered) and the contract
 * test is updated in the same change.
 */
export const FLAG_REASONS = [
  'locator-unresolvable', // extractLocator produced zero candidates; carries deactivates
  'unconvertible-locator', // resolved locator is recording residue (object-Object text, SVG geometry, hashed-class-only)
  'xpath-positional', // only absolute or positional XPath available, no stable signal
  'zero-assertion', // spec-level, generated spec contains no expect call; stepIndex is null
  'wait-value-invalid', // wait value missing, non-numeric, or out of range
  'key-unmapped', // Datadog key name has no Playwright KeyboardEvent.key mapping
  'unsupported-step-type', // structured replacement for a free-text unsupported-step comment
  'weak-fallback-chain', // the emitted firstMatch chain is led by a best-effort selector rung
  'secret-value-required', // routed type="password" secrets need post-migration population before the check can run
  'shadow-dom-locator', // a step's multiLocator carries a nested sd (shadow-DOM) locator; the top-level chain IS emitted and user-facing (role/text/testId) plus CSS rungs pierce open shadow roots automatically at runtime, while XPath rungs and closed shadow roots cannot be pierced by any Playwright locator, which this flag surfaces
  'negative-assertion-degraded', // a negative element assertion had multiple candidates and was pinned to the highest-priority candidate only
  'assertion-operator-unknown', // an assertElementContent check value has no implemented matcher, so the gap is surfaced instead of silently emitting a possibly inverted assertion
  'date-token-unknown', // a Datadog date() pattern contains a moment token outside the implemented table; the token is rendered literally and the date output will not match Datadog until adjusted
  'possible-plaintext-secret', // a non-password field's identifying attributes look secret-like; surfaced for review, never auto-routed (low severity is conveyed by this reason code and message wording, not a schema field)
  'user-locator-pin-unresolvable', // userLocator.failTestOnCannotLocate is true but the pinned selector could not be derived into a candidate; the self-healing chain was emitted instead, so this step will not reproduce Datadog's fail-on-pin-miss authority until the pin is reviewed
  'pwcs-device-unmapped', // a device_ids entry has no Playwright engine mapping and is ignored for browser routing
  'pwcs-engines-deduped', // Datadog declared more browser device profiles than distinct Playwright engines; the reduction is surfaced, never silent
  'pwcs-private-location-agent-version', // a multi-browser suite routed to a private location needs Checkly Agent 6.0.3 or newer, unknowable from the export; non-deactivating
] as const;

/**
 * The closed, extensible reason-code union.
 *
 * Derived from the as-const tuple so there is one source of truth: type-safe in
 * editors, raw literals greppable in code and JSON, and runtime-enforceable via
 * FLAG_REASONS because this repo has no tsc gate.
 */
export type FlagReason = (typeof FLAG_REASONS)[number];

/**
 * A single migration flag record (minimal shape).
 */
export interface MigrationFlag {
  /** The structured reason code; runtime-checked against FLAG_REASONS in emitFlag. */
  reason: FlagReason;
  /** The affected check's Datadog public_id (the migration_check_id join key). */
  publicId: string;
  /**
   * Zero-based index of the originating Datadog step; null for spec-level flags
   * such as zero-assertion. Rendered one-based in the inline marker and report.
   */
  stepIndex: number | null;
  /**
   * Human-readable description, stored raw and unescaped in the record and
   * rendered verbatim by the step-12 report. Contract: never place secret VALUES in
   * a message; reference variable or field names only.
   */
  message: string;
  /**
   * When true, the flag's publicId joins the deactivated set so step 08 forces
   * the check to activated:false. Only the zero-signal locator-unresolvable path
   * sets this; degraded-but-resolved candidates stay active and are merely flagged.
   */
  deactivates?: boolean;
}

/**
 * The exports/migration-flags.json schema (flag surface 1).
 *
 * Deliberately carries no timestamp so the artifact stays byte-deterministic for
 * the golden harness and the offline suite (the schema is kept minimal).
 */
export interface MigrationFlagsFile {
  /** All records in emission order. */
  flags: MigrationFlag[];
  /**
   * Deduplicated publicIds in first-emission order; step 08 reads this to append the
   * reviewMigrationFlag tag.
   */
  flaggedCheckIds: string[];
  /**
   * Deduplicated publicIds of deactivating flags; step 08 reads this to force
   * activated:false.
   */
  deactivatedCheckIds: string[];
}

/**
 * Render the loud inline marker for a flag (flag surface 3). Pure, no state.
 *
 * Grammar:
 *   line 1: four spaces + `// MIGRATION-FLAG: ` + reason
 *           + (when stepIndex is strictly not null: ` (step N)` one-based)
 *           + `: ` + escapeString(message)
 *   line 2 (only when ddStepText is provided): four spaces + `// DD original: `
 *           + escapeString(ddStepText)
 * The lines join with a single newline; there is no trailing newline.
 *
 * The four-space indent matches the browser-spec body depth (the body sits two
 * closure levels deep inside test.describe(() => { test(async ({ page }) => {}) }).
 * src/07 is the only inline-marker emitter (src/08 and src/12 read the JSON
 * artifact), so four spaces is correct for every embedding.
 *
 * The strict `!== null` comparison is load-bearing: stepIndex 0 must render
 * `(step 1)`. Both message and ddStepText route through escapeString so a hostile
 * Datadog value (raw newline, backslash, quote) cannot terminate the line comment
 * and become live code in the generated spec. Callers pass RAW text and never
 * pre-escape, making this the single escaping choke point with no double-escape drift.
 *
 * The separator between the site and the message is a colon plus one space, not a
 * dash: the repo forbids the U+2014 character in human-facing output.
 *
 * @param flag - The flag to render.
 * @param ddStepText - The original Datadog step text to preserve, if any.
 * @returns The one- or two-line inline marker string.
 */
export function formatInlineMarker(flag: MigrationFlag, ddStepText?: string): string {
  const stepSuffix = flag.stepIndex !== null ? ` (step ${flag.stepIndex + 1})` : '';
  const line1 = `    // MIGRATION-FLAG: ${flag.reason}${stepSuffix}: ${escapeString(flag.message)}`;

  if (ddStepText === undefined) {
    return line1;
  }

  const line2 = `    // DD original: ${escapeString(ddStepText)}`;
  return `${line1}\n${line2}`;
}

/**
 * Per-run flag accumulator (the one canonical seam).
 *
 * Instantiated once per step-07 run and threaded by reference through the
 * generator call tree, never held as module-global state: all accumulation lives on
 * the instance, following the same threading discipline as the usedVarNames
 * parameter in src/07.
 */
export class FlagCollector {
  /** All emitted records in emission order. */
  readonly flags: MigrationFlag[] = [];

  /** publicIds of deactivating flags, deduplicated by Set semantics. */
  private readonly deactivated = new Set<string>();

  /**
   * The single seam: records the raw flag and returns its inline marker.
   *
   * Throws a descriptive Error when flag.reason is not a member of FLAG_REASONS
   * (runtime enforcement of the closed union, since this repo has no tsc gate),
   * then pushes the raw record, tracks the publicId for deactivation when
   * flag.deactivates is true, and returns formatInlineMarker(flag, ddStepText).
   * One call feeds both the JSON aggregate and the inline spec marker.
   *
   * @param flag - The flag to emit. Its message is stored raw (unescaped).
   * @param ddStepText - The original Datadog step text to preserve, if any.
   * @returns The inline marker text, identical to formatInlineMarker(flag, ddStepText).
   */
  emitFlag(flag: MigrationFlag, ddStepText?: string): string {
    if (!(FLAG_REASONS as readonly string[]).includes(flag.reason)) {
      throw new Error(
        `Unknown migration-flag reason code: "${flag.reason}". ` +
          `Add it to FLAG_REASONS in src/shared/migration-flags.ts and update the contract test.`
      );
    }

    this.flags.push(flag);
    if (flag.deactivates) {
      this.deactivated.add(flag.publicId);
    }

    return formatInlineMarker(flag, ddStepText);
  }

  /**
   * Deduplicated publicIds of all recorded flags, in first-emission order.
   */
  flaggedCheckIds(): string[] {
    return [...new Set(this.flags.map((f) => f.publicId))];
  }

  /**
   * Deduplicated publicIds of deactivating flags, in first-emission order.
   */
  deactivatedCheckIds(): string[] {
    return [...this.deactivated];
  }

  /**
   * Assemble the plain-JSON MigrationFlagsFile that step 07 serializes with
   * JSON.stringify. No Set, Map, or function leaks into the returned shape.
   */
  toFile(): MigrationFlagsFile {
    return {
      flags: this.flags,
      flaggedCheckIds: this.flaggedCheckIds(),
      deactivatedCheckIds: this.deactivatedCheckIds(),
    };
  }
}
