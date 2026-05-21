'use client';

import { useEffect, useRef, useState } from 'react';
import {
  detectCard,
  Detection,
  DETECT_LONG_EDGE,
} from '@/lib/capture-v2/card-detector';

/**
 * CardOverlay — non-blocking live card-detection overlay.
 *
 * Renders an absolutely-positioned canvas that sits on top of a live video
 * element. On each animation frame the canvas samples the current video
 * frame into an offscreen canvas at detection resolution, runs the JS
 * card detector, and (if a card is found) draws the detected quadrilateral
 * back onto the visible overlay canvas in the video's display coordinate
 * space.
 *
 * Why this shape
 * --------------
 * 1. Cosmetic only. The capture flow (canvas snapshot → normalize → upload)
 *    is untouched. This component reads from the video stream and draws
 *    onto its own canvas. Nothing it does affects what gets captured.
 *
 * 2. Resolution-decoupled. The video preview can be any size; the detector
 *    always runs against a frame downsampled to DETECT_LONG_EDGE on its
 *    long edge (matching probe.py). This keeps per-frame cost roughly
 *    constant across devices.
 *
 * 3. Coordinate-space-aware. Detected corners come back in the offscreen
 *    canvas's coords (= detection resolution). Before drawing we scale
 *    them to the overlay canvas's CSS pixel size so the quadrilateral
 *    lines up with the visible video frame, no matter how the video is
 *    being letterboxed by `object-fit: cover`.
 *
 * 4. Throttled. The RAF loop runs at the browser's natural cadence (usually
 *    60 fps), but we skip frames if the detector is still working on the
 *    previous one. On a mid-tier phone the detector takes 50–150ms, so
 *    we'll typically run ~7–15 detections per second — plenty for the
 *    overlay to feel live without thrashing the main thread.
 *
 * 5. Fail-soft. Any error inside the detector is caught and logged once
 *    per session; the overlay keeps trying so a transient hiccup doesn't
 *    leave the user staring at a frozen box.
 */

type Props = {
  /** Live video element to read frames from. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Whether to actually run the detector. Set false to pause cleanly
   *  without unmounting the component (e.g., during capture or while
   *  the parent is showing a different screen). */
  active: boolean;
  /**
   * Optional. Called with the latest Detection (or null) on every detector
   * cycle. The parent should NOT use this to gate UI in the current
   * increment — we're surfacing it for the dev-overlay readout and for
   * future increments that will add guidance.
   */
  onDetection?: (detection: Detection | null) => void;
};

