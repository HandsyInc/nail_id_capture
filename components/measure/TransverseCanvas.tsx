'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type MeasurementProvenance,
  type ComputerProposal,
  buildPointProvenance,
} from '@/lib/measure/provenance';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Point = { x: number; y: number };

export type ICResult = {
  /** Left lateral nail edge — natural image px. Always founder-placed. */
  p1:           Point;
  /** Right lateral nail edge — natural image px. Always founder-placed. */
  p2:           Point;
  /** Arc apex — natural image px. Founder-placed or accepted from auto-detect. */
  apex:         Point;
  chordPx:      number;
  sagittaPx:    number;
  /** sagittaPx / chordPx */
  arcScore:     number;
  /** IC radius from 3-point circumscribed circle fit. */
  icPx:         number;
  chordWidthMm: number | null;
  sagittaMm:    number | null;
  /** IC = (W² + 4h²) / (4h). Null when no mm scale available. */
  icMm:         number | null;
  /**
   * Provenance of the apex landmark: computer's gradient-based proposal
   * vs. the founder's accepted placement.
   *
   * - computerProposal.value = the auto-detected apex (Point)
   * - computerProposal.score = peak Sobel gradient score
   * - computerProposal.extra.arcScore = sagittaPx/chordPx at proposed apex
   * - founderValue = the apex the founder accepted (may equal proposed apex)
   * - acceptedProposal = true if founder accepted without re-clicking
   * - correctionMagnitude = Euclidean distance (px) between proposed and accepted apex
   *
   * Null when detection was skipped (canvas unavailable, SecurityError, etc.)
   */
  apexProvenance:    MeasurementProvenance<Point> | null;
  /**
   * Laplacian variance sharpness score for the nail ROI (chord bounding box).
   * Lower = blurrier. Typical: <20 blurry, 20–60 marginal, >60 sharp.
   * Null if the region could not be read.
   */
  regionBlurScore:   number | null;
};

type Phase =
  | { step: 'idle' }
  /** P1 placed — waiting for P2. */
  | { step: 'placed_p1'; p1: Point }
  /**
   * P1+P2 placed, auto-apex detected with enough signal to suggest.
   * Founder can Accept (1 click) or click canvas / Re-pick to override.
   */
  | { step: 'apex_auto';
      p1:        Point;
      p2:        Point;
      candidate: ComputerProposal<Point>;
      blurScore: number | null }
  /**
   * Waiting for founder to click the apex manually.
   * autoCandidate is preserved for provenance even if it wasn't shown.
   */
  | { step: 'apex_manual';
      p1:            Point;
      p2:            Point;
      autoCandidate: ComputerProposal<Point> | null;
      blurScore:     number | null }
  | { step: 'done'; result: ICResult };

type Props = {
  captureImageId: string;
  sessionId:      string;
  imageUrl:       string;
  fingerLabel:    string;
  /**
   * Chord width in mm from accepted top-down measurement for the same
   * hand+finger. Null when not yet available — IC stored in px only.
   */
  widthMm:        number | null;
  onAccepted?:    (result: ICResult) => void;
};

// ─────────────────────────────────────────────────────────────────────────────
// Geometry helpers
// ─────────────────────────────────────────────────────────────────────────────

function pointToLineDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / Math.hypot(dx, dy);
}

function circumscribedCircle(P1: Point, P2: Point, P3: Point) {
  const ax = P2.x - P1.x, ay = P2.y - P1.y;
  const bx = P3.x - P1.x, by = P3.y - P1.y;
  const D  = 2 * (ax * by - ay * bx);
  if (Math.abs(D) < 1e-8) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by;
  const ux = (by * a2 - ay * b2) / D;
  const uy = (ax * b2 - bx * a2) / D;
  return { cx: P1.x + ux, cy: P1.y + uy, r: Math.hypot(ux, uy) };
}

