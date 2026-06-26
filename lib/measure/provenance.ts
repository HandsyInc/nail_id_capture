/**
 * lib/measure/provenance.ts
 *
 * Shared measurement provenance types for all founder-assisted geometry
 * measurements in the Geometry Package.
 *
 * ── Design intent ────────────────────────────────────────────────────────────
 *
 * Every measurement accepted by a founder stores two things alongside the
 * accepted value:
 *
 *   1. computerProposal  — what the algorithm proposed (null if not run)
 *   2. founderValue      — what the founder accepted
 *
 * The gap between them is the correction signal. Over time, the corpus of
 * (computerProposal, founderValue) pairs across all sessions becomes gold-
 * standard labeled training data for automating each measurement type.
 *
 * ── Measurement types and their provenance shape ─────────────────────────────
 *
 *   Measurement     T                        Computer's role
 *   ─────────────── ──────────────────────── ──────────────────────────────────
 *   Chord width     number (width_mm)        SAM2 contour → width_mm
 *   IC apex         Point (px)               Gradient bisector → apex Point
 *   W(z) sidewall   Point (px)               Not yet implemented
 *   h/L apex        Point (px)               Not yet implemented
 *   AP%             number (ratio)           Not yet implemented
 *
 * For chord the founder cannot override the number — they can only retry with
 * a new click. The correction signal is therefore attemptCount (how many
 * service calls before acceptance) rather than a value delta.
 *
 * For landmark measurements (IC apex, future h/L) the founder can accept or
 * reposition; correctionMagnitude is the Euclidean distance in natural px.
 *
 * ── Extending this schema ────────────────────────────────────────────────────
 *
 *   • Add new MeasurementMethod entries as new detectors are built.
 *   • For multi-point measurements (e.g. h/L needs three points), use
 *     T = { p1: Point; apex: Point; p2: Point } or similar.
 *   • If a new measurement type needs domain-specific diagnostics beyond
 *     score/confidence, put them in ComputerProposal.extra (free-form JSONB).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Core types
// ─────────────────────────────────────────────────────────────────────────────

export type Point = { x: number; y: number };

export type DetectionConfidence = 'high' | 'low';

/**
 * The algorithm's proposed measurement value, together with quality metadata.
 * T is the domain value type (number, Point, etc.).
 */
export type ComputerProposal<T> = {
  /** The proposed measurement value in domain units. */
  value:      T;
  /**
   * Confidence classification for this proposal.
   * 'high'  — passes all anatomical plausibility gates; accept with minimal review.
   * 'low'   — plausible but below the quality threshold; founder should verify.
   */
  confidence: DetectionConfidence;
  /**
   * Raw detection score from the algorithm (gradient magnitude, SAM2 mask
   * score, edge contrast, etc.). Domain-specific. Null when not applicable.
   */
  score:      number | null;
  /**
   * Identifies the algorithm that produced this proposal.
   * Use a value from MeasurementMethod. This is the key field for analysing
   * which algorithms produce more accurate proposals.
   */
  method:     MeasurementMethod;
  /**
   * Domain-specific additional diagnostics (free-form JSONB).
   * Use for measurements that carry extra metadata beyond score/confidence.
   * Examples:
   *   IC apex:   { arcScore: 0.123 }
   *   Chord:     { mrrWidthPx: 142.3, depthCorrectionFactor: 0.9987 }
   */
  extra?:     Record<string, unknown>;
};

/**
 * Full provenance record for one accepted measurement.
 *
 * Stored alongside the accepted value in every Geometry Package record.
 * Designed to be generic across all measurement types.
 */
