/**
 * Live card detector — JS port of the validated probe.py pipeline.
 *
 * What this is
 * ------------
 * The browser-side equivalent of `scripts/card_detection_probe/probe.py`.
 * Given an `ImageData` frame from the live camera preview, returns the
 * four corners of the credit/debit/loyalty card in the frame, or `null`
 * if no plausible card is found.
 *
 * Calibration provenance
 * ----------------------
 * Every constant in this file is carried over from probe.py, where it was
 * tuned against the 125-photo pilot set. The calibration rationale lives
 * in probe.py's comments and in the README at
 * `scripts/card_detection_probe/README.md` — this module deliberately
 * does not re-litigate it. If a constant changes here, the probe should
 * be re-run with the matching change first.
 *
 * What's ported vs. what isn't (this increment)
 * ---------------------------------------------
 * Ported:
 *   - Downsample to 1200px long edge for detection.
 *   - Otsu branch in BOTH polarities (dark-on-light and light-on-dark).
 *   - Morphological close with a kernel sized to ~1% of short side.
 *   - Aspect/area/edge-margin gates.
 *   - Convex hull + RDP for the polygon approximation, in place of
 *     `cv2.findContours` + `approxPolyDP`. See cv-primitives.ts for why
 *     this substitution preserves behavior for the card-detection case.
 *
 * Not ported in this increment:
 *   - Canny fallback. The 125-photo pilot run was Otsu-dominated; Canny
 *     fired on a small minority of edge cases. We're shipping Otsu first
 *     to validate the live overlay end-to-end, then will add Canny as a
 *     follow-up so the live detector reaches probe parity. The structure
 *     here makes that a drop-in addition (see TODO at the bottom of
 *     `detectCard`).
 *   - Lighter-surround gate. probe.py keeps the helper but leaves it
 *     disabled for Otsu; we mirror that — the helper isn't ported here
 *     and will arrive with the Canny port (where probe.py uses it).
 */

import {
  approxPolyDP,
  arcLength,
  binaryThreshold,
  closeBinary,
  componentBoundaryPixels,
  contourArea,
  convexHull,
  downsampleGray,
  GrayImage,
  isConvex,
  labelComponents,
  orderCorners,
  otsuThreshold,
  Point,
  quadEdges,
  rgbaToGray,
} from './cv-primitives';

// ISO/IEC 7810 ID-1 (standard credit card): 85.60mm × 53.98mm.
export const CARD_TRUE_RATIO = 85.6 / 53.98; // ≈ 1.586

// Aspect-ratio tolerance is deliberately generous: a card seen from a tilted
// camera distorts toward a trapezoid and the bounding ratio drifts. Over-
// accepting here and letting downstream gates reject false positives is
// better than under-detecting on tilted captures.
export const ASPECT_RATIO_TOLERANCE = 0.45; // accept ratios ~1.14–2.04

// Area gates: anything smaller than 1% of the image is logo/shadow/crease;
// anything larger than 60% is the whole page, not a card.
export const MIN_AREA_FRAC = 0.01;
export const MAX_AREA_FRAC = 0.6;

// Detection works on a downsampled copy. Pilot photos were 3024×4032; the
// live camera streams at whatever the device gives us (typically lower than
// 4K). 1200 long edge is plenty for finding a ~25%-of-frame card.
export const DETECT_LONG_EDGE = 1200;

// Tuned in the 125-photo bucketed analysis to kill the "dark background
// contamination" failure mode where the detector latches onto a desk edge
// or wood-floor strip clipped by the image border. The 3 wood-strip false
// positives had a corner at exactly 0.00% from the edge; the closest
// legitimate detection sat at 0.13%. 0.001 separates them cleanly without
// burning safety margin on either side.
export const EDGE_MARGIN_FRAC = 0.001;

// Cap on how many of the largest connected components we attempt to
// approximate, per polarity. probe.py iterates contours largest-first
// and stops on the first that passes all gates; we mirror that.
const MAX_CANDIDATES_PER_POLARITY = 10;

export type DetectionMethod = 'otsu' | 'canny';
export type DetectionConfidence = 'high' | 'low';

