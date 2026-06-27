'use client';

import { useCallback, useState } from 'react';
import { LongitudinalCanvas, type LongitudinalResult } from './LongitudinalCanvas';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type LongitudinalImageMeta = {
  imageId:        string;
  hand:           string;
  finger:         string;
  sequenceNumber: number;
  url:            string;
  /**
   * H matrix from the LONGITUDINAL CaptureImage — retained from DB for
   * provenance but NOT used as the mm scale source (architecture decision:
   * use top-down cross-reference, not a side-view calibration card).
   * Used here only as a proxy for the ⚠ nav indicator until a proper
   * nailBedLengthMm cross-reference is available.
   */
  hMatrix:        number[][] | null;
};

type Props = {
  sessionId:  string;
  clientName: string;
  images:     LongitudinalImageMeta[];
};

type AcceptedMap = Record<string, LongitudinalResult>;  // keyed by imageId

// ─────────────────────────────────────────────────────────────────────────────
// Sorting (mirrors TransverseWorkspace)
// ─────────────────────────────────────────────────────────────────────────────

const FINGER_ORDER = ['INDEX', 'MIDDLE', 'RING', 'PINKY'];
const HAND_ORDER   = ['LEFT', 'RIGHT'];

function sortedImages(images: LongitudinalImageMeta[]): LongitudinalImageMeta[] {
  return [...images].sort((a, b) => {
    const hd = HAND_ORDER.indexOf(a.hand) - HAND_ORDER.indexOf(b.hand);
    if (hd !== 0) return hd;
    return FINGER_ORDER.indexOf(a.finger) - FINGER_ORDER.indexOf(b.finger);
  });
}

function shortLabel(img: LongitudinalImageMeta) {
  return `${img.hand[0]}${img.finger.slice(0, 3)}`;
}

