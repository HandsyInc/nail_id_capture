/**
 * Shot specification — the 14-capture measurement protocol.
 *
 * Architecture
 * ------------
 * The full fitting measurement set requires two distinct capture geometries:
 *
 *   Palm-up (10 shots)
 *     One per finger, one hand at a time. Camera points straight down at the
 *     nail plate. Extracts chord width W and nail length. Reference card in
 *     frame provides the scale.
 *
 *   Curl / end-on (4 shots)
 *     Camera points along the finger axis, looking at the nail's cross-section.
 *     Extracts sagitta h and, with W, the IC (infinite-radius arc) curve.
 *
 *     curl-four-finger: index/middle/ring/pinky together in one shot.
 *       These four share a common flexion axis, so all four transverse arcs
 *       can be captured in a single frame.
 *     curl-thumb: thumb alone.
 *       The thumb's carpometacarpal joint rotates it ~90° relative to the
 *       finger plane. In the four-finger curl shot the thumb nail faces
 *       sideways, not toward the camera — its transverse arc is not in the
 *       image. A dedicated thumb curl shot is required. However, the geometry
 *       for extracting the thumb's IC is architecturally unresolved (the
 *       standard sagitta extractor assumes the nail faces the camera end-on;
 *       this assumption does not hold for the thumb in all poses). Thumb curl
 *       shots are captured for future development; IC extraction is skipped.
 *       See icArchitecturePending field.
 *
 * Multi-arc detection note
 * ------------------------
 * The curl-four-finger shot is expected to yield 4 arc candidates (one per
 * finger). The ShotSpec.expectedArcCount field documents the target so
 * diagnostics can surface the gap between "expected 4" and "detected N".
 *
 * Sequence order
 * --------------
 * Palm-up shots are grouped by hand (all left then all right), thumb first
 * within each hand. Curl shots come last so the user completes the familiar
 * flat-capture flow before switching to the end-on geometry.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Hand = 'left' | 'right';

export type Finger = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';

export type ShotType =
  | 'palm-up'           // top-down per-finger width capture
  | 'curl-four-finger'  // end-on group shot: index/middle/ring/pinky IC
  | 'curl-thumb';       // end-on isolated shot: thumb (IC extraction pending)

export type ShotSpec = {
  /** Discriminates the capture geometry and expected measurements. */
  shotType: ShotType;
  hand: Hand;
  /**
   * For palm-up: the specific finger being photographed.
   * For curl-four-finger and curl-thumb: null (finger(s) are implied by
   * shotType and extractsIC).
   */
  finger: Finger | null;
  /**
   * Which fingers' IC values this shot is expected to yield.
   * Empty for palm-up (width only). Populated for curl shots.
   */
  extractsIC: readonly Finger[];
  /**
   * Number of distinct arc candidates expected from this shot.
   * 1 for palm-up and curl-thumb; 4 for curl-four-finger.
   * Documents the target so diagnostics can flag the gap between
   * "expected 4" and "detected N".
   */
  expectedArcCount: 1 | 4;
  /**
   * When true, IC extraction for this shot geometry is architecturally
   * unresolved — the capture is still taken for future development, but the
   * extraction pipeline will not attempt measurement and the UI should surface
   * a "pending" note rather than a result (or a misleading failure message).
   *
   * Currently true only for curl-thumb shots. The thumb's CMC joint rotates
   * it ~90° from the finger plane, so the camera geometry required to see the
   * thumb arc end-on is fundamentally different from the four-finger curl shot.
   * Applying the existing sagitta extractor to a thumb curl would produce
   * physically meaningless values. The correct approach requires a separate
   * pose design validated against real thumb curl captures; that work is
   * deferred to a future increment.
   */
  icArchitecturePending: boolean;
  /** Short display label for progress UI and diagnostics. */
  label: string;
  /** User-facing instruction for this capture step. */
  instruction: string;
};

// ---------------------------------------------------------------------------
// The 14-shot sequence
// ---------------------------------------------------------------------------

/**
 * Complete measurement sequence for one client session.
 * Ordered: left palm-up (5) → right palm-up (5) → left four-finger curl →
 * right four-finger curl → left thumb curl → right thumb curl.
 */