export type Detection = {
  /**
   * Four corners in [TL, TR, BR, BL] order, in the coordinate space of the
   * input `ImageData` passed to `detectCard`. Callers that fed a downsampled
   * frame are responsible for scaling these back to their source coords.
   */
  corners: Point[];
  method: DetectionMethod;
  confidence: DetectionConfidence;
  metrics: {
    longEdge: number;
    shortEdge: number;
    /** observed long/short ratio. truth ≈ 1.586. */
    ratio: number;
    /** Fraction of the input image area covered by the card quadrilateral. */
    areaFrac: number;
    /**
     * Card long edge as a percentage of the image's short side. Mirrors
     * probe.py's `frame_width_pct`. Drives the too-far / too-close
     * guidance thresholds — dimensionless so consumers don't have to know
     * the source image's pixel dimensions.
     */
    framePct: number;
    /**
     * Closest distance from any corner to any image edge, normalized by
     * the image's short side. 0 = corner sits on the image border, 0.5 =
     * corner sits dead center. Drives the off-center guidance threshold.
     * Distinct from the much tighter EDGE_MARGIN_FRAC gate, which exists
     * only to reject false-positive detections.
     */
    minCornerEdgeFrac: number;
    /**
     * Perspective skew = max of the horizontal (|top - bottom|) and
     * vertical (|left - right|) edge-length disparities, each divided by
     * the mean of that pair. 0 means the four edges form a parallelogram
     * (phone parallel to the card); ~0.1+ indicates noticeable tilt.
     * Direction-agnostic on purpose — we surface "the phone is tilted",
     * not "tilted forward by X degrees", because nudging the user toward
     * flat is what the prompt does either way.
     */
    perspectiveSkew: number;
    /**
     * Minimum, across the four card edges, of the mean grayscale intensity
     * (0–255) measured in a small strip JUST OUTSIDE that edge. For a card
     * fully on white paper all four means are high (paper ≈ 240+). If any
     * edge has a low mean — wood, desk, hand, etc. — the minimum drops.
     *
     * Used together with `edgeSurroundSpread` below: either signal alone
     * is too easy to false-positive on (heavy single-edge shadow, glare,
     * card's own outer border bleeding into the surround sample). Both
     * conditions together give the actual "one edge is meaningfully
     * darker than the others AND is also low in absolute terms" signal.
     */
    minSurroundMean: number;
    /**
     * Max-minus-min of the per-edge surround means. Near 0 when the card
     * is on a uniform background (the desired state, even when the
     * background has some shadow); large when one or two edges are on a
     * very different surface from the others. The guidance layer fires
     * the off-paper prompt only when both this and `minSurroundMean`
     * cross their thresholds — see capture-guidance.ts for rationale.
     */
    edgeSurroundSpread: number;
  };
  /**
   * Short machine-side note describing which branch fired and the key
   * geometry. Useful for the dev-overlay readout and for diagnosing
   * disagreement with the Python probe when investigating a frame.
   */
  notes: string;
};

/**
 * Top-level detector. Operates on RGBA `ImageData` (the natural format you
 * get from `ctx.getImageData`). Returns the detected card or `null`.
 *
 * The detector is intentionally side-effect-free and synchronous so the
 * overlay's RAF loop can call it on the JS main thread. If profiling shows
 * we need to push it off-thread, the function shape (ImageData in, plain
 * object out) is already worker-friendly.
 */
