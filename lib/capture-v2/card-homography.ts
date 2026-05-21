/**
 * Card-plane homography — image↔card-plane mm metadata from 4 ordered corners.
 *
 * What this is
 * ------------
 * Given the four corners of an ISO/IEC 7810 ID-1 card already detected in
 * an image (see `card-detector.ts`), compute the 3×3 projective transforms
 * that map between image pixel coordinates and millimetres on the card's
 * own plane. These matrices are pure metadata — they do not modify, crop,
 * rectify, or resample the image in any way.
 *
 * Why this module exists (and what it deliberately does NOT do)
 * -------------------------------------------------------------
 * The current measurement pipeline downstream of this code carries two
 * assumptions: a constant `camera_to_card_distance` standing in for the
 * geometry we never measured, and a constant `hand_thickness` standing in
 * for the parallax between the card plane and the nail plane. The first
 * of those two is what this module sets up to retire.
 *
 * H alone is not enough to retire either constant — that requires camera
 * intrinsics (specifically focal length in pixels) to decompose H into a
 * full 3D card pose. But H is the prerequisite for that decomposition, and
 * it is also already useful on its own: any quantity measured ON the card
 * plane (or close enough to it that the depth offset is negligible) can be
 * scaled correctly with no further information.
 *
 * Scope of this increment:
 *   - Compute imageToCard and cardToImage from 4 ordered corners.
 *   - Carry a corner-reprojection residual so consumers can verify the
 *     solve was well-conditioned.
 *   - Provide `applyHomography` and `pixelsPerMmAt` helpers so consumers
 *     don't reimplement the projective math.
 *   - No external dependencies.
 *   - No modifications to the captured image bytes or to the measurement
 *     API contract. The matrices are intended to ride alongside captures
 *     as metadata; what consumes them comes in a later increment.
 *
 * Numerical approach
 * ------------------
 * Four point correspondences exactly determine the 8 degrees of freedom
 * of a planar homography (the 9th element is the projective scale and is
 * fixed by setting h33 = 1). We solve the 8×8 linear DLT system directly
 * with Gaussian elimination + partial pivoting.
 *
 * Image-pixel coordinates are typically on the order of 1e3 while card-mm
 * coordinates are on the order of 1e2; the cross-product terms in the DLT
 * matrix span several orders of magnitude as a result, which would give
 * the solve a bad condition number. We pre-apply Hartley normalization
 * (translate to centroid, scale so mean distance to origin = √2) on both
 * coordinate sets and de-normalize the recovered matrix at the end. This
 * is standard practice for DLT-style estimators and keeps the residual on
 * well-formed inputs at the machine-epsilon floor.
 *
 * Coordinate conventions
 * ----------------------
 *   - Image space: x rightward, y downward, units = pixels of the input
 *     image (matching whatever ImageData was fed into the detector).
 *   - Card space: origin at the card's TL corner, +x along the long edge
 *     (toward TR), +y along the short edge (toward BL), units = mm.
 *     Card extent is therefore [0, CARD_WIDTH_MM] × [0, CARD_HEIGHT_MM].
 *
 * Sanity check (`residualPx`)
 * ---------------------------
 * The corner residual is the maximum, across the four corners, of the
 * Euclidean distance between the input corner and that corner projected
 * through cardToImage. For a 4-point exact solve on well-conditioned
 * inputs this should sit at machine-epsilon (< 1e-6 px). Any non-trivial
 * value means the corners passed in were degenerate (collinear, duplicate,
 * or out of TL/TR/BR/BL order). Callers should treat anything above a
 * fraction of a pixel as "do not use this homography for measurement".
 */

import type { Point } from './cv-primitives';

// ---------------------------------------------------------------------------
// ID-1 dimensions
// ---------------------------------------------------------------------------

/**
 * ISO/IEC 7810 ID-1: 85.60 mm × 53.98 mm. These are the SAME numbers used
 * by `CARD_TRUE_RATIO` in `card-detector.ts`; we keep them as their own
 * named constants here because consumers of the homography want the actual
 * mm extents (for `pixelsPerMmAt` queries inside the card, for example),
 * not just the ratio.
 */
export const CARD_WIDTH_MM = 85.6;
export const CARD_HEIGHT_MM = 53.98;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A 3×3 matrix, row-major. Stored as a tuple-of-tuples so TypeScript can
 * statically guarantee shape — no chance of a stray 2×3 or 3×4 slipping
 * past the type-checker.
 */
export type Matrix3x3 = [
  [number, number, number],
  [number, number, number],
  [number, number, number],
];

