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
 * Lower-bound rationale (geometry-calibrated, device testing pending):
 *   A standard iPhone main camera (~77° diagonal FOV, 4:3 sensor portrait)
 *   at 210 mm (backend nominal) produces framePct ≈ 43%. The natural
 *   "paper-fills-frame" hold distance is 219–226 mm → framePct ≈ 39–41%,
 *   right at the former 40% boundary. Pilot data confirmed this: 16/59
 *   photos landed at 37–39% (p25 = 39%). Setting 35% (↔ D ≈ 256 mm)
 *   accepts the real natural hold distance and provides a comfortable
 *   margin above 210 mm while still blocking genuinely too-far captures.
 *   TUNE-ME once device-test framePct readings confirm the hold distance.
 *
 * Upper bound: 70% ↔ D ≈ 128 mm — legitimately too close. TUNE-ME.
 */
export const TARGET_FRAME_PCT_MIN = 35; // TUNE-ME — calibrated from pilot geometry
export const TARGET_FRAME_PCT_MAX = 70; // TUNE-ME

/**
 * Prompt thresholds — must stay equal to TARGET_FRAME_PCT_MIN/MAX.
 *
 * These used to carry a 10% deadband (30 / 80) on the theory that a buffer
 * between "target" and "warn" would prevent the guidance pill from oscillating
 * near the boundary. That role is now filled by the 2-frame hysteresis in
 * LiveCaptureView's handleDetection callback: the same new issue must appear
 * in two consecutive ~4Hz frames before the committed guidance state changes.
 * The hysteresis is the right place for boundary stability — the deadband was
 * a second, redundant mechanism that happened to let captures through at
 * distances outside the validated range (e.g. framePct = 75% passed 'ok'
 * even though TARGET_FRAME_PCT_MAX = 70).
 *
 * With the deadband removed, guidance.level === 'ok' ↔ framePct ∈ [35, 70],
 * which is the device-calibrated measurement range. Captures outside that
 * range are blocked by the captureReady gate.
 */
export const FAR_PROMPT_BELOW = 35; // must equal TARGET_FRAME_PCT_MIN
export const CLOSE_PROMPT_ABOVE = 70; // must equal TARGET_FRAME_PCT_MAX

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
// Curl-shot thresholds
// ---------------------------------------------------------------------------

/**
 * In a curl (end-on) shot the user points the camera at the fingertip. The
 * reference card is in frame for scale but naturally appears much smaller
 * than it does in a planar (palm-up) shot — the card is at a greater
 * effective angle and often further from the camera's optical axis.
 *
 * Consequence: the planar framePct thresholds (30–80%) are wrong for curl
 * shots and will almost always fire "move closer" or "move back" when the
 * user is actually positioned correctly. The curl guidance uses a different,
 * much wider acceptance band.
 *
 * Additionally: in a curl shot "hold the phone flat" is meaningless because
 * the camera must be tilted toward the fingertip, so the tilt check is
 * suppressed entirely. Off-paper is also irrelevant — the card in a curl
 * setup is not necessarily on paper and the surround-mean comparison would
 * produce false positives.
 *
 * The remaining checks (no-card, off-center) still apply.
 */
