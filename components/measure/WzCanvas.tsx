'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  type Point,
  type Station,
  type CropRegion,
  STATIONS,
  STATION_FRACTIONS,
  CLICK_SEQUENCE,
  TOTAL_STEPS,
  activeStation,
  computeCropRegion,
  stationLineEndpoints,
  stationPoint,
  computeWz,
} from '@/lib/measure/wz-geometry';

// ---------------------------------------------------------------------------
// Measurement Provenance — W(z) scaffold
// ---------------------------------------------------------------------------
//
// When a W(z) accept route is built (future sprint), each accepted station
// measurement should store MeasurementProvenance<Point> for both its left
// and right sidewall placements:
//
//   import {
//     type MeasurementProvenance,
//     type ComputerProposal,
//     buildPointProvenance,
//   } from '@/lib/measure/provenance';
//
//   For purely manual measurements (current):
//     T = Point
//     method = 'MANUAL'   (no computer proposal; computerProposal = null)
//
//   When auto-detection is added (e.g. station edge-detect):
//     T = Point
//     method = 'STATION_EDGE_DETECT'
//     computerProposal.value = auto-detected sidewall Point (px)
//     computerProposal.score = edge contrast score
//     founderValue           = the Point the founder accepted
//     correctionMagnitude    = Euclidean px distance (proposal vs. accepted)
//
//   One SidewallProvenance per station per sidewall:
//     type StationRecord = {
//       station:       Station;
//       leftPx:        Point;
//       rightPx:       Point;
//       leftProv:      MeasurementProvenance<Point>;   ← add when accept route built
//       rightProv:     MeasurementProvenance<Point>;   ← add when accept route built
//       widthPx:       number;
//       widthMm:       number | null;
//     };
//
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SidewallState = {
  left:  Point | null;
  right: Point | null;
};

export type ImageMeasurementState = {
  step:      number;
  pointA:    Point | null;
  pointB:    Point | null;
  sidewalls: Record<Station, SidewallState>;
  result:    ReturnType<typeof computeWz> | null;
};

export function emptyMeasurementState(): ImageMeasurementState {
  return {
    step:   0,
    pointA: null,
    pointB: null,
    sidewalls: {
      z25:  { left: null, right: null },
      z50:  { left: null, right: null },
      z75:  { left: null, right: null },
      z100: { left: null, right: null },
    },
    result: null,
  };
}

export function imageStatus(
  state: ImageMeasurementState,
): 'not_started' | 'in_progress' | 'complete' {
  if (state.step === 0)          return 'not_started';
  if (state.step >= TOTAL_STEPS) return 'complete';
  return 'in_progress';
}

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

type Phase = 'axis' | 'station' | 'review';

function getPhase(step: number): Phase {
  if (step < 2)            return 'axis';
  if (step >= TOTAL_STEPS) return 'review';
  return 'station';
}

// ---------------------------------------------------------------------------
// Letterbox helpers
// ---------------------------------------------------------------------------

/**
 * A rectangle in CSS-pixel space that describes where the image is drawn
 * inside the canvas while preserving its natural aspect ratio (object-fit:contain).
 * dx/dy = top-left offset; dw/dh = drawn dimensions.
 */
type LbRect = { dx: number; dy: number; dw: number; dh: number };

function computeLetterbox(imgW: number, imgH: number, canvasW: number, canvasH: number): LbRect {
  const imgAspect    = imgW / imgH;
  const canvasAspect = canvasW / canvasH;
  let dw: number, dh: number;
  if (imgAspect > canvasAspect) {
    // image is relatively wider → constrain by canvas width
    dw = canvasW;
    dh = canvasW / imgAspect;
  } else {
    // image is relatively taller → constrain by canvas height
    dh = canvasH;
    dw = canvasH * imgAspect;
  }
  return {
    dx: (canvasW - dw) / 2,
    dy: (canvasH - dh) / 2,
    dw,
    dh,
  };
}

// ---------------------------------------------------------------------------
// Coordinate helpers (all in CSS pixels; DPR is handled at the canvas level)
// ---------------------------------------------------------------------------

/**
 * Convert a natural-image point to canvas CSS pixels using a full-image
 * letterbox rect.
 */
function natToDisp(p: Point, natW: number, natH: number, lb: LbRect): Point {
  return {
    x: lb.dx + (p.x / natW) * lb.dw,
    y: lb.dy + (p.y / natH) * lb.dh,
  };
}

