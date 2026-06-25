'use client';

import { useCallback, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChordResult = {
  width_mm:        number;
  length_mm:       number;
  angle_deg:       number;
  overlay_image_b64: string;
  contour_px:      [number, number][];
  mrr_corners_mm:  [number, number][];
  nail_click_used: { x: number; y: number };
};

type Phase =
  | { step: 'idle' }
  | { step: 'loading'; clickNatural: { x: number; y: number } }
  | { step: 'done';    clickNatural: { x: number; y: number }; result: ChordResult }
  | { step: 'error';   message: string };

type Props = {
  captureImageId: string;
  sessionId:      string;
  imageUrl:       string;
  onAccepted?:    (result: ChordResult) => void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a display-space click to natural image coordinates. */
function toNaturalCoords(
  e: React.MouseEvent<HTMLImageElement>,
): { x: number; y: number } {
  const img = e.currentTarget;
  const rect = img.getBoundingClientRect();
  const scaleX = img.naturalWidth  / rect.width;
  const scaleY = img.naturalHeight / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top)  * scaleY,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChordCanvas({ captureImageId, sessionId, imageUrl, onAccepted }: Props) {
  const [phase, setPhase] = useState<Phase>({ step: 'idle' });
  const [accepting, setAccepting] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // ── Measure ──────────────────────────────────────────────────────────────
  const handleClick = useCallback(
    async (e: React.MouseEvent<HTMLImageElement>) => {
      if (phase.step === 'loading' || accepting) return;

      const natural = toNaturalCoords(e);
      setPhase({ step: 'loading', clickNatural: natural });

      try {
        const res = await fetch('/api/measure/chord', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            captureImageId,
            nail_x: natural.x,
            nail_y: natural.y,
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          setPhase({ step: 'error', message: err.error ?? 'Measurement failed' });
          return;
        }

        const data: ChordResult = await res.json();
        setPhase({ step: 'done', clickNatural: natural, result: data });
      } catch (err) {
        setPhase({ step: 'error', message: String(err) });
      }
    },
    [captureImageId, phase.step, accepting],
  );

  // ── Accept ───────────────────────────────────────────────────────────────
  const handleAccept = useCallback(async () => {
    if (phase.step !== 'done') return;
    setAccepting(true);

    try {
      const res = await fetch('/api/measure/chord/accept', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          captureImageId,
          sessionId,
          width_mm:       phase.result.width_mm,
          length_mm:      phase.result.length_mm,
          angle_deg:      phase.result.angle_deg,
          contour_px:     phase.result.contour_px,
          mrr_corners_mm: phase.result.mrr_corners_mm,
          nail_click_px:  phase.result.nail_click_used,
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

  // ── Reset ────────────────────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    setPhase({ step: 'idle' });
    setAccepting(false);
  }, []);

  // ── Derive display image src ──────────────────────────────────────────────
  const overlayB64 =
    phase.step === 'done' ? phase.result.overlay_image_b64 : null;
  const imageSrc = overlayB64
    ? `data:image/png;base64,${overlayB64}`
    : imageUrl;

  const cursorStyle =
    phase.step === 'loading' || accepting
      ? 'wait'
      : phase.step === 'done'
      ? 'default'
      : 'crosshair';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {/* ── Canvas ─────────────────────────────────────────────────────── */}
      <div style={{ position: 'relative', display: 'inline-block' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={imageSrc}
          alt="Nail capture"
          onClick={phase.step === 'done' ? undefined : handleClick}
          style={{
            display:    'block',
            maxWidth:   '100%',
            maxHeight:  '70vh',
            cursor:     cursorStyle,
            borderRadius: '6px',
            userSelect: 'none',
          }}
          draggable={false}
        />

        {/* Loading spinner overlay */}
        {phase.step === 'loading' && (
          <div
            style={{
              position:    'absolute',
              inset:       0,
              display:     'flex',
              alignItems:  'center',
              justifyContent: 'center',
              background:  'rgba(0,0,0,0.4)',
              borderRadius: '6px',
              color:       '#fff',
              fontSize:    '0.875rem',
              fontWeight:  600,
            }}
          >
            Measuring…
          </div>
        )}
      </div>

      {/* ── Status / result ────────────────────────────────────────────── */}
      {phase.step === 'idle' && (
        <p style={{ color: '#9ca3af', fontSize: '0.875rem', margin: 0 }}>
          Click the center of the nail to measure chord width.
        </p>
      )}

      {phase.step === 'error' && (
        <div style={{ color: '#f87171', fontSize: '0.875rem' }}>
          <strong>Error:</strong> {phase.message}
          <button
            onClick={handleReset}
            style={{
              marginLeft: '0.75rem',
              padding:    '0.25rem 0.6rem',
              fontSize:   '0.8rem',
              borderRadius: '4px',
              border:     '1px solid #f87171',
              background: 'transparent',
              color:      '#f87171',
              cursor:     'pointer',
            }}
          >
            Retry
          </button>
        </div>
      )}

      {phase.step === 'done' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', flexWrap: 'wrap' }}>
          {/* Width result */}
          <div>
            <span
              style={{
                fontSize:   '1.75rem',
                fontWeight: 700,
                color:      '#34d399',
                letterSpacing: '-0.02em',
              }}
            >
              {phase.result.width_mm.toFixed(2)} mm
            </span>
            <span style={{ marginLeft: '0.5rem', color: '#9ca3af', fontSize: '0.8rem' }}>
              chord width
            </span>
          </div>

          <div style={{ color: '#6b7280', fontSize: '0.8rem' }}>
            length {phase.result.length_mm.toFixed(2)} mm
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: '0.5rem', marginLeft: 'auto' }}>
            <button
              onClick={handleReset}
              disabled={accepting}
              style={{
                padding:    '0.4rem 0.85rem',
                fontSize:   '0.8rem',
                borderRadius: '5px',
                border:     '1px solid #4b5563',
                background: 'transparent',
                color:      '#9ca3af',
                cursor:     accepting ? 'not-allowed' : 'pointer',
              }}
            >
              Redo
            </button>
            <button
              onClick={handleAccept}
              disabled={accepting}
              style={{
                padding:    '0.4rem 1rem',
                fontSize:   '0.8rem',
                fontWeight: 600,
                borderRadius: '5px',
                border:     'none',
                background: accepting ? '#1d4ed8' : '#2563eb',
                color:      '#fff',
                cursor:     accepting ? 'not-allowed' : 'pointer',
              }}
            >
              {accepting ? 'Saving…' : 'Accept →'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
