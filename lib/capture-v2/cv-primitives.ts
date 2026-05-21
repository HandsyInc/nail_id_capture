/**
 * Classical-CV primitives, ported to TypeScript and typed arrays.
 *
 * Scope
 * -----
 * The narrow set of operations our card detector needs: grayscale conversion,
 * downsampling, Otsu thresholding, binary morphological close, connected-
 * component labeling, boundary extraction, convex hull, polygon approximation
 * (Ramer-Douglas-Peucker), and a handful of geometry helpers (area, arc
 * length, convexity, corner ordering).
 *
 * Why pure JS, not OpenCV.js
 * --------------------------
 * OpenCV.js is a single ~8MB WASM blob. For a live overlay that needs to
 * fire per video frame and start within a second of the user landing on
 * /capture-v2, that's a bad tradeoff. The card-detection pipeline only
 * touches a small slice of OpenCV, and the slice is well-understood
 * classical CV — implementable in a few hundred lines of TS that we own,
 * can profile, and can swap algorithms within without library upgrades.
 *
 * Relationship to the Python probe
 * --------------------------------
 * Where the Python probe used `cv2.findContours` + `cv2.approxPolyDP`,
 * this module substitutes connected-component labeling + boundary pixel
 * extraction + convex hull + RDP. For the card-detection use case the two
 * produce the same effective result: a credit card is a convex shape, so
 * the convex hull of its component IS its boundary, and RDP on the hull
 * yields the same four corners that approximating the raw contour would.
 * The substitution is cheaper to implement correctly and is more robust
 * to pixel-noise on the boundary than tracing the exact contour.
 *
 * Substitutions and omissions are explained at each function. Calibration
 * constants live in card-detector.ts, not here — this file is algorithm
 * primitives, not policy.
 */

export type Point = { x: number; y: number };

/**
 * A single-channel 8-bit image. We use a plain Uint8Array rather than
 * Uint8ClampedArray throughout (the clamped variant exists for canvas
 * ImageData and offers no benefit when we're managing the buffer ourselves).
 */
export type GrayImage = {
  data: Uint8Array;
  width: number;
  height: number;
};

// ---------------------------------------------------------------------------
// Colorspace + sampling
// ---------------------------------------------------------------------------

/**
 * Convert an RGBA buffer (as you'd get from `ctx.getImageData`) to a
 * single-channel grayscale image using the ITU-R BT.601 luma coefficients.
 * Integer math for speed — every multiplier is in 1/256ths of unity, so the
 * sum stays within 8 bits before the shift.
 */
export function rgbaToGray(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number
): GrayImage {
  const out = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    // 0.299 R + 0.587 G + 0.114 B, scaled into 8-bit fixed point
    out[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }
  return { data: out, width, height };
}

/**
 * Downsample a grayscale image so its long edge equals `longEdge` pixels,
 * preserving aspect ratio. Uses box-average sampling — each output pixel is
 * the mean of the input pixels that fall inside its source rectangle.
 *
 * Returns `{ img, scale }` where `scale = output / input`. The scale is
 * returned so callers can map detected geometry back to input coordinates
 * without rederiving it.
 *
 * Box averaging matches what OpenCV's `INTER_AREA` does for shrinking and
 * is the right choice for detection input: it suppresses aliasing without
 * the ringing artifacts a bicubic filter would introduce.
 */
