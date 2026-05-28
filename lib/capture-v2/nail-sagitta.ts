/**
 * Nail sagitta extraction from a curl-shot (end-on fingertip) image.
 *
 * Background
 * ----------
 * The sagitta h is the depth of the nail's transverse curve — the
 * perpendicular distance from the chord (a straight line connecting the two
 * lateral edges of the nail plate) to the apex of the arc. Combined with
 * chord width W it yields the IC radius:
 *
 *   IC = (W² + 4h²) / (4h)
 *
 * Image setup
 * -----------
 * The curl shot is taken end-on from the fingertip, looking straight down
 * the finger, so the nail's cross-sectional curve is visible directly. The
 * nail plate arcs across the top of the finger cross-section. The chord
 * endpoints (P1, P2) are at the lateral edges of the arc, and the apex is
 * the topmost point.
 *
 * Detection — two complementary strategies
 * -----------------------------------------
 * Both strategies run on every call; whichever produces the higher arc score
 * (sagittaPx / chordLengthPx) wins. Running two strategies guards against the
 * dominant failure mode of each one alone:
 *
 * Strategy A — Connected-component (CC) top-boundary scan
 *   1. Otsu-threshold in both polarities (CC runs twice).
 *   2. Collect connected components. Filters: area 0.5–65% of frame,
 *      bounding-box width ≥ MIN_CHORD_FRAC. The v1 MIN_ASPECT_RATIO filter
 *      is removed — a tight curl shot shows the fingertip in cross-section
 *      which is roughly circular (~1:1 aspect ratio) and would always fail
 *      the old 1.5 threshold.
 *   3. For each qualifying component, build a per-column top-boundary profile:
 *      for every x in [bb.minX, bb.maxX], find the topmost boundary pixel at
 *      that column. This traces the nail arc shape directly.
 *   4. Find the longest contiguous run in the profile and score it.
 *
 * Strategy B — Gradient scan-line (GS)
 *   1. For each image column, scan top-to-bottom; find the y of the maximum
 *      absolute vertical gradient. This traces the sharpest horizontal
 *      boundary per column — typically the finger-background edge.
 *   2. No Otsu threshold, no binary segmentation. Works even when the Otsu
 *      polarity is wrong or the nail plate merges with background/skin.
 *   3. Same contiguous-run scoring as Strategy A.
 *   4. Gradient scan returns a single global arc candidate. It is included
 *      in the multi-arc pool as a fallback for nails with poor CC contrast.
 *      NMS deduplication prevents it from double-counting a nail already
 *      found by the CC strategies.
 *
 * Multi-arc extraction
 * --------------------
 * `extractMultiArc` extends the single-arc path to return up to N independent
 * arc candidates from a single frame — the primary use case being a
 * four-finger curl shot where all four nails are visible end-on in one image.
 *
 * The strategy:
 *   1. Run the CC detector on both Otsu polarities, collecting ALL qualifying
 *      components' best arcs (not just the global best per polarity).
 *   2. Add the gradient-scan result as one additional fallback candidate.
 *   3. Sort all raw candidates by score descending.
 *   4. Spatial non-maximum suppression (NMS): discard any candidate whose
 *      chord x-interval overlaps > NMS_IOU_THRESHOLD with an already-kept
 *      higher-scoring candidate. This collapses duplicate detections of the
 *      same nail (bright and dark CC often find the same nail) while keeping
 *      genuinely separate nails intact.
 *   5. Process the top maxCandidates post-NMS candidates through upscaling,
 *      mm conversion, and anatomical sanity checks.
 *   6. Return accepted results plus a full debug record of every candidate
 *      (accepted and rejected) so the diagnostics panel can show what the
 *      pipeline saw and why it rejected specific arcs.
 *
 * Thumb IC note
 * -------------
 * The thumb's CMC joint rotates it ~90° from the finger plane; the standard
 * end-on geometry does not apply and this extractor must not be called for
 * curl-thumb shots. Shot-type gating is the caller's responsibility.
 *
 * Arc scoring and quality gate
 * ----------------------------
 * score = sagittaPx / chordLengthPx
 *   ≈ 0.00  → flat feature (card edge, table surface) — filtered out
 *   0.03–0.05 → very flat nail or noisy detection
 *   0.10–0.30 → typical nail arc
 */

import {
  rgbaToGray,
  downsampleGray,
  otsuThreshold,
  binaryThreshold,
  labelComponents,
  componentBoundaryPixels,
  type Point,
  type GrayImage,
} from './cv-primitives';
import {
  pixelsPerMmAt,
  applyHomography,
  CARD_WIDTH_MM,
  CARD_HEIGHT_MM,
  type CardHomography,
} from './card-homography';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SagittaResult = {
  /** Chord endpoints in full-resolution image pixels. chordEndpointsPx[0].x ≤ [1].x. */
  chordEndpointsPx: [Point, Point];
  /** Arc apex in full-resolution image pixels (topmost point of the arc). */
  apexPx: Point;
  /** Euclidean chord length in full-resolution pixels. */
  chordLengthPx: number;
  /** Perpendicular distance from apex to chord line in full-resolution pixels. */
  sagittaPx: number;
  /**
   * Chord width W in millimetres, derived from chordLengthPx via the local
   * card-plane px/mm scale. Null when no card homography is available.
   */
  chordWidthMm: number | null;
  /**
   * Sagitta depth h in millimetres. Null when no card homography is available.
   */
  sagittaMm: number | null;
  /**
   * IC radius in millimetres: IC = (W² + 4h²) / (4h).
   * Null when mm values are unavailable or h < 0.1 mm (physically implausible).
   */
  icMm: number | null;
  /** Fraction of full-resolution image width covered by the detected chord. */
  chordFrac: number;
  /**
   * Arc score: sagittaPx / chordLengthPx.
   * Key quality indicator — 0 = flat, ~0.15 = typical nail arc.
   */
  arcScore: number;
};

/** Which detection strategy produced a given arc candidate. */
export type ArcDetectionStrategy = 'cc-bright' | 'cc-bright-hi' | 'cc-dark' | 'gradient';

