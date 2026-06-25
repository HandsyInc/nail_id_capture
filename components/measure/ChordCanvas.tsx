'use client';

import { useCallback, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// D4.8 app-layer diagnostics — always present when routed through
// app/api/measure/chord/route.ts (computed there from the stored H matrix).

export type BboxDiag = {
  bbox_px:               { minX: number; minY: number; maxX: number; maxY: number };
  bbox_width_px:         number;
  bbox_height_px:        number;
  centroid_px:           { x: number; y: number };
  bbox_mm:               { minX: number; minY: number; maxX: number; maxY: number };
  bbox_width_mm:         number;
  bbox_height_mm:        number;
  bbox_scale_x_mm_per_px: number;
  bbox_scale_y_mm_per_px: number;
  jacobian_at_centroid:  number;
};

export type ChordDiag = {
  scale_mm_per_px_at_click: number;        // mm/px at nail click — H Jacobian
  depth_correction_factor:  number;        // (D − h) / D
  h_used_mm:                number;
  D_used_mm:                number;
  mrr_width_px:             number | null; // MRR short side in pixels, before H
  mrr_length_px:            number | null; // MRR long  side in pixels, before H
  mrr_width_raw_mm:         number | null; // MRR short side after H, before depth
  mrr_length_raw_mm:        number | null; // MRR long  side after H, before depth
  mrr_width_implied_px:     number | null; // mrr_width_raw_mm / scale (cross-check)
  bbox:                     BboxDiag | null;
  h_matrix:                 { row0: number[]; row1: number[]; row2: number[] } | null;
};

export type ChordResult = {
  width_mm:          number;
  length_mm:         number;
  angle_deg:         number;
  overlay_image_b64: string;
  contour_px:        [number, number][];
  mrr_corners_mm:    [number, number][];
  nail_click_used:   { x: number; y: number };
  diag?:             ChordDiag;   // always present with current route.ts
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
// Diagnostic row helper (used inside ChordCanvas)

function DiagRow({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
      <span style={{ color: '#6b7280', flexShrink: 0, width: '22rem' }}>{label}</span>
      <span style={{ color: highlight ? '#34d399' : '#d1d5db', fontWeight: highlight ? 600 : 400 }}>
        {value}
      </span>
    </div>
  );
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
        <>
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

          {/* D4.8 diagnostic panel — always present (diag computed in route.ts) */}
          {phase.result.diag && (
            <div
              style={{
                marginTop:    '0.75rem',
                padding:      '0.75rem 1rem',
                background:   'rgba(17,24,39,0.8)',
                border:       '1px solid #374151',
                borderRadius: '6px',
                fontSize:     '0.75rem',
                fontFamily:   'monospace',
                color:        '#9ca3af',
                lineHeight:   1.7,
              }}
            >
              <div style={{ color: '#4b5563', marginBottom: '0.4rem', fontFamily: 'system-ui', letterSpacing: '0.07em', textTransform: 'uppercase', fontSize: '0.62rem' }}>
                D4.8 pipeline breakdown
              </div>

              {/* ① pixel MRR */}
              <DiagRow
                label="① MRR width  (px, before H)"
                value={phase.result.diag.mrr_width_px !== null
                  ? `${phase.result.diag.mrr_width_px!.toFixed(1)} px   ×   ${phase.result.diag.mrr_length_px!.toFixed(1)} px`
                  : 'not returned by service'}
              />

              {/* ② scale */}
              <DiagRow
                label="② scale at click  (H Jacobian)"
                value={`${phase.result.diag.scale_mm_per_px_at_click.toFixed(5)} mm/px   =   ${(1 / phase.result.diag.scale_mm_per_px_at_click).toFixed(3)} px/mm`}
              />

              {/* ③ post-H pre-depth */}
              <DiagRow
                label="③ MRR width  (mm after H, before depth)"
                value={phase.result.diag.mrr_width_raw_mm !== null
                  ? `${phase.result.diag.mrr_width_raw_mm!.toFixed(4)} mm   ×   ${phase.result.diag.mrr_length_raw_mm!.toFixed(4)} mm`
                  : 'not returned by service'}
                highlight={phase.result.diag.mrr_width_raw_mm !== null}
              />

              {/* ③b cross-check */}
              {phase.result.diag.mrr_width_implied_px !== null && (
                <DiagRow
                  label="   implied px  (③ ÷ ②)"
                  value={`${phase.result.diag.mrr_width_implied_px!.toFixed(1)} px  ${
                    phase.result.diag.mrr_width_px !== null
                      ? `(service: ${phase.result.diag.mrr_width_px!.toFixed(1)} px)`
                      : ''
                  }`}
                />
              )}

              {/* ④ depth correction */}
              <DiagRow
                label={`④ depth correction  ×(D−h)/D  =  (${phase.result.diag.D_used_mm}−${phase.result.diag.h_used_mm})/${phase.result.diag.D_used_mm}`}
                value={`×${phase.result.diag.depth_correction_factor.toFixed(5)}`}
              />

              {/* ⑤ final */}
              <DiagRow
                label="⑤ final depth-corrected width"
                value={`${phase.result.width_mm.toFixed(4)} mm`}
                highlight
              />

              {/* click */}
              <DiagRow
                label="nail click (natural px)"
                value={`x = ${phase.result.nail_click_used.x.toFixed(0)},  y = ${phase.result.nail_click_used.y.toFixed(0)}`}
              />

              {/* ⑥ Bounding-box cross-check */}
              {phase.result.diag.bbox && (() => {
                const b = phase.result.diag.bbox!;
                const agree = Math.abs(b.bbox_scale_x_mm_per_px - b.jacobian_at_centroid) /
                              b.jacobian_at_centroid < 0.05; // within 5%
                return (
                  <>
                    <div style={{ borderTop: '1px solid #374151', margin: '0.4rem 0' }} />
                    <div style={{ color: '#4b5563', marginBottom: '0.2rem', fontFamily: 'system-ui', letterSpacing: '0.07em', textTransform: 'uppercase', fontSize: '0.62rem' }}>
                      ⑥ contour bbox cross-check (coordinate-space verification)
                    </div>
                    <DiagRow
                      label="   bbox  (px)"
                      value={`${b.bbox_width_px.toFixed(0)} × ${b.bbox_height_px.toFixed(0)} px   centroid (${b.centroid_px.x.toFixed(0)}, ${b.centroid_px.y.toFixed(0)})`}
                    />
                    <DiagRow
                      label="   bbox  (mm after H)"
                      value={`${b.bbox_width_mm.toFixed(3)} × ${b.bbox_height_mm.toFixed(3)} mm`}
                    />
                    <DiagRow
                      label="   empirical scale x  (bbox_mm / bbox_px)"
                      value={`${b.bbox_scale_x_mm_per_px.toFixed(5)} mm/px`}
                      highlight={!agree}
                    />
                    <DiagRow
                      label="   empirical scale y  (bbox_mm / bbox_px)"
                      value={`${b.bbox_scale_y_mm_per_px.toFixed(5)} mm/px`}
                    />
                    <DiagRow
                      label="   Jacobian at contour centroid"
                      value={`${b.jacobian_at_centroid.toFixed(5)} mm/px`}
                    />
                    <DiagRow
                      label="   coordinate space check"
                      value={agree
                        ? '✓ empirical ≈ Jacobian — contour in full-res pixel space'
                        : `✗ MISMATCH  ratio = ${(b.bbox_scale_x_mm_per_px / b.jacobian_at_centroid).toFixed(3)}  — contour likely in downsampled space`}
                      highlight={!agree}
                    />
                  </>
                );
              })()}

              {/* H matrix */}
              {phase.result.diag.h_matrix && (() => {
                const hm = phase.result.diag.h_matrix!;
                return (
                  <>
                    <div style={{ borderTop: '1px solid #374151', margin: '0.4rem 0' }} />
                    <div style={{ color: '#4b5563', marginBottom: '0.2rem', fontFamily: 'system-ui', letterSpacing: '0.07em', textTransform: 'uppercase', fontSize: '0.62rem' }}>
                      H matrix (imageToCard, px → mm)
                    </div>
                    <DiagRow label="   row 0" value={`[ ${hm.row0.join(',  ')} ]`} />
                    <DiagRow label="   row 1" value={`[ ${hm.row1.join(',  ')} ]`} />
                    <DiagRow label="   row 2" value={`[ ${hm.row2.join(',  ')} ]`} />
                  </>
                );
              })()}
            </div>
          )}
        </>
      )}
    </div>
  );
}
