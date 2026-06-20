/**
 * lib/capture-v2/shot-spec.ts
 *
 * 28-shot per-finger capture protocol:
 *
 *    0–9   top-down     all 5 fingers × 2 hands   — requires reference card
 *   10–17  transverse   4 fingers × 2 hands        — no card (thumbs excluded)
 *   18–27  longitudinal all 5 fingers × 2 hands   — no card
 *
 * Layer 4 (fit intelligence) is paused.
 * extractsIC / icArchitecturePending are reserved fields kept in-schema so
 * adding Layer 4 later doesn't require a structural change to CaptureImage or
 * the submission payload.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Hand = 'left' | 'right';

export type Finger = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';

export type ShotType =
  | 'top-down'       // per-finger top-down; extracts W and L; requires card
  | 'transverse'     // per-finger end-on cross-section; extracts IC; no card
  | 'longitudinal';  // per-finger side profile; extracts AP% and h/L; no card

export type ShotSpec = {
  /** Discriminates the capture geometry and expected measurements. */
  shotType: ShotType;
  hand: Hand;
  /**
   * The single finger this shot targets. Never null — every shot in the
   * per-finger protocol has exactly one primary finger.
   */
  finger: Finger;
  /**
   * Whether the reference card must be in frame for this shot.
   *
   * LiveCaptureView reads this to choose between two guidance modes:
   *   true  → computeGuidance()     strict card-detection ruleset
   *   false → computeCurlGuidance() relaxed no-card ruleset
   *
   * top-down:     true  (card provides scale reference)
   * transverse:   false (end-on curl; card would obstruct)
   * longitudinal: false (side profile; no scale reference needed at beta)
   */
  requiresCard: boolean;
  /**
   * Layer 4 placeholder — which fingers' IC (inter-curvature) data this
   * shot contributes to. Empty for top-down and longitudinal at beta;
   * populated for transverse once fit-intelligence pipeline is active.
   */
  extractsIC: readonly Finger[];
  /**
   * Layer 4 placeholder — true while the fit-intelligence pipeline is
   * paused. Signals to any downstream consumer that extractsIC should not
   * be acted on yet.
   */
  icArchitecturePending: boolean;
  /** Short label shown in progress UI, capture viewer, and section intros. */
  label: string;
  /**
   * Instruction shown to the user on the per-section intro screen.
   */
  instruction: string;
};

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const ALL_FINGERS: readonly Finger[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];

/** Thumbs excluded from transverse — nail geometry makes end-on alignment
 *  unreliable and thumb IC is computed differently in Layer 4. */
const TRANSVERSE_FINGERS: readonly Finger[] = ['index', 'middle', 'ring', 'pinky'];

const HANDS: readonly Hand[] = ['left', 'right'];

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Shot generators
// ---------------------------------------------------------------------------

function topDownShots(): ShotSpec[] {
  // Left hand first, then right. Within each hand: thumb → pinky.
  return HANDS.flatMap(hand =>
    ALL_FINGERS.map(finger => ({
      shotType: 'top-down' as const,
      hand,
      finger,
      requiresCard: true,
      extractsIC: [] as readonly Finger[],
      icArchitecturePending: true,
      label: `Top-Down · ${cap(hand)} ${cap(finger)}`,
      instruction:
        'Palm facing up, hand flat on a white surface. ' +
        'Place the reference card alongside your hand.',
    }))
  );
}

function transverseShots(): ShotSpec[] {
  // Thumbs excluded. Left hand first, then right. Within each hand: index → pinky.
  return HANDS.flatMap(hand =>
    TRANSVERSE_FINGERS.map(finger => ({
      shotType: 'transverse' as const,
      hand,
      finger,
      requiresCard: false,
      extractsIC: [finger] as readonly Finger[],
      icArchitecturePending: true,
      label: `Front Profile · ${cap(hand)} ${cap(finger)}`,
      instruction:
        'Rotate your phone 180° so the camera is level with the table. ' +
        'Move close enough to clearly see the nail\'s natural curve. No reference card needed.',
    }))
  );
}

function longitudinalShots(): ShotSpec[] {
  // All 5 fingers. Left hand first, then right. Within each hand: thumb → pinky.
  return HANDS.flatMap(hand =>
    ALL_FINGERS.map(finger => ({
      shotType: 'longitudinal' as const,
      hand,
      finger,
      requiresCard: false,
      extractsIC: [] as readonly Finger[],
      icArchitecturePending: true,
      label: `Side-Profile · ${cap(hand)} ${cap(finger)}`,
      instruction:
        `Hold your ${finger} finger sideways, tip pointing toward the camera. ` +
        'No reference card needed.',
    }))
  );
}

// ---------------------------------------------------------------------------
// Exported sequence — do not reorder without updating CaptureImage rows
// ---------------------------------------------------------------------------

export const CAPTURE_SEQUENCE: readonly ShotSpec[] = [
  ...topDownShots(),       // shots  0–9   left thumb → right pinky
  ...transverseShots(),    // shots 10–17  left index → right pinky (no thumbs)
  ...longitudinalShots(),  // shots 18–27  left thumb → right pinky
];

/** 28: 10 top-down + 8 transverse + 10 longitudinal */
export const TOTAL_SHOTS = CAPTURE_SEQUENCE.length;