export const CURL_FAR_BELOW  = 5;  // TUNE-ME — below 5% framePct: card probably not in frame
export const CURL_CLOSE_ABOVE = 95; // TUNE-ME — above 95%: card oddly dominant, probably wrong shot

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
  /**
   * True when it is safe to fire the shutter.
   *
   * This is the canonical gate for the capture button and for the
   * capturePhoto() defense-in-depth check. It is true if and only if
   * level === 'ok' (i.e. issue === null). Using a named boolean rather than
   * comparing level directly makes intent explicit and makes it impossible
   * to accidentally allow captures during the warn states that a loose
   * level-string comparison might miss.
   *
   * For palm-up shots (computeGuidance):
   *   true ↔ card on paper, centered, framePct ∈ [35 %, 70 %], tilt < 7°
   *
   * For curl shots (computeCurlGuidance):
   *   true ↔ card detected, centered, framePct ∈ (5 %, 95 %)
   *   (tilt and off-paper checks suppressed — camera must point end-on)
   */
  captureReady: boolean;
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
      captureReady: false,
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
      captureReady: false,
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
      captureReady: false,
    };
  }

  // 3. Too far. FAR_PROMPT_BELOW === TARGET_FRAME_PCT_MIN (40%) — the
  //    prompt threshold and the validated measurement range are the same
  //    boundary. The 2-frame hysteresis in handleDetection prevents
  //    flickering at this edge; no separate deadband is needed.
  if (framePct < FAR_PROMPT_BELOW) {
    return {
      level: 'warn',
      issue: 'too-far',
      message: 'Move closer',
      captureReady: false,
    };
  }

  // 4. Too close. CLOSE_PROMPT_ABOVE === TARGET_FRAME_PCT_MAX (70%).
  //    Same rationale as above: hysteresis handles the boundary; no
  //    deadband required.
  if (framePct > CLOSE_PROMPT_ABOVE) {
    return {
      level: 'warn',
      issue: 'too-close',
      message: 'Move back',
      captureReady: false,
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
      captureReady: false,
    };
  }

  // 6. All gates clear — card on paper, centered, framePct ∈ [40 %, 70 %],
  //    tilt < 7°. captureReady: true opens the shutter gate.
  return {
    level: 'ok',
    issue: null,
    message: 'Looks good — ready to capture',
    captureReady: true,
  };
}

/**
 * Compute guidance state for a curl (end-on) shot.
 *
 * The curl shot is taken pointing the camera at the fingertip to capture the
 * nail's cross-sectional arc. Guidance priorities and thresholds differ from
 * the planar shot in three ways:
 *
 *   1. framePct thresholds are much wider. The reference card appears at a
 *      much smaller fraction of the frame in an end-on setup. The old 30–80%
 *      band would almost always fire "move closer" or "move back" when the
 *      user is correctly positioned; the curl thresholds use 5–95%.
 *
 *   2. The tilt check is suppressed. Pointing the camera at the fingertip
 *      inherently tilts the phone — "hold the phone flat" would be wrong
 *      advice in this context.
 *
 *   3. The off-paper check is suppressed. Card placement against paper is
 *      a planar-shot concern; in curl framing the card may rest against a
 *      different surface and the surround-mean comparison would produce
 *      false positives.
 *
 * When the card is absent, the message prompts specifically for end-on
 * framing rather than the generic planar-shot card-placement instruction.
 */
export function computeCurlGuidance(detection: Detection | null): GuidanceState {
  if (!detection) {
    return {
      level: 'warn',
      issue: 'no-card',
      message: 'Point camera at your fingertip end-on, card visible',
      captureReady: false,
    };
  }

  const { framePct, minCornerEdgeFrac } = detection.metrics;

  // Off-center: a clipped card means we can't compute scale. Same logic
  // as the planar check — fix this before anything else.
  if (minCornerEdgeFrac < OFF_CENTER_THRESHOLD) {
    return {
      level: 'warn',
      issue: 'off-center',
      message: 'Center the card in frame',
      captureReady: false,
    };
  }

  // Distance: only fire at the extreme ends. In curl framing the card
  // legitimately occupies 5–90% of frame width depending on distance
  // and angle; only the degenerate extremes are worth prompting.
  if (framePct < CURL_FAR_BELOW) {
    return {
      level: 'warn',
      issue: 'too-far',
      message: 'Move card closer so it fills more of the frame',
      captureReady: false,
    };
  }
  if (framePct > CURL_CLOSE_ABOVE) {
    return {
      level: 'warn',
      issue: 'too-close',
      message: 'Move back slightly',
      captureReady: false,
    };
  }

  // Tilt and off-paper checks intentionally omitted — see doc comment.

  return {
    level: 'ok',
    issue: null,
    message: 'Looks good — hold still to capture',
    captureReady: true,
  };
}