export function detectCard(imageData: ImageData): Detection | null {
  const inputW = imageData.width;
  const inputH = imageData.height;

  // 1. Grayscale + downsample for detection. We hold onto `scale` so we
  //    can map detected corners back to the input ImageData's coords.
  const grayFull = rgbaToGray(imageData.data, inputW, inputH);
  const { img: gray, scale } = downsampleGray(grayFull, DETECT_LONG_EDGE);

  // 2. Try the Otsu branch. probe.py runs both polarities and keeps the
  //    higher-area passing candidate across both — same here.
  const otsu = tryOtsuBranch(gray);

  // TODO(canny-port): If `otsu` is null, fall through to a Canny+contour
  // branch matching probe.py's _find_card_canny. The helper signature
  // here ((gray) → { corners, note } | null) is what the Canny port will
  // expose. See module header for why this increment is Otsu-only.
  if (!otsu) {
    return null;
  }

  // 3. Rescale corners back to the input ImageData's pixel coordinates.
  const cornersInput =
    scale === 1
      ? otsu.corners
      : otsu.corners.map((p) => ({ x: p.x / scale, y: p.y / scale }));

  // 4. Compute confidence + metrics relative to the INPUT image (not the
  //    downsampled one), so the numbers are comparable across different
  //    sampling resolutions.
  const ordered = orderCorners(cornersInput);
  const edges = quadEdges(ordered);
  const ratio = edges.short > 0 ? edges.long / edges.short : 0;
  const areaFrac = contourArea(ordered) / (inputW * inputH);
  const confidence: DetectionConfidence =
    Math.abs(ratio - CARD_TRUE_RATIO) < 0.15 && areaFrac >= 0.04
      ? 'high'
      : 'low';

  // Guidance-feeding metrics. Computed here (not in capture-guidance.ts) so
  // every consumer sees the same numbers and so the guidance layer stays
  // pure threshold logic with no geometry of its own.
  const imageShortSide = Math.min(inputW, inputH);
  const framePct = imageShortSide > 0 ? (edges.long / imageShortSide) * 100 : 0;
  const minCornerEdgeFrac =
    imageShortSide > 0
      ? minCornerDistanceToEdge(ordered, inputW, inputH) / imageShortSide
      : 0;
  const perspectiveSkew = computePerspectiveSkew(ordered);
  // Surround sampling stays in the downsampled gray's coordinate space —
  // otsu.corners are in those coords and the gray buffer is right here,
  // so no rescaling or re-sampling of the full-res frame is needed.
  const surround = sampleEdgeSurroundStats(gray, otsu.corners);

  return {
    corners: ordered,
    method: 'otsu',
    confidence,
    metrics: {
      longEdge: edges.long,
      shortEdge: edges.short,
      ratio,
      areaFrac,
      framePct,
      minCornerEdgeFrac,
      perspectiveSkew,
      minSurroundMean: surround.minMean,
      edgeSurroundSpread: surround.spread,
    },
    notes: otsu.note,
  };
}

/**
 * Smallest perpendicular distance from any of the four corners to any of
 * the four image edges. Used (normalized) for the off-center guidance
 * threshold — the closer the nearest corner gets to the frame, the more
 * urgently we want to nudge the user to recenter before the card clips.
 */
function minCornerDistanceToEdge(
  corners: Point[],
  width: number,
  height: number
): number {
  let minDist = Infinity;
  for (const p of corners) {
    const d = Math.min(p.x, p.y, width - p.x, height - p.y);
    if (d < minDist) minDist = d;
  }
  return Math.max(0, minDist);
}

/**
 * Perspective skew from the four ordered corners (TL, TR, BR, BL).
 *
 * A rectangle viewed perpendicular has top == bottom and left == right.
 * As the camera tilts, the edge closer to the lens grows longer than its
 * parallel partner — that pair-difference is exactly the tilt signal we
 * want, and it's direction-agnostic (we treat forward/back/left/right
 * tilt as the same "phone isn't flat" prompt).
 *
 * Returns max(horizontal disparity, vertical disparity), each expressed
 * as a fraction of the mean of that pair. Typical values:
 *   ~0.00  phone exactly parallel to the card
 *   ~0.05  small tilt, usually still fine for measurement
 *   ~0.10+ noticeable tilt — guidance fires
 */
function computePerspectiveSkew(corners: Point[]): number {
  const [tl, tr, br, bl] = corners;
  const top = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const bottom = Math.hypot(br.x - bl.x, br.y - bl.y);
  const left = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const right = Math.hypot(br.x - tr.x, br.y - tr.y);
  const horizMean = (top + bottom) / 2;
  const vertMean = (left + right) / 2;
  const horizSkew = horizMean > 0 ? Math.abs(top - bottom) / horizMean : 0;
  const vertSkew = vertMean > 0 ? Math.abs(left - right) / vertMean : 0;
  return Math.max(horizSkew, vertSkew);
}

/**
 * Sample each of the four card edges' OUTSIDE neighborhoods and return
 * summary stats across the four per-edge means: the minimum, the spread
 * (max − min), and the per-edge means themselves.
 *
 * Why two numbers, not one:
 *   - `minMean` alone false-positives on a single heavily shadowed paper
 *     edge — a hand or phone bezel casting one shadow drops min below an
 *     absolute threshold even though the card is fully on paper.
 *   - `spread` alone false-positives on glare-vs-shadow on the same paper
 *     (one edge in bright direct light at 250, another in shadow at 180,
 *     spread 70 — but nothing is actually off the paper).
 *   - Requiring BOTH gives a much tighter signal: "one edge is meaningfully
 *     darker than the others AND is also low in absolute terms" — the
 *     actual off-paper signature. The guidance layer is what combines
 *     them; this function just returns both numbers.
 *
 * Sampling strategy
 * -----------------
 * Per edge: walk N_ALONG points across the edge midline, and at each
 * point sample at M_OFFSETS perpendicular offsets outward (away from the
 * polygon centroid). Averaging across this small strip is far more robust
 * than the previous single-offset sampling, which was sensitive to
 * corner-detection slop and to the card's own dark border bleeding into
 * the surround at small offsets.
 *
 * Offset band is shortEdge·[4%, 12%] clamped to absolute [6, 30] px. The
 * absolute floor of 6 px keeps the band past typical corner slop and the
 * card's outer dark ring even on small cards; the cap of 30 px stops the
 * band from shooting off the reference paper on tightly framed cards.
 *
 * Edges with too few in-bounds samples are skipped — a card nudged near
 * the image edge just doesn't contribute that edge to the stats. If
 * fewer than two edges have signal we return a "no opinion" result
 * (`minMean: 255, spread: 0`) so the guidance layer can't fire on it;
 * the off-center prompt will be firing in that case anyway.
 */
