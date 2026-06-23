'use client';

import { useEffect, useRef } from 'react';
import {
  type Point,
  STATIONS,
  STATION_FRACTIONS,
  activeStation,
  computeCropRegion,
  stationLineEndpoints,
} from '@/lib/measure/wz-geometry';
import type { ImageMeasurementState } from './WzCanvas';

// Fixed canvas CSS dimensions. Portrait ratio suits nail images.
const MW = 100;
const MH = 160;

// ---------------------------------------------------------------------------
// Letterbox helper (same logic as WzCanvas; kept local to avoid coupling)
// ---------------------------------------------------------------------------

type LbRect = { dx: number; dy: number; dw: number; dh: number };

function computeLetterbox(imgW: number, imgH: number, canvasW: number, canvasH: number): LbRect {
  const imgAspect    = imgW / imgH;
  const canvasAspect = canvasW / canvasH;
  let dw: number, dh: number;
  if (imgAspect > canvasAspect) {
    dw = canvasW;
    dh = canvasW / imgAspect;
  } else {
    dh = canvasH;
    dw = canvasH * imgAspect;
  }
  return { dx: (canvasW - dw) / 2, dy: (canvasH - dh) / 2, dw, dh };
}

// ---------------------------------------------------------------------------

type Props = {
  imageUrl:    string;
  state:       ImageMeasurementState;
  naturalSize: { w: number; h: number } | null;
};

export function WzMinimap({ imageUrl, state, naturalSize }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef    = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const img  = new Image();
    img.onload = () => { imgRef.current = img; draw(); };
    img.src    = imageUrl;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl]);

  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, naturalSize]);

  function draw() {
    const canvas = canvasRef.current;
    const img    = imgRef.current;
    if (!canvas || !img || !naturalSize) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Non-null alias — TypeScript can narrow `ctx` through closures below
    const c: CanvasRenderingContext2D = ctx;

    const { w: natW, h: natH } = naturalSize;

    c.clearRect(0, 0, MW, MH);

    // Draw image letterboxed into the 100×160 minimap
    const lb = computeLetterbox(natW, natH, MW, MH);
    c.drawImage(img, 0, 0, natW, natH, lb.dx, lb.dy, lb.dw, lb.dh);

    // Dim overlay (only over the drawn image area)
    c.fillStyle = 'rgba(0,0,0,0.30)';
    c.fillRect(lb.dx, lb.dy, lb.dw, lb.dh);

    // ── Coordinate helpers ────────────────────────────────────────────────
    function toM(p: Point): Point {
      return {
        x: lb.dx + (p.x / natW) * lb.dw,
        y: lb.dy + (p.y / natH) * lb.dh,
      };
    }

    function mLine(
      p1:    Point,
      p2:    Point,
      color: string,
      width: number,
      dash:  number[] = [],
    ) {
      const d1 = toM(p1);
      const d2 = toM(p2);
      c.beginPath();
      c.moveTo(d1.x, d1.y);
      c.lineTo(d2.x, d2.y);
      c.strokeStyle = color;
      c.lineWidth   = width;
      c.setLineDash(dash);
      c.stroke();
      c.setLineDash([]);
    }

    function mDot(p: Point, color: string, r: number) {
      const d = toM(p);
      c.beginPath();
      c.arc(d.x, d.y, r, 0, Math.PI * 2);
      c.fillStyle = color;
      c.fill();
    }

    // ── Landmarks ──────────────────────────────────────────────────────────
    const { pointA: A, pointB: B } = state;
    const curStation = activeStation(state.step);

    if (A && B) {
      const halfLen = natW * 0.18;

      // Axis
      mLine(A, B, 'rgba(250,204,21,0.4)', 0.5, [4, 3]);

      // Station lines
      for (const s of STATIONS) {
        const t          = STATION_FRACTIONS[s];
        const isActive   = s === curStation;
        const [ep1, ep2] = stationLineEndpoints(A, B, t, halfLen);
        mLine(
          ep1,
          ep2,
          isActive ? '#38bdf8' : 'rgba(255,255,255,0.25)',
          isActive ? 1.5 : 0.75,
        );

        // Completed width line
        const sw = state.sidewalls[s];
        if (sw.left && sw.right) mLine(sw.left, sw.right, 'rgba(74,222,128,0.7)', 1);
      }

      // Crop rectangle for active station (dashed sky blue)
      if (curStation) {
        const crop  = computeCropRegion(A, B, curStation, natW, natH);
        // Scale crop rect corners through the letterbox
        const tl = toM({ x: crop.x,          y: crop.y          });
        const br = toM({ x: crop.x + crop.w, y: crop.y + crop.h });
        c.strokeStyle = 'rgba(56,189,248,0.75)';
        c.lineWidth   = 1;
        c.setLineDash([3, 2]);
        c.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
        c.setLineDash([]);
      }

      // A and B dots
      mDot(A, '#f97316', 2.5);
      mDot(B, '#f97316', 2.5);
    }
  }

  return (
    <div className="space-y-1">
      <div className="text-xs text-gray-500 uppercase font-semibold tracking-wider">
        Minimap
      </div>
      <canvas
        ref={canvasRef}
        width={MW}
        height={MH}
        className="rounded border border-gray-700 block"
      />
      <div className="text-xs text-gray-600 leading-tight">
        Blue box = zoom region
      </div>
    </div>
  );
}
