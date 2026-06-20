/**
 * shot-spec.ts
 * Shot specification — the 30-capture measurement protocol.
 *
 * Architecture
 * ------------
 * Three capture geometries, each applied once per finger across both hands
 * (30 shots total):
 *
 *   Top-down (10 shots)
 *     Camera points straight down at the nail plate. Extracts chord width W
 *     and nail length L. Reference card in frame provides scale.
 *
 *   Transverse (10 shots)
 *     Camera points along the finger axis, end-on at the nail cross-section.
 *     Extracts sagitta h and, with W, the IC curve.
 *     Thumb transverse IC extraction is architecturally unresolved — shots are
 *     captured for future development. See icArchitecturePending.
 *
 *   Longitudinal (10 shots)
 *     Camera positioned at the nail's side profile. Extracts apex height,
 *     apex position (AP%), and h/L ratio.
 *
 * Sequence order
 * --------------
 * Top-down (left then right) → transverse (left then right) →
 * longitudinal (left then right). Grouping by geometry minimises
 * repositioning between shots.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Hand = 'left' | 'right';

export type Finger = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';

export type ShotType =
  | 'top-down'      // per-finger top-down; extracts W and L
  | 'transverse'    // per-finger end-on cross-section; extracts IC
  | 'longitudinal'; // per-finger side profile; extracts AP% and h/L

export type ShotSpec = {
  /** Discriminates the capture geometry and expected measurements. */
  shotType: ShotType;
  hand: Hand;
  /** Every shot targets exactly one finger. */
  finger: Finger;

  requiresCard: boolean;

  extractsIC: readonly Finger[];
  icArchitecturePending: boolean;
  label: string;
  instruction: string;
};

// ---------------------------------------------------------------------------
// Sequence generators
// ---------------------------------------------------------------------------

const FINGERS: readonly Finger[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const HANDS: readonly Hand[]     = ['left', 'right'];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function topDownShots(): ShotSpec[] {
  return HANDS.flatMap(hand =>
    FINGERS.map(finger => ({
      shotType: 'top-down' as const,
      hand,
      finger,
      requiresCard: true,
      extractsIC: [] as const,
      icArchitecturePending: false,
      label: `${cap(hand)} ${cap(finger)} — Top Down`,
      instruction: `Place your ${hand} hand palm-up on a flat surface. Hold the camera directly above your ${finger} nail, pointing straight down. Keep the reference card in frame.`,
    }))
  );
}

function transverseShots(): ShotSpec[] {
  return HANDS.flatMap(hand =>
    FINGERS.map(finger => {
      const isThumb = finger === 'thumb';
      return {
        shotType: 'transverse' as const,
        hand,
        finger,
        requiresCard: false,
        extractsIC: isThumb ? ([] as const) : ([finger] as const),
        icArchitecturePending: isThumb,
        label: `${cap(hand)} ${cap(finger)} — Transverse`,
        instruction: isThumb
          ? `Curl your ${hand} thumb so the nail faces the camera end-on. Capture the cross-section of the nail. IC extraction is pending for thumb transverse geometry.`
          : `Curl your ${hand} ${finger} so the nail faces the camera end-on. Capture the full cross-section of the nail plate.`,
      };
    })
  );
}

function longitudinalShots(): ShotSpec[] {
  return HANDS.flatMap(hand =>
    FINGERS.map(finger => ({
      shotType: 'longitudinal' as const,
      hand,
      finger,
      requiresCard: false,
      extractsIC: [] as const,
      icArchitecturePending: false,
      label: `${cap(hand)} ${cap(finger)} — Longitudinal`,
      instruction: `Position the camera at the side of your ${hand} ${finger} nail. The full nail length from base to tip should be visible in the frame.`,
    }))
  );
}

// ---------------------------------------------------------------------------
// The 30-shot sequence
// ---------------------------------------------------------------------------

/**
 * Complete measurement sequence for one client session.
 * Order: left top-down (5) → right top-down (5) →
 *        left transverse (5) → right transverse (5) →
 *        left longitudinal (5) → right longitudinal (5).
 */
export const CAPTURE_SEQUENCE: readonly ShotSpec[] = [
  ...topDownShots(),
  ...transverseShots(),
  ...longitudinalShots(),
];

export const TOTAL_SHOTS = CAPTURE_SEQUENCE.length; // 30