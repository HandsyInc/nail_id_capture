'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type MeasurementProvenance,
  buildPointProvenance,
} from '@/lib/measure/provenance';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Point = { x: number; y: number };

export type LongitudinalResult = {
  /** Cuticle midpoint — natural image px. Founder-placed. */
  cuticle:             Point;
  /** Free-edge midpoint — natural image px. Founder-placed. */
  freeEdge:            Point;
  /** Apex (maximum height) — natural image px. Founder-placed. */
  apex:                Point;
  // Pixel-space geometry
  chordLengthPx:       number;
  heightPx:            number;
  /** [0, 1] scalar projection of apex along chord C→F from cuticle. */
  apexPositionRatio:   number;
  // mm-space — always null for now (see buildResult comment)
  lengthMm:            number | null;
  heightMm:            number | null;
  hOverL:              number | null;
  apexPositionPercent: number | null;
  // Provenance
  apexProvenance:      MeasurementProvenance<Point>;
  regionBlurScore:     number | null;
};

/**
 * Phase state machine:
 *
 *   idle → placed_cuticle → placed_chord → ready → accepted
 *                                            ↑          |
 *                                            └──(Edit)──┘
 *
 * - idle/placed_cuticle/placed_chord: sequential click-to-place.
 *   Already-placed points are draggable at any intermediate step.
 * - ready: all 3 placed; any point is draggable; geometry updates live.
 *   Accept button enabled.
 * - accepted: locked — geometry visible but not editable. Edit button
 *   returns to ready without API roundtrip; re-Accept overwrites the
 *   JSONB key (same as a normal accept).
 */
type Phase =
  | { step: 'idle' }
  | { step: 'placed_cuticle'; cuticle: Point }
  | { step: 'placed_chord';   cuticle: Point; freeEdge: Point; blurScore: number | null }
  | { step: 'ready';          result: LongitudinalResult }
  | { step: 'accepted';       result: LongitudinalResult };

type DragTarget = 'cuticle' | 'freeEdge' | 'apex';

type Props = {
  captureImageId: string;
  sessionId:      string;
  imageUrl:       string;
  fingerLabel:    string;
  /**
   * Placeholder for the future cross-reference scale source.
   *
   * D4.10 mm scaling is blocked — see buildResult comment for the full
   * explanation. When the canonical C→F nail-bed length becomes available
   * (a `nailBedLengthMm` field produced by a future measurement step that
   * explicitly places the hyponychium detachment point in the top-down view),
   * add it here and wire it into buildResult.
   *
   * The longitudinal H matrix (CaptureImage.h_matrix) is intentionally NOT
   * used here. Architecture decision: longitudinal mm values should derive from
   * a top-down cross-reference, not from a separate calibration card in the
   * side-view image. This mirrors how transverse uses top-down chord width.
   */
  onAccepted?:    (result: LongitudinalResult) => void;
};

// ─────────────────────────────────────────────────────────────────────────────
// Geometry helpers (unchanged — no measurement-model changes in this UX delta)
// ─────────────────────────────────────────────────────────────────────────────

/** Perpendicular distance from point P to line through A and B. */
function pointToLineDist(P: Point, A: Point, B: Point): number {
  const dx = B.x - A.x, dy = B.y - A.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-8) return Math.hypot(P.x - A.x, P.y - A.y);
  return Math.abs(dy * P.x - dx * P.y + B.x * A.y - B.y * A.x) / len;
}

function projectPointOnLine(P: Point, A: Point, B: Point): Point {
  const dx = B.x - A.x, dy = B.y - A.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-8) return { x: A.x, y: A.y };
  const t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / lenSq;
  return { x: A.x + t * dx, y: A.y + t * dy };
}

