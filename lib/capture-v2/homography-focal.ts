/**
 * Focal-length estimate from a card-plane homography.
 *
 * Background
 * ----------
 * Given the projective map H from card-mm coordinates to image-px
 * coordinates (CardHomography.cardToImage), we can estimate the camera's
 * focal length in pixels under a simplified camera model:
 *
 *   K = [[f,  0, cx],    square pixels, no skew
 *        [0,  f, cy],
 *        [0,  0,  1]]
 *
 * H = λ · K · [r1 | r2 | t]
 *
 * where r1, r2 are the first two columns of the rotation matrix and λ is
 * an unknown overall scale that cancels out. Since r1 and r2 must be
 * orthonormal:
 *
 *   (i)  h1ᵀ B h2 = 0            (orthogonality)
 *   (ii) h1ᵀ B h1 = h2ᵀ B h2    (equal norms)
 *
 * where B = K⁻ᵀ K⁻¹ (the image of the absolute conic) and h1, h2 are the
 * first two columns of H.
 *
 * Assuming the principal point is at the image centre (cx = W/2, cy = H/2)
 * — a good approximation for modern phone cameras — each constraint yields
 * a closed-form estimate of f. See derivations inline below.
 *
 * Degeneracy
 * ----------
 * For a card viewed perfectly flat-on and centred, both constraint
 * denominators are near zero and neither estimate is valid. This is
 * correct: a fronto-parallel card at exact centre gives a scaled identity
 * homography from which any focal length is consistent. The estimate
 * becomes informative only when the card has measurable perspective
 * distortion (tilt > ~5°, or an off-centre position that makes the
 * principal-point correction non-trivial). When the denominator is near
 * zero, the affected estimate is returned as null rather than a large noisy
 * number.
 *
 * Both estimates are returned so the caller can sanity-check their
 * agreement. When both are positive, the best composite estimate is their
 * geometric mean.
 */

import type { CardHomography } from './card-homography';

export type HomographyFocalEstimate = {
  /**
   * Focal length estimate in pixels from the orthogonality constraint
   * h1ᵀ B h2 = 0. Generally more numerically robust than the norms
   * estimate at typical card poses.
   */
  focalLengthPxOrtho: number | null;
  /**
   * Focal length estimate in pixels from the equal-norms constraint
   * |K⁻¹h1| = |K⁻¹h2|. Can be unreliable when the card is symmetric
   * under 90° rotation relative to the camera axis.
   */
  focalLengthPxNorms: number | null;
  /**
   * Best composite estimate: geometric mean when both are positive;
   * the single available estimate otherwise; null if neither constraint
   * yields a positive f².
   */
  focalLengthPx: number | null;
};

/**
 * Estimate focal length in pixels from the card-plane homography.
 *
 * @param homography  CardHomography (must have residualPx < 1 to be trustworthy).
 * @param imageWidth  Width of the captured image in pixels (sets cx).
 * @param imageHeight Height of the captured image in pixels (sets cy).
 */
export function estimateFocalFromHomography(
  homography: CardHomography,
  imageWidth: number,
  imageHeight: number,
): HomographyFocalEstimate {
  const h = homography.cardToImage;
  const cx = imageWidth / 2;
  const cy = imageHeight / 2;

  // First and second columns of H (row-major storage: h[row][col])
  const h1x = h[0][0], h1y = h[1][0], h1z = h[2][0];
  const h2x = h[0][1], h2y = h[1][1], h2z = h[2][1];

  // Principal-point-shifted components:
  //   ã_i = h_ix − cx · h_iz
  //   b̃_i = h_iy − cy · h_iz
  const a1 = h1x - cx * h1z;
  const b1 = h1y - cy * h1z;
  const a2 = h2x - cx * h2z;
  const b2 = h2y - cy * h2z;

  // -----------------------------------------------------------------------
  // Orthogonality constraint: (ã1·ã2 + b̃1·b̃2)/f² + h1z·h2z = 0
  //   → f² = −(ã1·ã2 + b̃1·b̃2) / (h1z · h2z)
  // -----------------------------------------------------------------------
  let focalLengthPxOrtho: number | null = null;
  const orthoDen = h1z * h2z;
  if (Math.abs(orthoDen) > 1e-12) {
    const f2 = -(a1 * a2 + b1 * b2) / orthoDen;
    if (f2 > 0) focalLengthPxOrtho = Math.sqrt(f2);
  }

  // -----------------------------------------------------------------------
  // Equal-norms constraint: (ã1²+b̃1²−ã2²−b̃2²)/f² = h2z²−h1z²
  //   → f² = (ã1²+b̃1²−ã2²−b̃2²) / (h2z²−h1z²)
  // -----------------------------------------------------------------------
  let focalLengthPxNorms: number | null = null;
  const normsDen = h2z * h2z - h1z * h1z;
  if (Math.abs(normsDen) > 1e-12) {
    const f2 = (a1 * a1 + b1 * b1 - a2 * a2 - b2 * b2) / normsDen;
    if (f2 > 0) focalLengthPxNorms = Math.sqrt(f2);
  }

  // Best composite estimate
  let focalLengthPx: number | null = null;
  if (focalLengthPxOrtho !== null && focalLengthPxNorms !== null) {
    focalLengthPx = Math.sqrt(focalLengthPxOrtho * focalLengthPxNorms);
  } else {
    focalLengthPx = focalLengthPxOrtho ?? focalLengthPxNorms ?? null;
  }

  return { focalLengthPxOrtho, focalLengthPxNorms, focalLengthPx };
}
