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
  naturalToDisplayCropped,
  displayToNatural,
  displayToNaturalCropped,
  stationLineEndpoints,
  stationPoint,
  distancePx,
  computeWz,
} from '@/lib/measure/wz-geometry';

// ---------------------------------------------------------------------------
// Public types (re-exported for use in parent components)
// ---------------------------------------------------------------------------

export type SidewallState = {
  left:  Point | null;
  right: Point | null;
};

export type ImageMeasurementState = {
  /** 0 = awaiting A … 10 = all points placed */
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
  if (state.step === 0)           return 'not_started';
  if (state.step >= TOTAL_STEPS)  return 'complete';
  return 'in_progress';
}

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

type Phase = 'axis' | 'station' | 'review';

function getPhase(step: number): Phase {
  if (step < 2)             return 'axis';
  if (step >= TOTAL_STEPS)  return 'review';
  return 'station';
}

// ---------------------------------------------------------------------------
// Drawing constants
// ---------------------------------------------------------------------------

const DOT_R          = 7;
const AXIS_COLOR     = 'rgba(250,204,21,0.7)';   // yellow
const STATION_COLOR  = '#38bdf8';                 // sky blue
const SIDEWALL_COLOR = '#4ade80';                 // green
const WIDTH_COLOR    = '#4ade80';
const DOT_A_COLOR    = '#f97316';
const DOT_B_COLOR    = '#f97316';

// ---------------------------------------------------------------------------
// Helper: natural → display for FULL image
// ---------------------------------------------------------------------------