export function downsampleGray(
  img: GrayImage,
  longEdge: number
): { img: GrayImage; scale: number } {
  const srcW = img.width;
  const srcH = img.height;
  const inputLong = Math.max(srcW, srcH);
  if (inputLong <= longEdge) {
    return { img, scale: 1 };
  }
  const scale = longEdge / inputLong;
  const dstW = Math.max(1, Math.round(srcW * scale));
  const dstH = Math.max(1, Math.round(srcH * scale));
  const dst = new Uint8Array(dstW * dstH);

  // Inverse mapping: for each destination pixel, average the source region
  // it covers. Using floor/ceil bounds rather than integer block sizes so
  // non-integer scale factors don't drift.
  const xScale = srcW / dstW;
  const yScale = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const y0 = Math.floor(dy * yScale);
    const y1 = Math.min(srcH, Math.ceil((dy + 1) * yScale));
    for (let dx = 0; dx < dstW; dx++) {
      const x0 = Math.floor(dx * xScale);
      const x1 = Math.min(srcW, Math.ceil((dx + 1) * xScale));
      let sum = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy++) {
        const rowBase = sy * srcW;
        for (let sx = x0; sx < x1; sx++) {
          sum += img.data[rowBase + sx];
          count++;
        }
      }
      dst[dy * dstW + dx] = count === 0 ? 0 : (sum / count) | 0;
    }
  }
  return { img: { data: dst, width: dstW, height: dstH }, scale };
}

// ---------------------------------------------------------------------------
// Thresholding
// ---------------------------------------------------------------------------

/**
 * Otsu's method: pick the threshold that maximizes between-class variance.
 *
 * Builds a 256-bin intensity histogram, then sweeps every possible cut and
 * picks the cut whose foreground/background split has the highest between-
 * class variance. The standard formulation; nothing exotic.
 *
 * Returns the threshold in the range [0, 255].
 */
export function otsuThreshold(img: GrayImage): number {
  const hist = new Int32Array(256);
  for (let i = 0; i < img.data.length; i++) hist[img.data[i]]++;

  const total = img.data.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];

  let sumBg = 0;
  let weightBg = 0;
  let bestThreshold = 0;
  let bestVariance = -1;

  for (let t = 0; t < 256; t++) {
    weightBg += hist[t];
    if (weightBg === 0) continue;
    const weightFg = total - weightBg;
    if (weightFg === 0) break;

    sumBg += t * hist[t];
    const meanBg = sumBg / weightBg;
    const meanFg = (sumAll - sumBg) / weightFg;
    const meanDiff = meanBg - meanFg;
    // Between-class variance: w0 * w1 * (mu0 - mu1)^2. We drop the constant
    // 1/N^2 factor — it doesn't affect the argmax.
    const variance = weightBg * weightFg * meanDiff * meanDiff;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = t;
    }
  }
  return bestThreshold;
}

/**
 * Binary threshold. Pixels strictly greater than `threshold` become 255 if
 * `invert` is false (standard `THRESH_BINARY`) or 0 if `invert` is true
 * (`THRESH_BINARY_INV`). The Python probe runs both polarities to handle
 * both "dark card on light background" and the rare inverse, so we keep
 * the same option here.
 */
export function binaryThreshold(
  img: GrayImage,
  threshold: number,
  invert: boolean
): GrayImage {
  const out = new Uint8Array(img.data.length);
  if (invert) {
    for (let i = 0; i < img.data.length; i++) {
      out[i] = img.data[i] > threshold ? 0 : 255;
    }
  } else {
    for (let i = 0; i < img.data.length; i++) {
      out[i] = img.data[i] > threshold ? 255 : 0;
    }
  }
  return { data: out, width: img.width, height: img.height };
}

// ---------------------------------------------------------------------------
// Binary morphology
// ---------------------------------------------------------------------------

/**
 * Binary dilation with a square (k×k) kernel. Implemented as two separable
 * 1D max-filters (horizontal then vertical), turning the per-pixel cost
 * from O(k^2) into O(k). For binary input the max is equivalent to a
 * logical OR over the window; we use a running count so the inner loop is
 * just additions and a comparison.
 */
