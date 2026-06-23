'use client';

import { useState, useCallback } from 'react';
import { WzCanvas, emptyMeasurementState, imageStatus, type ImageMeasurementState } from './WzCanvas';
import { WzMinimap } from './WzMinimap';
import { SessionSummary } from './SessionSummary';
import { TOTAL_STEPS, CLICK_SEQUENCE, stepPrompt } from '@/lib/measure/wz-geometry';

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

const FINGER_ORDER = ['THUMB', 'INDEX', 'MIDDLE', 'RING', 'PINKY'];
const HAND_ORDER   = ['LEFT', 'RIGHT'];

function sortedImages(images: ImageMeta[]): ImageMeta[] {
  return [...images].sort((a, b) => {
    const handDiff = HAND_ORDER.indexOf(a.hand) - HAND_ORDER.indexOf(b.hand);
    if (handDiff !== 0) return handDiff;
    return FINGER_ORDER.indexOf(a.finger) - FINGER_ORDER.indexOf(b.finger);
  });
}

// ---------------------------------------------------------------------------
// Status chip
// ---------------------------------------------------------------------------

function StatusChip({ status }: { status: 'not_started' | 'in_progress' | 'complete' }) {
  if (status === 'complete') {
    return (
      <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-900/60 text-green-400 font-medium">
        ✓
      </span>
    );
  }
  if (status === 'in_progress') {
    return (
      <span className="text-xs px-1.5 py-0.5 rounded-full bg-yellow-900/60 text-yellow-400 font-medium">
        …
      </span>
    );
  }
  return (
    <span className="text-xs px-1.5 py-0.5 rounded-full bg-gray-800 text-gray-500">
      —
    </span>
  );
}

// ---------------------------------------------------------------------------
// Live measurement table
// ---------------------------------------------------------------------------

function MeasurementTable({ state }: { state: ImageMeasurementState }) {
  const r   = state.result;
  const fmt = (n: number | undefined) => (n != null ? n.toFixed(1) : '—');

  const rows: [string, string][] = [
    ['L px',      fmt(r?.L_px)],
    ['W25 px',    fmt(r?.W25_px)],
    ['W50 px',    fmt(r?.W50_px)],
    ['W75 px',    fmt(r?.W75_px)],
    ['W100 px',   fmt(r?.W100_px)],
    ['Wmax px',   fmt(r?.Wmax_px)],
    ['Wmax pos',  r ? `${r.Wmax_position_pct}%` : '—'],
    ['Retention', r ? `${r.retention_pct.toFixed(1)}%` : '—'],
  ];

  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label} className="border-b border-gray-800">
            <td className="py-1.5 pr-3 text-gray-400 text-xs">{label}</td>
            <td className="py-1.5 text-right font-mono text-gray-100 text-xs">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Main workspace
// ---------------------------------------------------------------------------