export type CardHomography = {
  /**
   * Maps a point in image-pixel coordinates to its location on the card
   * plane in millimetres (origin = card TL corner).
   *
   * For a point that genuinely lies on the card plane and is inside the
   * card, the result will fall in [0, CARD_WIDTH_MM] × [0, CARD_HEIGHT_MM].
   * For points that don't lie on the card plane (e.g. on top of the hand)
   * this map silently extrapolates as if they did — that's exactly the
   * parallax error `hand_thickness` is currently absorbing, and it's why
   * retiring that constant needs more than just H.
   */
  imageToCard: Matrix3x3;
  /**
   * Inverse of imageToCard: card-mm → image-px. Computed once at construct-
   * ion time so consumers don't pay the inversion cost per query.
   */
  cardToImage: Matrix3x3;
  /**
   * Max Euclidean distance, in image pixels, between an input corner and
   * that corner projected back through cardToImage. For a well-conditioned
   * 4-point exact solve this is at the machine-epsilon floor (< 1e-6).
   * A meaningful value here means the input corners were degenerate; the
   * homography should not be trusted in that case.
   */
  residualPx: number;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a CardHomography from the detector's four ordered corners.
 *
 * The corner order MUST be [TL, TR, BR, BL] — the same order
 * `orderCorners` in cv-primitives emits and the same order
 * `Detection.corners` carries. Passing a different order produces a
 * mathematically valid but semantically wrong homography (the card-mm
 * frame ends up rotated or reflected); the residual check will NOT catch
 * that, because the solve is exact regardless of orientation. Order is a
 * caller-side guarantee.
 *
 * Throws on:
 *   - corners.length !== 4
 *   - a degenerate corner set that makes the 8×8 system singular
 *     (collinear points, duplicates, etc.)
 *   - a non-invertible cardToImage (this would only happen alongside the
 *     above and is a defense-in-depth check)
 */
export function computeCardHomography(corners: Point[]): CardHomography {
  if (corners.length !== 4) {
    throw new Error(
      `computeCardHomography expects exactly 4 corners, got ${corners.length}`
    );
  }
  const [tl, tr, br, bl] = corners;

  // Canonical card-plane corners, in the same TL/TR/BR/BL order as the
  // image corners. The card-mm frame is defined by this assignment.
  const cardCorners: Point[] = [
    { x: 0, y: 0 },
    { x: CARD_WIDTH_MM, y: 0 },
    { x: CARD_WIDTH_MM, y: CARD_HEIGHT_MM },
    { x: 0, y: CARD_HEIGHT_MM },
  ];
  const imageCorners: Point[] = [tl, tr, br, bl];

  // Solve in the card → image direction. That choice is arbitrary in
  // principle (we could solve image → card and invert), but solving the
  // direction whose source coordinates are the well-conditioned, small,
  // identical-across-photos card-mm values makes the Hartley normalization
  // step trivial on the source side and the conditioning predictable.
  const cardToImage = solveHomography(cardCorners, imageCorners);
  const imageToCard = invertMatrix3x3(cardToImage);

  // Reproject the canonical card corners and measure residual against the
  // input image corners. For a 4-point exact solve this should be tiny.
  let residualPx = 0;
  for (let i = 0; i < 4; i++) {
    const projected = applyHomography(cardToImage, cardCorners[i]);
    const dx = projected.x - imageCorners[i].x;
    const dy = projected.y - imageCorners[i].y;
    const err = Math.hypot(dx, dy);
    if (err > residualPx) residualPx = err;
  }

  return { imageToCard, cardToImage, residualPx };
}

/**
 * Apply a 3×3 homography to a 2D point. Handles the homogeneous-divide
 * and guards against the (numerically pathological) case of the w
 * coordinate landing at zero, which would indicate the point projects to
 * infinity — never expected for any real card-plane query inside the
 * image, but worth a defensive throw rather than a silent NaN.
 */
export function applyHomography(h: Matrix3x3, p: Point): Point {
  const x = h[0][0] * p.x + h[0][1] * p.y + h[0][2];
  const y = h[1][0] * p.x + h[1][1] * p.y + h[1][2];
  const w = h[2][0] * p.x + h[2][1] * p.y + h[2][2];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) {
    throw new Error('applyHomography: point projects to infinity (w ≈ 0)');
  }
  return { x: x / w, y: y / w };
}

