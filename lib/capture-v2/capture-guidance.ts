/**
 * Capture guidance — turn a Detection's geometry into a single prompt.
 *
 * Inputs are dimensionless metrics already computed by the detector
 * (framePct, minCornerEdgeFrac, perspectiveSkew). This module's only job
 * is to apply thresholds, pick the highest-priority issue, and return a
 * short user-facing message.
 *
 * Why a single primary issue?
 * ---------------------------
 * A user holding a too-far, off-center, tilted card has three things to
 * fix. Surfacing all three at once is overwhelming and ambiguous about
 * what to do first. Surfacing one — the most actionable — gives clear
 * direction. When the user fixes it, the next-highest issue surfaces.
 *
 * Priority order rationale:
 *   1. no-card     — without a detection there's nothing else to guide on.
 *   2. off-paper   — when one edge of the detected quad isn't bordered by
 *                    paper, the quad probably includes some of the darker
 *                    surrounding surface (desk, wood) and isn't actually
 *                    the card's edges. Everything downstream
 *                    (centering, distance, tilt) assumes the quad IS the
 *                    card, so this needs to be fixed first.
 *   3. off-center  — a card near the edge will clip out of frame before
 *                    the user finishes adjusting other things; fix it first.
 *   4. too-far     — at small sizes the perspective-skew measurement is
 *                    noisy. Get the card to a reasonable size before
 *                    asking the user to flatten.
 *   5. too-close   — same reason as too-far (and a too-close card may also
 *                    be partially clipped, so this rarely fires on its own).
 *   6. tilted      — only meaningful when the card is well-positioned.
 *   7. (null)      — ready.
 *
 * Thresholds tagged TUNE-ME are first-pass guesses. They will be
 * adjusted during device testing once we see real distributions of these
 * metrics from the live overlay. Don't treat them as load-bearing.
 */

import type { Detection } from './card-detector';

// ---------------------------------------------------------------------------
// Thresholds  (TUNE-ME after first device-test pass)
// ---------------------------------------------------------------------------

/**
 * The target band for `framePct`. Inside this band, distance is "good".
 * Outside, we prompt the user to move.
 *
 * Initial values: the pilot dataset's frame_width_pct distribution centered
 * around 40–65%. We pick a slightly tighter inner band so the guidance
 * nudges users toward the sweet spot of that distribution rather than
 * accepting anything that happened to occur in pilot.
 */
export const TARGET_FRAME_PCT_MIN = 40; // TUNE-ME
export const TARGET_FRAME_PCT_MAX = 70; // TUNE-ME

/**
 * Asymmetric deadband on each side of the target. We only fire the prompt
 * once the user is meaningfully outside the band, not the moment they
 * cross the target boundary — otherwise the prompt would oscillate as
 * the user hovers near the edge.
 */
export const FAR_PROMPT_BELOW = 30; // TUNE-ME — below this %, say "move closer"
export const CLOSE_PROMPT_ABOVE = 80; // TUNE-ME — above this %, say "move back"

/**
 * Off-center threshold. If the closest corner gets within this fraction
 * of the image short side from any edge, we prompt to recenter. 0.05 =
 * 5% of the short side; for a 1080-wide preview that's ~54px of safety
 * margin before the card actually clips.
 */
export const OFF_CENTER_THRESHOLD = 0.05; // TUNE-ME

/**
 * Tilt threshold. Perspective skew above this fraction triggers the
 * flatten-phone prompt.
 *
 * What the number actually means
 * ------------------------------
 * For a card of long edge L viewed from camera-to-card distance D, a tilt
 * of angle θ around the card's short axis (the direction that produces
 * the most measurable skew per degree) yields
 *
 *     perspectiveSkew ≈ (L / D) · sin(θ)
 *
 * At the user's current nominal D = 210mm and L = 85.6mm (ISO/IEC 7810
 * ID-1), that gives:
 *
 *     skew = 0.10 → θ ≈ 14°     ← previous threshold; "extremely tilted"
 *     skew = 0.07 → θ ≈ 10°
 *     skew = 0.05 → θ ≈ 7°      ← current threshold
 *     skew = 0.04 → θ ≈ 5.5°
 *     skew = 0.03 → θ ≈ 4°      ← approaching the corner-detection noise floor
 *
 * iPhone testing reported 0.10 only fired on "extremely tilted" phones
 * and accepted angles that "still felt risky". Dropping to 0.05 means we
 * warn around 7° of tilt in the worst-case direction. A 7° tilt produces
 * roughly 5% pixel-size disparity across the card surface — measurements
 * taken at different points on the card would disagree by ~5%, which is
 * the right ballpark to start nudging the user toward flat.
 *
 * Noise floor: corner-detection slop is on the order of 2–3 px out of a
 * ~700px card edge in detection-space, so pure-jitter perspectiveSkew
 * sits around 0.01. A 0.05 threshold is 5× the noise floor — robustly
 * distinguishable, comfortably above false-firing-on-jitter. If we want
 * stricter, 0.04 is still safe; 0.03 starts to risk noise-triggered
 * prompts on otherwise-flat captures.
 */