function dilateBinarySquare(img: GrayImage, kernel: number): GrayImage {
  const r = (kernel - 1) >> 1;
  const { width, height, data } = img;
  const tmp = new Uint8Array(data.length);
  const out = new Uint8Array(data.length);

  // Horizontal pass.
  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    let onCount = 0;
    // Prime the window with the first r+1 pixels (the rest are out of bounds).
    for (let x = 0; x <= r && x < width; x++) {
      if (data[rowBase + x] !== 0) onCount++;
    }
    for (let x = 0; x < width; x++) {
      tmp[rowBase + x] = onCount > 0 ? 255 : 0;
      // Slide the window: drop the pixel that just fell off the left,
      // add the one entering on the right.
      const dropIdx = x - r;
      if (dropIdx >= 0 && data[rowBase + dropIdx] !== 0) onCount--;
      const addIdx = x + r + 1;
      if (addIdx < width && data[rowBase + addIdx] !== 0) onCount++;
    }
  }

  // Vertical pass over the horizontal result.
  for (let x = 0; x < width; x++) {
    let onCount = 0;
    for (let y = 0; y <= r && y < height; y++) {
      if (tmp[y * width + x] !== 0) onCount++;
    }
    for (let y = 0; y < height; y++) {
      out[y * width + x] = onCount > 0 ? 255 : 0;
      const dropY = y - r;
      if (dropY >= 0 && tmp[dropY * width + x] !== 0) onCount--;
      const addY = y + r + 1;
      if (addY < height && tmp[addY * width + x] !== 0) onCount++;
    }
  }
  return { data: out, width, height };
}

/**
 * Binary erosion — same separable structure as dilation but the window
 * needs to be *fully* on for the output to be on. Equivalent to a logical
 * AND over the window.
 */
function erodeBinarySquare(img: GrayImage, kernel: number): GrayImage {
  const r = (kernel - 1) >> 1;
  const { width, height, data } = img;
  const tmp = new Uint8Array(data.length);
  const out = new Uint8Array(data.length);

  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    let offCount = 0;
    // Window size depends on position near the edge — and pixels OUTSIDE
    // the image count as "off" for erosion (the border erodes inward,
    // matching OpenCV's default BORDER_CONSTANT with zero).
    let windowSize = 0;
    for (let x = 0; x <= r && x < width; x++) {
      windowSize++;
      if (data[rowBase + x] === 0) offCount++;
    }
    // Account for the r pixels that hang off the LEFT edge as "off".
    const leftOverhang = r;
    let pseudoOff = leftOverhang;
    for (let x = 0; x < width; x++) {
      // Total "off" in the conceptual k-wide window = real off + virtual off.
      tmp[rowBase + x] = offCount + pseudoOff === 0 ? 255 : 0;
      const dropIdx = x - r;
      if (dropIdx < 0) {
        // We just dropped a virtual "off" pixel from the left.
        pseudoOff--;
      } else if (data[rowBase + dropIdx] === 0) {
        offCount--;
      }
      const addIdx = x + r + 1;
      if (addIdx < width) {
        if (data[rowBase + addIdx] === 0) offCount++;
      } else {
        // Adding a virtual "off" pixel from the right.
        pseudoOff++;
      }
    }
  }

  for (let x = 0; x < width; x++) {
    let offCount = 0;
    for (let y = 0; y <= r && y < height; y++) {
      if (tmp[y * width + x] === 0) offCount++;
    }
    let pseudoOff = r;
    for (let y = 0; y < height; y++) {
      out[y * width + x] = offCount + pseudoOff === 0 ? 255 : 0;
      const dropY = y - r;
      if (dropY < 0) {
        pseudoOff--;
      } else if (tmp[dropY * width + x] === 0) {
        offCount--;
      }
      const addY = y + r + 1;
      if (addY < height) {
        if (tmp[addY * width + x] === 0) offCount++;
      } else {
        pseudoOff++;
      }
    }
  }
  return { data: out, width, height };
}

/**
 * Binary morphological close = dilate then erode. Closes holes/gaps in
 * foreground regions without growing the overall shape. The Python probe
 * sizes the kernel as ~1% of the image's short side; we accept the kernel
 * size as a parameter so the card detector can apply the same policy.
 *
 * If `kernel` ≤ 1 the input is returned unchanged.
 */