function sampleEdgeSurroundStats(
  gray: GrayImage,
  corners: Point[]
): { minMean: number; spread: number; perEdgeMeans: number[] } {
  const fallback = {
    minMean: 255,
    spread: 0,
    perEdgeMeans: [NaN, NaN, NaN, NaN],
  };
  if (corners.length !== 4) return fallback;

  const ordered = orderCorners(corners);
  const [tl, tr, br, bl] = ordered;

  // Polygon centroid — used to determine which way is "outward" for each edge.
  const cx = (tl.x + tr.x + br.x + bl.x) / 4;
  const cy = (tl.y + tr.y + br.y + bl.y) / 4;

  const edgeSegs: [Point, Point][] = [
    [tl, tr], // top
    [tr, br], // right
    [br, bl], // bottom
    [bl, tl], // left
  ];

  const edgeLens = edgeSegs.map(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y));
  const validLens = edgeLens.filter((l) => l > 0);
  if (validLens.length < 2) return fallback;
  const shortLen = Math.min(...validLens);
  if (shortLen < 4) return fallback;

  // Offset band — sampled at M_OFFSETS depths so a single bad offset
  // (shadow ring, dark card border, paper-edge transition) can't dominate.
  const offsetMin = Math.max(6, shortLen * 0.04);
  const offsetMax = Math.min(30, Math.max(offsetMin + 4, shortLen * 0.12));
  // M_OFFSETS samples evenly across [offsetMin, offsetMax]. Keep this ≥2
  // — the t = m / (M_OFFSETS - 1) parameterization requires it, and a
  // single-offset version would defeat the whole point of band sampling.
  const M_OFFSETS = 4;
  const offsets: number[] = [];
  for (let m = 0; m < M_OFFSETS; m++) {
    const t = m / (M_OFFSETS - 1);
    offsets.push(offsetMin + (offsetMax - offsetMin) * t);
  }

  const N_ALONG = 12;
  const MIN_VALID_SAMPLES_PER_EDGE = 8;

  const perEdgeMeans: number[] = [];

  for (const [a, b] of edgeSegs) {
    // Outward unit vector: from centroid toward the edge midpoint. Length
    // safety guard — collinear corners would zero this out, in which case
    // we can't define "outward" and just skip the edge.
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = mx - cx;
    const dy = my - cy;
    const dlen = Math.hypot(dx, dy);
    if (dlen === 0) {
      perEdgeMeans.push(NaN);
      continue;
    }
    const ux = dx / dlen;
    const uy = dy / dlen;

    let sum = 0;
    let count = 0;
    for (let i = 0; i < N_ALONG; i++) {
      // Walk t in (0,1) with half-step offsets so the endpoints don't get
      // oversampled (and so corner imprecision affects fewer samples).
      const tAlong = (i + 0.5) / N_ALONG;
      const baseX = a.x + (b.x - a.x) * tAlong;
      const baseY = a.y + (b.y - a.y) * tAlong;
      for (const off of offsets) {
        const xi = Math.round(baseX + ux * off);
        const yi = Math.round(baseY + uy * off);
        if (xi < 0 || yi < 0 || xi >= gray.width || yi >= gray.height) continue;
        sum += gray.data[yi * gray.width + xi];
        count++;
      }
    }
    if (count < MIN_VALID_SAMPLES_PER_EDGE) {
      perEdgeMeans.push(NaN);
      continue;
    }
    perEdgeMeans.push(sum / count);
  }

  const validMeans = perEdgeMeans.filter((m) => !Number.isNaN(m));
  if (validMeans.length < 2) {
    return { minMean: 255, spread: 0, perEdgeMeans };
  }
  const minMean = Math.min(...validMeans);
  const maxMean = Math.max(...validMeans);
  return { minMean, spread: maxMean - minMean, perEdgeMeans };
}