export const TILT_THRESHOLD = 0.05; // TUNE-ME

/**
 * Off-paper detection uses TWO thresholds together: an absolute "this
 * edge is dark" floor and a relative "this edge is much darker than the
 * other edges" spread. iPhone testing showed that either signal alone
 * false-positives on perfectly fine on-paper captures:
 *
 *   - minSurroundMean alone (the previous rule): a hand or phone bezel
 *     casting a shadow over one edge drops min below ~180 even with the
 *     card fully on paper. The prompt fired constantly.
 *   - edgeSurroundSpread alone: direct light on one edge and shadow on
 *     another can produce a spread of 50–80 on uniform paper (one edge
 *     ~250, another ~180). The prompt would fire on a well-positioned
 *     card whenever the lighting wasn't perfectly flat.
 *
 * Requiring both filters those out: a shadowed-paper edge has low min
 * but also similar values on the other edges (small spread); a glare-vs-
 * shadow pattern has high spread but the min still stays above ~180
 * because shadowed paper isn't as dark as wood/desk. True off-paper
 * (one edge resting on wood) trips both at once.
 *
 * The user explicitly asked us to err toward false negatives ("if
 * uncertain, avoid false positives"), so both thresholds are sized to
 * be conservative — if they prove too tight we'll loosen them on the
 * next pass.
 */
export const OFF_PAPER_MIN_THRESHOLD = 170; // TUNE-ME — gray-units floor for darkest edge
export const OFF_PAPER_SPREAD_THRESHOLD = 50; // TUNE-ME — gray-units gap min→max

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GuidanceLevel = 'ok' | 'warn';

export type GuidanceIssue =
  | 'no-card'
  | 'card-off-paper'
  | 'off-center'
  | 'too-far'
  | 'too-close'
  | 'tilted';

export type GuidanceState = {
  level: GuidanceLevel;
  /** null when everything's good; otherwise the primary issue to surface. */
  issue: GuidanceIssue | null;
  /** Short user-facing prompt — render this verbatim in the UI. */
  message: string;
};

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

/**
 * Compute the guidance state for a single Detection. Pure function — no
 * state, no DOM, no side effects. Hysteresis (preventing flicker between
 * states on borderline frames) lives in the caller; this function just
 * answers "given this frame's measurements, what's the right prompt?".
 */
export function computeGuidance(detection: Detection | null): GuidanceState {
  if (!detection) {
    return {
      level: 'warn',
      issue: 'no-card',
      message: 'Place the card flat on the paper',
    };
  }

  const {
    framePct,
    minCornerEdgeFrac,
    perspectiveSkew,
    minSurroundMean,
    edgeSurroundSpread,
  } = detection.metrics;

  // 1. Off paper. Fires before any geometry-assuming prompt because if
  //    the quad isn't actually the card, "center it / move closer / hold
  //    flat" are all advice about the wrong shape. Both thresholds must
  //    trip together — see OFF_PAPER_*_THRESHOLD comments above for the
  //    rationale and the failure modes each one alone has on real
  //    iPhone captures.
  if (
    minSurroundMean < OFF_PAPER_MIN_THRESHOLD &&
    edgeSurroundSpread > OFF_PAPER_SPREAD_THRESHOLD
  ) {
    return {
      level: 'warn',
      issue: 'card-off-paper',
      message: 'Place the card fully on the paper',
    };
  }

  // 2. Off-center beats the remaining issues: a clipped card can't be
  //    measured, fixed by any other adjustment, or even reliably
  //    detected next frame.
  if (minCornerEdgeFrac < OFF_CENTER_THRESHOLD) {
    return {
      level: 'warn',
      issue: 'off-center',
      message: 'Center the card',
    };
  }

  // 3. Too far. Below the warn threshold, fire the prompt.
  if (framePct < FAR_PROMPT_BELOW) {
    return {
      level: 'warn',
      issue: 'too-far',
      message: 'Move closer',
    };
  }

  // 4. Too close.
  if (framePct > CLOSE_PROMPT_ABOVE) {
    return {
      level: 'warn',
      issue: 'too-close',
      message: 'Move back',
    };
  }

  // 5. Tilt. Last, because tilt measurements at the extremes of distance
  //    are unreliable — and the prompts above will have already nudged
  //    the user toward a measurable size.
  if (perspectiveSkew > TILT_THRESHOLD) {
    return {
      level: 'warn',
      issue: 'tilted',
      message: 'Hold the phone flat',
    };
  }

  // 6. All gates clear — card on paper, well-positioned, well-sized,
  //    flat. Note that framePct may still be between TARGET_*_MIN/MAX and
  //    the warn thresholds — that's the intentional deadband. The user
  //    gets a green pill there even though they're not at the exact
  //    center of the target; the asymmetric thresholds are what keeps
  //    the pill from flickering as they move.
  return {
    level: 'ok',
    issue: null,
    message: 'Looks good — ready to capture',
  };
}