function fullLabel(img: LongitudinalImageMeta) {
  return `${img.hand} ${img.finger}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status chip
// ─────────────────────────────────────────────────────────────────────────────

function StatusChip({ accepted }: { accepted: boolean }) {
  return accepted ? (
    <span style={{ fontSize: '0.7rem', padding: '0.1rem 0.45rem', borderRadius: '999px', background: 'rgba(52,211,153,0.15)', color: '#34d399', fontWeight: 600 }}>✓</span>
  ) : (
    <span style={{ fontSize: '0.7rem', padding: '0.1rem 0.45rem', borderRadius: '999px', background: 'rgba(75,85,99,0.4)', color: '#6b7280' }}>—</span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace
// ─────────────────────────────────────────────────────────────────────────────

export function LongitudinalWorkspace({ sessionId, clientName, images }: Props) {
  const sorted  = sortedImages(images);
  const [activeId, setActiveId] = useState(sorted[0]?.imageId ?? '');
  const [accepted, setAccepted] = useState<AcceptedMap>({});

  const activeImage = sorted.find(img => img.imageId === activeId) ?? sorted[0];

  const handleAccepted = useCallback(
    (imageId: string, result: LongitudinalResult) => {
      setAccepted(prev => ({ ...prev, [imageId]: result }));
      const next = sorted.find(img => img.imageId !== imageId && !accepted[img.imageId]);
      if (next) setActiveId(next.imageId);
    },
    [sorted, accepted],
  );

  const acceptedCount = Object.keys(accepted).length;
  const total         = sorted.length;

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#111827', color: '#f9fafb', fontFamily: 'system-ui, sans-serif' }}>

      {/* ── Left nav ────────────────────────────────────────────────────── */}
      <aside style={{ width: '180px', flexShrink: 0, borderRight: '1px solid #1f2937', padding: '1.25rem 0', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        <div style={{ padding: '0 1rem 0.75rem', borderBottom: '1px solid #1f2937', fontSize: '0.75rem', color: '#6b7280' }}>
          {clientName}<br />
          <span style={{ color: '#34d399' }}>{acceptedCount}</span>
          <span style={{ color: '#4b5563' }}>/{total} accepted</span>
        </div>

        {sorted.map(img => {
          const isActive = img.imageId === activeId;
          const isDone   = Boolean(accepted[img.imageId]);
          return (
            <button
              key={img.imageId}
              onClick={() => setActiveId(img.imageId)}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                padding: '0.5rem 1rem',
                background:  isActive ? 'rgba(99,102,241,0.15)' : 'transparent',
                border:      'none',
                borderLeft:  isActive ? '2px solid #6366f1' : '2px solid transparent',
                color:       isActive ? '#a5b4fc' : isDone ? '#34d399' : '#9ca3af',
                fontSize:    '0.8rem', fontWeight: isActive ? 600 : 400,
                cursor: 'pointer', textAlign: 'left', width: '100%',
              }}
            >
              <StatusChip accepted={isDone} />
              <span>{shortLabel(img)}</span>
              {img.hMatrix === null && (
                <span style={{ marginLeft: 'auto', fontSize: '0.65rem', color: '#f59e0b' }} title="No longitudinal scale source — px only">⚠</span>
              )}
            </button>
          );
        })}
      </aside>

      {/* ── Main area ───────────────────────────────────────────────────── */}
      <main style={{ flex: 1, padding: '1.5rem 2rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1rem' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', paddingBottom: '0.75rem', borderBottom: '1px solid #1f2937' }}>
          <h1 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
            Longitudinal — {activeImage ? fullLabel(activeImage) : ''}
          </h1>
          {activeImage && accepted[activeImage.imageId] && (() => {
            const r = accepted[activeImage.imageId];
            return (
              <span style={{ color: '#34d399', fontSize: '0.8rem' }}>
                {r.hOverL !== null
                  ? `✓ accepted · h/L ${r.hOverL.toFixed(4)} · AP% ${r.apexPositionPercent!.toFixed(1)}`
                  : `✓ accepted · h/L ${(r.chordLengthPx > 0 ? r.heightPx / r.chordLengthPx : 0).toFixed(4)} (px)`
                }
              </span>
            );
          })()}
          {activeImage && activeImage.hMatrix === null && (
            <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#f59e0b' }}>
              ⚠ px only — no longitudinal scale source
            </span>
          )}
        </div>

        {/* Instruction */}
        {activeImage && !accepted[activeImage.imageId] && (
          <p style={{ margin: 0, color: '#6b7280', fontSize: '0.8rem' }}>
            Click <strong style={{ color: '#60a5fa' }}>C</strong> (cuticle midpoint) →{' '}
            <strong style={{ color: '#60a5fa' }}>F</strong> (free-edge midpoint) →{' '}
            <strong style={{ color: '#34d399' }}>apex</strong> (highest point of the arc).
          </p>
        )}

        {/* Canvas */}
        {activeImage && (
          <LongitudinalCanvas
            key={activeImage.imageId}
            captureImageId={activeImage.imageId}
            sessionId={sessionId}
            imageUrl={activeImage.url}
            fingerLabel={fullLabel(activeImage)}
            onAccepted={result => handleAccepted(activeImage.imageId, result)}
          />
        )}

        {/* Summary table */}
        {acceptedCount > 0 && (
          <section style={{ marginTop: '1.5rem' }}>
            <h2 style={{ fontSize: '0.8rem', color: '#6b7280', margin: '0 0 0.5rem' }}>
              Accepted longitudinal measurements
            </h2>
            <table style={{ borderCollapse: 'collapse', fontSize: '0.8rem', width: '100%', maxWidth: '700px' }}>
              <thead>
                <tr style={{ color: '#6b7280' }}>
                  <th style={thS}>Hand</th>
                  <th style={thS}>Finger</th>
                  <th style={thS}>L mm</th>
                  <th style={thS}>h mm</th>
                  <th style={thS}>h/L</th>
                  <th style={thS}>AP%</th>
                  <th style={thS}>h/L (px)</th>
                </tr>
              </thead>
              <tbody>
                {sorted.filter(img => accepted[img.imageId]).map(img => {
                  const r = accepted[img.imageId];
                  const hOverLPx = r.chordLengthPx > 0 ? r.heightPx / r.chordLengthPx : 0;
                  return (
                    <tr key={img.imageId}>
                      <td style={tdS}>{img.hand}</td>
                      <td style={tdS}>{img.finger}</td>
                      <td style={{ ...tdS, color: '#34d399', fontWeight: 600 }}>
                        {r.lengthMm !== null ? r.lengthMm.toFixed(2) : '—'}
                      </td>
                      <td style={tdS}>{r.heightMm !== null ? r.heightMm.toFixed(2) : '—'}</td>
                      <td style={{ ...tdS, color: '#34d399', fontWeight: 600 }}>
                        {r.hOverL !== null ? r.hOverL.toFixed(4) : '—'}
                      </td>
                      <td style={{ ...tdS, color: '#a78bfa' }}>
                        {r.apexPositionPercent !== null ? r.apexPositionPercent.toFixed(1) + '%' : '—'}
                      </td>
                      <td style={{ ...tdS, color: '#6b7280' }}>{hOverLPx.toFixed(4)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}
      </main>
    </div>
  );
}

const thS: React.CSSProperties = { textAlign: 'left', padding: '0.3rem 0.75rem', fontWeight: 500, borderBottom: '1px solid #1f2937' };
const tdS: React.CSSProperties = { padding: '0.35rem 0.75rem', color: '#d1d5db', borderBottom: '1px solid #1f2937' };