/**
 * Full debug record for one candidate arc found during multi-arc extraction.
 * Surfaced in the diagnostics panel so that rejected candidates and their
 * rejection reasons are visible alongside accepted results.
 */
export type ArcCandidateDebug = {
  /** Strategy that produced this candidate. */
  strategy: ArcDetectionStrategy;
  /**
   * Raw arc score (sagittaPx / chordLengthPx) in detection space.
   * Computed before upscaling and mm conversion.
   */
  rawScore: number;
  /** Chord endpoints in detection-space pixels (before upscaling to full res). */
  detectionP1: Point;
  detectionP2: Point;
  detectionApex: Point;
  /**
   * Chord as a fraction of full-resolution image width (computed after
   * upscaling, so it matches chordFrac in SagittaResult).
   */
  chordFrac: number;
  /** Passed all geometric and anatomical sanity filters. */
  accepted: boolean;
  /** Human-readable rejection reason, or null if accepted. */
  rejectionReason: string | null;
  /** Full measurement result if accepted; null if rejected. */
  result: SagittaResult | null;
};

/**
 * Stage-by-stage candidate counts from a single `extractMultiArc` call.
 *
 * Exposed so the diagnostics panel can distinguish the four failure modes:
 *   (A) Pool empty — nothing in the image matched the CC/gradient criteria.
 *       Usually means low contrast between finger and background (lighting
 *       or background-colour issue) or all components outside area bounds.
 *   (B) Pool non-empty, but all rejected by scale-prefilter.
 *       Candidates exist but all exceed the mm ceiling (hand-scale blobs).
 *   (C) Pool non-empty after prefilter + NMS, but all fail anatomical gates.
 *       Candidates exist at the right scale but wrong geometry — pose or
 *       segmentation traces the wrong boundary (skin vs. nail plate).
 *   (D) Accepted = expected. Success.
 *
 * `otsuThreshold` is the key lighting diagnostic: values near 0 or 255
 * indicate the image has almost no bi-modal contrast and the binarization
 * has likely collapsed into one class.
 */
export type ArcPipelineCounts = {
  /** Otsu binarization threshold (0–255). Near 0 or 255 → low contrast. */
  otsuThreshold: number;
  /** Total CC components found in the above-threshold (bright) polarity. */
  ccBrightTotal: number;
  /** Bright-polarity components that passed area + chord filters. */
  ccBrightPass: number;
  /** Bright-polarity components rejected because area < MIN_COMPONENT_AREA_FRAC. */
  ccBrightTooSmall: number;
  /** Bright-polarity components rejected because area > MAX_COMPONENT_AREA_FRAC. */
  ccBrightTooLarge: number;
  /** Bright-polarity components that passed area but whose bounding-box width < MIN_CHORD_FRAC. */
  ccBrightTooNarrow: number;
  /** Total CC components found in the below-threshold (dark) polarity. */
  ccDarkTotal: number;
  /** Dark-polarity components that passed area + chord filters. */
  ccDarkPass: number;
  /** Dark-polarity components rejected because area < MIN_COMPONENT_AREA_FRAC. */
  ccDarkTooSmall: number;
  /** Dark-polarity components rejected because area > MAX_COMPONENT_AREA_FRAC. */
  ccDarkTooLarge: number;
  /** Dark-polarity components that passed area but whose bounding-box width < MIN_CHORD_FRAC. */
  ccDarkTooNarrow: number;
  /** Candidates entering the pool (ccBright + ccDark + gradient). */
  poolBeforePrefilter: number;
  /** Candidates removed by scale prefilter (chord > mm ceiling). */
  prefilterRejectCount: number;
  /** Candidates remaining after scale prefilter + spatial NMS. */
  postNmsCount: number;
  /**
   * Candidates removed because their chord midpoint fell inside the projected
   * card footprint. The most common source is the EMV chip module (~12.5 mm
   * wide) which lands squarely in the NAIL_W range and forms a bright CC.
   */
  cardRegionRejectCount: number;
};

/**
 * Result of multi-arc extraction from a single curl-shot frame.
 *
 * For a four-finger curl shot, `accepted` will contain 0–4 SagittaResults,
 * one per detected nail. `allCandidatesDebug` exposes the full post-NMS
 * candidate set — accepted and rejected — for diagnostic display. Use it to
 * investigate the gap between "expected 4" and "detected N".
 * `pipelineCounts` surfaces per-stage counts so the diagnostics panel can
 * distinguish pool-empty (contrast/segmentation failure) from pool-non-empty
 * (geometry gate failure).
 */
export type MultiArcResult = {
  /** Accepted candidates sorted by arc score descending. */
  accepted: SagittaResult[];
  /**
   * All candidates considered (post spatial-NMS, before sanity filtering),
   * sorted by raw score descending.
   *
   * `allCandidatesDebug.length >= accepted.length`.
   * Rejected entries carry a `rejectionReason` explaining which sanity gate
   * they failed.
   */
  allCandidatesDebug: ArcCandidateDebug[];
  /** Stage-by-stage candidate counts for diagnostics. */
  pipelineCounts: ArcPipelineCounts;
};

// ---------------------------------------------------------------------------
// Tuneable constants  (TUNE-ME after device-test passes)
// ---------------------------------------------------------------------------

/** Long-edge resolution used for detection (matches card-detector). */
const DETECT_LONG_EDGE = 1200;

/** Minimum fraction of detection-image width the chord must span. */
const MIN_CHORD_FRAC = 0.03;

/**
 * Minimum arc score (sagitta / chord). Rejects flat features (card edges,
 * table surface, score ≈ 0) while admitting moderately flat nails.
 */
const MIN_ARC_SCORE = 0.03;

/**
 * Maximum arc score (sagitta / chord). Rejects near-circular blobs that
 * cannot be nail arcs — nails are shallow curves (typical score 0.03–0.35).
 * A score above 0.50 means the sagitta exceeds half the chord length, which
 * implies more than a quarter-circle curve; this is never a nail plate arc.
 * The observed h=15.5mm / chord=12mm artifact (score ≈ 1.31) is caught here
 * before entering the pool rather than only at the downstream NAIL_H gate.
 */