export function closeBinary(img: GrayImage, kernel: number): GrayImage {
  if (kernel <= 1) return img;
  // Force odd kernel size so the structuring element is centered.
  const k = kernel % 2 === 0 ? kernel + 1 : kernel;
  return erodeBinarySquare(dilateBinarySquare(img, k), k);
}

// ---------------------------------------------------------------------------
// Connected components
// ---------------------------------------------------------------------------

export type ComponentStats = {
  /** Pixel labels: 0 = background, ≥1 = component id. Length = width*height. */
  labels: Int32Array;
  /** Total number of components (excluding background). */
  count: number;
  /** Pixel count per component, indexed by id. sizes[0] is unused. */
  sizes: Int32Array;
  /** Bounding boxes per component, indexed by id. bboxes[0] is unused. */
  bboxes: { minX: number; minY: number; maxX: number; maxY: number }[];
};

/**
 * Two-pass connected-component labeling with 8-connectivity, using
 * union-find for label equivalence. Returns labels, pixel counts, and
 * bounding boxes per component.
 *
 * Background = pixel value 0. Anything non-zero is foreground.
 */
export function labelComponents(binary: GrayImage): ComponentStats {
  const { width, height, data } = binary;
  const labels = new Int32Array(width * height);
  // parent[] uses a regular number array because we may grow it dynamically.
  // For typical card images post-close the component count is in the hundreds,
  // not the millions, so the allocation cost is negligible.
  const parent: number[] = [0];

  function find(x: number): number {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    // Path compression — flatten the chain on the way back.
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Smaller label wins, which gives a deterministic final labeling.
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  }

  let nextLabel = 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (data[i] === 0) continue;

      // Examine the four already-labeled neighbors: NW, N, NE, W.
      let minNeighbor = 0;
      const candidates: number[] = [];
      if (y > 0) {
        if (x > 0) {
          const l = labels[i - width - 1];
          if (l !== 0) candidates.push(l);
        }
        const lN = labels[i - width];
        if (lN !== 0) candidates.push(lN);
        if (x < width - 1) {
          const l = labels[i - width + 1];
          if (l !== 0) candidates.push(l);
        }
      }
      if (x > 0) {
        const lW = labels[i - 1];
        if (lW !== 0) candidates.push(lW);
      }

      if (candidates.length === 0) {
        labels[i] = nextLabel;
        parent[nextLabel] = nextLabel;
        nextLabel++;
      } else {
        minNeighbor = candidates[0];
        for (let k = 1; k < candidates.length; k++) {
          if (candidates[k] < minNeighbor) minNeighbor = candidates[k];
        }
        labels[i] = minNeighbor;
        for (let k = 0; k < candidates.length; k++) {
          if (candidates[k] !== minNeighbor) union(minNeighbor, candidates[k]);
        }
      }
    }
  }

  // Second pass: collapse each label to its union-find root, then renumber
  // contiguously so callers can index into sizes/bboxes by component id.
  const remap = new Int32Array(nextLabel);
  let finalCount = 0;
  const sizes: number[] = [0];
  const bboxes: { minX: number; minY: number; maxX: number; maxY: number }[] = [
    { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  ];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const raw = labels[i];
      if (raw === 0) continue;
      const root = find(raw);
      let mapped = remap[root];
      if (mapped === 0) {
        finalCount++;
        mapped = finalCount;
        remap[root] = mapped;
        sizes.push(0);
        bboxes.push({
          minX: Infinity,
          minY: Infinity,
          maxX: -Infinity,
          maxY: -Infinity,
        });
      }
      labels[i] = mapped;
      sizes[mapped]++;
      const bb = bboxes[mapped];
      if (x < bb.minX) bb.minX = x;
      if (x > bb.maxX) bb.maxX = x;
      if (y < bb.minY) bb.minY = y;
      if (y > bb.maxY) bb.maxY = y;
    }
  }

  return {
    labels,
    count: finalCount,
    sizes: Int32Array.from(sizes),
    bboxes,
  };
}