export function WzSessionWorkspace({ sessionId, clientName, images }: Props) {
  const sorted = sortedImages(images);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [measurements, setMeasurements] = useState<Record<string, ImageMeasurementState>>({});
  const [naturalSizes, setNaturalSizes] = useState<Record<string, { w: number; h: number }>>({});
  const [showSummary,  setShowSummary]  = useState(false);

  const current      = sorted[currentIndex];
  const currentState = measurements[current?.imageId] ?? emptyMeasurementState();

  const handleStateChange = useCallback(
    (next: ImageMeasurementState) => {
      setMeasurements((prev) => ({ ...prev, [current.imageId]: next }));
    },
    [current?.imageId],
  );

  const handleNaturalSize = useCallback(
    (size: { w: number; h: number }) => {
      setNaturalSizes((prev) => ({ ...prev, [current.imageId]: size }));
    },
    [current?.imageId],
  );

  function handleUndo() {
    const s = currentState;
    if (s.step === 0) return;
    const prev   = s.step - 1;
    const target = CLICK_SEQUENCE[prev];

    const next: ImageMeasurementState = {
      ...s,
      step:   prev,
      result: null,
      sidewalls: {
        z25:  { ...s.sidewalls.z25  },
        z50:  { ...s.sidewalls.z50  },
        z75:  { ...s.sidewalls.z75  },
        z100: { ...s.sidewalls.z100 },
      },
    };

    if (target.kind === 'axis') {
      if (target.label === 'A') next.pointA = null;
      else                      next.pointB = null;
    } else {
      next.sidewalls[target.station] = {
        ...next.sidewalls[target.station],
        [target.side]: null,
      };
    }

    handleStateChange(next);
  }

  function handleReset() {
    handleStateChange(emptyMeasurementState());
  }

  const completedCount = images.filter(
    (img) => imageStatus(measurements[img.imageId] ?? emptyMeasurementState()) === 'complete',
  ).length;

  if (!current) {
    return (
      <div className="p-8 text-gray-400">No top-down images found for this session.</div>
    );
  }

  const leftImages  = sorted.filter((img) => img.hand === 'LEFT');
  const rightImages = sorted.filter((img) => img.hand === 'RIGHT');

  function NavItem({ img }: { img: ImageMeta }) {
    const status   = imageStatus(measurements[img.imageId] ?? emptyMeasurementState());
    const isActive = img.imageId === current.imageId;
    return (
      <button
        onClick={() => setCurrentIndex(sorted.indexOf(img))}
        className={[
          'w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-sm text-left transition-colors',
          isActive
            ? 'bg-blue-600/30 text-blue-300 border border-blue-500/40'
            : 'hover:bg-gray-800 text-gray-300 border border-transparent',
        ].join(' ')}
      >
        <span className="capitalize">{img.finger.toLowerCase()}</span>
        <StatusChip status={status} />
      </button>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">

      {/* ── Header ── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 shrink-0">
        <div>
          <span className="text-sm text-gray-400">W(z) · </span>
          <span className="text-sm font-semibold text-gray-100">{clientName}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500">{completedCount}/{images.length} complete</span>
          <button
            onClick={() => setShowSummary((v) => !v)}
            className="px-3 py-1.5 text-sm rounded-lg border border-gray-700 hover:border-gray-500 text-gray-300"
          >
            {showSummary ? 'Hide Summary' : 'Summary'}
          </button>
        </div>
      </div>

      {/* ── Session summary panel ── */}
      {showSummary && (
        <div className="border-b border-gray-800 bg-gray-900/60 px-4 py-4 shrink-0">
          <SessionSummary
            sessionId={sessionId}
            images={images}
            measurements={measurements}
          />
        </div>
      )}

      {/* ── Main layout ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left nav strip — grouped by hand */}
        <div className="w-36 shrink-0 border-r border-gray-800 bg-gray-900/40 overflow-y-auto p-2 space-y-4">
          <div>
            <div className="text-xs text-gray-500 uppercase px-2 pb-1 font-semibold tracking-wider">
              Left Hand
            </div>
            <div className="space-y-1">
              {leftImages.map((img) => <NavItem key={img.imageId} img={img} />)}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase px-2 pb-1 font-semibold tracking-wider">
              Right Hand
            </div>
            <div className="space-y-1">
              {rightImages.map((img) => <NavItem key={img.imageId} img={img} />)}
            </div>
          </div>
        </div>

        {/* Centre — step prompt + canvas + action bar */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">

          {/* Step prompt */}
          <div className="px-4 py-2 border-b border-gray-800 bg-gray-900/60 text-sm font-medium text-blue-300 shrink-0">
            {stepPrompt(currentState.step)}
          </div>

          {/* Canvas */}
          <div className="flex-1 relative bg-black overflow-hidden">
            <WzCanvas
              key={current.imageId}
              imageUrl={current.url}
              naturalSize={naturalSizes[current.imageId] ?? null}
              onNaturalSize={handleNaturalSize}
              state={currentState}
              onStateChange={handleStateChange}
            />
          </div>

          {/* Action bar */}
          <div className="flex items-center gap-2 px-4 py-2 border-t border-gray-800 bg-gray-900/60 shrink-0">
            <button
              onClick={handleUndo}
              disabled={currentState.step === 0}
              className="px-3 py-1.5 text-sm rounded-lg border border-gray-700 hover:border-gray-500 text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Undo
            </button>
            <button
              onClick={handleReset}
              disabled={currentState.step === 0}
              className="px-3 py-1.5 text-sm rounded-lg border border-gray-700 hover:border-gray-500 text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Reset
            </button>
            <div className="flex-1" />
            <button
              onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
              disabled={currentIndex === 0}
              className="px-3 py-1.5 text-sm rounded-lg border border-gray-700 hover:border-gray-500 text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ← Prev
            </button>
            <span className="text-xs text-gray-500 tabular-nums">
              {currentIndex + 1}/{sorted.length}
            </span>
            <button
              onClick={() => setCurrentIndex((i) => Math.min(sorted.length - 1, i + 1))}
              disabled={currentIndex === sorted.length - 1}
              className="px-3 py-1.5 text-sm rounded-lg border border-gray-700 hover:border-gray-500 text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next →
            </button>
          </div>
        </div>

        {/* Right panel — minimap + measurements */}
        <div className="w-52 shrink-0 border-l border-gray-800 bg-gray-900/40 p-3 overflow-y-auto space-y-4">

          {/* Finger label */}
          <div className="text-xs text-gray-500 uppercase font-semibold tracking-wider">
            {current.hand.toLowerCase()} {current.finger.toLowerCase()}
          </div>

          {/* Minimap */}
          <WzMinimap
            key={current.imageId}
            imageUrl={current.url}
            state={currentState}
            naturalSize={naturalSizes[current.imageId] ?? null}
          />

          {/* Divider */}
          <div className="border-t border-gray-800" />

          {/* Measurements */}
          <MeasurementTable state={currentState} />

        </div>

      </div>
    </div>
  );
}
