'use client';

import { useState } from 'react';
import LiveCaptureView from '@/components/capture-v2/LiveCaptureView';
import {
  CAPTURE_SEQUENCE,
  type ShotSpec,
} from '@/lib/capture-v2/shot-spec';

type CaptureEntry = {
  file: File;
  preview: string;
  diagnostics: unknown;
  spec: ShotSpec;
};

export default function CaptureV2Page({
  searchParams,
}: {
  searchParams: { token?: string };
}) {
  const sessionToken = searchParams?.token ?? null;

  const [captures, setCaptures] = useState<CaptureEntry[]>([]);
  const [currentShotIndex, setCurrentShotIndex] = useState(0);
  const [step, setStep] = useState<'capture' | 'complete'>('capture');

  function handlePhotoTaken(
    file: File,
    preview: string,
    diagnostics: unknown,
    spec: ShotSpec
  ) {
    setCaptures(current => [...current, { file, preview, diagnostics, spec }]);

    const nextIndex = currentShotIndex + 1;
    if (nextIndex >= CAPTURE_SEQUENCE.length) {
      setStep('complete');
    } else {
      setCurrentShotIndex(nextIndex);
    }
  }

  function handleRestart() {
    setCaptures([]);
    setCurrentShotIndex(0);
    setStep('capture');
  }

  const currentShot = CAPTURE_SEQUENCE[currentShotIndex];

  return (
    <main style={{ padding: '2rem' }}>
      {step === 'capture' && (
        <>
          <p style={{ marginBottom: '0.25rem', fontWeight: 600 }}>
            {currentShot.label}
          </p>
          <p style={{ marginBottom: '1rem', color: '#6b7280', fontSize: '0.875rem' }}>
            Shot {currentShotIndex + 1} of {CAPTURE_SEQUENCE.length} — {currentShot.instruction}
          </p>
          <LiveCaptureView
            onPhotoTaken={handlePhotoTaken}
            shotSpec={currentShot}
          />
        </>
      )}

      {step === 'complete' && (
        <CompletionPanel
          captures={captures}
          sessionToken={sessionToken}
          onRestart={handleRestart}
        />
      )}
    </main>
  );
}

function CompletionPanel({
  captures,
  sessionToken,
  onRestart,
}: {
  captures: CaptureEntry[];
  sessionToken: string | null;
  onRestart: () => void;
}) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [isSubmitted, setIsSubmitted] = useState(false);

  async function downloadSession(captures: CaptureEntry[]) {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();

    captures.forEach((capture, index) => {
      const base64 = capture.preview?.split(',')[1];
      if (base64) {
        zip.file(`capture-${String(index + 1).padStart(2, '0')}-${capture.spec.hand}-${capture.spec.finger}-${capture.spec.shotType}.jpg`, base64, { base64: true });
      }
    });

    const blob = await zip.generateAsync({ type: 'blob' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `capture-session.zip`;
    a.click();
    window.URL.revokeObjectURL(url);
  }

  async function handleDownload() {
    if (!captures || captures.length === 0) return;
    if (isDownloading || isSubmitted) return;

    setIsDownloading(true);
    setDownloadError(null);

    try {
      if (sessionToken) {
        const response = await fetch(`/api/capture/${sessionToken}/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ captures }),
        });

        if (!response.ok) throw new Error('Submit failed');
      }

      await downloadSession(captures);
      setIsSubmitted(true);
    } catch (err: unknown) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <div>
      <div style={{ marginBottom: '1rem' }}>
        {!isSubmitted ? (
          <>
            <h2>Ready to submit</h2>
            <p>{captures.length} of {CAPTURE_SEQUENCE.length} shots captured</p>
          </>
        ) : (
          <>
            <h2>Submitted ✓</h2>
            <p>Your capture has been sent for processing.</p>
          </>
        )}
      </div>

      {downloadError && (
        <p style={{ color: 'red' }}>{downloadError}</p>
      )}

      <button
        onClick={handleDownload}
        disabled={isDownloading || isSubmitted}
        style={{
          padding: '10px 16px',
          background: '#2563eb',
          color: 'white',
          borderRadius: '6px',
          opacity: isDownloading || isSubmitted ? 0.5 : 1,
          cursor: isDownloading || isSubmitted ? 'not-allowed' : 'pointer',
        }}
      >
        {isDownloading ? 'Submitting…' : isSubmitted ? 'Submitted ✓' : `Submit ${captures.length} shots`}
      </button>

      {isSubmitted && (
        <div style={{ marginTop: '1rem', display: 'flex', gap: '10px' }}>
          <button onClick={onRestart}>Capture Again</button>
        </div>
      )}
    </div>
  );
}