function buildResult(
  cuticle:      Point,
  freeEdge:     Point,
  apex:         Point,
  blurScore:    number | null,
  attemptCount: number,
): LongitudinalResult {
  const chordLengthPx = Math.hypot(freeEdge.x - cuticle.x, freeEdge.y - cuticle.y);
  const heightPx      = pointToLineDist(apex, cuticle, freeEdge);
  const dx = freeEdge.x - cuticle.x, dy = freeEdge.y - cuticle.y;
  const lenSq = dx * dx + dy * dy;
  const rawRatio = lenSq > 1e-8
    ? ((apex.x - cuticle.x) * dx + (apex.y - cuticle.y) * dy) / lenSq
    : 0.5;
  const apexPositionRatio = Math.max(0, Math.min(1, rawRatio));

  // ── mm scaling: blocked (D4.10) ────────────────────────────────────────────
  //
  // Architecture: longitudinal mm values should come from a top-down
  // cross-reference (mirroring how transverse uses top-down chord width),
  // NOT from a calibration card in the side-view image.
  //
  // The closest available field is widthData.chordMeasurements[key].length_mm
  // (MRR long-axis from the top-down SAM2 segmentation). However, that value
  // measures cuticle → nail TIP (the full plate extent), whereas D4.10's F
  // landmark is explicitly the hyponychium detachment line — NOT the tip.
  // For nail-enhancement clients with significant free edges this mismatch
  // is several mm and would produce silently wrong h values.
  //
  // GeometryPackage.lengthData exists in the schema but no route writes to it.
  //
  // Unblock when: a canonical C→F nail-bed length (cuticle → hyponychium) is
  // produced by the measurement pipeline and stored in the GeometryPackage.
  // At that point, pass it as `nailBedLengthMm` via Props and apply:
  //   const scale = nailBedLengthMm / chordLengthPx;
  //   heightMm    = heightPx * scale;
  //   hOverL      = heightMm / nailBedLengthMm;
  // ──────────────────────────────────────────────────────────────────────────
  const lengthMm: number | null = null;
  const heightMm: number | null = null;
  const hOverL:   number | null = null;
  const apexPositionPercent: number | null = null;

  // D4.10: no auto-detection — computerProposal always null.
  const apexProvenance = buildPointProvenance(null, apex, false, attemptCount);

  return {
    cuticle, freeEdge, apex,
    chordLengthPx, heightPx, apexPositionRatio,
    lengthMm, heightMm, hOverL, apexPositionPercent,
    apexProvenance,
    regionBlurScore: blurScore,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Blur score (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

function computeBlurScore(canvas: HTMLCanvasElement, c: Point, f: Point): number | null {
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const chordPx = Math.hypot(f.x - c.x, f.y - c.y);
    const midX = (c.x + f.x) / 2, midY = (c.y + f.y) / 2;
    const half = Math.max(50, chordPx * 0.6);
    const rx0 = Math.max(0, Math.floor(midX - half));
    const ry0 = Math.max(0, Math.floor(midY - half * 0.5));
    const rw  = Math.min(canvas.width  - rx0, Math.ceil(half * 2));
    const rh  = Math.min(canvas.height - ry0, Math.ceil(half));
    if (rw < 20 || rh < 20) return null;
    const { data, width } = ctx.getImageData(rx0, ry0, rw, rh);
    function g(x: number, y: number) {
      const i = (y * width + x) * 4;
      return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    let sumSq = 0, n = 0;
    for (let y = 1; y < rh - 1; y += 2) {
      for (let x = 1; x < rw - 1; x += 2) {
        const lap = 4*g(x,y) - g(x-1,y) - g(x+1,y) - g(x,y-1) - g(x,y+1);
        sumSq += lap * lap; n++;
      }
    }
    return n > 0 ? Math.round(sumSq / n) : null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hit testing
// ─────────────────────────────────────────────────────────────────────────────

/** Drag hit radius in natural image pixels — ~2× dot radius, generous target. */
function getHitRadius(canvas: HTMLCanvasElement): number {
  return Math.max(20, Math.round(canvas.width * 0.022));
}

function nearPoint(a: Point, b: Point, r: number): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < r;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coordinate helper (module-level — captures nothing from closure)
// ─────────────────────────────────────────────────────────────────────────────

function canvasPt(e: React.MouseEvent<HTMLCanvasElement>): Point {
  const canvas = e.currentTarget, rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width  / rect.width),
    y: (e.clientY - rect.top)  * (canvas.height / rect.height),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Canvas drawing
// ─────────────────────────────────────────────────────────────────────────────

const COL_CHORD   = '#60a5fa';  // blue   — C, F, chord line
const COL_APEX    = '#34d399';  // green  — apex
const COL_SAGITTA = '#f59e0b';  // orange — sagitta construction line
const COL_ARC     = '#a78bfa';  // violet — fitted arc

function redraw(canvas: HTMLCanvasElement, img: HTMLImageElement, phase: Phase) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const c = ctx; // alias — prevents TS closure-narrowing error on ctx
  canvas.width  = img.naturalWidth;
  canvas.height = img.naturalHeight;
  c.drawImage(img, 0, 0);

  const R  = Math.max(8,  Math.round(img.naturalWidth * 0.006));
  const LW = Math.max(3,  Math.round(img.naturalWidth * 0.003));
  const F  = Math.max(22, Math.round(img.naturalWidth * 0.018));

  function solidDot(p: Point, color: string, label?: string) {
    c.beginPath();
    c.arc(p.x, p.y, R, 0, Math.PI * 2);
    c.fillStyle   = color;
    c.globalAlpha = 0.9;
    c.fill();
    c.globalAlpha = 1;
    c.strokeStyle = '#fff';
    c.lineWidth   = 2;
    c.stroke();
    if (label) {
      c.font        = `bold ${F}px system-ui`;
      c.fillStyle   = '#fff';
      c.globalAlpha = 0.9;
      c.fillText(label, p.x + R + 6, p.y + F * 0.35);
      c.globalAlpha = 1;
    }
  }

  function line(a: Point, b: Point, color: string, dashed = false, alpha = 0.8) {
    c.beginPath();
    if (dashed) c.setLineDash([Math.round(LW * 3), Math.round(LW * 2)]);
    c.moveTo(a.x, a.y);
    c.lineTo(b.x, b.y);
    c.strokeStyle = color;
    c.lineWidth   = LW;
    c.globalAlpha = alpha;
    c.stroke();
    c.setLineDash([]);
    c.globalAlpha = 1;
  }

  if (phase.step === 'idle') return;

  // Cuticle is available in all non-idle phases
  const cuticle: Point =
    phase.step === 'placed_cuticle' ? phase.cuticle :
    phase.step === 'placed_chord'   ? phase.cuticle :
    phase.result.cuticle;

  solidDot(cuticle, COL_CHORD, 'C');

  if (phase.step === 'placed_chord' || phase.step === 'ready' || phase.step === 'accepted') {
    const freeEdge: Point =
      phase.step === 'placed_chord' ? phase.freeEdge : phase.result.freeEdge;
    line(cuticle, freeEdge, COL_CHORD);
    solidDot(freeEdge, COL_CHORD, 'F');
  }

  if (phase.step === 'ready' || phase.step === 'accepted') {
    const { cuticle: C, freeEdge: F_pt, apex: A, chordLengthPx, heightPx } = phase.result;

    // Sagitta — dashed perpendicular from apex to chord
    const foot = projectPointOnLine(A, C, F_pt);
    line(A, foot, COL_SAGITTA, true);

    // Quadratic Bézier arc C → A → F as longitudinal profile
    const qx = 2 * A.x - 0.5 * (C.x + F_pt.x);
    const qy = 2 * A.y - 0.5 * (C.y + F_pt.y);
    c.beginPath();
    c.moveTo(C.x, C.y);
    c.quadraticCurveTo(qx, qy, F_pt.x, F_pt.y);
    c.strokeStyle = COL_ARC;
    c.lineWidth   = LW;
    c.globalAlpha = 0.7;
    c.stroke();
    c.globalAlpha = 1;

    solidDot(A, COL_APEX, 'A');

    // Inline metric labels
    const midX = (C.x + F_pt.x) / 2, midY = (C.y + F_pt.y) / 2;
    c.font      = `${F}px monospace`;
    c.fillStyle = COL_CHORD;
    c.fillText(`L ${chordLengthPx.toFixed(0)} px`, midX + 8, midY - 8);
    c.fillStyle = COL_SAGITTA;
    c.fillText(`h ${heightPx.toFixed(1)} px`, (A.x + foot.x) / 2 + 8, (A.y + foot.y) / 2);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Landmark guidance panel
// ─────────────────────────────────────────────────────────────────────────────

const GUIDES = [
  {
    id:       'cuticle'  as DragTarget,
    dot:      'C',
    color:    COL_CHORD,
    name:     'Cuticle',
    desc:     'Center where the nail plate emerges from the skin.',
    activeOn: 'idle' as Phase['step'],
  },
  {
    id:       'freeEdge' as DragTarget,
    dot:      'F',
    color:    COL_CHORD,
    name:     'Free Edge',
    desc:     'Where the attached pink nail transitions to the unsupported white free edge — not the nail tip.',
    activeOn: 'placed_cuticle' as Phase['step'],
  },
  {
    id:       'apex'     as DragTarget,
    dot:      'A',
    color:    COL_APEX,
    name:     'Apex',
    desc:     'Highest point of the attached natural nail surface between C and F.',
    activeOn: 'placed_chord' as Phase['step'],
  },
] as const;

function LandmarkGuide({ step }: { step: Phase['step'] }) {
  const placedIds = new Set<string>(
    step === 'placed_cuticle'              ? ['cuticle'] :
    step === 'placed_chord'               ? ['cuticle', 'freeEdge'] :
    (step === 'ready' || step === 'accepted') ? ['cuticle', 'freeEdge', 'apex'] :
    [],
  );
  const isRefine = step === 'ready';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '0.3rem',
      padding: '0.5rem 0.8rem',
      background: 'rgba(17,24,39,0.7)',
      border: '1px solid #1f2937',
      borderRadius: '6px',
      fontSize: '0.72rem',
    }}>
      {GUIDES.map(g => {
        const active  = g.activeOn === step;
        const placed  = placedIds.has(g.id);
        const opacity = active ? 1 : placed ? 0.65 : 0.3;
        const icon    = placed ? '✓' : active ? '▸' : '○';
        return (
          <div key={g.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', opacity, transition: 'opacity 0.15s' }}>
            <span style={{ color: g.color, fontWeight: 700, flexShrink: 0, width: '0.9rem', textAlign: 'center' }}>
              {icon}
            </span>
            <div>
              <span style={{ color: active ? '#e5e7eb' : placed ? '#d1d5db' : '#6b7280', fontWeight: active ? 700 : 500 }}>
                {g.name}
              </span>
              <span style={{ color: active ? '#9ca3af' : '#4b5563' }}>
                {' — '}{g.desc}
              </span>
            </div>
          </div>
        );
      })}
      {isRefine && (
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.1rem', color: '#9ca3af' }}>
          <span style={{ color: COL_ARC }}>↔</span>
          <span>Drag any landmark to refine, then Accept.</span>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

function InstructionPill({ text }: { text: string }) {
  return (
    <div style={{
      alignSelf: 'flex-start', padding: '0.3rem 0.9rem', borderRadius: '999px',
      background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.4)',
      color: '#a5b4fc', fontSize: '0.8rem', fontWeight: 500,
    }}>
      {text}
    </div>
  );
}

function DiagRow({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
      <span style={{ color: '#6b7280', flexShrink: 0, width: '30rem' }}>{label}</span>
      <span style={{ color: highlight ? '#34d399' : '#d1d5db', fontWeight: highlight ? 600 : 400 }}>{value}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function LongitudinalCanvas({
  captureImageId, sessionId, imageUrl, fingerLabel, onAccepted,
}: Props) {
  const canvasRef       = useRef<HTMLCanvasElement>(null);
  const imgRef          = useRef<HTMLImageElement | null>(null);
  // dragRef tracks which point is being dragged without triggering re-renders
  const dragRef         = useRef<DragTarget | null>(null);
  const attemptCountRef = useRef(0);

  const [imgLoaded,   setImgLoaded]   = useState(false);
  const [phase,       setPhase]       = useState<Phase>({ step: 'idle' });
  const [accepting,   setAccepting]   = useState(false);
  const [isDragging,  setIsDragging]  = useState(false);
  const [hoverTarget, setHoverTarget] = useState<DragTarget | null>(null);

  // Mirror phase into a ref so event handlers (useCallback) can read the
  // latest phase without stale closures, without adding phase to deps and
  // recreating handlers on every drag pixel.
  const phaseRef = useRef<Phase>(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // ── Load image ─────────────────────────────────────────────────────────────
  useEffect(() => {
    setImgLoaded(false);
    setPhase({ step: 'idle' });
    dragRef.current = null;
    setIsDragging(false);
    setHoverTarget(null);
    attemptCountRef.current = 0;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { imgRef.current = img; setImgLoaded(true); };
    img.src = imageUrl;
  }, [imageUrl]);

  // ── Redraw whenever phase or image changes ──────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current, img = imgRef.current;
    if (!canvas || !img || !imgLoaded) return;
    redraw(canvas, img, phase);
  }, [phase, imgLoaded]);

  // ── Global mouseup — ends drag even if released outside the canvas ──────────
  useEffect(() => {
    if (!isDragging) return;
    const end = () => { dragRef.current = null; setIsDragging(false); };
    window.addEventListener('mouseup', end);
    return () => window.removeEventListener('mouseup', end);
  }, [isDragging]);

  // ── mousedown — drag start or next-point placement ──────────────────────────
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (accepting) return;
    const cur = phaseRef.current;
    if (cur.step === 'accepted') return;

    e.preventDefault(); // prevent text selection during drag
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pt   = canvasPt(e);
    const hitR = getHitRadius(canvas);

    // ── idle: place cuticle ─────────────────────────────────────────────────
    if (cur.step === 'idle') {
      attemptCountRef.current += 1;
      setPhase({ step: 'placed_cuticle', cuticle: pt });
      return;
    }

    // ── placed_cuticle: drag cuticle OR place free edge ─────────────────────
    if (cur.step === 'placed_cuticle') {
      if (nearPoint(pt, cur.cuticle, hitR)) {
        dragRef.current = 'cuticle';
        setIsDragging(true);
        return;
      }
      const blurScore = computeBlurScore(canvas, cur.cuticle, pt);
      setPhase({ step: 'placed_chord', cuticle: cur.cuticle, freeEdge: pt, blurScore });
      return;
    }

    // ── placed_chord: drag C or F, OR place apex ────────────────────────────
    if (cur.step === 'placed_chord') {
      if (nearPoint(pt, cur.cuticle, hitR)) {
        dragRef.current = 'cuticle';
        setIsDragging(true);
        return;
      }
      if (nearPoint(pt, cur.freeEdge, hitR)) {
        dragRef.current = 'freeEdge';
        setIsDragging(true);
        return;
      }
      const result = buildResult(
        cur.cuticle, cur.freeEdge, pt,
        cur.blurScore, attemptCountRef.current,
      );
      setPhase({ step: 'ready', result });
      return;
    }

    // ── ready: drag any of the three points ─────────────────────────────────
    if (cur.step === 'ready') {
      const { cuticle, freeEdge, apex } = cur.result;
      // Apex checked first — smallest target, highest precision demand
      if (nearPoint(pt, apex,     hitR)) { dragRef.current = 'apex';     setIsDragging(true); return; }
      if (nearPoint(pt, cuticle,  hitR)) { dragRef.current = 'cuticle';  setIsDragging(true); return; }
      if (nearPoint(pt, freeEdge, hitR)) { dragRef.current = 'freeEdge'; setIsDragging(true); return; }
      // Click not near any point — no action in ready phase
    }
  }, [accepting]);

  // ── mousemove — drag update or hover detection ──────────────────────────────
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pt = canvasPt(e);

    if (dragRef.current !== null) {
      const target = dragRef.current;
      // Functional update reads latest phase without stale closure
      setPhase(prev => {
        if (prev.step === 'placed_cuticle' && target === 'cuticle') {
          return { step: 'placed_cuticle', cuticle: pt };
        }
        if (prev.step === 'placed_chord') {
          if (target === 'cuticle')  return { ...prev, cuticle:  pt };
          if (target === 'freeEdge') return { ...prev, freeEdge: pt };
        }
        if (prev.step === 'ready') {
          const { cuticle, freeEdge, apex, regionBlurScore } = prev.result;
          const nc = target === 'cuticle'  ? pt : cuticle;
          const nf = target === 'freeEdge' ? pt : freeEdge;
          const na = target === 'apex'     ? pt : apex;
          return {
            step:   'ready',
            result: buildResult(nc, nf, na, regionBlurScore, attemptCountRef.current),
          };
        }
        return prev;
      });
      return;
    }

    // Not dragging — update hover target for grab cursor in ready phase
    const cur = phaseRef.current;
    if (cur.step === 'ready') {
      const { cuticle, freeEdge, apex } = cur.result;
      const hitR = getHitRadius(canvas);
      if      (nearPoint(pt, apex,     hitR)) setHoverTarget('apex');
      else if (nearPoint(pt, cuticle,  hitR)) setHoverTarget('cuticle');
      else if (nearPoint(pt, freeEdge, hitR)) setHoverTarget('freeEdge');
      else                                    setHoverTarget(null);
    } else {
      setHoverTarget(null);
    }
  }, []);

  // ── mouseleave — clear hover; do NOT cancel drag (user may drag back in) ───
  const handleMouseLeave = useCallback(() => {
    setHoverTarget(null);
  }, []);

  // ── mouseup on canvas (global listener handles outside-canvas release) ──────
  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
    setIsDragging(false);
  }, []);

  // ── Redo from scratch ───────────────────────────────────────────────────────
  const handleRedo = useCallback(() => {
    dragRef.current = null;
    setIsDragging(false);
    setHoverTarget(null);
    setPhase({ step: 'idle' });
  }, []);

  // ── Edit — return from accepted to ready without API roundtrip ─────────────
  const handleEdit = useCallback(() => {
    setPhase(prev =>
      prev.step === 'accepted' ? { step: 'ready', result: prev.result } : prev,
    );
  }, []);

  // ── Accept — POST to API, then lock ────────────────────────────────────────
  const handleAccept = useCallback(async () => {
    const cur = phaseRef.current;
    if (cur.step !== 'ready') return;
    setAccepting(true);
    const result = cur.result;
    const {
      cuticle, freeEdge, apex,
      chordLengthPx, heightPx, apexPositionRatio,
      lengthMm, heightMm, hOverL, apexPositionPercent,
      apexProvenance, regionBlurScore,
    } = result;
    try {
      const res = await fetch('/api/measure/longitudinal/accept', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          captureImageId, sessionId,
          cuticlePx:  cuticle,
          freeEdgePx: freeEdge,
          apexPx:     apex,
          chordLengthPx, heightPx, apexPositionRatio,
          lengthMm, heightMm, hOverL, apexPositionPercent,
          apexProvenance,
          regionBlurScore,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        alert(`Accept failed: ${err.error ?? res.statusText}`);
        return;
      }
      setPhase({ step: 'accepted', result });
      onAccepted?.(result);
    } catch (err) {
      alert(`Accept failed: ${String(err)}`);
    } finally {
      setAccepting(false);
    }
  }, [captureImageId, sessionId, onAccepted]);

  // ── Cursor ──────────────────────────────────────────────────────────────────
  const cursor: string =
    accepting                    ? 'wait'      :
    phase.step === 'accepted'    ? 'default'   :
    isDragging                   ? 'grabbing'  :
    hoverTarget !== null         ? 'grab'      :
    phase.step === 'ready'       ? 'default'   :
    imgLoaded                    ? 'crosshair' :
    'default';

  // ── Instruction text ────────────────────────────────────────────────────────
  const instruction: string | null =
    phase.step === 'idle'           ? 'Step 1 — Click the cuticle midpoint' :
    phase.step === 'placed_cuticle' ? 'Step 2 — Click the free-edge midpoint' :
    phase.step === 'placed_chord'   ? 'Step 3 — Click the apex' :
    phase.step === 'ready'          ? 'Drag any landmark to refine, then Accept' :
    null; // accepted — no pill shown

  const result = (phase.step === 'ready' || phase.step === 'accepted') ? phase.result : null;

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>

      {/* Instruction pill */}
      {instruction && imgLoaded && <InstructionPill text={instruction} />}

      {/* Canvas */}
      <div style={{ position: 'relative', display: 'inline-block' }}>
        {!imgLoaded && (
          <div style={{
            width: '100%', height: '320px', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            color: '#6b7280', fontSize: '0.875rem',
          }}>
            Loading image…
          </div>
        )}
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          style={{
            display:      imgLoaded ? 'block' : 'none',
            maxWidth:     '100%',
            maxHeight:    '64vh',
            borderRadius: '6px',
            userSelect:   'none',
            cursor,
          }}
        />
      </div>

      {/* Landmark guidance — visible during placement and refine phases */}
      {imgLoaded && phase.step !== 'accepted' && (
        <LandmarkGuide step={phase.step} />
      )}

      {/* Result panel — once all 3 points are placed */}
      {result && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
            {/* Primary metric */}
            <div>
              {result.hOverL !== null ? (
                <>
                  <span style={{ fontSize: '1.75rem', fontWeight: 700, color: '#34d399', letterSpacing: '-0.02em' }}>
                    {result.hOverL.toFixed(4)}
                  </span>
                  <span style={{ marginLeft: '0.5rem', color: '#9ca3af', fontSize: '0.8rem' }}>h/L</span>
                </>
              ) : (
                <>
                  <span style={{ fontSize: '1.75rem', fontWeight: 700, color: '#a78bfa', letterSpacing: '-0.02em' }}>
                    {result.chordLengthPx > 0 ? (result.heightPx / result.chordLengthPx).toFixed(4) : '—'}
                  </span>
                  <span style={{ marginLeft: '0.5rem', color: '#9ca3af', fontSize: '0.8rem' }}>
                    h/L (px only)
                  </span>
                </>
              )}
            </div>

            {/* Buttons */}
            <div style={{ display: 'flex', gap: '0.5rem', marginLeft: 'auto' }}>
              {phase.step === 'accepted' ? (
                <button onClick={handleEdit} style={btnStyle('ghost')}>Edit</button>
              ) : (
                <>
                  <button onClick={handleRedo}   disabled={accepting} style={btnStyle('ghost')}>Redo</button>
                  <button onClick={handleAccept} disabled={accepting} style={btnStyle('accept')}>
                    {accepting ? 'Saving…' : 'Accept →'}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Diagnostics panel */}
          <div style={{
            padding: '0.75rem 1rem',
            background: 'rgba(17,24,39,0.85)',
            border: '1px solid #374151',
            borderRadius: '6px',
            fontSize: '0.75rem', fontFamily: 'monospace', lineHeight: 1.8,
          }}>
            <div style={{ color: '#4b5563', marginBottom: '0.4rem', fontFamily: 'system-ui', letterSpacing: '0.07em', textTransform: 'uppercase', fontSize: '0.62rem' }}>
              D4.10 Longitudinal · {fingerLabel}{phase.step === 'accepted' ? ' · ✓ Accepted' : ''}
            </div>
            <DiagRow label="C — cuticle (px)"   value={`x=${result.cuticle.x.toFixed(0)}  y=${result.cuticle.y.toFixed(0)}`} />
            <DiagRow label="F — free edge (px)" value={`x=${result.freeEdge.x.toFixed(0)}  y=${result.freeEdge.y.toFixed(0)}`} />
            <DiagRow label="A — apex (px)"      value={`x=${result.apex.x.toFixed(0)}  y=${result.apex.y.toFixed(0)}`} />
            <DiagRow label="Chord L (px)"       value={`${result.chordLengthPx.toFixed(2)} px`} />
            <DiagRow label="Height h (px)"      value={`${result.heightPx.toFixed(2)} px`} />
            <DiagRow label="h/L (px-space)"     value={(result.chordLengthPx > 0 ? result.heightPx / result.chordLengthPx : 0).toFixed(4)} highlight />
            <DiagRow label="AP% (px-space)"     value={`${(result.apexPositionRatio * 100).toFixed(1)} %`} highlight />
            {result.regionBlurScore !== null && (
              <DiagRow
                label="Region blur score (Laplacian var)"
                value={`${result.regionBlurScore}${result.regionBlurScore < 20 ? ' ⚠ blurry' : result.regionBlurScore > 60 ? ' ✓ sharp' : ' marginal'}`}
              />
            )}

            {result.lengthMm !== null && (
              <>
                <div style={{ borderTop: '1px solid #374151', margin: '0.4rem 0' }} />
                <div style={{ color: '#4b5563', fontFamily: 'system-ui', letterSpacing: '0.07em', textTransform: 'uppercase', fontSize: '0.62rem', marginBottom: '0.2rem' }}>
                  mm scale
                </div>
                <DiagRow label="L (length mm)"          value={`${result.lengthMm.toFixed(3)} mm`} highlight />
                <DiagRow label="h (height mm)"          value={`${result.heightMm!.toFixed(3)} mm`} />
                <DiagRow label="h/L"                    value={result.hOverL!.toFixed(4)} highlight />
                <DiagRow label="AP% (apex position %)"  value={`${result.apexPositionPercent!.toFixed(1)} %`} highlight />
              </>
            )}
            {result.lengthMm === null && (
              <>
                <div style={{ borderTop: '1px solid #374151', margin: '0.4rem 0' }} />
                <div style={{ color: '#f59e0b', fontSize: '0.72rem', fontFamily: 'system-ui' }}>
                  No longitudinal scale source — px only. h/L and AP% are valid ratios.
                </div>
              </>
            )}

            <>
              <div style={{ borderTop: '1px solid #374151', margin: '0.4rem 0' }} />
              <div style={{ color: '#4b5563', fontFamily: 'system-ui', letterSpacing: '0.07em', textTransform: 'uppercase', fontSize: '0.62rem', marginBottom: '0.2rem' }}>
                provenance
              </div>
              <DiagRow label="Method"         value="LONGITUDINAL_FOUNDER_CLICK" />
              <DiagRow label="Auto-detection" value="not implemented (D4.10)" />
              <DiagRow label="Attempt count"  value={String(result.apexProvenance.attemptCount ?? 1)} />
            </>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Shared button styles ────────────────────────────────────────────────────

function btnStyle(variant: 'ghost' | 'accept'): React.CSSProperties {
  return variant === 'accept'
    ? { padding: '0.4rem 1rem', fontSize: '0.8rem', fontWeight: 600, borderRadius: '5px', border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer' }
    : { padding: '0.4rem 0.85rem', fontSize: '0.8rem', borderRadius: '5px', border: '1px solid #4b5563', background: 'transparent', color: '#9ca3af', cursor: 'pointer' };
}