function fullToDisplay(
  p: Point,
  natW: number,
  natH: number,
  dw: number,
  dh: number,
): Point {
  return { x: (p.x / natW) * dw, y: (p.y / natH) * dh };
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

function dot(
  ctx: CanvasRenderingContext2D,
  dp: Point,
  color: string,
  radius: number,
  label: string,
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
  ctx: CanvasRenderingContext2D,
  dp1: Point,
  dp2: Point,
  color: string,
  width: number,
  dash: number[] = [],
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
// Phase draw functions
// ---------------------------------------------------------------------------

/** Axis phase: full image, A and/or B dots only. */
function drawAxisPhase(
  ctx: CanvasRenderingContext2D,
  state: ImageMeasurementState,
  natW: number,
  natH: number,
  dw: number,
  dh: number,
) {
  const toD = (p: Point) => fullToDisplay(p, natW, natH, dw, dh);
  if (state.pointA && state.pointB) {
    line(ctx, toD(state.pointA), toD(state.pointB), AXIS_COLOR, 1.5, [6, 4]);
  }
  if (state.pointA) dot(ctx, toD(state.pointA), DOT_A_COLOR, DOT_R, 'A');
  if (state.pointB) dot(ctx, toD(state.pointB), DOT_B_COLOR, DOT_R, 'B');
}

/**
 * Station phase: cropped image already drawn; overlay only the active station.
 * When isFlash=true (right sidewall just placed, brief hold), both sidewall
 * dots and the width line are shown to confirm placement.
 */
function drawStationPhase(
  ctx: CanvasRenderingContext2D,
  state: ImageMeasurementState,
  station: Station,
  crop: CropRegion,
  natW: number,
  natH: number,
  dw: number,
  dh: number,
) {
  const A = state.pointA;
  const B = state.pointB;
  if (!A || !B) return;

  const toD = (p: Point) => naturalToDisplayCropped(p, crop, dw, dh);

  // Station line: halfLen large enough to always span the full cropped canvas.
  // canvas.stroke() clips naturally to the canvas bounds.
  const halfLen = Math.max(natW, natH) * 2;
  const t       = STATION_FRACTIONS[station];
  const [ep1, ep2] = stationLineEndpoints(A, B, t, halfLen);
  line(ctx, toD(ep1), toD(ep2), STATION_COLOR, 2.5);

  // Station label near center
  const center = stationPoint(A, B, t);
  const dc     = toD(center);
  const pct    = Math.round(t * 100);
  ctx.font      = 'bold 14px monospace';
  ctx.fillStyle = STATION_COLOR;
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth   = 3;
  ctx.strokeText(`z${pct}%`, dc.x + 6, dc.y - 8);
  ctx.fillText(`z${pct}%`, dc.x + 6, dc.y - 8);

  // Placed sidewall dots for this station
  const sw = state.sidewalls[station];
  if (sw.left)  dot(ctx, toD(sw.left),  SIDEWALL_COLOR, DOT_R, 'L');
  if (sw.right) dot(ctx, toD(sw.right), SIDEWALL_COLOR, DOT_R, 'R');

  // Width line if both placed
  if (sw.left && sw.right) {
    line(ctx, toD(sw.left), toD(sw.right), WIDTH_COLOR, 2.5);
  }
}

/** Review phase: full image with all stations, widths, and axis. */
function drawReviewPhase(
  ctx: CanvasRenderingContext2D,
  state: ImageMeasurementState,
  natW: number,
  natH: number,
  dw: number,
  dh: number,
) {
  const A = state.pointA;
  const B = state.pointB;
  if (!A || !B) return;

  const toD     = (p: Point) => fullToDisplay(p, natW, natH, dw, dh);
  const halfLen = natW * 0.20;

  // Axis
  line(ctx, toD(A), toD(B), AXIS_COLOR, 1.5, [6, 4]);

  // All station lines + widths
  for (const s of STATIONS) {
    const t          = STATION_FRACTIONS[s];
    const [ep1, ep2] = stationLineEndpoints(A, B, t, halfLen);
    line(ctx, toD(ep1), toD(ep2), STATION_COLOR, 1.5);

    // Station label
    const center = stationPoint(A, B, t);
    const dc     = toD(center);
    ctx.font        = '11px monospace';
    ctx.fillStyle   = STATION_COLOR;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth   = 2.5;
    ctx.strokeText(s, dc.x + 4, dc.y - 5);
    ctx.fillText(s, dc.x + 4, dc.y - 5);

    // Sidewall dots + width line
    const sw = state.sidewalls[s];
    if (sw.left)  dot(ctx, toD(sw.left),  SIDEWALL_COLOR, DOT_R - 1, 'L');
    if (sw.right) dot(ctx, toD(sw.right), SIDEWALL_COLOR, DOT_R - 1, 'R');
    if (sw.left && sw.right) {
      line(ctx, toD(sw.left), toD(sw.right), WIDTH_COLOR, 2);
    }
  }

  // A and B dots on top
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
  const canvasRef      = useRef<HTMLCanvasElement>(null);
  const imgRef         = useRef<HTMLImageElement | null>(null);
  // Station held visible briefly after its right sidewall is placed.
  const [flashStation, setFlashStation] = useState<Station | null>(null);
  const flashTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up flash timer on unmount (navigation between images uses key=imageId)
  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  // Load image
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      onNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
      imgRef.current = img;
      redraw();
    };
    img.src = imageUrl;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl]);

  // Redraw on every state or flash change
  useEffect(() => {
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, naturalSize, flashStation]);

  function redraw() {
    const canvas = canvasRef.current;
    const img    = imgRef.current;
    if (!canvas || !img || !naturalSize) return;

    const dw = canvas.offsetWidth;
    const dh = canvas.offsetHeight;
    if (dw === 0 || dh === 0) return;

    canvas.width  = dw;
    canvas.height = dh;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, dw, dh);

    // Determine display station (flash overrides current step station)
    const displayStation = flashStation ?? activeStation(state.step);
    const phase: Phase   = displayStation
      ? 'station'
      : state.step < 2
        ? 'axis'
        : 'review';

    if (phase === 'station' && displayStation && state.pointA && state.pointB) {
      const crop = computeCropRegion(
        state.pointA,
        state.pointB,
        displayStation,
        naturalSize.w,
        naturalSize.h,
      );
      ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, dw, dh);
      drawStationPhase(ctx, state, displayStation, crop, naturalSize.w, naturalSize.h, dw, dh);
    } else {
      ctx.drawImage(img, 0, 0, dw, dh);
      if (phase === 'axis') {
        drawAxisPhase(ctx, state, naturalSize.w, naturalSize.h, dw, dh);
      } else {
        drawReviewPhase(ctx, state, naturalSize.w, naturalSize.h, dw, dh);
      }
    }
  }

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      // Block clicks during flash (coordinate system would be wrong for next station)
      if (flashStation) return;
      if (state.step >= TOTAL_STEPS) return;
      if (!naturalSize) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect  = canvas.getBoundingClientRect();
      const phase = getPhase(state.step);

      let pt: Point;
      if (phase === 'station' && state.pointA && state.pointB) {
        const crop = computeCropRegion(
          state.pointA,
          state.pointB,
          activeStation(state.step)!,
          naturalSize.w,
          naturalSize.h,
        );
        pt = displayToNaturalCropped(e.clientX, e.clientY, rect, crop);
      } else {
        pt = displayToNatural(e.clientX, e.clientY, rect, naturalSize.w, naturalSize.h);
      }

      const target = CLICK_SEQUENCE[state.step];

      // Build next state (shallow-copy sidewalls to avoid mutation)
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

      // Compute result when all 10 points are placed
      if (next.step === TOTAL_STEPS && next.pointA && next.pointB) {
        next.result = computeWz(
          next.pointA,
          next.pointB,
          next.sidewalls as Record<Station, { left: Point; right: Point }>,
        );
      }

      // Flash on station completion (right sidewall placed)
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