/**
 * Collect the boundary pixels of a labeled component. A pixel is on the
 * boundary if it belongs to the component AND at least one 4-neighbor
 * does not (either a different label, or off the image entirely).
 *
 * We don't need ordered pixels — convex hull is order-independent and
 * that's what we feed these into.
 */
export function componentBoundaryPixels(
  labels: Int32Array,
  width: number,
  height: number,
  targetLabel: number,
  bbox: { minX: number; minY: number; maxX: number; maxY: number }
): Point[] {
  const out: Point[] = [];
  const minX = Math.max(0, bbox.minX);
  const maxX = Math.min(width - 1, bbox.maxX);
  const minY = Math.max(0, bbox.minY);
  const maxY = Math.min(height - 1, bbox.maxY);

  for (let y = minY; y <= maxY; y++) {
    const rowBase = y * width;
    for (let x = minX; x <= maxX; x++) {
      if (labels[rowBase + x] !== targetLabel) continue;
      // Image-edge pixels are always boundary pixels by convention.
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        out.push({ x, y });
        continue;
      }
      // Otherwise check the four neighbors.
      if (
        labels[rowBase + x - 1] !== targetLabel ||
        labels[rowBase + x + 1] !== targetLabel ||
        labels[rowBase - width + x] !== targetLabel ||
        labels[rowBase + width + x] !== targetLabel
      ) {
        out.push({ x, y });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Convex hull + polygon approximation
// ---------------------------------------------------------------------------

/**
 * Convex hull via Andrew's monotone chain. Returns hull vertices in
 * counter-clockwise order (when the y-axis points down, as in image
 * coordinates, the visual sense is clockwise — but the cross-product
 * sign convention used by isConvex below matches).
 *
 * Points on the hull edges (collinear) are dropped via the strict `<= 0`
 * comparison. For our use case that's the right behavior: we want the
 * minimal vertex set that still describes the hull.
 */
export function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return points.slice();
  const pts = points
    .slice()
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

  // Cross product of OA and OB vectors. Positive = counter-clockwise turn.
  const cross = (o: Point, a: Point, b: Point): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Point[] = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }
  // Last point of each half is the first point of the other half — drop it.
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Ramer-Douglas-Peucker polyline simplification.
 *
 * For a closed polygon, we run RDP twice — once on each "half" split at the
 * pair of points farthest apart — and concatenate. This is the same trick
 * OpenCV's `approxPolyDP(... closed=true)` uses internally; running RDP
 * once treating the polygon as an open polyline misses points on the
 * "wrong" side of the start/end pair.
 *
 * `epsilon` is the maximum allowed perpendicular distance from a kept
 * vertex's chord to a dropped vertex. The Python probe uses
 * `0.02 * arcLength` for the Otsu branch.
 */
export function approxPolyDP(
  polygon: Point[],
  epsilon: number,
  closed: boolean
): Point[] {
  if (polygon.length < 3) return polygon.slice();

  if (!closed) {
    return rdpRecursive(polygon, epsilon);
  }

  // Find the two points farthest apart; split the polygon there.
  let bestI = 0;
  let bestJ = 0;
  let bestDist = -1;
  for (let i = 0; i < polygon.length; i++) {
    for (let j = i + 1; j < polygon.length; j++) {
      const dx = polygon[i].x - polygon[j].x;
      const dy = polygon[i].y - polygon[j].y;
      const d = dx * dx + dy * dy;
      if (d > bestDist) {
        bestDist = d;
        bestI = i;
        bestJ = j;
      }
    }
  }
  // Slicing a closed polygon at (bestI, bestJ) yields two open polylines.
  const first = polygon.slice(bestI, bestJ + 1);
  const second = polygon.slice(bestJ).concat(polygon.slice(0, bestI + 1));
  const simpleA = rdpRecursive(first, epsilon);
  const simpleB = rdpRecursive(second, epsilon);
  // Drop the duplicated endpoints to keep the result a clean polygon.
  return simpleA.slice(0, -1).concat(simpleB.slice(0, -1));
}

function rdpRecursive(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points.slice();
  const first = points[0];
  const last = points[points.length - 1];
  let maxDist = 0;
  let maxIndex = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIndex = i;
    }
  }
  if (maxDist > epsilon) {
    const left = rdpRecursive(points.slice(0, maxIndex + 1), epsilon);
    const right = rdpRecursive(points.slice(maxIndex), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

function perpendicularDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) {
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return Math.sqrt(ex * ex + ey * ey);
  }
  // |cross| / |b-a| is the perpendicular distance from p to the line ab.
  const num = Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x);
  const den = Math.sqrt(dx * dx + dy * dy);
  return num / den;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Shoelace area. Sign indicates winding; callers that want unsigned area
 * should take Math.abs of the result.
 */
export function contourArea(polygon: Point[]): number {
  if (polygon.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/**
 * Perimeter (or open-path length if `closed` is false).
 */
export function arcLength(polygon: Point[], closed: boolean): number {
  if (polygon.length < 2) return 0;
  let total = 0;
  const end = closed ? polygon.length : polygon.length - 1;
  for (let i = 0; i < end; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return total;
}

/**
 * Is the polygon convex? Checks that every consecutive triple turns in the
 * same direction. Returns false on degenerate (zero-area) polygons.
 */
export function isConvex(polygon: Point[]): boolean {
  if (polygon.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const c = polygon[(i + 2) % polygon.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (sign !== s) return false;
    }
  }
  return sign !== 0;
}

/**
 * Reorder four corners into a stable [TL, TR, BR, BL] sequence, matching
 * the convention used in probe.py for downstream consumers.
 *
 * The trick: sort by (x + y) and (y - x). TL has the smallest sum, BR the
 * largest. TR has the smallest (y - x), BL the largest. Works for any
 * affine-ish projection of a rectangle and doesn't require any prior
 * winding-order assumption from the input.
 */
export function orderCorners(corners: Point[]): Point[] {
  if (corners.length !== 4) {
    throw new Error(`orderCorners expects 4 points, got ${corners.length}`);
  }
  const sums = corners.map((p) => p.x + p.y);
  const diffs = corners.map((p) => p.y - p.x);
  let tlIdx = 0;
  let brIdx = 0;
  let trIdx = 0;
  let blIdx = 0;
  for (let i = 1; i < 4; i++) {
    if (sums[i] < sums[tlIdx]) tlIdx = i;
    if (sums[i] > sums[brIdx]) brIdx = i;
    if (diffs[i] < diffs[trIdx]) trIdx = i;
    if (diffs[i] > diffs[blIdx]) blIdx = i;
  }
  return [corners[tlIdx], corners[trIdx], corners[brIdx], corners[blIdx]];
}

/**
 * Long / short edge lengths of an ordered four-corner quadrilateral
 * (TL, TR, BR, BL). Returned as `{ long, short }` so callers don't need
 * to recompute aspect ratio from raw corner coordinates.
 */
export function quadEdges(corners: Point[]): { long: number; short: number } {
  if (corners.length !== 4) {
    throw new Error(`quadEdges expects 4 points, got ${corners.length}`);
  }
  const [tl, tr, br, bl] = corners;
  const top = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const right = Math.hypot(br.x - tr.x, br.y - tr.y);
  const bottom = Math.hypot(br.x - bl.x, br.y - bl.y);
  const left = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  // Average the parallel pairs first — this is what probe.py does — so a
  // slightly trapezoidal capture doesn't get an outsized horizontal or
  // vertical from one side alone.
  const horizontal = (top + bottom) / 2;
  const vertical = (left + right) / 2;
  return {
    long: Math.max(horizontal, vertical),
    short: Math.min(horizontal, vertical),
  };
}