/**
 * Convert a natural-image point to canvas CSS pixels using a crop-region
 * letterbox rect (station zoom mode).
 */
function natToDispCropped(p: Point, crop: CropRegion, lb: LbRect): Point {
  return {
    x: lb.dx + ((p.x - crop.x) / crop.w) * lb.dw,
    y: lb.dy + ((p.y - crop.y) / crop.h) * lb.dh,
  };
}

/**
 * Convert a mouse click to natural image coordinates (full-image letterbox).
 * Returns null if the click landed outside the drawn image area.
 */
function clickToNatural(
  clickX: number,
  clickY: number,
  rect:   DOMRect,
  lb:     LbRect,
  natW:   number,
  natH:   number,
): Point | null {
  const cx = clickX - rect.left;
  const cy = clickY - rect.top;
  if (cx < lb.dx || cx > lb.dx + lb.dw || cy < lb.dy || cy > lb.dy + lb.dh) return null;
  return {
    x: ((cx - lb.dx) / lb.dw) * natW,
    y: ((cy - lb.dy) / lb.dh) * natH,
  };
}

/**
 * Convert a mouse click to natural image coordinates (crop-region letterbox).
 * Returns null if the click landed outside the drawn image area.
 */
function clickToNaturalCropped(
  clickX: number,
  clickY: number,
  rect:   DOMRect,
  lb:     LbRect,
  crop:   CropRegion,
): Point | null {
  const cx = clickX - rect.left;
  const cy = clickY - rect.top;
  if (cx < lb.dx || cx > lb.dx + lb.dw || cy < lb.dy || cy > lb.dy + lb.dh) return null;
  return {
    x: crop.x + ((cx - lb.dx) / lb.dw) * crop.w,
    y: crop.y + ((cy - lb.dy) / lb.dh) * crop.h,
  };
}

// ---------------------------------------------------------------------------
// Drawing constants
// ---------------------------------------------------------------------------

const DOT_R          = 7;
const AXIS_COLOR     = 'rgba(250,204,21,0.7)';
const STATION_COLOR  = '#38bdf8';
const SIDEWALL_COLOR = '#4ade80';
const WIDTH_COLOR    = '#4ade80';
const DOT_A_COLOR    = '#f97316';
const DOT_B_COLOR    = '#f97316';

// ---------------------------------------------------------------------------
// Drawing primitives (all coordinates in CSS pixels)
// ---------------------------------------------------------------------------

