'use client';

import Link from 'next/link';
import { useState } from 'react';
import LiveCaptureView, {
  CaptureDiagnostics,
} from '@/components/capture-v2/LiveCaptureView';

/**
 * Capture v2 — Step 1 testbed.
 *
 * This page is intentionally minimal. It exists to verify the live-capture
 * mechanism (getUserMedia + canvas snapshot + existing normalization) works
 * across real devices, before any guidance overlay or sequencing work is
 * built on top of it. No card detection, no distance/tilt readouts, no
 * upload to the backend — those are later steps in the roadmap.
 *
 * The existing capture flow at `/` is unchanged. This page sits side-by-side
 * so we can test the new capture surface without disturbing the v1 path.
 */

type Captured = {
  file: File;
  preview: string;
  diagnostics: CaptureDiagnostics;
};

export default function CaptureV2Page() {
  const [captured, setCaptured] = useState<Captured | null>(null);

  function handleCapture(
    file: File,
    preview: string,
    diagnostics: CaptureDiagnostics
  ) {
    setCaptured({ file, preview, diagnostics });
  }

  function handleRetake() {
    setCaptured(null);
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-blue-950 px-5 py-8">
      <div className="max-w-2xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold text-white">
            Capture v2 testbed
          </h1>
          <p className="text-sm text-white/70 mt-1">
            Phase 1 · Step 1 — getUserMedia + canvas capture, no guidance
            overlay yet.
          </p>
          <Link
            href="/"
            className="text-xs text-blue-300 hover:text-blue-200 underline mt-2 inline-block"
          >
            ← Back to v1 capture flow
          </Link>
        </header>

        {!captured ? (
          <LiveCaptureView onPhotoTaken={handleCapture} />
        ) : (
          <CapturedPanel
            preview={captured.preview}
            diagnostics={captured.diagnostics}
            onRetake={handleRetake}
          />
        )}
      </div>
    </main>
  );
}

function CapturedPanel({
  preview,
  diagnostics,
  onRetake,
}: {
  preview: string;
  diagnostics: CaptureDiagnostics;
  onRetake: () => void;
}) {
  const requestedWidth =
    (diagnostics.requestedConstraints.video as MediaTrackConstraints | undefined)
      ?.width;
  const requestedHeight =
    (diagnostics.requestedConstraints.video as MediaTrackConstraints | undefined)
      ?.height;
  const reqW =
    typeof requestedWidth === 'object'
      ? (requestedWidth as ConstrainULongRange).ideal ?? '?'
      : requestedWidth ?? '?';
  const reqH =
    typeof requestedHeight === 'object'
      ? (requestedHeight as ConstrainULongRange).ideal ?? '?'
      : requestedHeight ?? '?';

  const actualW = diagnostics.actualSettings.width ?? '?';
  const actualH = diagnostics.actualSettings.height ?? '?';
  const actualFps = diagnostics.actualSettings.frameRate
    ? Math.round(diagnostics.actualSettings.frameRate)
    : '?';
  const facingMode = diagnostics.actualSettings.facingMode ?? '?';

  const dimensionsMatch =
    typeof actualW === 'number' &&
    actualW === diagnostics.normalizedWidth &&
    typeof actualH === 'number' &&
    actualH === diagnostics.normalizedHeight;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl overflow-hidden border border-white/10 bg-black">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={preview}
          alt="Captured photo preview"
          className="w-full h-auto"
        />
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-5 text-white">
        <p className="text-sm font-medium mb-3">Diagnostics</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs">
          <DiagRow
            label="Requested resolution"
            value={`${reqW} × ${reqH}`}
          />
          <DiagRow
            label="Actual stream"
            value={`${actualW} × ${actualH} @ ${actualFps}fps`}
          />
          <DiagRow label="Facing mode" value={String(facingMode)} />
          <DiagRow
            label="Captured blob"
            value={`${formatBytes(diagnostics.capturedBlobSize)} (${diagnostics.capturedBlobType})`}
          />
          <DiagRow
            label="Normalized output"
            value={`${diagnostics.normalizedWidth} × ${diagnostics.normalizedHeight} · ${diagnostics.normalizedOrientation}`}
          />
          <DiagRow
            label="Normalized size"
            value={formatBytes(diagnostics.normalizedSize)}
          />
          <DiagRow
            label="Capture latency"
            value={`${diagnostics.captureLatencyMs} ms`}
          />
          <DiagRow
            label="Dimensions preserved"
            value={dimensionsMatch ? 'yes (1:1)' : 'NO — investigate'}
            warn={!dimensionsMatch}
          />
        </div>

        <details className="mt-4 text-xs text-white/60">
          <summary className="cursor-pointer hover:text-white/80">
            User agent
          </summary>
          <p className="mt-2 break-all font-mono leading-5">
            {diagnostics.userAgent}
          </p>
        </details>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onRetake}
          className="flex-1 rounded-xl bg-blue-600 hover:bg-blue-500 px-6 py-3 text-white font-medium"
        >
          Capture another
        </button>
      </div>
    </div>
  );
}

function DiagRow({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 border-b border-white/5 last:border-b-0">
      <span className="text-white/60">{label}</span>
      <span
        className={
          warn ? 'text-amber-300 font-medium' : 'text-white font-medium'
        }
      >
        {value}
      </span>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