export default function CardOverlay({ videoRef, active, onDetection }: Props) {
  // Visible overlay canvas — drawn into in CSS pixels so the quadrilateral
  // overlays the video preview at the right size.
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);

  // Offscreen canvas used purely to sample the current video frame at
  // detection resolution. Created once and resized as the video reports
  // new intrinsic dimensions.
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Guard so the next RAF tick doesn't kick off a detector run while the
  // previous one is still in flight. The detector is synchronous so the
  // "in flight" window is just the JS execution time of detectCard, but
  // the guard still saves us from double-running when something stalls.
  const detectingRef = useRef(false);

  // We log detector errors at most once per mount so a persistent bug
  // doesn't spam the console. Recoverable transient errors are still
  // suppressed by the surrounding try/catch.
  const errorLoggedRef = useRef(false);

  // Latest detection — held in a ref so the RAF loop can read/write
  // without forcing component rerenders. We mirror it into state below
  // only for the dev readout, behind a throttle.
  const lastDetectionRef = useRef<Detection | null>(null);

  // Dev-only readout state. Updated at most ~4x per second so React isn't
  // doing render work on every detector cycle.
  const [displayDetection, setDisplayDetection] = useState<Detection | null>(
    null
  );

  useEffect(() => {
    if (!active) return;

    let rafId = 0;
    let cancelled = false;
    let lastReadoutMs = 0;

    function getSampleCanvas(): HTMLCanvasElement {
      if (!sampleCanvasRef.current) {
        sampleCanvasRef.current = document.createElement('canvas');
      }
      return sampleCanvasRef.current;
    }

    function tick() {
      if (cancelled) return;
      rafId = requestAnimationFrame(tick);

      const video = videoRef.current;
      const overlay = overlayCanvasRef.current;
      if (!video || !overlay) return;
      if (video.readyState < 2) return; // HAVE_CURRENT_DATA
      if (video.videoWidth === 0 || video.videoHeight === 0) return;
      if (detectingRef.current) return;

      detectingRef.current = true;
      try {
        runDetectionCycle(video, overlay);
      } catch (err) {
        if (!errorLoggedRef.current) {
          errorLoggedRef.current = true;
          // eslint-disable-next-line no-console
          console.warn('[CardOverlay] detector error (silenced after first):', err);
        }
        // Don't leave a stale box on the overlay if the detector blew up.
        clearOverlay(overlay);
        lastDetectionRef.current = null;
      } finally {
        detectingRef.current = false;
      }

      // Throttle the React state update for the dev readout.
      const now = performance.now();
      if (now - lastReadoutMs > 250) {
        lastReadoutMs = now;
        setDisplayDetection(lastDetectionRef.current);
        if (onDetection) onDetection(lastDetectionRef.current);
      }
    }

    function runDetectionCycle(
      video: HTMLVideoElement,
      overlay: HTMLCanvasElement
    ) {
      // Sample resolution: aim for DETECT_LONG_EDGE on the long edge so the
      // detector sees roughly the same resolution that probe.py was tuned
      // against, regardless of the actual stream resolution.
      const vidW = video.videoWidth;
      const vidH = video.videoHeight;
      const inputLong = Math.max(vidW, vidH);
      const scale = inputLong > DETECT_LONG_EDGE ? DETECT_LONG_EDGE / inputLong : 1;
      const sampW = Math.max(1, Math.round(vidW * scale));
      const sampH = Math.max(1, Math.round(vidH * scale));

      const sample = getSampleCanvas();
      if (sample.width !== sampW) sample.width = sampW;
      if (sample.height !== sampH) sample.height = sampH;
      const sampleCtx = sample.getContext('2d', { willReadFrequently: true });
      if (!sampleCtx) return;
      sampleCtx.imageSmoothingEnabled = false;
      sampleCtx.drawImage(video, 0, 0, sampW, sampH);

      const imageData = sampleCtx.getImageData(0, 0, sampW, sampH);
      const detection = detectCard(imageData);
      lastDetectionRef.current = detection;

      // Match the overlay canvas's backing-store resolution to its
      // displayed CSS size so 1px-thick lines stay sharp on high-DPR
      // screens. We resize lazily — only when the CSS box has changed —
      // so the loop doesn't churn the canvas allocator every frame.
      const cssW = overlay.clientWidth;
      const cssH = overlay.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      const backingW = Math.max(1, Math.round(cssW * dpr));
      const backingH = Math.max(1, Math.round(cssH * dpr));
      if (overlay.width !== backingW) overlay.width = backingW;
      if (overlay.height !== backingH) overlay.height = backingH;

      const overlayCtx = overlay.getContext('2d');
      if (!overlayCtx) return;
      overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
      overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

      if (!detection) return;

      // The video uses object-fit: cover, so the displayed video crops
      // either the top/bottom or left/right of the source frame to fill
      // the overlay's CSS box. We need to map sample-canvas coords →
      // CSS coords through the same cover transform.
      const { offsetX, offsetY, scaleVisible } = computeCoverMap(
        sampW,
        sampH,
        cssW,
        cssH
      );

      const color = detection.confidence === 'high' ? '#22c55e' : '#facc15';
      overlayCtx.scale(dpr, dpr);
      overlayCtx.lineWidth = 3;
      overlayCtx.strokeStyle = color;
      overlayCtx.fillStyle = color;
      overlayCtx.beginPath();
      detection.corners.forEach((p, i) => {
        const x = p.x * scaleVisible + offsetX;
        const y = p.y * scaleVisible + offsetY;
        if (i === 0) overlayCtx.moveTo(x, y);
        else overlayCtx.lineTo(x, y);
      });
      overlayCtx.closePath();
      overlayCtx.stroke();
      // Corner dots — useful both visually and for the eventual
      // distance/tilt readout.
      for (const p of detection.corners) {
        const x = p.x * scaleVisible + offsetX;
        const y = p.y * scaleVisible + offsetY;
        overlayCtx.beginPath();
        overlayCtx.arc(x, y, 5, 0, Math.PI * 2);
        overlayCtx.fill();
      }
    }

    // Snapshot the canvas ref now so the cleanup function doesn't read a
    // post-unmount/post-rerender ref value (eslint react-hooks/exhaustive-
    // deps flag). The visible overlay belongs to this effect's lifecycle.
    const overlayAtEffectStart = overlayCanvasRef.current;
    rafId = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (overlayAtEffectStart) clearOverlay(overlayAtEffectStart);
    };
  }, [active, videoRef, onDetection]);

  return (
    <>
      <canvas
        ref={overlayCanvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
      />
      {active && displayDetection !== undefined && (
        <DetectionReadout detection={displayDetection} />
      )}
    </>
  );
}

function clearOverlay(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

/**
 * Compute the offset+scale that maps coordinates in the sample-canvas's
 * frame to CSS coordinates of a container styled `object-fit: cover` over
 * the same source aspect ratio. `cover` scales the source so it fully
 * covers the container, cropping whichever axis overflows; the offset is
 * negative on the cropped axis.
 */
function computeCoverMap(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): { offsetX: number; offsetY: number; scaleVisible: number } {
  if (srcW === 0 || srcH === 0) {
    return { offsetX: 0, offsetY: 0, scaleVisible: 1 };
  }
  const scale = Math.max(dstW / srcW, dstH / srcH);
  const scaledW = srcW * scale;
  const scaledH = srcH * scale;
  return {
    offsetX: (dstW - scaledW) / 2,
    offsetY: (dstH - scaledH) / 2,
    scaleVisible: scale,
  };
}

/**
 * Dev-only readout positioned at the top-left corner of the video. Shows
 * method / confidence / area% / ratio so we can verify on real devices
 * that the detector is firing and producing sensible numbers without
 * having to open devtools.
 *
 * This is the same kind of temporary surface as the CaptureDiagnostics
 * panel on the captured-photo screen — useful during phase 1 device
 * testing, removed once we trust the pipeline.
 */
function DetectionReadout({ detection }: { detection: Detection | null }) {
  if (!detection) {
    return (
      <div className="absolute top-2 left-2 px-2 py-1 rounded bg-black/60 text-white text-[10px] font-mono pointer-events-none">
        searching…
      </div>
    );
  }
  return (
    <div className="absolute top-2 left-2 px-2 py-1 rounded bg-black/70 text-white text-[10px] font-mono leading-tight pointer-events-none">
      <div>
        {detection.method} · {detection.confidence}
      </div>
      <div>
        area {(detection.metrics.areaFrac * 100).toFixed(1)}% · ratio{' '}
        {detection.metrics.ratio.toFixed(2)}
      </div>
    </div>
  );
}