function dot(
  ctx:    CanvasRenderingContext2D,
  dp:     Point,
  color:  string,
  radius: number,
  label:  string,
) {
  ctx.beginPath();
  ctx.arc(dp.x, dp.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.font        = `bold ${radius + 5}px monospace`;
  ctx.lineWidth   = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.strokeText(label, dp.x + radius + 3, dp.y - 3);
  ctx.fillStyle = '#fff';
  ctx.fillText(label, dp.x + radius + 3, dp.y - 3);
}

function line(
  ctx:   CanvasRenderingContext2D,
  dp1:   Point,
  dp2:   Point,
  color: string,
  width: number,
  dash:  number[] = [],
) {
  ctx.beginPath();
  ctx.moveTo(dp1.x, dp1.y);
  ctx.lineTo(dp2.x, dp2.y);
  ctx.strokeStyle = color;
  ctx.lineWidth   = width;
  ctx.setLineDash(dash);
  ctx.stroke();
  ctx.setLineDash([]);
}

// ---------------------------------------------------------------------------
// Phase-specific draw functions
// All take lb (letterbox) instead of raw dw/dh.
// ---------------------------------------------------------------------------

function drawAxisPhase(
  ctx:   CanvasRenderingContext2D,
  state: ImageMeasurementState,
  natW:  number,
  natH:  number,
  lb:    LbRect,
) {
  const toD = (p: Point) => natToDisp(p, natW, natH, lb);
  if (state.pointA && state.pointB) {
    line(ctx, toD(state.pointA), toD(state.pointB), AXIS_COLOR, 1.5, [6, 4]);
  }
  if (state.pointA) dot(ctx, toD(state.pointA), DOT_A_COLOR, DOT_R, 'A');
  if (state.pointB) dot(ctx, toD(state.pointB), DOT_B_COLOR, DOT_R, 'B');
}

function drawStationPhase(
  ctx:     CanvasRenderingContext2D,
  state:   ImageMeasurementState,
  station: Station,
  crop:    CropRegion,
  natW:    number,
  natH:    number,
  lb:      LbRect,
) {
  const A = state.pointA;
  const B = state.pointB;
  if (!A || !B) return;

  const toD = (p: Point) => natToDispCropped(p, crop, lb);

  // Station line: halfLen large enough that ctx.stroke() clips it at canvas edges
  const halfLen     = Math.max(natW, natH) * 2;
  const t           = STATION_FRACTIONS[station];
  const [ep1, ep2]  = stationLineEndpoints(A, B, t, halfLen);
  line(ctx, toD(ep1), toD(ep2), STATION_COLOR, 2.5);

  // Station label
  const center = stationPoint(A, B, t);
  const dc     = toD(center);
  const pct    = Math.round(t * 100);
  ctx.font        = 'bold 14px monospace';
  ctx.fillStyle   = STATION_COLOR;
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth   = 3;
  ctx.strokeText(`z${pct}%`, dc.x + 6, dc.y - 8);
  ctx.fillText(`z${pct}%`, dc.x + 6, dc.y - 8);

  // Placed sidewall dots
  const sw = state.sidewalls[station];
  if (sw.left)  dot(ctx, toD(sw.left),  SIDEWALL_COLOR, DOT_R, 'L');
  if (sw.right) dot(ctx, toD(sw.right), SIDEWALL_COLOR, DOT_R, 'R');

  // Width line when both placed
  if (sw.left && sw.right) {
    line(ctx, toD(sw.left), toD(sw.right), WIDTH_COLOR, 2.5);
  }
}

function drawReviewPhase(
  ctx:   CanvasRenderingContext2D,
  state: ImageMeasurementState,
  natW:  number,
  natH:  number,
  lb:    LbRect,
) {
  const A = state.pointA;
  const B = state.pointB;
  if (!A || !B) return;

  const toD     = (p: Point) => natToDisp(p, natW, natH, lb);
  const halfLen = natW * 0.20;

  line(ctx, toD(A), toD(B), AXIS_COLOR, 1.5, [6, 4]);

  for (const s of STATIONS) {
    const t          = STATION_FRACTIONS[s];
    const [ep1, ep2] = stationLineEndpoints(A, B, t, halfLen);
    line(ctx, toD(ep1), toD(ep2), STATION_COLOR, 1.5);

    const center = stationPoint(A, B, t);
    const dc     = toD(center);
    ctx.font        = '11px monospace';
    ctx.fillStyle   = STATION_COLOR;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth   = 2.5;
    ctx.strokeText(s, dc.x + 4, dc.y - 5);
    ctx.fillText(s, dc.x + 4, dc.y - 5);

    const sw = state.sidewalls[s];
    if (sw.left)  dot(ctx, toD(sw.left),  SIDEWALL_COLOR, DOT_R - 1, 'L');
    if (sw.right) dot(ctx, toD(sw.right), SIDEWALL_COLOR, DOT_R - 1, 'R');
    if (sw.left && sw.right) {
      line(ctx, toD(sw.left), toD(sw.right), WIDTH_COLOR, 2);
    }
  }

  dot(ctx, toD(A), DOT_A_COLOR, DOT_R, 'A');
  dot(ctx, toD(B), DOT_B_COLOR, DOT_R, 'B');
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Props = {
  imageUrl:      string;
  naturalSize:   { w: number; h: number } | null;
  onNaturalSize: (size: { w: number; h: number }) => void;
  state:         ImageMeasurementState;
  onStateChange: (next: ImageMeasurementState) => void;
};

export function WzCanvas({
  imageUrl,
  naturalSize,
  onNaturalSize,
  state,
  onStateChange,
}: Props) {
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const imgRef        = useRef<HTMLImageElement | null>(null);
  const [flashStation, setFlashStation] = useState<Station | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (flashTimerRef.current) clearTimeout(flashTimerRef.current); };
  }, []);

  // Load image
  useEffect(() => {
    const img  = new Image();
    img.onload = () => {
      onNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
      imgRef.current = img;
      redraw();
    };
    img.src = imageUrl;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl]);

  // Redraw whenever state, naturalSize, or flash changes
  useEffect(() => {
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, naturalSize, flashStation]);

  function redraw() {
    const canvas = canvasRef.current;
    const img    = imgRef.current;
    if (!canvas || !img || !naturalSize) return;

    // CSS dimensions (layout pixels)
    const cssW = canvas.offsetWidth;
    const cssH = canvas.offsetHeight;
    if (cssW === 0 || cssH === 0) return;

    // ── DPR scaling ────────────────────────────────────────────────────────
    // Set the canvas buffer to physical pixels, then scale the context so all
    // subsequent drawing commands are expressed in CSS pixels.
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    // ── Phase & display station ─────────────────────────────────────────────
    const displayStation = flashStation ?? activeStation(state.step);
    const phase: Phase   = displayStation
      ? 'station'
      : state.step < 2
        ? 'axis'
        : 'review';

    // ── Draw image + overlay ────────────────────────────────────────────────
    if (phase === 'station' && displayStation && state.pointA && state.pointB) {
      const crop = computeCropRegion(
        state.pointA,
        state.pointB,
        displayStation,
        naturalSize.w,
        naturalSize.h,
      );
      // Letterbox the crop region into the canvas
      const lb = computeLetterbox(crop.w, crop.h, cssW, cssH);
      ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, lb.dx, lb.dy, lb.dw, lb.dh);
      drawStationPhase(ctx, state, displayStation, crop, naturalSize.w, naturalSize.h, lb);

    } else {
      // Full image letterboxed into canvas
      const lb = computeLetterbox(naturalSize.w, naturalSize.h, cssW, cssH);
      ctx.drawImage(img, 0, 0, naturalSize.w, naturalSize.h, lb.dx, lb.dy, lb.dw, lb.dh);
      if (phase === 'axis') {
        drawAxisPhase(ctx, state, naturalSize.w, naturalSize.h, lb);
      } else {
        drawReviewPhase(ctx, state, naturalSize.w, naturalSize.h, lb);
      }
    }
  }

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (flashStation)              return;
      if (state.step >= TOTAL_STEPS) return;
      if (!naturalSize)              return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect  = canvas.getBoundingClientRect(); // CSS pixels
      const cssW  = rect.width;
      const cssH  = rect.height;
      const phase = getPhase(state.step);

      let pt: Point | null;

      if (phase === 'station' && state.pointA && state.pointB) {
        const crop = computeCropRegion(
          state.pointA,
          state.pointB,
          activeStation(state.step)!,
          naturalSize.w,
          naturalSize.h,
        );
        const lb = computeLetterbox(crop.w, crop.h, cssW, cssH);
        pt = clickToNaturalCropped(e.clientX, e.clientY, rect, lb, crop);
      } else {
        const lb = computeLetterbox(naturalSize.w, naturalSize.h, cssW, cssH);
        pt = clickToNatural(e.clientX, e.clientY, rect, lb, naturalSize.w, naturalSize.h);
      }

      // Ignore clicks in the letterbox bars
      if (!pt) return;

      const target = CLICK_SEQUENCE[state.step];

      const next: ImageMeasurementState = {
        ...state,
        sidewalls: {
          z25:  { ...state.sidewalls.z25  },
          z50:  { ...state.sidewalls.z50  },
          z75:  { ...state.sidewalls.z75  },
          z100: { ...state.sidewalls.z100 },
        },
        step: state.step + 1,
      };

      if (target.kind === 'axis') {
        if (target.label === 'A') next.pointA = pt;
        else                      next.pointB = pt;
      } else {
        next.sidewalls[target.station] = {
          ...next.sidewalls[target.station],
          [target.side]: pt,
        };
      }

      if (next.step === TOTAL_STEPS && next.pointA && next.pointB) {
        next.result = computeWz(
          next.pointA,
          next.pointB,
          next.sidewalls as Record<Station, { left: Point; right: Point }>,
        );
      }

      if (target.kind === 'sidewall' && target.side === 'right') {
        setFlashStation(target.station);
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => setFlashStation(null), 550);
      }

      onStateChange(next);
    },
    [state, naturalSize, flashStation, onStateChange],
  );

  const isComplete = state.step >= TOTAL_STEPS;

  return (
    <canvas
      ref={canvasRef}
      onClick={handleClick}
      className="w-full h-full block"
      style={{ cursor: isComplete || flashStation ? 'default' : 'crosshair' }}
    />
  );
}
