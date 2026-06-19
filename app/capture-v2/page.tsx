'use client';

import { useState } from 'react';

// NOTE: keep your existing import if downloadSession lives elsewhere
// import { downloadSession } from '@/lib/downloadSession';

export default function CaptureV2Page({
  searchParams,
}: {
  searchParams: { token?: string };
}) {
  const sessionToken = searchParams?.token ?? null;

  // MOCK: replace with your actual capture fetch logic
  const [captures] = useState<any[]>([
  {
    preview: null,
    spec: {
      shotType: "test",
    },
  },
]);

  const [step, setStep] = useState<'capture' | 'complete'>('complete');

  return (
    <main style={{ padding: '2rem' }}>
      <h1>Capture v2 testbed</h1>

      {step === 'complete' && (
        <CompletionPanel
          captures={captures}
          sessionToken={sessionToken}
          onRestart={() => setStep('capture')}
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
  captures: any[];
  sessionToken: string | null;
  onRestart: () => void;
}) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [isSubmitted, setIsSubmitted] = useState(false);

  const palmUp = captures.filter(
    (c) => c?.spec?.shotType === 'palm-up'
  );

  const curl = captures.filter(
    (c) => c?.spec?.shotType !== 'palm-up'
  );
async function downloadSession(captures: any[]) {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  captures.forEach((capture, index) => {
    const base64 = capture.preview?.split(',')[1];
    if (base64) {
      zip.file(`capture-${index}.jpg`, base64, { base64: true });
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
      // STEP 1: download ZIP locally
      await downloadSession(captures);

      // STEP 2: mark submitted
      if (sessionToken) {
        const response = await fetch(
  `/api/capture/${sessionToken}/submit`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      captures,
    }),
  }
);

        if (!response.ok) {
          throw new Error(
            'Capture ZIP downloaded, but submission status could not be updated.'
          );
        }
      }

      // STEP 3: success
      setIsSubmitted(true);
    } catch (err: any) {
      setDownloadError(
        err?.message ?? 'Download failed - check browser console.'
      );
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <div>
      <div style={{ marginBottom: '1rem' }}>
        {!isSubmitted ? (
          <>
            <h2>Ready to submit capture</h2>
            <p>{captures.length} shots captured</p>
          </>
        ) : (
          <>
            <h2>Submitted ✓</h2>
            <p>Your capture has been sent for processing</p>
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
        }}
      >
        {isDownloading
          ? 'Submitting...'
          : isSubmitted
          ? 'Submitted ✓'
          : 'Download session (1 image + JSON)'}
      </button>

      {isSubmitted && (
        <div style={{ marginTop: '1rem', display: 'flex', gap: '10px' }}>
          <button onClick={onRestart}>
            Return to Client
          </button>

          <button
            onClick={() => (window.location.href = '/dashboard')}
          >
            Go to Dashboard
          </button>
        </div>
      )}
    </div>
  );
}