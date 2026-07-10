/**
 * The MIGRATION-FLAG cross-phase contract (FLAG-01; D-01, D-02, D-03).
 *
 * When the browser generator cannot deterministically close a gap, it fires a
 * structured, greppable flag at the exact generation site instead of the old
 * ad-hoc free-text comment convention. A flag surfaces in three coordinated
 * places (D-03):
 *   1. an aggregated JSON artifact (exports/migration-flags.json) written by
 *      step 07 (plan 07-02),
 *   2. a step-12 report section grouped by reason code (plan 07-03),
 *   3. a loud inline `// MIGRATION-FLAG:` marker in the generated .spec.ts at the
 *      exact site, with the original Datadog step preserved as an adjacent
 *      comment so whoever triages sees what Datadog intended in-context.
 *
 * This module is the one canonical seam (D-02): a single FlagCollector.emitFlag
 * call both accumulates the record for surfaces 1 and 2 and returns the inline
 * marker text for surface 3. It is a pure, filesystem-free shared module: it
 * holds no top-level mutable state, resolves no paths, and performs no I/O.
 * Serializing the aggregate is plan 07-02's job; rendering the report is plan
 * 07-03's.
 *
 * Extension protocol (D-01): Phases 8 (LOC-06/LOC-08), 9 (SEC-03), and 10
 * (PWCS-03) append new reason codes to FLAG_REASONS and update the contract test
 * (tool-tests/generation/migration-flags.test.ts) in the same change. They never
 * invent ad-hoc strings. The closed, extensible union is what prevents
 * cross-phase reason-code drift.
 */

import { escapeString } from './utils.ts';

/**
 * The locked reason-code vocabulary (D-01), as a readonly as-const tuple.
 *
 * jiti performs no typechecking, so this runtime tuple, not the derived type, is
 * what makes the union offline-testable and runtime-enforceable in emitFlag. It
 * is the single source of truth for FlagReason.
 *
 * The order is locked; later phases append (never reorder) and update the
 * contract test in the same change.
 */
export const FLAG_REASONS = [
  'locator-unresolvable', // FLAG-04: extractLocator produced zero candidates; carries deactivates (D-05)
  'unconvertible-locator', // FLAG-05: resolved locator is recording residue (object-Object text, SVG geometry, hashed-class-only)
  'xpath-positional', // FLAG-05: only absolute or positional XPath available, no stable signal
  'zero-assertion', // FLAG-05: spec-level, generated spec contains no expect call; stepIndex is null
  'wait-value-invalid', // GEN-01: wait value missing, non-numeric, or out of range
  'key-unmapped', // GEN-02: Datadog key name has no Playwright KeyboardEvent.key mapping
  'unsupported-step-type', // FLAG-01: structured replacement for the free-text unsupported-step comment convention
  'weak-fallback-chain', // LOC-06/FLAG-05: the seeded string exists from Phase 7; Phase 8 plan 08-03 wires its first emit site
  'secret-value-required', // SEC-03: wired by Phase 9 at generateTypeText; routed type="password" secrets need post-migration population before the check can run
  'shadow-dom-locator', // LOC-06/FLAG-05: a step's multiLocator carries a nested sd (shadow-DOM) locator; the top-level chain IS emitted and user-facing (role/text/testId) plus CSS rungs pierce open shadow roots automatically at runtime, while XPath rungs and closed shadow roots cannot be pierced by any Playwright locator, which this flag surfaces (message corrected by Phase 9.5 FID-06). Emitted by plan 08-03.
  'negative-assertion-degraded', // LOC-08/D-05: a negative element assertion had multiple candidates and was pinned to the highest-priority candidate only (primary-only pin seam, settled by Phase 9.5 FID-08; emitted by plan 08-05)
  'assertion-operator-unknown', // LOC-08/Phase 9 seam: an assertElementContent check value has no implemented matcher in the Phase 8 emitter; the full operator map is Phase 9 (ASRT-01), so the gap is surfaced instead of silently emitting a possibly inverted assertion
  'date-token-unknown', // ASRT-04/D-08: a Datadog date() pattern contains a moment token outside the implemented table; the token is rendered literally and the date output will not match Datadog until adjusted
  'possible-plaintext-secret', // D-10 advisory: a non-password field's identifying attributes look secret-like; surfaced for review, never auto-routed (low severity is conveyed by this reason code and message wording, not a schema field)
  'user-locator-pin-unresolvable', // FID-01/D-01: userLocator.failTestOnCannotLocate is true but the pinned selector could not be derived into a candidate; the self-healing chain was emitted instead, so this step will not reproduce Datadog's fail-on-pin-miss authority until the pin is reviewed
  'pwcs-device-unmapped', // PWCS-03: a device_ids entry has no Playwright engine mapping and is ignored for browser routing
  'pwcs-engines-deduped', // PWCS-03/D-04: Datadog declared more browser device profiles than distinct Playwright engines; the reduction is surfaced, never silent
  'pwcs-private-location-agent-version', // PWCS-03/D-07: a multi-browser suite routed to a private location needs Checkly Agent 6.0.3 or newer, unknowable from the export; non-deactivating
] as const;