// ---------------------------------------------------------------------------
// Otsu branch
// ---------------------------------------------------------------------------

/**
 * Returns the best (largest-area, passing) quadrilateral across BOTH Otsu
 * polarities, with corners in the coordinate space of the input `gray`
 * image. Returns null if no candidate passes the gates.
 *
 * "Best" matches probe.py: among all gate-passing candidates from either
 * polarity, the one with the largest area wins.
 */
function tryOtsuBranch(
  gray: GrayImage
): { corners: Point[]; note: string } | null {
  const threshold = otsuThreshold(gray);

  let bestCorners: Point[] | null = null;
  let bestArea = -1;
  let bestNote = 'otsu: no candidate passed gates';

  for (const invert of [false, true] as const) {
    const binary = binaryThreshold(gray, threshold, invert);

    // Kernel size matches probe.py: ~1% of the image's short side, with a
    // floor of 3 so the structuring element is always meaningful. The
    // closeBinary helper enforces odd sizes internally.
    const kernel = Math.max(3, Math.floor(gray.height / 100));
    const closed = closeBinary(binary, kernel);

    const components = labelComponents(closed);
    if (components.count === 0) continue;

    // Rank components by pixel count (proxy for contour area) and probe
    // the top N — matches probe.py's "sort contours by area, take top 10".
    const ids = Array.from({ length: components.count }, (_, k) => k + 1);
    ids.sort((a, b) => components.sizes[b] - components.sizes[a]);

    const imageArea = gray.width * gray.height;
    const probeCount = Math.min(MAX_CANDIDATES_PER_POLARITY, ids.length);

    for (let i = 0; i < probeCount; i++) {
      const id = ids[i];
      const boundary = componentBoundaryPixels(
        components.labels,
        gray.width,
        gray.height,
        id,
        components.bboxes[id]
      );
      if (boundary.length < 4) continue;

      // Convex hull + RDP. See cv-primitives.ts for why this substitutes
      // cleanly for findContours + approxPolyDP in the card-detection case.
      const hull = convexHull(boundary);
      if (hull.length < 4) continue;

      // RDP epsilon = 0.02 * perimeter — same as the Otsu branch in
      // probe.py. The Canny branch in probe.py uses 0.03; that will land
      // with the Canny port.
      const perim = arcLength(hull, true);
      const approx = approxPolyDP(hull, 0.02 * perim, true);
      if (approx.length !== 4) continue;
      if (!isConvex(approx)) continue;

      const ordered = orderCorners(approx);
      const edges = quadEdges(ordered);
      if (edges.short < 1) continue;

      const ratio = edges.long / edges.short;
      if (Math.abs(ratio - CARD_TRUE_RATIO) > ASPECT_RATIO_TOLERANCE) continue;

      const polyArea = contourArea(ordered);
      const areaFrac = polyArea / imageArea;
      if (areaFrac < MIN_AREA_FRAC || areaFrac > MAX_AREA_FRAC) continue;

      if (!passesEdgeMargin(ordered, gray.width, gray.height)) continue;

      // Lighter-surround gate is intentionally NOT applied in the Otsu
      // branch — matches probe.py, which kept the helper available but
      // disabled it after the sensitivity test showed it produced
      // identical results to edge-margin alone on the 125-photo pilot.

      if (polyArea > bestArea) {
        bestArea = polyArea;
        bestCorners = ordered;
        bestNote = `otsu: invert=${invert} area_frac=${areaFrac.toFixed(3)} ratio=${ratio.toFixed(3)}`;
      }
    }
  }

  return bestCorners ? { corners: bestCorners, note: bestNote } : null;
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * Reject candidates whose corners come within `EDGE_MARGIN_FRAC` of any
 * image edge. The wood/desk false positives identified in the 125-photo
 * pilot all had at least one corner pinned to the image border because
 * the intruding dark strip was clipped by the frame.
 */
function passesEdgeMargin(
  corners: Point[],
  width: number,
  height: number
): boolean {
  const margin = EDGE_MARGIN_FRAC * Math.min(width, height);
  for (const p of corners) {
    if (p.x < margin || p.y < margin) return false;
    if (p.x > width - margin || p.y > height - margin) return false;
  }
  return true;
}