/**
 * Local image-pixels per card-millimetre at a given card-plane point.
 *
 * Derivation
 * ----------
 * For the projective map (X, Y) ↦ (x, y) with
 *     x = (h00·X + h01·Y + h02) / (h20·X + h21·Y + h22)
 *     y = (h10·X + h11·Y + h12) / (h20·X + h21·Y + h22)
 * the 2×2 Jacobian J = ∂(x, y) / ∂(X, Y) describes how a small step in
 * card-mm becomes a small step in image-px around that point. The local
 * area scale is |det J| (units: px²/mm²), and its square root is a single
 * scalar linear scale (units: px/mm) that averages over direction.
 *
 * Why a scalar and not the full Jacobian
 * --------------------------------------
 * The Jacobian carries directional information — a tilted card has
 * different px/mm along the long axis vs. the short axis. For the eventual
 * measurement use ("how many millimetres is this many pixels?") consumers
 * may want one or the other depending on the measurement direction. We
 * return the isotropic scalar for now because it's what the existing
 * `framePct`-based guidance thresholds want (a single number per frame);
 * if a consumer later needs the directional version, exposing the
 * Jacobian as a separate function is a non-breaking add.
 */
export function pixelsPerMmAt(
  homography: CardHomography,
  cardPoint: Point
): number {
  const h = homography.cardToImage;
  const X = cardPoint.x;
  const Y = cardPoint.y;

  const u = h[0][0] * X + h[0][1] * Y + h[0][2];
  const v = h[1][0] * X + h[1][1] * Y + h[1][2];
  const w = h[2][0] * X + h[2][1] * Y + h[2][2];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) {
    throw new Error('pixelsPerMmAt: point projects to infinity (w ≈ 0)');
  }
  const w2 = w * w;

  // Quotient rule on x = u/w, y = v/w.
  const j00 = (h[0][0] * w - u * h[2][0]) / w2;
  const j01 = (h[0][1] * w - u * h[2][1]) / w2;
  const j10 = (h[1][0] * w - v * h[2][0]) / w2;
  const j11 = (h[1][1] * w - v * h[2][1]) / w2;

  const detJ = Math.abs(j00 * j11 - j01 * j10);
  return Math.sqrt(detJ);
}

// ---------------------------------------------------------------------------
// Solver internals
// ---------------------------------------------------------------------------

/**
 * Solve the planar homography H mapping `src` points to `dst` points.
 *
 * Uses Hartley normalization on both coordinate sets so the 8×8 DLT
 * system stays well-conditioned even when src and dst live at very
 * different scales (mm vs. pixels in our case).
 *
 *   1. Compute similarity transforms T_src, T_dst that recenter and
 *      rescale each set to unit-ish coordinates.
 *   2. Solve Ĥ on the normalized correspondences with h33 = 1.
 *   3. Denormalize: H = T_dst⁻¹ · Ĥ · T_src.
 *
 * Step (2) sets h33 = 1 rather than enforcing ||H|| = 1 because that
 * collapses the problem to a determined 8×8 linear solve (no SVD
 * dependency). For card-plane homographies the true h33 is never near
 * zero — the card plane is never edge-on to the camera — so this is safe
 * here. A more general implementation would use SVD nullspace.
 */
function solveHomography(src: Point[], dst: Point[]): Matrix3x3 {
  if (src.length !== dst.length || src.length !== 4) {
    throw new Error('solveHomography: need exactly 4 src/dst correspondences');
  }

  const { T: T_src, normalized: srcN } = hartleyNormalization(src);
  const { T: T_dst, normalized: dstN } = hartleyNormalization(dst);

  // Build 8×8 DLT system on normalized coordinates.
  //
  // For each (X, Y) → (x, y), with h33 = 1, the two scalar equations are
  //   X·h11 + Y·h12 + h13 − x·X·h31 − x·Y·h32 = x
  //   X·h21 + Y·h22 + h23 − y·X·h31 − y·Y·h32 = y
  // Unknown vector ordering: [h11, h12, h13, h21, h22, h23, h31, h32].
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x: X, y: Y } = srcN[i];
    const { x, y } = dstN[i];
    A.push([X, Y, 1, 0, 0, 0, -x * X, -x * Y]);
    b.push(x);
    A.push([0, 0, 0, X, Y, 1, -y * X, -y * Y]);
    b.push(y);
  }
  const h = solveLinearSystem(A, b);

  const Hn: Matrix3x3 = [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1],
  ];

  // Denormalize: H = T_dst⁻¹ · Ĥ · T_src.
  const T_dst_inv = invertMatrix3x3(T_dst);
  return multiplyMatrix3x3(multiplyMatrix3x3(T_dst_inv, Hn), T_src);
}

/**
 * Hartley normalization: translate the point set to have centroid at the
 * origin and uniformly scale so the mean distance from the origin is √2.
 *
 * Returns the similarity transform T (3×3) that maps original points to
 * normalized ones, along with the normalized points themselves. Calling
 * `applyHomography(T, p)` gives back the corresponding normalized point.
 *
 * Edge case: if all input points are coincident the mean distance is 0
 * and we fall back to no scaling (s = 1) — the downstream linear solve
 * will then fail with a singular-matrix error, which is the right outcome
 * (you can't fit a homography to four identical points).
 */