/**
 * The closed, extensible reason-code union (D-01).
 *
 * Derived from the as-const tuple so there is one source of truth: type-safe in
 * editors, raw literals greppable in code and JSON, and runtime-enforceable via
 * FLAG_REASONS because this repo has no tsc gate.
 */
export type FlagReason = (typeof FLAG_REASONS)[number];

/**
 * A single migration flag record (D-02, minimal shape).
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
   * rendered verbatim by the step-12 report. Contract (T-07-02): never place
   * secret VALUES in a message; reference variable or field names only.
   */
  message: string;
  /**
   * When true, the flag's publicId joins the deactivated set so step 08 forces
   * the check to activated:false. Per D-05 only the zero-signal
   * locator-unresolvable path sets this in Phase 7; per D-06 degraded-but-resolved
   * candidates stay active and are merely flagged.
   */
  deactivates?: boolean;
}

/**
 * The exports/migration-flags.json schema (D-03 flag surface 1).
 *
 * Deliberately carries no timestamp so the artifact stays byte-deterministic for
 * the golden harness and the offline suite (D-02: keep the schema minimal).
 */
export interface MigrationFlagsFile {
  /** All records in emission order. */
  flags: MigrationFlag[];
  /**
   * Deduplicated publicIds in first-emission order; plan 07-04 reads this to
   * append the reviewMigrationFlag tag (D-04).
   */
  flaggedCheckIds: string[];
  /**
   * Deduplicated publicIds of deactivating flags; plan 07-04 reads this to force
   * activated:false (D-05).
   */
  deactivatedCheckIds: string[];
}

/**
 * Render the loud inline marker for a flag (D-03 flag surface 3). Pure, no state.
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
 * and become live code in the generated spec (T-07-01). Callers pass RAW text and
 * never pre-escape, making this the single escaping choke point with no
 * double-escape drift.
 *
 * The separator between the site and the message is a colon plus one space, not a
 * dash: the repo forbids the U+2014 character in human-facing output (a deliberate
 * deviation from the 07-RESEARCH.md Pattern 2 sample).
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
 * Per-run flag accumulator (D-02 one canonical seam).
 *
 * Instantiated once per step-07 run and threaded by reference through the
 * generator call tree (plan 07-02), never held as module-global state: all
 * accumulation lives on the instance, following the same threading discipline as
 * the existing usedVarNames parameter in src/07.
 */
export class FlagCollector {
  /** All emitted records in emission order. */
  readonly flags: MigrationFlag[] = [];

  /** publicIds of deactivating flags, deduplicated by Set semantics. */
  private readonly deactivated = new Set<string>();

  /**
   * The single seam (D-02): records the raw flag and returns its inline marker.
   *
   * Throws a descriptive Error when flag.reason is not a member of FLAG_REASONS
   * (runtime enforcement of the D-01 closed union, since this repo has no tsc
   * gate), then pushes the raw record, tracks the publicId for deactivation when
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
   * Assemble the plain-JSON MigrationFlagsFile that plan 07-02 serializes with
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
