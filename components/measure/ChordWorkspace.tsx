'use client';

import { useCallback, useState } from 'react';
import { ChordCanvas, type ChordResult } from './ChordCanvas';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ImageMeta = {
  imageId:        string;
  hand:           string;
  finger:         string;
  sequenceNumber: number;
  url:            string;
};

type Props = {
  sessionId:  string;
  clientName: string;
  images:     ImageMeta[];
};

type AcceptedMap = Record<string, ChordResult>; // keyed by imageId

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FINGER_ORDER = ['THUMB', 'INDEX', 'MIDDLE', 'RING', 'PINKY'];
const HAND_ORDER   = ['LEFT', 'RIGHT'];

function sortedImages(images: ImageMeta[]): ImageMeta[] {
  return [...images].sort((a, b) => {
    const handDiff = HAND_ORDER.indexOf(a.hand) - HAND_ORDER.indexOf(b.hand);
    if (handDiff !== 0) return handDiff;
    return FINGER_ORDER.indexOf(a.finger) - FINGER_ORDER.indexOf(b.finger);
  });
}

function fingerLabel(img: ImageMeta) {
  return `${img.hand[0]}${img.finger.slice(0, 3)}`;   // e.g. "LIDX", "RMID"
}

// ---------------------------------------------------------------------------
// Status chip
// ---------------------------------------------------------------------------