function hartleyNormalization(
  points: Point[]
): { T: Matrix3x3; normalized: Point[] } {
  const n = points.length;
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;

  let meanDist = 0;
  for (const p of points) {
    meanDist += Math.hypot(p.x - cx, p.y - cy);
  }
  meanDist /= n;

  const s = meanDist > 0 ? Math.SQRT2 / meanDist : 1;

  const T: Matrix3x3 = [
    [s, 0, -s * cx],
    [0, s, -s * cy],
    [0, 0, 1],
  ];

  const normalized: Point[] = points.map((p) => ({
    x: s * (p.x - cx),
    y: s * (p.y - cy),
  }));

  return { T, normalized };
}

/**
 * Solve A·x = b for square A using Gaussian elimination with partial
 * pivoting. Mutates A and b in place. Throws on singular systems.
 *
 * 8×8 is small enough that a more sophisticated factorization (LU, QR)
 * would be overkill; partial-pivoted elimination is numerically adequate
 * once the Hartley normalization above has equalized the row scales.
 */
function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = A.length;
  for (let k = 0; k < n; k++) {
    // Partial pivot: swap in the row with the largest |A[i][k]| below k.
    let maxAbs = Math.abs(A[k][k]);
    let pivotRow = k;
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(A[i][k]);
      if (v > maxAbs) {
        maxAbs = v;
        pivotRow = i;
      }
    }
    if (maxAbs < 1e-12) {
      throw new Error(
        'solveLinearSystem: matrix is singular (degenerate correspondences?)'
      );
    }
    if (pivotRow !== k) {
      const tmpRow = A[k];
      A[k] = A[pivotRow];
      A[pivotRow] = tmpRow;
      const tmpB = b[k];
      b[k] = b[pivotRow];
      b[pivotRow] = tmpB;
    }
    // Eliminate below the pivot.
    const pivot = A[k][k];
    for (let i = k + 1; i < n; i++) {
      const factor = A[i][k] / pivot;
      if (factor === 0) continue;
      for (let j = k; j < n; j++) {
        A[i][j] -= factor * A[k][j];
      }
      b[i] -= factor * b[k];
    }
  }
  // Back-substitution.
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = b[i];
    for (let j = i + 1; j < n; j++) {
      sum -= A[i][j] * x[j];
    }
    x[i] = sum / A[i][i];
  }
  return x;
}

/**
 * 3×3 matrix multiply, M = A · B. Inlined explicitly — at this fixed size
 * it's both faster and easier to audit than a triple-nested loop.
 */
function multiplyMatrix3x3(a: Matrix3x3, b: Matrix3x3): Matrix3x3 {
  return [
    [
      a[0][0] * b[0][0] + a[0][1] * b[1][0] + a[0][2] * b[2][0],
      a[0][0] * b[0][1] + a[0][1] * b[1][1] + a[0][2] * b[2][1],
      a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2] * b[2][2],
    ],
    [
      a[1][0] * b[0][0] + a[1][1] * b[1][0] + a[1][2] * b[2][0],
      a[1][0] * b[0][1] + a[1][1] * b[1][1] + a[1][2] * b[2][1],
      a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2] * b[2][2],
    ],
    [
      a[2][0] * b[0][0] + a[2][1] * b[1][0] + a[2][2] * b[2][0],
      a[2][0] * b[0][1] + a[2][1] * b[1][1] + a[2][2] * b[2][1],
      a[2][0] * b[0][2] + a[2][1] * b[1][2] + a[2][2] * b[2][2],
    ],
  ];
}

/**
 * Closed-form 3×3 inverse via the adjugate matrix. Throws if the matrix
 * is non-invertible (determinant ~ 0), which for a card-plane homography
 * would indicate either degenerate input corners or a numerical disaster
 * upstream — either way, the right behaviour is to fail loudly rather
 * than return a NaN-laden matrix that silently corrupts every downstream
 * measurement.
 */
function invertMatrix3x3(m: Matrix3x3): Matrix3x3 {
  const a = m[0][0],
    b = m[0][1],
    c = m[0][2];
  const d = m[1][0],
    e = m[1][1],
    f = m[1][2];
  const g = m[2][0],
    h = m[2][1],
    i = m[2][2];

  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-15) {
    throw new Error('invertMatrix3x3: matrix is non-invertible');
  }
  const invDet = 1 / det;
  return [
    [(e * i - f * h) * invDet, (c * h - b * i) * invDet, (b * f - c * e) * invDet],
    [(f * g - d * i) * invDet, (a * i - c * g) * invDet, (c * d - a * f) * invDet],
    [(d * h - e * g) * invDet, (b * g - a * h) * invDet, (a * e - b * d) * invDet],
  ];
}