export const CAPTURE_SEQUENCE: readonly ShotSpec[] = [

  // ── Left hand — palm-up ────────────────────────────────────────────────
  {
    shotType: 'palm-up', hand: 'left', finger: 'thumb',
    extractsIC: [], expectedArcCount: 1, icArchitecturePending: false,
    label: 'Left thumb — width',
    instruction: 'Place your left thumb flat on the paper, nail facing up. Keep the reference card fully visible.',
  },
  {
    shotType: 'palm-up', hand: 'left', finger: 'index',
    extractsIC: [], expectedArcCount: 1, icArchitecturePending: false,
    label: 'Left index — width',
    instruction: 'Place your left index finger flat on the paper, nail facing up. Keep the reference card fully visible.',
  },
  {
    shotType: 'palm-up', hand: 'left', finger: 'middle',
    extractsIC: [], expectedArcCount: 1, icArchitecturePending: false,
    label: 'Left middle — width',
    instruction: 'Place your left middle finger flat on the paper, nail facing up. Keep the reference card fully visible.',
  },
  {
    shotType: 'palm-up', hand: 'left', finger: 'ring',
    extractsIC: [], expectedArcCount: 1, icArchitecturePending: false,
    label: 'Left ring — width',
    instruction: 'Place your left ring finger flat on the paper, nail facing up. Keep the reference card fully visible.',
  },
  {
    shotType: 'palm-up', hand: 'left', finger: 'pinky',
    extractsIC: [], expectedArcCount: 1, icArchitecturePending: false,
    label: 'Left pinky — width',
    instruction: 'Place your left pinky flat on the paper, nail facing up. Keep the reference card fully visible.',
  },

  // ── Right hand — palm-up ───────────────────────────────────────────────
  {
    shotType: 'palm-up', hand: 'right', finger: 'thumb',
    extractsIC: [], expectedArcCount: 1, icArchitecturePending: false,
    label: 'Right thumb — width',
    instruction: 'Place your right thumb flat on the paper, nail facing up. Keep the reference card fully visible.',
  },
  {
    shotType: 'palm-up', hand: 'right', finger: 'index',
    extractsIC: [], expectedArcCount: 1, icArchitecturePending: false,
    label: 'Right index — width',
    instruction: 'Place your right index finger flat on the paper, nail facing up. Keep the reference card fully visible.',
  },
  {
    shotType: 'palm-up', hand: 'right', finger: 'middle',
    extractsIC: [], expectedArcCount: 1, icArchitecturePending: false,
    label: 'Right middle — width',
    instruction: 'Place your right middle finger flat on the paper, nail facing up. Keep the reference card fully visible.',
  },
  {
    shotType: 'palm-up', hand: 'right', finger: 'ring',
    extractsIC: [], expectedArcCount: 1, icArchitecturePending: false,
    label: 'Right ring — width',
    instruction: 'Place your right ring finger flat on the paper, nail facing up. Keep the reference card fully visible.',
  },
  {
    shotType: 'palm-up', hand: 'right', finger: 'pinky',
    extractsIC: [], expectedArcCount: 1, icArchitecturePending: false,
    label: 'Right pinky — width',
    instruction: 'Place your right pinky flat on the paper, nail facing up. Keep the reference card fully visible.',
  },

  // ── Four-finger curl shots ──────────────────────────────────────────────
  {
    shotType: 'curl-four-finger', hand: 'left', finger: null,
    extractsIC: ['index', 'middle', 'ring', 'pinky'], expectedArcCount: 4,
    icArchitecturePending: false,
    label: 'Left — four-finger curl',
    instruction: 'Point your left index, middle, ring, and pinky toward the camera, end-on. Keep the reference card visible in frame.',
  },
  {
    shotType: 'curl-four-finger', hand: 'right', finger: null,
    extractsIC: ['index', 'middle', 'ring', 'pinky'], expectedArcCount: 4,
    icArchitecturePending: false,
    label: 'Right — four-finger curl',
    instruction: 'Point your right index, middle, ring, and pinky toward the camera, end-on. Keep the reference card visible in frame.',
  },

  // ── Thumb curl shots — IC extraction architecture pending ───────────────
  //
  // The thumb's CMC joint rotates it ~90° from the finger plane. A separate
  // capture pose is taken so the thumb arc can be developed in a future
  // increment, but no IC measurement is attempted here.
  {
    shotType: 'curl-thumb', hand: 'left', finger: null,
    extractsIC: ['thumb'], expectedArcCount: 1,
    icArchitecturePending: true,
    label: 'Left — thumb curl',
    instruction: 'Extend your left thumb toward the camera, end-on. Keep the reference card visible in frame.',
  },
  {
    shotType: 'curl-thumb', hand: 'right', finger: null,
    extractsIC: ['thumb'], expectedArcCount: 1,
    icArchitecturePending: true,
    label: 'Right — thumb curl',
    instruction: 'Extend your right thumb toward the camera, end-on. Keep the reference card visible in frame.',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True for any shot that uses end-on curl geometry. */
export function isCurlShot(spec: ShotSpec): boolean {
  return spec.shotType === 'curl-four-finger' || spec.shotType === 'curl-thumb';
}

/** Human-readable list of fingers whose IC this shot targets. */
export function icTargetLabel(spec: ShotSpec): string {
  if (spec.extractsIC.length === 0) return 'none (width only)';
  return spec.extractsIC.join(', ');
}

/** Section label for grouping shots in progress UI. */
export function sectionLabel(spec: ShotSpec): string {
  if (spec.shotType === 'palm-up') {
    return `${capitalize(spec.hand)} hand — width`;
  }
  return 'Curl shots — IC';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
