/**
 * W(z) geometry — pure functions, no React, no side effects.
 *
 * All coordinates are in NATURAL IMAGE PIXELS (not canvas display pixels).
 * Callers must convert click coordinates from display space before passing
 * them here.
 *
 * Coordinate system: x = right, y = down (standard image coordinates).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Point = { x: number; y: number };
export type Vector = { x: number; y: number };

export type Station = 'z25' | 'z50' | 'z75' | 'z100';
export const STATIONS: Station[] = ['z25', 'z50', 'z75', 'z100'];
export const STATION_FRACTIONS: Record<Station, number> = {
  z25: 0.25,
  z50: 0.50,
  z75: 0.75,
  z100: 1.00,
};

export type SidewallState = {
  left: Point | null;
  right: Point | null;
};

export type WzLandmarks = {
  A: Point;       // cuticle center
  B: Point;       // free-edge center
  z25: SidewallState;
  z50: SidewallState;
  z75: SidewallState;
  z100: SidewallState;
};

export type WzResult = {
  L_px: number;
  W25_px: number;
  W50_px: number;
  W75_px: number;
  W100_px: number;
  Wmax_px: number;
  Wmax_position_pct: number; // 25 | 50 | 75 | 100
  retention_pct: number;     // W100 / Wmax × 100
};

// ---------------------------------------------------------------------------
// Basic geometry
// ---------------------------------------------------------------------------

export function distancePx(P1: Point, P2: Point): number {
  return Math.hypot(P2.x - P1.x, P2.y - P1.y);
}

/** Unit vector from A toward B. Returns {x:0,y:1} for degenerate (A===B). */
export function axisVector(A: Point, B: Point): Vector {
  const len = distancePx(A, B);
  if (len < 0.001) return { x: 0, y: 1 };
  return { x: (B.x - A.x) / len, y: (B.y - A.y) / len };
}

/** Unit vector perpendicular to the A→B axis (90° CCW). */
export function perpVector(A: Point, B: Point): Vector {
  const ax = axisVector(A, B);
  return { x: -ax.y, y: ax.x };
}

/** Point at fraction t along A→B (t=0 → A, t=1 → B). */
export function stationPoint(A: Point, B: Point, t: number): Point {
  return {
    x: A.x + (B.x - A.x) * t,
    y: A.y + (B.y - A.y) * t,
  };
}

/**
 * Two endpoints of the station line drawn through stationPoint(A,B,t),
 * perpendicular to A→B, extending halfLen pixels in each direction.
 */
export function stationLineEndpoints(
  A: Point,
  B: Point,
  t: number,
  halfLen: number,
): [Point, Point] {
  const center = stationPoint(A, B, t);
  const perp = perpVector(A, B);
  return [
    { x: center.x - perp.x * halfLen, y: center.y - perp.y * halfLen },
    { x: center.x + perp.x * halfLen, y: center.y + perp.y * halfLen },
  ];
}

// ---------------------------------------------------------------------------
// Full W(z) result
// ---------------------------------------------------------------------------

/**
 * Compute all W(z) outputs from a complete set of landmarks.
 * All inputs must be non-null (caller should check step === 10 first).
 */
export function computeWz(
  A: Point,
  B: Point,
  sidewalls: Record<Station, SidewallState>,
): WzResult {
  const L_px = distancePx(A, B);

  const W25_px  = distancePx(sidewalls.z25.left!,  sidewalls.z25.right!);
  const W50_px  = distancePx(sidewalls.z50.left!,  sidewalls.z50.right!);
  const W75_px  = distancePx(sidewalls.z75.left!,  sidewalls.z75.right!);
  const W100_px = distancePx(sidewalls.z100.left!, sidewalls.z100.right!);

  const widths: [number, Station][] = [
    [W25_px,  'z25'],
    [W50_px,  'z50'],
    [W75_px,  'z75'],
    [W100_px, 'z100'],
  ];

  const [Wmax_px, Wmax_station] = widths.reduce(
    (best, cur) => (cur[0] > best[0] ? cur : best),
    widths[0],
  );

  const Wmax_position_pct = STATION_FRACTIONS[Wmax_station] * 100;
  const retention_pct = Wmax_px > 0 ? (W100_px / Wmax_px) * 100 : 0;

  return {
    L_px,
    W25_px,
    W50_px,
    W75_px,
    W100_px,
    Wmax_px,
    Wmax_position_pct,
    retention_pct,
  };
}

// ---------------------------------------------------------------------------
// Click-sequence helpers
// ---------------------------------------------------------------------------

/**
 * The ordered click sequence for a single image.
 * step 0  → place A
 * step 1  → place B
 * steps 2–9 → sidewall clicks in this order
 */
