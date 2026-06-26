'use client';

import { useCallback, useState } from 'react';
import { TransverseCanvas, type ICResult } from './TransverseCanvas';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransverseImageMeta = {
  imageId:        string;
  hand:           string;
  finger:         string;
  sequenceNumber: number;
  url:            string;
  /**
   * Chord width in mm from the accepted top-down measurement for this
   * hand + finger. Null when no top-down measurement exists yet.
   * Used by TransverseCanvas to compute mm-space IC values.
   */
  widthMm:        number | null;
};

type Props = {
  sessionId:  string;
  clientName: string;
  images:     TransverseImageMeta[];
};

type AcceptedMap = Record<string, ICResult>;  // keyed by imageId

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

const FINGER_ORDER = ['INDEX', 'MIDDLE', 'RING', 'PINKY'];
const HAND_ORDER   = ['LEFT',  'RIGHT'];

function sortedImages(images: TransverseImageMeta[]): TransverseImageMeta[] {
  return [...images].sort((a, b) => {
    const hd = HAND_ORDER.indexOf(a.hand)   - HAND_ORDER.indexOf(b.hand);
    if (hd !== 0) return hd;
    return FINGER_ORDER.indexOf(a.finger) - FINGER_ORDER.indexOf(b.finger);
  });
}

function shortLabel(img: TransverseImageMeta) {
  return `${img.hand[0]}${img.finger.slice(0, 3)}`;   // e.g. LIDX, RMID
}

function fullLabel(img: TransverseImageMeta) {
  return `${img.hand} ${img.finger}`;
}

// ---------------------------------------------------------------------------
// Status chip
// ---------------------------------------------------------------------------

function StatusChip({ accepted }: { accepted: boolean }) {
  return accepted ? (
    <span style={{ fontSize: '0.7rem', padding: '0.1rem 0.45rem', borderRadius: '999px', background: 'rgba(52,211,153,0.15)', color: '#34d399', fontWeight: 600 }}>✓</span>
  ) : (
    <span style={{ fontSize: '0.7rem', padding: '0.1rem 0.45rem', borderRadius: '999px', background: 'rgba(75,85,99,0.4)', color: '#6b7280' }}>—</span>
  );
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export function TransverseWorkspace({ sessionId, clientName, images }: Props) {
  const sorted  = sortedImages(images);
  const [activeId, setActiveId] = useState(sorted[0]?.imageId ?? '');
  const [accepted, setAccepted] = useState<AcceptedMap>({});

  const activeImage = sorted.find(img => img.imageId === activeId) ?? sorted[0];

  const handleAccepted = useCallback(
    (imageId: string, result: ICResult) => {
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
              {img.widthMm !== null && (
                <span style={{ marginLeft: 'auto', fontSize: '0.65rem', color: '#4b5563' }}>
                  W{img.widthMm.toFixed(1)}
                </span>
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
            Transverse IC — {activeImage ? fullLabel(activeImage) : ''}
          </h1>
          {activeImage && accepted[activeImage.imageId] && (() => {
            const r = accepted[activeImage.imageId];
            return (
              <span style={{ color: '#34d399', fontSize: '0.8rem' }}>
                {r.icMm !== null ? `✓ accepted · IC ${r.icMm.toFixed(2)} mm` : `✓ accepted · ${r.icPx.toFixed(1)} px`}
              </span>
            );
          })()}
          {activeImage && activeImage.widthMm !== null && (
            <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#4b5563' }}>
              top-down width: {activeImage.widthMm.toFixed(2)} mm
            </span>
          )}
          {activeImage && activeImage.widthMm === null && (
            <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#f59e0b' }}>
              ⚠ no top-down width yet
            </span>
          )}
        </div>

        {/* Instruction */}
        {activeImage && !accepted[activeImage.imageId] && (
          <p style={{ margin: 0, color: '#6b7280', fontSize: '0.8rem' }}>
            Click <strong style={{ color: '#60a5fa' }}>P1</strong> (left edge) → <strong style={{ color: '#60a5fa' }}>P2</strong> (right edge) → <strong style={{ color: '#34d399' }}>apex</strong> (highest point of curve).
          </p>
        )}

        {/* Canvas */}
        {activeImage && (
          <TransverseCanvas
            key={activeImage.imageId}
            captureImageId={activeImage.imageId}
            sessionId={sessionId}
            imageUrl={activeImage.url}
            fingerLabel={fullLabel(activeImage)}
            widthMm={activeImage.widthMm}
            onAccepted={result => handleAccepted(activeImage.imageId, result)}
          />
        )}

        {/* Summary table */}
        {acceptedCount > 0 && (
          <section style={{ marginTop: '1.5rem' }}>
            <h2 style={{ fontSize: '0.8rem', color: '#6b7280', margin: '0 0 0.5rem' }}>
              Accepted IC measurements
            </h2>
            <table style={{ borderCollapse: 'collapse', fontSize: '0.8rem', width: '100%', maxWidth: '600px' }}>
              <thead>
                <tr style={{ color: '#6b7280' }}>
                  <th style={thS}>Hand</th>
                  <th style={thS}>Finger</th>
                  <th style={thS}>IC mm</th>
                  <th style={thS}>W mm</th>
                  <th style={thS}>h mm</th>
                  <th style={thS}>IC px</th>
                  <th style={thS}>Score</th>
                </tr>
              </thead>
              <tbody>
                {sorted.filter(img => accepted[img.imageId]).map(img => {
                  const r = accepted[img.imageId];
                  return (
                    <tr key={img.imageId}>
                      <td style={tdS}>{img.hand}</td>
                      <td style={tdS}>{img.finger}</td>
                      <td style={{ ...tdS, color: '#34d399', fontWeight: 600 }}>
                        {r.icMm !== null ? r.icMm.toFixed(2) : '—'}
                      </td>
                      <td style={tdS}>{r.chordWidthMm !== null ? r.chordWidthMm.toFixed(2) : '—'}</td>
                      <td style={tdS}>{r.sagittaMm    !== null ? r.sagittaMm.toFixed(2)    : '—'}</td>
                      <td style={{ ...tdS, color: '#a78bfa' }}>{r.icPx.toFixed(1)}</td>
                      <td style={{ ...tdS, color: '#6b7280' }}>{r.arcScore.toFixed(3)}</td>
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