function buildResult(
  p1:           Point,
  p2:           Point,
  apex:         Point,
  widthMm:      number | null,
  /**
   * The computer's proposal for this apex (from detectApex), or null.
   * Always the proposal from the accepted attempt, not earlier retries.
   */
  autoProposal: ComputerProposal<Point> | null,
  /**
   * True when the founder accepted the computer's proposal without
   * re-clicking (i.e. pressed "Accept apex →" in the apex_auto phase).
   */
  proposalAccepted: boolean,
  blurScore:    number | null,
  /**
   * How many full attempts (P1→apex) the founder has started for this image.
   * 1 = accepted on first try. >1 = at least one Redo before acceptance.
   */
  attemptCount: number,
): ICResult {
  const chordPx   = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const sagittaPx = pointToLineDist(apex, p1, p2);
  const arcScore  = chordPx > 0 ? sagittaPx / chordPx : 0;
  const circle    = circumscribedCircle(p1, p2, apex);
  const icPx      = circle?.r ?? (sagittaPx > 0.1
    ? (chordPx * chordPx + 4 * sagittaPx * sagittaPx) / (4 * sagittaPx)
    : Infinity);

  let chordWidthMm: number | null = null;
  let sagittaMm:    number | null = null;
  let icMm:         number | null = null;
  if (widthMm !== null && chordPx > 0) {
    const scale  = widthMm / chordPx;
    chordWidthMm = widthMm;
    sagittaMm    = sagittaPx * scale;
    if (sagittaMm >= 0.1)
      icMm = (widthMm * widthMm + 4 * sagittaMm * sagittaMm) / (4 * sagittaMm);
  }

  const apexProvenance = buildPointProvenance(
    autoProposal,
    apex,
    proposalAccepted,
    attemptCount,
  );

  return {
    p1, p2, apex, chordPx, sagittaPx, arcScore, icPx,
    chordWidthMm, sagittaMm, icMm,
    apexProvenance, regionBlurScore: blurScore,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-apex detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Searches for the nail arc apex along the perpendicular bisector of chord
 * [P1, P2], reading pixel data from the provided canvas (assumed to already
 * have the full-res image drawn at natural dimensions).
 *
 * ── Why "outermost boundary" rather than "peak gradient" ─────────────────────
 *
 * The previous version used argmax(gradient) — it found the STRONGEST edge
 * along the search ray. This systematically selected the cuticle ridge, which
 * sits between the chord and the true apex and produces a stronger gradient
 * (hard tissue boundary) than the outer nail surface (gentler curvature).
 *
 * The correct target is the outermost nail-to-background boundary — the last
 * significant gradient before the profile drops to background level when
 * sweeping outward from the chord. This is a different operation:
 *   wrong: argmax( gradient(t) )             → strongest edge   = cuticle ridge
 *   right: max(t) where gradient(t) > thresh  → outermost edge  = nail surface
 *
 * ── Algorithm ────────────────────────────────────────────────────────────────
 *
 *   1. Compute chord midpoint M and two perpendicular unit vectors.
 *   2. For each direction, sweep t = [minT … maxT] in 2px steps, averaging
 *      Sobel gradient across 5 parallel scan lines (±2px, ±5px along chord)
 *      to build the full gradient profile.
 *   3. Choose the direction whose profile has the higher peak — this correctly
 *      identifies which side of the chord the nail is on (direction selection
 *      still uses the peak, which is fine: the nail side reliably has more
 *      gradient structure than the volar finger side).
 *   4. Within the chosen direction, find the OUTERMOST t whose gradient exceeds
 *      OUTER_THRESHOLD_FRACTION × profile_peak. This skips the inner cuticle
 *      ridge and lands on the outer nail surface.
 *   5. Gate on anatomical arcScore range [0.05, 0.42].
 *   6. Classify confidence based on the outer boundary score and arcScore.
 *
 * ── Diagnostic fields in extra ────────────────────────────────────────────────
 *
 *   arcScore         — outermost boundary t / chordPx  (the accepted apex)
 *   peakArcScore     — peak-gradient t / chordPx       (where cuticle ridge was)
 *   peakScore        — gradient magnitude at inner peak (training signal)
 *   fractionOfPeak   — outerScore / peakScore           (boundary strength ratio)
 *
 * Every founder correction combined with these diagnostics becomes training data
 * for identifying how often the inner vs outer boundary selection was correct.
 *
 * Returns null when:
 *   - Chord is too short (<30 px)
 *   - Canvas ImageData cannot be read (SecurityError, context unavailable)
 *   - Profile peak < 8 (no discernible edge on either side)
 *   - No t above the outer threshold in the anatomical range [0.05, 0.42]
 */
function detectApex(canvas: HTMLCanvasElement, p1: Point, p2: Point): ComputerProposal<Point> | null {
  const chordPx = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (chordPx < 30) return null;

  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;
  const cdx  = (p2.x - p1.x) / chordPx;
  const cdy  = (p2.y - p1.y) / chordPx;

  const perps: [Point, Point] = [
    { x: -cdy,  y:  cdx },
    { x:  cdy,  y: -cdx },
  ];

  const minT = Math.max(4, chordPx * 0.03);
  const maxT = chordPx * 0.45;
  if (maxT <= minT) return null;

  const pad = 8;
  const x0  = Math.max(0, Math.floor(midX - maxT - pad));
  const y0  = Math.max(0, Math.floor(midY - maxT - pad));
  const x1  = Math.min(canvas.width  - 1, Math.ceil(midX + maxT + pad));
  const y1  = Math.min(canvas.height - 1, Math.ceil(midY + maxT + pad));

  let imgData: ImageData;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    imgData = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
  } catch {
    return null;
  }

  const iw = imgData.width;
  const ih = imgData.height;
  const px = imgData.data;

  function gray(gx: number, gy: number): number {
    const lx = Math.round(gx) - x0;
    const ly = Math.round(gy) - y0;
    if (lx < 0 || ly < 0 || lx >= iw || ly >= ih) return 0;
    const i = (ly * iw + lx) * 4;
    return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  }

  function sobel(gx: number, gy: number): number {
    const gxv =
      -gray(gx-1,gy-1) + gray(gx+1,gy-1)
      -2*gray(gx-1,gy) + 2*gray(gx+1,gy)
      -gray(gx-1,gy+1) + gray(gx+1,gy+1);
    const gyv =
      -gray(gx-1,gy-1) - 2*gray(gx,gy-1) - gray(gx+1,gy-1)
      +gray(gx-1,gy+1) + 2*gray(gx,gy+1) + gray(gx+1,gy+1);
    return Math.hypot(gxv, gyv);
  }

  const PARALLEL_OFFSETS = [-5, -2, 0, 2, 5];

  /**
   * Build the full gradient profile for one perpendicular direction.
   * Returns the array of {t, score} pairs.
   */
  function buildProfile(perp: Point): { t: number; score: number }[] {
    const profile: { t: number; score: number }[] = [];
    for (let t = minT; t <= maxT; t += 2) {
      const bx = midX + perp.x * t;
      const by = midY + perp.y * t;
      let sum = 0;
      for (const off of PARALLEL_OFFSETS) {
        sum += sobel(bx + cdx * off, by + cdy * off);
      }
      profile.push({ t, score: sum / PARALLEL_OFFSETS.length });
    }
    return profile;
  }

  const profileA = buildProfile(perps[0]);
  const profileB = buildProfile(perps[1]);

  const peakA = Math.max(...profileA.map(p => p.score));
  const peakB = Math.max(...profileB.map(p => p.score));

  // Direction selection: the nail side reliably has the stronger peak.
  // (Peak is still the right signal here — we're choosing which side of the
  // chord the nail is on, not where the apex is within that side.)
  if (peakA < 8 && peakB < 8) return null;

  const chosenProfile = peakA >= peakB ? profileA : profileB;
  const chosenPerp    = peakA >= peakB ? perps[0]  : perps[1];
  const peakScore     = peakA >= peakB ? peakA     : peakB;
  const peakT         = chosenProfile.find(p => p.score === peakScore)!.t;

  // Apex location: outermost t whose gradient exceeds a fraction of the
  // profile peak. Searches outward and takes the LAST hit, so internal
  // edges (cuticle ridge) are skipped in favour of the nail-surface boundary.
  //
  // Fraction 0.28: empirically, the outer nail surface produces ~25-40% of
  // the cuticle ridge's gradient on front-camera transverse images. 0.28 sits
  // above typical noise (~10-15% of peak) while catching a blurry outer edge.
  const OUTER_THRESHOLD_FRACTION = 0.28;
  const outerThreshold = peakScore * OUTER_THRESHOLD_FRACTION;

  let outerT = -1, outerScore = 0;
  for (const { t, score } of chosenProfile) {
    if (score > outerThreshold) {
      outerT     = t;       // keep updating → last hit = outermost
      outerScore = score;
    }
  }
  if (outerT < 0) return null;

  const arcScore     = outerT    / chordPx;
  const peakArcScore = peakT     / chordPx;

  // Require the outermost boundary to be in the anatomically plausible range.
  // Lower bound raised to 0.05 (< 5% sagitta is too flat to be a real nail arc).
  if (arcScore < 0.05 || arcScore > 0.42) return null;

  const proposedApex: Point = {
    x: midX + chosenPerp.x * outerT,
    y: midY + chosenPerp.y * outerT,
  };

  // Confidence: high when the outer boundary has a reasonable signal strength
  // AND the arc depth is anatomically normal (0.05-0.30).
  // Note: outer score is weaker than the old peak score, so the threshold is
  // lower (12 rather than 25). The fractionOfPeak is also a quality signal:
  // a value near 1.0 means there is no inner ridge; near 0.28 means a strong
  // inner ridge was skipped.
  const fractionOfPeak   = outerScore / peakScore;
  const confidence: 'high' | 'low' =
    outerScore >= 12 && arcScore >= 0.05 && arcScore <= 0.30 ? 'high' : 'low';

  return {
    value:      proposedApex,
    score:      Math.round(outerScore * 10) / 10,
    confidence,
    method:     'PERP_BISECTOR_GRADIENT',
    extra: {
      // Primary diagnostic: where did we land?
      arcScore:       Math.round(arcScore     * 1000) / 1000,
      // Training signal: where was the inner peak (cuticle ridge)?
      peakArcScore:   Math.round(peakArcScore * 1000) / 1000,
      peakScore:      Math.round(peakScore    * 10)   / 10,
      // Ratio: how strong is the outer boundary relative to the inner peak?
      // Low (< 0.35) = strong inner ridge was skipped; high (≈ 1) = clean profile.
      fractionOfPeak: Math.round(fractionOfPeak * 100) / 100,
    },
  };
}

/**
 * Laplacian variance sharpness estimate for the nail ROI.
 * Samples every other pixel (fast), applies discrete Laplacian, returns
 * variance. Higher = sharper.
 */
function computeBlurScore(canvas: HTMLCanvasElement, p1: Point, p2: Point): number | null {
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const chordPx = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const midX = (p1.x + p2.x) / 2, midY = (p1.y + p2.y) / 2;
    const half = Math.max(50, chordPx * 0.6);
    const rx0 = Math.max(0, Math.floor(midX - half));
    const ry0 = Math.max(0, Math.floor(midY - half * 0.8));
    const rw   = Math.min(canvas.width  - rx0, Math.ceil(half * 2));
    const rh   = Math.min(canvas.height - ry0, Math.ceil(half * 1.6));
    if (rw < 20 || rh < 20) return null;
    const { data, width } = ctx.getImageData(rx0, ry0, rw, rh);
    function g(x: number, y: number) {
      const i = (y * width + x) * 4;
      return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    let sumSq = 0, n = 0;
    for (let y = 1; y < rh - 1; y += 2) {
      for (let x = 1; x < width - 1; x += 2) {
        const lap = 4*g(x,y) - g(x-1,y) - g(x+1,y) - g(x,y-1) - g(x,y+1);
        sumSq += lap * lap;
        n++;
      }
    }
    return n > 0 ? Math.round(sumSq / n) : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Canvas drawing
// ─────────────────────────────────────────────────────────────────────────────

const COL_CHORD   = '#60a5fa';   // blue   — chord line, P1, P2
const COL_APEX    = '#34d399';   // green  — accepted apex
const COL_SUGGEST = '#fbbf24';   // amber  — auto-suggested, unconfirmed
const COL_GHOST   = '#6b7280';   // slate  — low-conf rejected proposal (ghost)
const COL_SAGITTA = '#f59e0b';   // orange — sagitta construction line
const COL_ARC     = '#a78bfa';   // violet — fitted arc

function redraw(canvas: HTMLCanvasElement, img: HTMLImageElement, phase: Phase) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const c = ctx;
  canvas.width  = img.naturalWidth;
  canvas.height = img.naturalHeight;
  c.drawImage(img, 0, 0);

  const R  = Math.max(8,  Math.round(img.naturalWidth * 0.006));
  const LW = Math.max(3,  Math.round(img.naturalWidth * 0.003));
  const F  = Math.max(22, Math.round(img.naturalWidth * 0.018));

  /** Solid filled dot with white border. */
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
      c.font      = `bold ${F}px system-ui`;
      c.fillStyle = '#fff';
      c.globalAlpha = 0.9;
      c.fillText(label, p.x + R + 6, p.y + F * 0.35);
      c.globalAlpha = 1;
    }
  }

  /** Dashed ring — "proposed but not confirmed". */
  function dashedRing(p: Point, color: string, label?: string) {
    c.beginPath();
    c.setLineDash([5, 4]);
    c.arc(p.x, p.y, R * 1.5, 0, Math.PI * 2);
    c.strokeStyle = color;
    c.lineWidth   = Math.max(2, LW * 0.9);
    c.globalAlpha = 0.9;
    c.stroke();
    c.setLineDash([]);
    c.globalAlpha = 1;
    // small centre dot
    c.beginPath();
    c.arc(p.x, p.y, R * 0.45, 0, Math.PI * 2);
    c.fillStyle   = color;
    c.globalAlpha = 0.7;
    c.fill();
    c.globalAlpha = 1;
    if (label) {
      c.font      = `bold ${F}px system-ui`;
      c.fillStyle = color;
      c.globalAlpha = 0.9;
      c.fillText(label, p.x + R * 1.8, p.y + F * 0.35);
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

  // Resolve P1 / P2 from the active phase
  const p1: Point | null =
    phase.step === 'placed_p1'   ? phase.p1 :
    phase.step === 'apex_auto'   ? phase.p1 :
    phase.step === 'apex_manual' ? phase.p1 :
    phase.step === 'done'        ? phase.result.p1 : null;

  const p2: Point | null =
    phase.step === 'apex_auto'   ? phase.p2 :
    phase.step === 'apex_manual' ? phase.p2 :
    phase.step === 'done'        ? phase.result.p2 : null;

  if (p1) solidDot(p1, COL_CHORD, 'P1');

  if (p1 && p2) {
    line(p1, p2, COL_CHORD, false);
    solidDot(p2, COL_CHORD, 'P2');
  }

  // Ghost: low-confidence auto candidate the founder rejected / overrode
  if (phase.step === 'apex_manual' && phase.autoCandidate?.confidence === 'low') {
    solidDot(phase.autoCandidate.value, COL_GHOST);
    c.font      = `${Math.round(F * 0.7)}px system-ui`;
    c.fillStyle = COL_GHOST;
    c.globalAlpha = 0.7;
    c.fillText('auto?', phase.autoCandidate.value.x + R + 4, phase.autoCandidate.value.y + F * 0.3);
    c.globalAlpha = 1;
  }

  // Auto-suggested apex (amber dashed ring)
  if (phase.step === 'apex_auto') {
    const mid: Point = { x: (p1!.x + p2!.x)/2, y: (p1!.y + p2!.y)/2 };
    line(mid, phase.candidate.value, COL_SAGITTA, true);
    dashedRing(phase.candidate.value, COL_SUGGEST, 'apex?');
  }

  // Done: full overlay
  if (phase.step === 'done') {
    const { p2: rp2, apex, chordPx, sagittaPx } = phase.result;
    const mid: Point = { x: (p1!.x + rp2.x)/2, y: (p1!.y + rp2.y)/2 };

    // Sagitta construction line
    line(mid, apex, COL_SAGITTA, true);

    // Quadratic bezier arc: P1 → apex → P2
    // Control point Q: bezier midpoint = apex → Q = 2·apex − 0.5·(P1+P2)
    const qx = 2*apex.x - 0.5*(p1!.x + rp2.x);
    const qy = 2*apex.y - 0.5*(p1!.y + rp2.y);
    c.beginPath();
    c.moveTo(p1!.x, p1!.y);
    c.quadraticCurveTo(qx, qy, rp2.x, rp2.y);
    c.strokeStyle = COL_ARC;
    c.lineWidth   = LW;
    c.globalAlpha = 0.7;
    c.stroke();
    c.globalAlpha = 1;

    solidDot(apex, COL_APEX, 'apex');

    // Labels
    c.font      = `${F}px monospace`;
    c.fillStyle = COL_CHORD;
    c.fillText(`chord ${chordPx.toFixed(0)} px`, mid.x + 8, mid.y - 8);
    c.fillStyle = COL_SAGITTA;
    const sagLX = (mid.x + apex.x) / 2 + 8, sagLY = (mid.y + apex.y) / 2;
    c.fillText(`h ${sagittaPx.toFixed(1)} px`, sagLX, sagLY);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function InstructionPill({ text, variant = 'neutral' }: {
  text: string;
  variant?: 'neutral' | 'suggest' | 'warn';
}) {
  const bg =
    variant === 'suggest' ? 'rgba(251,191,36,0.15)'  :
    variant === 'warn'    ? 'rgba(245,158,11,0.15)'  :
    'rgba(99,102,241,0.15)';
  const border =
    variant === 'suggest' ? 'rgba(251,191,36,0.45)'  :
    variant === 'warn'    ? 'rgba(245,158,11,0.4)'   :
    'rgba(99,102,241,0.4)';
  const color =
    variant === 'suggest' ? '#fcd34d' :
    variant === 'warn'    ? '#fbbf24' :
    '#a5b4fc';
  return (
    <div style={{ alignSelf: 'flex-start', padding: '0.3rem 0.9rem', borderRadius: '999px', background: bg, border: `1px solid ${border}`, color, fontSize: '0.8rem', fontWeight: 500 }}>
      {text}
    </div>
  );
}

function DiagRow({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
      <span style={{ color: '#6b7280', flexShrink: 0, width: '26rem' }}>{label}</span>
      <span style={{ color: highlight ? '#34d399' : '#d1d5db', fontWeight: highlight ? 600 : 400 }}>{value}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function TransverseCanvas({
  captureImageId, sessionId, imageUrl, fingerLabel, widthMm, onAccepted,
}: Props) {
  const canvasRef             = useRef<HTMLCanvasElement>(null);
  const imgRef                = useRef<HTMLImageElement | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [phase,     setPhase]     = useState<Phase>({ step: 'idle' });
  const [accepting, setAccepting] = useState(false);
  /**
   * Counts how many full measurement attempts (P1→P2→apex) the founder has
   * started for this image. Increments on each P1 click, resets when the
   * image changes. Passed to buildPointProvenance as attemptCount so the
   * stored record distinguishes first-try accepts from accepted-after-Redo.
   */
  const attemptCountRef = useRef(0);

  // ── Load image ─────────────────────────────────────────────────────────────
  useEffect(() => {
    setImgLoaded(false);
    setPhase({ step: 'idle' });
    attemptCountRef.current = 0;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { imgRef.current = img; setImgLoaded(true); };
    img.src = imageUrl;
  }, [imageUrl]);

  // ── Redraw on phase change ──────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current, img = imgRef.current;
    if (!canvas || !img || !imgLoaded) return;
    redraw(canvas, img, phase);
  }, [phase, imgLoaded]);

  // ── Click handler ───────────────────────────────────────────────────────────
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (accepting || phase.step === 'done') return;
    // In apex_auto: any canvas click = override the apex with the clicked point
    if (phase.step === 'apex_auto') {
      const canvas = e.currentTarget, rect = canvas.getBoundingClientRect();
      const pt: Point = {
        x: (e.clientX - rect.left) * (canvas.width  / rect.width),
        y: (e.clientY - rect.top)  * (canvas.height / rect.height),
      };
      // Founder clicked to override — proposal not accepted
      const result = buildResult(phase.p1, phase.p2, pt, widthMm, phase.candidate, false, phase.blurScore, attemptCountRef.current);
      setPhase({ step: 'done', result });
      return;
    }

    const canvas = e.currentTarget, rect = canvas.getBoundingClientRect();
    const pt: Point = {
      x: (e.clientX - rect.left) * (canvas.width  / rect.width),
      y: (e.clientY - rect.top)  * (canvas.height / rect.height),
    };

    if (phase.step === 'idle') {
      attemptCountRef.current += 1;
      setPhase({ step: 'placed_p1', p1: pt });
      return;
    }

    if (phase.step === 'placed_p1') {
      const p1 = phase.p1, p2 = pt;
      const canvas2 = canvasRef.current;
      // Run auto-detect and blur check synchronously on the canvas pixel data
      const candidate  = canvas2 ? detectApex(canvas2, p1, p2) : null;
      const blurScore  = canvas2 ? computeBlurScore(canvas2, p1, p2) : null;

      if (candidate) {
        setPhase({ step: 'apex_auto', p1, p2, candidate, blurScore });
      } else {
        setPhase({ step: 'apex_manual', p1, p2, autoCandidate: null, blurScore });
      }
      return;
    }

    if (phase.step === 'apex_manual') {
      // Founder placed apex manually — proposal not accepted (or was null)
      const result = buildResult(phase.p1, phase.p2, pt, widthMm, phase.autoCandidate, false, phase.blurScore, attemptCountRef.current);
      setPhase({ step: 'done', result });
    }
  }, [phase, accepting, widthMm]);

  // ── Accept suggested apex ────────────────────────────────────────────────────
  const handleAcceptSuggestion = useCallback(() => {
    if (phase.step !== 'apex_auto') return;
    // Founder accepted computer's proposal — proposalAccepted = true
    const result = buildResult(phase.p1, phase.p2, phase.candidate.value, widthMm, phase.candidate, true, phase.blurScore, attemptCountRef.current);
    setPhase({ step: 'done', result });
  }, [phase, widthMm]);

  // ── Re-pick apex (from apex_auto → apex_manual) ──────────────────────────────
  const handleRepick = useCallback(() => {
    if (phase.step !== 'apex_auto') return;
    setPhase({
      step:          'apex_manual',
      p1:            phase.p1,
      p2:            phase.p2,
      autoCandidate: phase.candidate,
      blurScore:     phase.blurScore,
    });
  }, [phase]);

  // ── Redo from scratch ───────────────────────────────────────────────────────
  const handleRedo = useCallback(() => setPhase({ step: 'idle' }), []);

  // ── Accept final result to API ───────────────────────────────────────────────
  const handleAccept = useCallback(async () => {
    if (phase.step !== 'done') return;
    setAccepting(true);
    const { p1, p2, apex, chordPx, sagittaPx, arcScore, chordWidthMm, sagittaMm, icMm, apexProvenance, regionBlurScore } = phase.result;
    try {
      const res = await fetch('/api/measure/transverse/accept', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          captureImageId, sessionId,
          chordEndpointsPx: [p1, p2],
          apexPx:           apex,
          chordLengthPx:    chordPx,
          sagittaPx, arcScore,
          chordWidthMm, sagittaMm, icMm,
          apexProvenance,
          regionBlurScore,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        alert(`Accept failed: ${err.error ?? res.statusText}`);
        return;
      }
      onAccepted?.(phase.result);
    } catch (err) {
      alert(`Accept failed: ${String(err)}`);
    } finally {
      setAccepting(false);
    }
  }, [phase, captureImageId, sessionId, onAccepted]);

  // ── Derive instruction + cursor ─────────────────────────────────────────────
  const instruction: { text: string; variant?: 'neutral' | 'suggest' | 'warn' } | null =
    phase.step === 'idle'         ? { text: 'Step 1 — Click the left lateral edge (sidewall endpoint)' } :
    phase.step === 'placed_p1'    ? { text: 'Step 2 — Click the right lateral edge (sidewall endpoint)' } :
    phase.step === 'apex_auto'
      ? phase.candidate.confidence === 'high'
          ? { text: 'Auto-detected apex  ·  Accept below or click anywhere to reposition', variant: 'suggest' }
          : { text: 'Weak auto-detection  ·  Accept if correct, click canvas to reposition, or Re-pick', variant: 'warn' }
      : phase.step === 'apex_manual' ? { text: 'Step 3 — Click the apex — highest visible point of the arc' }
      : null;

  const cursor =
    phase.step === 'done'      ? 'default'    :
    phase.step === 'apex_auto' ? 'crosshair'  :
    accepting                  ? 'wait'       :
    !imgLoaded                 ? 'default'    : 'crosshair';

  const result = phase.step === 'done' ? phase.result : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>

      {/* Instruction pill */}
      {instruction && imgLoaded && (
        <InstructionPill text={instruction.text} variant={instruction.variant} />
      )}

      {/* Canvas */}
      <div style={{ position: 'relative', display: 'inline-block' }}>
        {!imgLoaded && (
          <div style={{ width: '100%', height: '320px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', fontSize: '0.875rem' }}>
            Loading image…
          </div>
        )}
        <canvas
          ref={canvasRef}
          onClick={handleClick}
          style={{
            display:    imgLoaded ? 'block' : 'none',
            maxWidth:   '100%',
            maxHeight:  '64vh',
            borderRadius: '6px',
            userSelect: 'none',
            cursor,
          }}
        />
      </div>

      {/* apex_auto action bar */}
      {phase.step === 'apex_auto' && (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '0.78rem', color: '#6b7280', marginRight: 'auto' }}>
            outer arc {((phase.candidate.extra?.arcScore as number) ?? 0).toFixed(3)}
            {' · '}inner peak arc {((phase.candidate.extra?.peakArcScore as number) ?? 0).toFixed(3)}
            {' · '}
            <span style={{ color: phase.candidate.confidence === 'high' ? '#34d399' : '#f59e0b' }}>
              {phase.candidate.confidence} confidence
            </span>
          </div>
          <button onClick={handleRepick} style={btnStyle('ghost')}>Re-pick apex</button>
          <button onClick={handleAcceptSuggestion} style={btnStyle('accept')}>Accept apex →</button>
        </div>
      )}

      {/* Result panel */}
      {result && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
            {/* Primary metric */}
            <div>
              {result.icMm !== null ? (
                <>
                  <span style={{ fontSize: '1.75rem', fontWeight: 700, color: '#34d399', letterSpacing: '-0.02em' }}>
                    {result.icMm.toFixed(2)} mm
                  </span>
                  <span style={{ marginLeft: '0.5rem', color: '#9ca3af', fontSize: '0.8rem' }}>IC radius</span>
                </>
              ) : (
                <>
                  <span style={{ fontSize: '1.75rem', fontWeight: 700, color: '#a78bfa', letterSpacing: '-0.02em' }}>
                    {isFinite(result.icPx) ? result.icPx.toFixed(1) : '∞'} px
                  </span>
                  <span style={{ marginLeft: '0.5rem', color: '#9ca3af', fontSize: '0.8rem' }}>
                    IC radius (px — no width ref)
                  </span>
                </>
              )}
            </div>
            {/* Buttons */}
            <div style={{ display: 'flex', gap: '0.5rem', marginLeft: 'auto' }}>
              <button onClick={handleRedo}   disabled={accepting} style={btnStyle('ghost')}>Redo</button>
              <button onClick={handleAccept} disabled={accepting} style={btnStyle('accept')}>
                {accepting ? 'Saving…' : 'Accept →'}
              </button>
            </div>
          </div>

          {/* Diagnostics */}
          <div style={{ padding: '0.75rem 1rem', background: 'rgba(17,24,39,0.85)', border: '1px solid #374151', borderRadius: '6px', fontSize: '0.75rem', fontFamily: 'monospace', lineHeight: 1.8 }}>
            <div style={{ color: '#4b5563', marginBottom: '0.4rem', fontFamily: 'system-ui', letterSpacing: '0.07em', textTransform: 'uppercase', fontSize: '0.62rem' }}>
              D4.9 IC · {fingerLabel}
            </div>
            <DiagRow label="P1 (left edge, px)"         value={`x=${result.p1.x.toFixed(0)}  y=${result.p1.y.toFixed(0)}`} />
            <DiagRow label="P2 (right edge, px)"        value={`x=${result.p2.x.toFixed(0)}  y=${result.p2.y.toFixed(0)}`} />
            <DiagRow label="Apex (px)"                  value={`x=${result.apex.x.toFixed(0)}  y=${result.apex.y.toFixed(0)}`} />
            <DiagRow label="Chord px"                   value={`${result.chordPx.toFixed(2)} px`} />
            <DiagRow label="Sagitta px"                 value={`${result.sagittaPx.toFixed(2)} px`} />
            <DiagRow label="Arc score (h/W)"            value={result.arcScore.toFixed(4)} />
            <DiagRow label="IC px (circumscribed)"      value={isFinite(result.icPx) ? result.icPx.toFixed(2)+' px' : '∞ (flat arc)'} />
            {result.regionBlurScore !== null && (
              <DiagRow
                label="Region blur score (Laplacian var)"
                value={`${result.regionBlurScore}${result.regionBlurScore < 20 ? ' ⚠ blurry' : result.regionBlurScore > 60 ? ' ✓ sharp' : ' marginal'}`}
              />
            )}

            {/* Auto-detection sub-section */}
            {result.apexProvenance?.computerProposal != null && (() => {
              const cp  = result.apexProvenance!.computerProposal!;
              const prov = result.apexProvenance!;
              return (
                <>
                  <div style={{ borderTop: '1px solid #374151', margin: '0.4rem 0' }} />
                  <div style={{ color: '#4b5563', fontFamily: 'system-ui', letterSpacing: '0.07em', textTransform: 'uppercase', fontSize: '0.62rem', marginBottom: '0.2rem' }}>
                    auto-detect result
                  </div>
                  <DiagRow label="Proposed apex (px)"        value={`x=${cp.value.x.toFixed(0)}  y=${cp.value.y.toFixed(0)}`} />
                  <DiagRow label="Outer boundary score"      value={(cp.score ?? 0).toFixed(1)} />
                  <DiagRow label="Outer arc score"           value={((cp.extra?.arcScore as number) ?? 0).toFixed(3)} />
                  <DiagRow label="Inner peak (cuticle) arc"  value={((cp.extra?.peakArcScore as number) ?? 0).toFixed(3)}
                    highlight={(cp.extra?.peakArcScore as number) < (cp.extra?.arcScore as number)} />
                  <DiagRow label="Inner peak gradient"       value={((cp.extra?.peakScore as number) ?? 0).toFixed(1)} />
                  <DiagRow label="Outer/inner fraction"      value={((cp.extra?.fractionOfPeak as number) ?? 0).toFixed(2)}
                    highlight={(cp.extra?.fractionOfPeak as number) > 0.6} />
                  <DiagRow label="Confidence"                value={cp.confidence} highlight={cp.confidence === 'high'} />
                  <DiagRow label="Founder accepted proposal" value={String(prov.acceptedProposal ?? false)} highlight={prov.acceptedProposal === true} />
                  {prov.correctionMagnitude !== null && prov.correctionMagnitude > 0 && (
                    <DiagRow
                      label="Founder apex vs. auto (px)"
                      value={`Δ${prov.correctionMagnitude.toFixed(1)} px`}
                    />
                  )}
                  {(prov.correctionMagnitude === 0 || prov.acceptedProposal) && (
                    <DiagRow label="Apex delta vs. placed" value="—" />
                  )}
                </>
              );
            })()}
            {result.apexProvenance?.computerProposal == null && (
              <>
                <div style={{ borderTop: '1px solid #374151', margin: '0.4rem 0' }} />
                <div style={{ color: '#6b7280', fontSize: '0.72rem', fontFamily: 'system-ui' }}>
                  Auto-detect: no candidate found (gradient threshold not met or canvas unavailable)
                </div>
              </>
            )}

            {/* mm-space section */}
            {widthMm !== null && (
              <>
                <div style={{ borderTop: '1px solid #374151', margin: '0.4rem 0' }} />
                <div style={{ color: '#4b5563', fontFamily: 'system-ui', letterSpacing: '0.07em', textTransform: 'uppercase', fontSize: '0.62rem', marginBottom: '0.2rem' }}>
                  mm scale · top-down width {widthMm.toFixed(2)} mm
                </div>
                <DiagRow label="Scale (px/mm)"  value={result.chordPx > 0 ? (result.chordPx / widthMm).toFixed(3)+' px/mm' : '—'} />
                <DiagRow label="W (chord mm)"   value={result.chordWidthMm !== null ? result.chordWidthMm.toFixed(3)+' mm' : '—'} highlight />
                <DiagRow label="h (sagitta mm)" value={result.sagittaMm    !== null ? result.sagittaMm.toFixed(3)+' mm'    : '—'} />
                <DiagRow label="IC mm"          value={result.icMm         !== null ? result.icMm.toFixed(3)+' mm'         : '—'} highlight />
              </>
            )}
            {widthMm === null && (
              <>
                <div style={{ borderTop: '1px solid #374151', margin: '0.4rem 0' }} />
                <div style={{ color: '#f59e0b', fontSize: '0.72rem', fontFamily: 'system-ui' }}>
                  ⚠ No top-down width for this finger — IC stored in px only. Accept chord measurement first.
                </div>
              </>
            )}
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