export type ClickTarget =
  | { kind: 'axis'; label: 'A' | 'B' }
  | { kind: 'sidewall'; station: Station; side: 'left' | 'right' };

export const CLICK_SEQUENCE: ClickTarget[] = [
  { kind: 'axis', label: 'A' },
  { kind: 'axis', label: 'B' },
  { kind: 'sidewall', station: 'z25',  side: 'left'  },
  { kind: 'sidewall', station: 'z25',  side: 'right' },
  { kind: 'sidewall', station: 'z50',  side: 'left'  },
  { kind: 'sidewall', station: 'z50',  side: 'right' },
  { kind: 'sidewall', station: 'z75',  side: 'left'  },
  { kind: 'sidewall', station: 'z75',  side: 'right' },
  { kind: 'sidewall', station: 'z100', side: 'left'  },
  { kind: 'sidewall', station: 'z100', side: 'right' },
];

export const TOTAL_STEPS = CLICK_SEQUENCE.length; // 10

export function stepPrompt(step: number): string {
  if (step >= TOTAL_STEPS) return '✓ Complete — review measurements below';
  const target = CLICK_SEQUENCE[step];
  if (target.kind === 'axis') {
    return target.label === 'A'
      ? 'Step 1 — click A: cuticle center'
      : 'Step 2 — click B: free-edge center';
  }
  const pct      = Math.round(STATION_FRACTIONS[target.station] * 100);
  const side     = target.side === 'left' ? 'LEFT' : 'RIGHT';
  const stnNum   = STATIONS.indexOf(target.station) + 1;
  return `Station ${stnNum}/4 · z${pct}% — click ${side} sidewall`;
}

// ---------------------------------------------------------------------------
// Coordinate conversion — full image
// ---------------------------------------------------------------------------

/**
 * Convert a canvas display-space click to natural image pixel coordinates.
 * rect = canvas.getBoundingClientRect()
 */
export function displayToNatural(
  clickX: number,
  clickY: number,
  rect: DOMRect,
  naturalW: number,
  naturalH: number,
): Point {
  const scaleX = naturalW / rect.width;
  const scaleY = naturalH / rect.height;
  return {
    x: (clickX - rect.left) * scaleX,
    y: (clickY - rect.top) * scaleY,
  };
}

// ---------------------------------------------------------------------------
// Zoom / crop helpers
// ---------------------------------------------------------------------------

/** Axis-aligned crop rectangle in natural image pixels. */
export type CropRegion = { x: number; y: number; w: number; h: number };

/**
 * Which station is currently active, derived from click step.
 * Returns null during axis phase (step 0–1) and review phase (step >= 10).
 */
export function activeStation(step: number): Station | null {
  if (step < 2 || step >= TOTAL_STEPS) return null;
  return STATIONS[Math.floor((step - 2) / 2)];
}

/**
 * Compute the crop rectangle (natural image pixels) to zoom into a station.
 * Centered on the station point with generous margins so both sidewalls are
 * clearly visible even for wide nails.
 */
export function computeCropRegion(
  A: Point,
  B: Point,
  station: Station,
  naturalW: number,
  naturalH: number,
): CropRegion {
  const t      = STATION_FRACTIONS[station];
  const center = stationPoint(A, B, t);
  const L      = distancePx(A, B);

  // Size: 45% of nail length, minimum 22% of image short-edge.
  const size = Math.max(L * 0.45, Math.min(naturalW, naturalH) * 0.22);

  // Cap to image dimensions, then clamp origin so we never go OOB.
  const w = Math.min(size, naturalW);
  const h = Math.min(size, naturalH);
  const x = Math.max(0, Math.min(naturalW - w, center.x - w / 2));
  const y = Math.max(0, Math.min(naturalH - h, center.y - h / 2));

  return { x, y, w, h };
}

/**
 * Convert a natural image coordinate to canvas display position inside a
 * crop region (zoomed view).
 */
export function naturalToDisplayCropped(
  p: Point,
  crop: CropRegion,
  displayW: number,
  displayH: number,
): Point {
  return {
    x: ((p.x - crop.x) / crop.w) * displayW,
    y: ((p.y - crop.y) / crop.h) * displayH,
  };
}

/**
 * Convert a canvas display-space click to natural image coordinates inside a
 * crop region (zoomed view).
 */
export function displayToNaturalCropped(
  clickX: number,
  clickY: number,
  rect: DOMRect,
  crop: CropRegion,
): Point {
  return {
    x: crop.x + ((clickX - rect.left) / rect.width)  * crop.w,
    y: crop.y + ((clickY - rect.top)  / rect.height) * crop.h,
  };
}