function StatusChip({ accepted }: { accepted: boolean }) {
  return accepted ? (
    <span
      style={{
        fontSize:   '0.7rem',
        padding:    '0.1rem 0.45rem',
        borderRadius: '999px',
        background: 'rgba(52,211,153,0.15)',
        color:      '#34d399',
        fontWeight: 600,
      }}
    >
      ✓
    </span>
  ) : (
    <span
      style={{
        fontSize:   '0.7rem',
        padding:    '0.1rem 0.45rem',
        borderRadius: '999px',
        background: 'rgba(75,85,99,0.4)',
        color:      '#6b7280',
      }}
    >
      —
    </span>
  );
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export function ChordWorkspace({ sessionId, clientName, images }: Props) {
  const sorted   = sortedImages(images);
  const [activeId, setActiveId] = useState<string>(sorted[0]?.imageId ?? '');
  const [accepted, setAccepted] = useState<AcceptedMap>({});

  const activeImage = sorted.find((img) => img.imageId === activeId) ?? sorted[0];

  const handleAccepted = useCallback(
    (imageId: string, result: ChordResult) => {
      setAccepted((prev) => ({ ...prev, [imageId]: result }));
      // Advance to next unaccepted image
      const next = sorted.find(
        (img) => img.imageId !== imageId && !accepted[img.imageId],
      );
      if (next) setActiveId(next.imageId);
    },
    [sorted, accepted],
  );

  const acceptedCount = Object.keys(accepted).length;
  const total         = sorted.length;

  return (
    <div
      style={{
        display:   'flex',
        height:    '100vh',
        background: '#111827',
        color:      '#f9fafb',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* ── Left nav ────────────────────────────────────────────────────── */}
      <aside
        style={{
          width:      '180px',
          flexShrink: 0,
          borderRight: '1px solid #1f2937',
          padding:    '1.25rem 0',
          overflowY:  'auto',
          display:    'flex',
          flexDirection: 'column',
          gap:        '0.25rem',
        }}
      >
        <div
          style={{
            padding:    '0 1rem 0.75rem',
            borderBottom: '1px solid #1f2937',
            fontSize:   '0.75rem',
            color:      '#6b7280',
          }}
        >
          {clientName}
          <br />
          <span style={{ color: '#34d399' }}>{acceptedCount}</span>
          <span style={{ color: '#4b5563' }}>/{total} accepted</span>
        </div>

        {sorted.map((img) => {
          const isActive = img.imageId === activeId;
          const isDone   = Boolean(accepted[img.imageId]);
          return (
            <button
              key={img.imageId}
              onClick={() => setActiveId(img.imageId)}
              style={{
                display:        'flex',
                alignItems:     'center',
                gap:            '0.5rem',
                padding:        '0.5rem 1rem',
                background:     isActive ? 'rgba(37,99,235,0.15)' : 'transparent',
                border:         'none',
                borderLeft:     isActive ? '2px solid #2563eb' : '2px solid transparent',
                color:          isActive ? '#93c5fd' : isDone ? '#34d399' : '#9ca3af',
                fontSize:       '0.8rem',
                fontWeight:     isActive ? 600 : 400,
                cursor:         'pointer',
                textAlign:      'left',
                width:          '100%',
              }}
            >
              <StatusChip accepted={isDone} />
              {fingerLabel(img)}
            </button>
          );
        })}
      </aside>

      {/* ── Main canvas area ─────────────────────────────────────────────── */}
      <main
        style={{
          flex:     1,
          padding:  '1.5rem 2rem',
          overflowY: 'auto',
          display:  'flex',
          flexDirection: 'column',
          gap:      '1rem',
        }}
      >
        {/* Header */}
        <div
          style={{
            display:     'flex',
            alignItems:  'baseline',
            gap:         '0.75rem',
            paddingBottom: '0.75rem',
            borderBottom: '1px solid #1f2937',
          }}
        >
          <h1 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
            Chord Width — {activeImage?.hand} {activeImage?.finger}
          </h1>
          {accepted[activeImage?.imageId] && (
            <span style={{ color: '#34d399', fontSize: '0.8rem' }}>
              ✓ accepted · {accepted[activeImage.imageId].width_mm.toFixed(2)} mm
            </span>
          )}
        </div>

        {/* Instruction (shown when not yet measured) */}
        {!accepted[activeImage?.imageId] && (
          <p style={{ margin: 0, color: '#6b7280', fontSize: '0.8rem' }}>
            Click the center of the nail plate. SAM2 will segment and compute chord width.
          </p>
        )}

        {/* Canvas — keyed by imageId so state resets when switching fingers */}
        {activeImage && (
          <ChordCanvas
            key={activeImage.imageId}
            captureImageId={activeImage.imageId}
            sessionId={sessionId}
            imageUrl={activeImage.url}
            onAccepted={(result) => handleAccepted(activeImage.imageId, result)}
          />
        )}

        {/* Accepted summary table */}
        {acceptedCount > 0 && (
          <section style={{ marginTop: '1.5rem' }}>
            <h2 style={{ fontSize: '0.8rem', color: '#6b7280', margin: '0 0 0.5rem' }}>
              Accepted measurements
            </h2>
            <table
              style={{
                borderCollapse: 'collapse',
                fontSize:       '0.8rem',
                width:          '100%',
                maxWidth:       '480px',
              }}
            >
              <thead>
                <tr style={{ color: '#6b7280' }}>
                  <th style={thStyle}>Hand</th>
                  <th style={thStyle}>Finger</th>
                  <th style={thStyle}>Width mm</th>
                  <th style={thStyle}>Length mm</th>
                </tr>
              </thead>
              <tbody>
                {sorted
                  .filter((img) => accepted[img.imageId])
                  .map((img) => {
                    const r = accepted[img.imageId];
                    return (
                      <tr key={img.imageId}>
                        <td style={tdStyle}>{img.hand}</td>
                        <td style={tdStyle}>{img.finger}</td>
                        <td style={{ ...tdStyle, color: '#34d399', fontWeight: 600 }}>
                          {r.width_mm.toFixed(2)}
                        </td>
                        <td style={tdStyle}>{r.length_mm.toFixed(2)}</td>
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

const thStyle: React.CSSProperties = {
  textAlign:   'left',
  padding:     '0.3rem 0.75rem',
  fontWeight:  500,
  borderBottom: '1px solid #1f2937',
};

const tdStyle: React.CSSProperties = {
  padding:     '0.35rem 0.75rem',
  color:       '#d1d5db',
  borderBottom: '1px solid #1f2937',
};