export type MeasurementProvenance<T> = {
  /**
   * The computer's proposal for the accepted attempt.
   * Null when:
   *   - Auto-detection was not run (purely manual measurement).
   *   - Detection produced no candidate (gradient below threshold, etc.).
   *   - Canvas was unavailable (SecurityError, not-yet-loaded, etc.).
   */
  computerProposal:    ComputerProposal<T> | null;

  /**
   * The value the founder accepted.
   * For landmark measurements: the founder's placed or accepted Point.
   * For scalar measurements: the algorithm's output value (the founder
   *   cannot numerically override, so this equals computerProposal.value
   *   on the accepted attempt).
   */
  founderValue:        T;

  /**
   * True when the founder accepted the computer's proposal without
   * modification.
   *
   * For landmark measurements (IC apex, future h/L): the founder clicked
   *   "Accept" rather than repositioning. True even if the founder had a
   *   low-confidence proposal they chose to accept.
   *
   * For scalar measurements (chord width): the founder accepted the first
   *   service result (attemptCount === 1). False if they retried.
   *
   * Null when computerProposal is null (no proposal to accept or reject).
   */
  acceptedProposal:    boolean | null;

  /**
   * Scalar magnitude of the founder's correction.
   *
   * For landmark measurements: Euclidean distance in natural image px
   *   between computerProposal.value (Point) and founderValue (Point).
   *   Zero when acceptedProposal is true.
   *
   * For scalar measurements: |founderValue − computerProposal.value|.
   *   For chord this is always 0 on the accepted attempt (the founder
   *   can't override the number); the correction signal is in attemptCount.
   *
   * Null when computerProposal is null.
   */
  correctionMagnitude: number | null;

  /**
   * How many measurement attempts were made before this one was accepted.
   * 1 = first try. > 1 = founder retried (rejected earlier proposals).
   *
   * This is the primary correction signal for scalar measurements where the
   * founder cannot override the value directly (e.g. chord width: a retry
   * means the founder rejected the previous service result by re-clicking).
   *
   * Null when not tracked (older records, or the UI doesn't yet accumulate
   * attempt history).
   */
  attemptCount:        number | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Method registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical algorithm identifiers.
 *
 * Add a new value here whenever a new computer-assisted detection method is
 * introduced. The string value is stored verbatim in JSONB, so treat existing
 * values as stable identifiers — rename by adding a new value, not by changing
 * the old one.
 */
export type MeasurementMethod =
  // ── Chord width (top-down) ──────────────────────────────────────────────
  /** SAM2 segmentation → minimum rotated rectangle → width_mm via H matrix. */
  | 'SAM2_CONTOUR'

  // ── IC / transverse arc ──────────────────────────────────────────────────
  /**
   * Sobel gradient search along the perpendicular bisector of the chord.
   * Averages across 5 parallel scan lines for noise robustness.
   * Introduced: D4.9.
   */
  | 'PERP_BISECTOR_GRADIENT'

  // ── W(z) station widths ──────────────────────────────────────────────────
  /**
   * Future: automatic sidewall detection at each z-station.
   * Not yet implemented — reserved so records from future detectors
   * are identifiable even if reviewed alongside older manual records.
   */
  | 'STATION_EDGE_DETECT'

  // ── Longitudinal (h/L, AP%) ───────────────────────────────────────────────
  /**
   * Future: side-profile contour detection for nail height h and plate
   * length L. Not yet implemented.
   */
  | 'LONGITUDINAL_CONTOUR'

  /**
   * Purely founder-placed landmark. No computer proposal. Stored as the
   * method when a measurement is 100% manual so records are unambiguous.
   */
  | 'MANUAL';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the correctionMagnitude for a Point-typed measurement.
 * Returns 0 if acceptedProposal is true, Euclidean px distance otherwise.
 * Returns null when there is no computer proposal.
 */
export function pointCorrectionMagnitude(
  computerProposal: ComputerProposal<Point> | null,
  founderValue:     Point,
): number | null {
  if (!computerProposal) return null;
  return Math.hypot(
    founderValue.x - computerProposal.value.x,
    founderValue.y - computerProposal.value.y,
  );
}

/**
 * Compute the correctionMagnitude for a scalar (number) measurement.
 * Returns null when there is no computer proposal.
 */
export function scalarCorrectionMagnitude(
  computerProposal: ComputerProposal<number> | null,
  founderValue:     number,
): number | null {
  if (!computerProposal) return null;
  return Math.abs(founderValue - computerProposal.value);
}

/**
 * Build a MeasurementProvenance for a Point landmark (e.g. IC apex, future
 * h/L apex).
 *
 * @param proposal     - computer's proposal, or null if detection failed/skipped
 * @param founderValue - the Point the founder accepted
 * @param accepted     - whether the founder accepted the proposal without clicking
 * @param attemptCount - how many placements before acceptance; null if not tracked
 */
export function buildPointProvenance(
  proposal:     ComputerProposal<Point> | null,
  founderValue: Point,
  accepted:     boolean,
  attemptCount: number | null,
): MeasurementProvenance<Point> {
  return {
    computerProposal:    proposal,
    founderValue,
    acceptedProposal:    proposal ? accepted : null,
    correctionMagnitude: accepted ? 0 : pointCorrectionMagnitude(proposal, founderValue),
    attemptCount,
  };
}

/**
 * Build a MeasurementProvenance for a scalar measurement (e.g. chord width_mm).
 *
 * For scalar measurements the founder cannot numerically override the computer's
 * output — they can only accept or retry with a new seed click. Therefore:
 *   - founderValue === computerProposal.value (on the accepted attempt)
 *   - acceptedProposal = (attemptCount === 1) — first try counts as "accepted"
 *   - correctionMagnitude = 0
 *
 * @param proposal     - computer's proposal for the accepted attempt
 * @param founderValue - the accepted scalar value (equals proposal.value)
 * @param attemptCount - total attempts before acceptance; null if not tracked
 */
export function buildScalarProvenance(
  proposal:     ComputerProposal<number> | null,
  founderValue: number,
  attemptCount: number | null,
): MeasurementProvenance<number> {
  const firstTry = attemptCount === 1;
  return {
    computerProposal:    proposal,
    founderValue,
    // acceptedProposal for scalar: true only when first attempt was accepted.
    // If founder retried, they rejected earlier proposals (those are lost for
    // now; attemptCount records the fact).
    acceptedProposal:    proposal ? firstTry : null,
    correctionMagnitude: proposal ? 0 : null,
    attemptCount,
  };
}