const MAX_ARC_SCORE = 0.50;

/**
 * Minimum CC component area as a fraction of detection-image area.
 *
 * In an end-on curl shot the nail plate appears as a bright curved band across
 * the top of the finger cross-section. In detection space (900×1200) at
 * ~4 px/mm the nail plate bright-CC component spans roughly 57px × 15px ≈ 855px
 * ≈ 0.08% of detection area. The previous value of 0.5% (5 400px) was filtering
 * out nail-plate-scale bright components entirely, leaving only the larger
 * (and geometrically incorrect) full-finger cross-section components in the pool.
 *
 * 0.03% (324px in a 900×1200 detection frame) admits shallow nail-plate CCs
 * (~57 × 10px ≈ 570px) while the secondary bbWidth check (MIN_CHORD_FRAC)
 * still rejects compact noise blobs whose width < 3% of the image — those are
 * too narrow to be nail arcs and are counted as tooNarrow in pipelineCounts.
 *
 * History: started at 0.5% (5 400px floor, filtered all nail-plate CCs).
 * Lowered to 0.1% (Fix 3) which was still above the ~855px nail-plate estimate.
 * Now at 0.03% after field data showed 150/154 cc-bright components rejected sm.
 */
const MIN_COMPONENT_AREA_FRAC = 0.0003;

/**
 * Maximum CC component area as a fraction of detection-image area.
 *
 * A single fingertip cross-section in a four-finger curl shot occupies
 * roughly 3–8% of the frame. 0.12 admits individual finger components
 * (with buffer for close framing or low-contrast merge with nail) while
 * rejecting whole-hand silhouettes (40–60% of frame) that the previous
 * value of 0.65 was letting through as dominant arc candidates.
 */
const MAX_COMPONENT_AREA_FRAC = 0.12;

/** Minimum absolute vertical-gradient magnitude for the gradient scan. */
const GS_GRAD_THRESHOLD = 15;

/** Gradient scan covers the top this fraction of each image column. */
const GS_SCAN_FRAC = 0.85;

/**
 * Chord endpoints must sit at least this fraction of the image dimension
 * away from each edge. Any P1 or P2 touching the image boundary indicates
 * the gradient scan latched onto the frame itself, not a nail arc.
 */
const EDGE_MARGIN_FRAC = 0.04;

/**
 * A single nail arc can never span more than this fraction of the image width.
 * Applied per-arc in both single and multi-arc modes.
 *
 * In a correctly-framed four-finger curl shot each nail spans roughly 5–10%
 * of the frame width. 0.25 gives generous margin for close framing while
 * reliably rejecting the hand/finger-cluster silhouette that spans 40–50%.
 * The previous value of 0.85 permitted chord runs nearly spanning the entire
 * frame, which caused the per-column boundary scan to trace the combined
 * finger-cluster outline rather than individual nail arcs.
 */
const MAX_RUN_FRAC = 0.25;

/**
 * Scale-aware chord prefilter: applied before spatial NMS using the card
 * homography to convert chord pixels → mm at capture time.
 *
 * Any candidate whose chord exceeds NAIL_W_MAX_MM × SCALE_PREFILTER_MARGIN
 * in card-plane mm is dropped BEFORE NMS. This is the critical ordering:
 * if a large-silhouette candidate reaches NMS with a high score it can
 * suppress every nail-scale candidate whose x-interval overlaps it — which,
 * for four fingers viewed end-on, is all of them.
 *
 * A 2× margin rejects hand-scale arcs (~100mm) while admitting nails that
 * appear up to 44mm in card-plane-mm (e.g. a nail closer to the camera than
 * the reference card, making it appear larger per card-plane-mm unit).
 * Filtered candidates are still recorded in allCandidatesDebug so the
 * diagnostics panel shows why they were removed.
 */
const SCALE_PREFILTER_MARGIN = 2.0;

/**
 * Spatial NMS: chord x-intervals that overlap by more than this IOU fraction
 * are treated as detections of the same nail — only the higher-scoring one
 * is kept.
 *
 * Why 0.7 (not 0.5):
 *
 * The cc-dark strategy traces the full finger cross-section boundary (~25mm)
 * because the skin and nail plate form one connected region in the below-Otsu
 * binary image. The cc-bright strategy may isolate just the nail plate (~14mm).
 * A 14mm nail inside a 25.8mm finger cross-section has IOU = 14/25.8 = 0.54.
 *
 * At IOU threshold 0.50 the finger-scale arc suppresses the nail-scale arc
 * (0.54 > 0.50), leaving only the 25.8mm candidate which fails NAIL_W_MAX_MM.
 * At IOU threshold 0.70 the 14mm nail survives NMS (0.54 < 0.70) and is
 * evaluated independently.
 *
 * True duplicates (same nail found by both CC polarities) have IOU ≈ 0.85–0.95
 * and are still correctly collapsed. Adjacent distinct nails have IOU ≈ 0
 * and are still kept as separate candidates.
 */
const NMS_IOU_THRESHOLD = 0.7;

/**
 * Threshold increment added on top of the Otsu level for the high-threshold
 * bright pass (`cc-bright-hi` strategy).
 *
 * Motivation: nail plate luminance (~175–200) sits above surrounding skin
 * (~140–160). The standard Otsu threshold often lands between them, so nail
 * plate and skin merge into one finger-scale bright CC. Raising the threshold
 * by this offset excludes skin pixels while retaining the nail plate, giving
 * the nail plate an isolated bright CC at the correct (~12mm) scale.
 *
 * 30 units above Otsu is a starting point. Tune upward if skin still bleeds
 * into the high-threshold CC; tune downward if nail plates disappear entirely.
 */
const HIGH_THRESHOLD_OFFSET = 30;

// ---------------------------------------------------------------------------
// Anatomical sanity constants  (mm-space checks, requires homography)
// ---------------------------------------------------------------------------

const NAIL_W_MIN_MM  =  7.0;  // narrowest plausible nail (small pinky)
const NAIL_W_MAX_MM  = 22.0;  // widest plausible nail (large thumb)
const NAIL_H_MIN_MM  =  0.2;  // very flat arc
const NAIL_H_MAX_MM  =  7.0;  // very pronounced curve
const NAIL_IC_MIN_MM =  5.0;  // tightest plausible IC radius
const NAIL_IC_MAX_MM = 30.0;  // flattest plausible arc

// ---------------------------------------------------------------------------
// Internal type (not exported)
// ---------------------------------------------------------------------------

/** Raw arc detection result in detection-space pixels. */
type ArcCandidate = {
  P1:    Point;
  P2:    Point;
  apex:  Point;
  /** sagittaPx / chordLengthPx in detection space. */
  score: number;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract up to `maxCandidates` nail arc candidates from a single curl-shot
 * frame, returning both accepted measurement results and the full debug
 * candidate list.
 *
 * Only call this for `curl-four-finger` shots. Do not call for `curl-thumb`
 * shots — the thumb's CMC rotation makes end-on geometry incompatible with
 * this extractor. Shot-type gating is the caller's responsibility.
 *
 * @param imageData      Full-resolution RGBA frame from canvas.getImageData.
 * @param homography     Card-plane homography at capture time, or null.
 * @param maxCandidates  Maximum accepted arcs returned (default 4). All
 *                       post-NMS candidates are evaluated; the accepted set
 *                       is trimmed to this limit after anatomical filtering.
 */
export function extractMultiArc(
  imageData: ImageData,
  homography: CardHomography | null,
  maxCandidates = 4,
): MultiArcResult {
  const { data, width, height } = imageData;

  const grayFull = rgbaToGray(data, width, height);
  const { img: gray, scale: downScale } = downsampleGray(grayFull, DETECT_LONG_EDGE);
  const threshold = otsuThreshold(gray);

  type TaggedCandidate = { candidate: ArcCandidate; strategy: ArcDetectionStrategy };

  // Collect all per-component arc candidates from both CC polarities.
  const pool: TaggedCandidate[] = [];

  const brightResult = findArcCandidatesFromBinary(binaryThreshold(gray, threshold, false));
  const darkResult   = findArcCandidatesFromBinary(binaryThreshold(gray, threshold, true));

  for (const c of brightResult.candidates) pool.push({ candidate: c, strategy: 'cc-bright' });
  for (const c of darkResult.candidates)   pool.push({ candidate: c, strategy: 'cc-dark' });

  // High-threshold bright pass: re-run CC detection at Otsu + HIGH_THRESHOLD_OFFSET
  // to separate nail plate pixels from surrounding skin.
  //
  // At the standard Otsu level, skin luminance (~140–160) and nail plate luminance
  // (~175–200) often both exceed the threshold, merging into a single finger-scale
  // bright CC whose top boundary traces the whole finger outline rather than just
  // the nail plate arc. The higher threshold excludes skin, allowing the nail plate
  // to form its own isolated CC at nail scale (~12 mm).
  //
  // NMS deduplication collapses any candidate this pass finds that overlaps a
  // candidate already found by the standard Otsu pass.
  const highThreshold     = Math.min(threshold + HIGH_THRESHOLD_OFFSET, 240);
  const highBrightResult  = findArcCandidatesFromBinary(
    binaryThreshold(gray, highThreshold, false),
  );
  for (const c of highBrightResult.candidates) {
    pool.push({ candidate: c, strategy: 'cc-bright-hi' });
  }

  // Gradient scan contributes one additional fallback candidate.
  // MAX_ARC_SCORE gate mirrors the CC candidate filter — reject near-circular
  // blobs that cannot be nail arcs before they enter the pool.
  const gs = findArcByGradientScan(gray);
  if (gs && gs.score >= MIN_ARC_SCORE && gs.score <= MAX_ARC_SCORE) {
    pool.push({ candidate: gs, strategy: 'gradient' });
  }

  // Sort by raw score descending before NMS.
  pool.sort((a, b) => b.candidate.score - a.candidate.score);

  // ── Scale-aware prefilter — must run BEFORE spatial NMS ──────────────────
  //
  // A large-silhouette candidate (whole hand, ~100mm chord) that reaches NMS
  // with a high score will suppress every nail-scale candidate whose x-interval
  // overlaps it — for four fingers, all of them. Filtering before NMS gives
  // nail-scale candidates a clean pass.
  //
  // If the homography is absent we skip this filter; the anatomical W-range
  // check in buildCandidateResult still catches oversized chords downstream.
  //
  // Removed candidates are captured in prefilterRejects and appended to
  // allCandidatesDebug so the diagnostics panel shows why they were dropped.
  const prefilterRejects: ArcCandidateDebug[] = [];
  let filteredPool = pool;

  if (homography !== null) {
    try {
      const pxPerMm = pixelsPerMmAt(
        homography,
        { x: CARD_WIDTH_MM / 2, y: CARD_HEIGHT_MM / 2 },
      );
      if (pxPerMm > 0) {
        const maxChordFullPx = NAIL_W_MAX_MM * pxPerMm * SCALE_PREFILTER_MARGIN;
        filteredPool = [];
        for (const item of pool) {
          const { candidate, strategy } = item;
          // downScale: detection coords × (1/downScale) = full-res coords,
          // so chordDetPx / downScale gives the chord in full-res pixels.
          const chordDetPx  = Math.hypot(
            candidate.P2.x - candidate.P1.x,
            candidate.P2.y - candidate.P1.y,
          );
          const chordFullPx = chordDetPx / downScale;
          if (chordFullPx <= maxChordFullPx) {
            filteredPool.push(item);
          } else {
            const chordFrac = chordFullPx / width;
            const chordMm   = chordFullPx / pxPerMm;
            // eslint-disable-next-line no-console
            console.warn(
              `[nail-sagitta] scale-prefilter rejected — ` +
              `chord ${chordFullPx.toFixed(0)} px (${chordMm.toFixed(1)} mm, ` +
              `${(chordFrac * 100).toFixed(1)}% of frame) ` +
              `> ${(NAIL_W_MAX_MM * SCALE_PREFILTER_MARGIN).toFixed(0)} mm ceiling  ` +
              `strategy=${strategy}  rawScore=${candidate.score.toFixed(3)}`,
            );
            prefilterRejects.push({
              strategy,
              rawScore: candidate.score,
              detectionP1:  candidate.P1,
              detectionP2:  candidate.P2,
              detectionApex: candidate.apex,
              chordFrac,
              accepted: false,
              rejectionReason:
                `scale-prefilter: chord ${chordMm.toFixed(1)} mm` +
                ` > ${(NAIL_W_MAX_MM * SCALE_PREFILTER_MARGIN).toFixed(0)} mm ceiling`,
              result: null,
            });
          }
        }
      }
    } catch {
      // Homography operation failed — leave pool unfiltered; downstream mm
      // checks will still reject oversized candidates.
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // ── Card-footprint exclusion — AFTER scale-prefilter, BEFORE NMS ─────────
  //
  // The reference card is in-frame for every curl shot. Small high-contrast
  // features on the card surface (EMV chip module, logo, text) can form bright
  // CCs that survive all area + score filters at nail scale. The chip module is
  // the primary offender: ~12.5 × 9.5 mm width lands squarely in NAIL_W_MAX_MM.
  //
  // If the card homography is available we project the four card corners to
  // full-resolution image space and reject any candidate whose chord midpoint
  // falls inside that quadrilateral. This eliminates card-region false positives
  // before NMS so they cannot suppress genuine nail-scale candidates.
  //
  // Rejected candidates are still recorded in cardRegionRejects and appended
  // to allCandidatesDebug so the diagnostics panel can confirm the filter fired.
  const cardRegionRejects: ArcCandidateDebug[] = [];
  let postCardPool = filteredPool;

  if (homography !== null) {
    try {
      // Project card corners (mm) → image space (full-res px).
      // cardToImage maps card-plane mm → full-resolution image pixels directly.
      const corners = [
        applyHomography(homography.cardToImage, { x: 0,             y: 0              }),
        applyHomography(homography.cardToImage, { x: CARD_WIDTH_MM, y: 0              }),
        applyHomography(homography.cardToImage, { x: CARD_WIDTH_MM, y: CARD_HEIGHT_MM }),
        applyHomography(homography.cardToImage, { x: 0,             y: CARD_HEIGHT_MM }),
      ] as [Point, Point, Point, Point];

      postCardPool = [];
      for (const item of filteredPool) {
        const { candidate, strategy } = item;
        // Convert detection-space chord midpoint → full-resolution image pixels.
        const midFullX = ((candidate.P1.x + candidate.P2.x) / 2) / downScale;
        const midFullY = ((candidate.P1.y + candidate.P2.y) / 2) / downScale;
        const mid: Point = { x: midFullX, y: midFullY };

        if (isPointInConvexQuad(mid, corners)) {
          const chordDetPx  = Math.hypot(
            candidate.P2.x - candidate.P1.x,
            candidate.P2.y - candidate.P1.y,
          );
          const chordFrac = (chordDetPx / downScale) / width;
          // eslint-disable-next-line no-console
          console.warn(
            `[nail-sagitta] card-exclusion filtered — ` +
            `midpoint=(${Math.round(midFullX)},${Math.round(midFullY)}) ` +
            `inside card footprint  strategy=${strategy}  ` +
            `score=${candidate.score.toFixed(3)}`,
          );
          cardRegionRejects.push({
            strategy,
            rawScore: candidate.score,
            detectionP1:   candidate.P1,
            detectionP2:   candidate.P2,
            detectionApex: candidate.apex,
            chordFrac,
            accepted: false,
            rejectionReason:
              `card-region: midpoint (${Math.round(midFullX)},${Math.round(midFullY)}) inside card footprint`,
            result: null,
          });
        } else {
          postCardPool.push(item);
        }
      }
    } catch {
      // Homography projection failed (degenerate matrix) — leave pool unfiltered.
      postCardPool = filteredPool;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Spatial NMS: collapse duplicate detections of the same nail.
  const deduped = spatialNMS(postCardPool);

  // Process ALL post-NMS candidates through upscaling → mm conversion → sanity.
  //
  // Previously only the top `maxCandidates` (= 4) post-NMS candidates were
  // evaluated. That was the second layer of suppression: finger-scale arcs
  // (~25mm, from cc-dark tracing the full cross-section) score higher than
  // nail-scale arcs (~14mm, from cc-bright isolating the nail plate), so they
  // consumed all 4 evaluation slots. The nail-scale arcs were never seen by
  // buildCandidateResult.
  //
  // The fix: evaluate every post-NMS candidate; trim the ACCEPTED set to
  // maxCandidates afterward. Finger-scale candidates still appear in
  // allCandidatesDebug with their W-range rejection reason so the diagnostics
  // panel shows why they were removed.
  const allCandidatesDebug: ArcCandidateDebug[] = deduped.map(
    ({ candidate, strategy }) =>
      buildCandidateResult(candidate, strategy, downScale, width, homography),
  );

  // Collect accepted results.
  const accepted: SagittaResult[] = [];
  for (const d of allCandidatesDebug) {
    if (d.accepted && d.result !== null) {
      accepted.push(d.result);
    }
  }
  accepted.sort((a, b) => b.arcScore - a.arcScore);

  // Append prefilter rejects so the diagnostics panel can confirm the
  // transition from hand-scale to nail-scale detection. They appear in the
  // "Rejected candidates" section with reason "scale-prefilter: …".
  //
  // Trim accepted to maxCandidates here (previously at deduped.slice).
  return {
    accepted: accepted.slice(0, maxCandidates),
    allCandidatesDebug: [...allCandidatesDebug, ...prefilterRejects, ...cardRegionRejects],
    pipelineCounts: {
      otsuThreshold:        threshold,
      ccBrightTotal:        brightResult.totalComponents,
      ccBrightPass:         brightResult.candidates.length,
      ccBrightTooSmall:     brightResult.tooSmall,
      ccBrightTooLarge:     brightResult.tooLarge,
      ccBrightTooNarrow:    brightResult.tooNarrow,
      ccDarkTotal:          darkResult.totalComponents,
      ccDarkPass:           darkResult.candidates.length,
      ccDarkTooSmall:       darkResult.tooSmall,
      ccDarkTooLarge:       darkResult.tooLarge,
      ccDarkTooNarrow:      darkResult.tooNarrow,
      poolBeforePrefilter:  pool.length,
      prefilterRejectCount: prefilterRejects.length,
      postNmsCount:         deduped.length,
      cardRegionRejectCount: cardRegionRejects.length,
    },
  };
}

/**
 * Extract the nail sagitta (and derived IC) from a full-resolution RGBA
 * curl-shot frame. Returns the single best accepted arc candidate, or null
 * when none pass the sanity filters.
 *
 * Convenience wrapper around `extractMultiArc` for single-nail shots and
 * backwards-compatible callers. For full debug info or multi-nail results,
 * call `extractMultiArc` directly.
 *
 * @param imageData   Full-resolution RGBA frame from canvas.getImageData.
 * @param homography  Card-plane homography at capture time, or null if absent.
 */
export function extractSagitta(
  imageData: ImageData,
  homography: CardHomography | null,
): SagittaResult | null {
  const { accepted } = extractMultiArc(imageData, homography, 1);
  return accepted[0] ?? null;
}

// ---------------------------------------------------------------------------
// Strategy A — connected-component per-column top-boundary scan
// ---------------------------------------------------------------------------

/**
 * Result of one call to `findArcCandidatesFromBinary`.
 * `totalComponents` is the raw CC count from `labelComponents` (before any
 * area/chord filtering). It drives the `ccBrightTotal` / `ccDarkTotal` fields
 * in `ArcPipelineCounts` so the diagnostics panel can distinguish "no CCs at
 * all" (contrast/lighting failure) from "CCs exist but all filtered" (area or
 * chord constraint too strict).
 */
type CCFindResult = {
  candidates: ArcCandidate[];
  totalComponents: number;
  tooSmall: number;
  tooLarge: number;
  tooNarrow: number;
};

/**
 * Returns all qualifying arc candidates from the connected components of a
 * binary image — one best arc per component, sorted by score descending.
 *
 * In a four-finger curl shot each nail typically occupies a separate connected
 * component, so this returns one candidate per visible nail. Running it on
 * both Otsu polarities and then applying spatial NMS gives robust per-nail
 * detection across lighting conditions.
 *
 * Key behaviour vs. v1:
 * - No aspect-ratio filter. A curl-shot fingertip cross-section is roughly
 *   circular; the old bbWidth/bbHeight ≥ 1.5 gate rejected whole-finger
 *   silhouettes unconditionally.
 * - Per-column top-boundary profile rather than overall extreme pixels.
 * - MAX_COMPONENT_AREA_FRAC = 0.12 — targets single finger-tip components.
 *   The previous value of 0.65 admitted whole-hand silhouettes which were
 *   producing dominant arc candidates at ~100mm chord width.
 * - MIN_COMPONENT_AREA_FRAC = 0.001 — admits nail-plate bright-CC components
 *   (~0.08% of detection area) that the previous 0.5% floor was rejecting.
 * - MAX_ARC_SCORE = 0.50 — rejects near-circular blobs (score > 0.5) early.
 */
function findArcCandidatesFromBinary(binary: GrayImage): CCFindResult {
  const { width, height } = binary;
  const totalPx = width * height;
  const minPx   = Math.round(totalPx * MIN_COMPONENT_AREA_FRAC);
  const maxPx   = Math.round(totalPx * MAX_COMPONENT_AREA_FRAC);

  const { labels, count, sizes, bboxes } = labelComponents(binary);
  const results: ArcCandidate[] = [];
  let tooSmall = 0;
  let tooLarge = 0;
  let tooNarrow = 0;

  for (let id = 1; id <= count; id++) {
    const sz = sizes[id];
    if (sz < minPx) { tooSmall++; continue; }
    if (sz > maxPx) { tooLarge++; continue; }

    const bb = bboxes[id];
    const bbWidth = bb.maxX - bb.minX + 1;
    if (bbWidth < width * MIN_CHORD_FRAC) { tooNarrow++; continue; }

    const boundary = componentBoundaryPixels(labels, width, height, id, bb);
    if (boundary.length === 0) continue;

    // Per-column top-boundary profile: for each x, smallest y = topmost boundary pixel.
    const topBoundary: (number | null)[] = new Array(width).fill(null);
    for (const p of boundary) {
      const cur = topBoundary[p.x];
      if (cur === null || p.y < cur) topBoundary[p.x] = p.y;
    }

    const candidate = arcFromProfile(topBoundary, bb.minX, bb.maxX, width, height);
    if (candidate && candidate.score >= MIN_ARC_SCORE && candidate.score <= MAX_ARC_SCORE) {
      results.push(candidate);
    }
  }

  return {
    candidates: results.sort((a, b) => b.score - a.score),
    totalComponents: count,
    tooSmall,
    tooLarge,
    tooNarrow,
  };
}

// ---------------------------------------------------------------------------
// Strategy B — gradient scan-line (single arc per image)
// ---------------------------------------------------------------------------

/**
 * Gradient scan-line arc finder.
 *
 * For each image column, scan the top GS_SCAN_FRAC of the column and find
 * the y of the maximum absolute vertical gradient. This traces the sharpest
 * horizontal boundary in each column — typically the finger-background edge —
 * without depending on the Otsu threshold polarity. Handles cases where the
 * nail plate merges with the background or skin in binary segmentation.
 *
 * Returns a single global arc candidate (the best-scoring run across the
 * full image profile). Included in the multi-arc candidate pool as a fallback;
 * NMS deduplication prevents it from double-counting any nail already found
 * by the CC strategies.
 */
function findArcByGradientScan(gray: GrayImage): ArcCandidate | null {
  const { data, width, height } = gray;
  const limit = Math.round(height * GS_SCAN_FRAC);

  const profile: (number | null)[] = new Array(width).fill(null);

  for (let x = 0; x < width; x++) {
    let maxGrad = GS_GRAD_THRESHOLD;
    let bestY: number | null = null;
    for (let y = 1; y < limit; y++) {
      const grad = Math.abs(
        data[y       * width + x] -
        data[(y - 1) * width + x],
      );
      if (grad > maxGrad) {
        maxGrad = grad;
        bestY   = y;
      }
    }
    profile[x] = bestY;
  }

  return arcFromProfile(profile, 0, width - 1, width, height);
}

// ---------------------------------------------------------------------------
// Spatial non-maximum suppression (NMS)
// ---------------------------------------------------------------------------

/**
 * Greedy spatial NMS over chord x-intervals.
 *
 * Candidates are assumed pre-sorted by score descending. Scan from best to
 * worst: keep each candidate unless its chord x-interval overlaps an already-
 * kept candidate by more than NMS_IOU_THRESHOLD. Duplicate detections of the
 * same nail across CC polarities or vs. the gradient scan are collapsed; nails
 * with non-overlapping x-intervals are retained as separate candidates.
 */
function spatialNMS<T extends { candidate: ArcCandidate }>(sorted: T[]): T[] {
  const kept: T[] = [];
  const keptIntervals: Array<[number, number]> = [];

  for (const item of sorted) {
    const left  = Math.min(item.candidate.P1.x, item.candidate.P2.x);
    const right = Math.max(item.candidate.P1.x, item.candidate.P2.x);

    let dominated = false;
    for (const [kl, kr] of keptIntervals) {
      const intersection = Math.max(0, Math.min(right, kr) - Math.max(left, kl));
      const union        = Math.max(right, kr) - Math.min(left, kl);
      if (union > 0 && intersection / union > NMS_IOU_THRESHOLD) {
        dominated = true;
        break;
      }
    }

    if (!dominated) {
      kept.push(item);
      keptIntervals.push([left, right]);
    }
  }

  return kept;
}

// ---------------------------------------------------------------------------
// Candidate result builder
// ---------------------------------------------------------------------------

/**
 * Upscale a detection-space ArcCandidate to full-resolution coordinates,
 * compute mm measurements via the card homography, apply anatomical sanity
 * filters, and return a complete ArcCandidateDebug record.
 *
 * A candidate is "accepted" if and only if it passes every sanity gate
 * (chord fraction, W mm range, h mm range, IC mm range). Rejected candidates
 * carry a `rejectionReason` describing the first gate they failed.
 */
function buildCandidateResult(
  raw: ArcCandidate,
  strategy: ArcDetectionStrategy,
  downScale: number,
  fullWidth: number,
  homography: CardHomography | null,
): ArcCandidateDebug {
  const s = 1 / downScale;
  const P1:   Point = { x: raw.P1.x   * s, y: raw.P1.y   * s };
  const P2:   Point = { x: raw.P2.x   * s, y: raw.P2.y   * s };
  const apex: Point = { x: raw.apex.x * s, y: raw.apex.y * s };

  const chordLengthPx = Math.hypot(P2.x - P1.x, P2.y - P1.y);
  const sagittaPx     = pointToLineDistance(apex, P1, P2);
  const chordFrac     = chordLengthPx / fullWidth;
  const arcScore      = chordLengthPx > 0 ? sagittaPx / chordLengthPx : 0;

  // Minimum chord fraction gate.
  if (chordFrac < MIN_CHORD_FRAC) {
    return {
      strategy,
      rawScore: raw.score,
      detectionP1: raw.P1, detectionP2: raw.P2, detectionApex: raw.apex,
      chordFrac,
      accepted: false,
      rejectionReason: `chord ${(chordFrac * 100).toFixed(1)}% < min ${(MIN_CHORD_FRAC * 100).toFixed(1)}%`,
      result: null,
    };
  }

  // mm conversion via card-homography local scale.
  let chordWidthMm: number | null = null;
  let sagittaMm:    number | null = null;
  let icMm:         number | null = null;

  if (homography !== null) {
    try {
      const pxPerMm = pixelsPerMmAt(
        homography,
        { x: CARD_WIDTH_MM / 2, y: CARD_HEIGHT_MM / 2 },
      );
      if (pxPerMm > 0) {
        chordWidthMm = chordLengthPx / pxPerMm;
        sagittaMm    = sagittaPx     / pxPerMm;
        if (sagittaMm >= 0.1) {
          const W = chordWidthMm;
          const h = sagittaMm;
          icMm = (W * W + 4 * h * h) / (4 * h);
        }
      }
    } catch {
      // Degenerate homography — leave mm fields null.
    }
  }

  // Anatomical sanity gates (only when mm values are available).
  if (chordWidthMm !== null && sagittaMm !== null) {
    if (chordWidthMm < NAIL_W_MIN_MM || chordWidthMm > NAIL_W_MAX_MM) {
      const reason =
        `W=${chordWidthMm.toFixed(1)} mm out of [${NAIL_W_MIN_MM}, ${NAIL_W_MAX_MM}] mm`;
      // eslint-disable-next-line no-console
      console.warn(
        `[nail-sagitta] rejected — ${reason}  strategy=${strategy}  ` +
        `score=${raw.score.toFixed(3)}  chordFrac=${chordFrac.toFixed(3)}  ` +
        `P1=(${Math.round(P1.x)},${Math.round(P1.y)})  P2=(${Math.round(P2.x)},${Math.round(P2.y)})`,
      );
      return {
        strategy, rawScore: raw.score,
        detectionP1: raw.P1, detectionP2: raw.P2, detectionApex: raw.apex,
        chordFrac, accepted: false, rejectionReason: reason, result: null,
      };
    }
    if (sagittaMm < NAIL_H_MIN_MM || sagittaMm > NAIL_H_MAX_MM) {
      const reason =
        `h=${sagittaMm.toFixed(1)} mm out of [${NAIL_H_MIN_MM}, ${NAIL_H_MAX_MM}] mm`;
      // eslint-disable-next-line no-console
      console.warn(
        `[nail-sagitta] rejected — ${reason}  strategy=${strategy}  ` +
        `score=${raw.score.toFixed(3)}`,
      );
      return {
        strategy, rawScore: raw.score,
        detectionP1: raw.P1, detectionP2: raw.P2, detectionApex: raw.apex,
        chordFrac, accepted: false, rejectionReason: reason, result: null,
      };
    }
    if (icMm !== null && (icMm < NAIL_IC_MIN_MM || icMm > NAIL_IC_MAX_MM)) {
      const reason =
        `IC=${icMm.toFixed(1)} mm out of [${NAIL_IC_MIN_MM}, ${NAIL_IC_MAX_MM}] mm`;
      // eslint-disable-next-line no-console
      console.warn(
        `[nail-sagitta] rejected — ${reason}  W=${chordWidthMm.toFixed(1)} h=${sagittaMm.toFixed(1)}  ` +
        `strategy=${strategy}`,
      );
      return {
        strategy, rawScore: raw.score,
        detectionP1: raw.P1, detectionP2: raw.P2, detectionApex: raw.apex,
        chordFrac, accepted: false, rejectionReason: reason, result: null,
      };
    }
  }

  return {
    strategy,
    rawScore: raw.score,
    detectionP1: raw.P1, detectionP2: raw.P2, detectionApex: raw.apex,
    chordFrac,
    accepted: true,
    rejectionReason: null,
    result: {
      chordEndpointsPx: [P1, P2],
      apexPx: apex,
      chordLengthPx,
      sagittaPx,
      chordWidthMm,
      sagittaMm,
      icMm,
      chordFrac,
      arcScore,
    },
  };
}

// ---------------------------------------------------------------------------
// Shared arc-from-profile scoring
// ---------------------------------------------------------------------------

/**
 * Given a top-edge profile (per-column y value, null = no hit), find the
 * contiguous run of non-null columns in [startX, endX] whose chord and
 * sagitta yield the highest arc score. Returns the best-scoring candidate,
 * or null when no qualifying run exists.
 *
 * "Best-scoring" rather than "longest run" because the longest run may be a
 * card edge (very high width, near-zero sagitta, score ≈ 0) or a frame-
 * spanning gradient artefact.
 */
function arcFromProfile(
  profile: (number | null)[],
  startX: number,
  endX: number,
  imageWidth: number,
  imageHeight: number,
): ArcCandidate | null {
  const minRunWidth = Math.round(imageWidth * MIN_CHORD_FRAC);
  const maxRunWidth = Math.round(imageWidth * MAX_RUN_FRAC);
  let best: ArcCandidate | null = null;
  let runStart: number | null = null;

  for (let x = startX; x <= endX + 1; x++) {
    const hasHit = x <= endX && profile[x] !== null;

    if (hasHit && runStart === null) {
      runStart = x;
    } else if (!hasHit && runStart !== null) {
      const runWidth = x - runStart;
      if (runWidth >= minRunWidth && runWidth <= maxRunWidth) {
        const candidate = scoreRun(profile, runStart, x - 1, imageWidth, imageHeight);
        if (candidate && (best === null || candidate.score > best.score)) {
          best = candidate;
        }
      }
      runStart = null;
    }
  }

  return best;
}

/**
 * Compute chord endpoints and sagitta for the profile run [left, right].
 * P1 = left endpoint, P2 = right endpoint, apex = column with minimum y
 * (highest point of the arc in image coordinates).
 *
 * Returns null if any sanity condition fails:
 *   - Edge proximity: P1.x or P2.x within EDGE_MARGIN_FRAC of image border
 *     → gradient scan latched onto the frame itself, not a nail arc.
 *   - Endpoint row proximity: leftY or rightY near top/bottom edge
 *     → same reason.
 *   - Apex orientation: apex.y ≥ min(P1.y, P2.y)
 *     → arc bows downward (away from camera), impossible for a correct curl shot.
 */
function scoreRun(
  profile: (number | null)[],
  left: number,
  right: number,
  imageWidth: number,
  imageHeight: number,
): ArcCandidate | null {
  const xMargin = imageWidth  * EDGE_MARGIN_FRAC;
  const yMargin = imageHeight * EDGE_MARGIN_FRAC;

  if (left < xMargin || right > imageWidth - xMargin) return null;

  const leftY  = profile[left]  as number;
  const rightY = profile[right] as number;

  if (leftY  < yMargin || leftY  > imageHeight - yMargin) return null;
  if (rightY < yMargin || rightY > imageHeight - yMargin) return null;

  let minY  = Infinity;
  let apexX = left;
  for (let x = left; x <= right; x++) {
    const y = profile[x];
    if (y !== null && y < minY) {
      minY  = y;
      apexX = x;
    }
  }

  const P1:   Point = { x: left,  y: leftY  };
  const P2:   Point = { x: right, y: rightY };
  const apex: Point = { x: apexX, y: minY   };

  if (apex.y >= Math.min(P1.y, P2.y)) return null;

  const chordLen = Math.hypot(P2.x - P1.x, P2.y - P1.y);
  if (chordLen < 1) return null;

  const sag   = pointToLineDistance(apex, P1, P2);
  const score = sag / chordLen;

  return { P1, P2, apex, score };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Returns true when point `p` lies inside (or on the boundary of) the convex
 * quadrilateral defined by `corners` in vertex order (CW or CCW).
 *
 * Implementation: for each directed edge a→b, compute the signed area of the
 * triangle (a, b, p) via the 2-D cross product. A point inside a convex polygon
 * has the same sign for all edges. Zero-cross edges (p on an edge line) are
 * treated as inside so boundary candidates are conservatively excluded.
 */
function isPointInConvexQuad(p: Point, corners: [Point, Point, Point, Point]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    const s = cross > 0 ? 1 : cross < 0 ? -1 : 0;
    if (s !== 0) {
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

function pointToLineDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }
  const num = Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x);
  return num / Math.hypot(dx, dy);
}
