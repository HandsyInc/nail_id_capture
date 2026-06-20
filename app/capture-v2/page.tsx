'use client';

import { useState } from 'react';
import LiveCaptureView from '@/components/capture-v2/LiveCaptureView';
import {
  CAPTURE_SEQUENCE,
  TOTAL_SHOTS,
  type ShotSpec,
  type ShotType,
} from '@/lib/capture-v2/shot-spec';

type SectionIntro = {
  image: string;
  imageAlt: string;
  title: string;
  checklist?: string[];
  steps: string[];
  buttonLabel: string;
};

const SECTION_INTROS: Record<ShotType, SectionIntro> = {
  'top-down': {
    image: '/example.jpg',
    imageAlt: 'Example top-down finger photo',
    title: 'Top-Down Shots',
    checklist: [
      'A plain white sheet of standard printer paper (8.5 × 11)',
      'A dark credit, debit, or loyalty card (not white)',
    ],
    steps: [
      'Place white paper flat on the table',
      'Remove all rings',
      'Lay one finger flat on the paper beside the card, nail facing up',
      'Let your other fingers hang off the table edge',
      'Hold your phone straight above, not angled',
      'Keep the full finger and full card in the frame',
    ],
    buttonLabel: 'Begin top-down shots',
  },
  'transverse': {
    image: '/example.jpg',
    imageAlt: 'Example end-on finger photo',
    title: 'End-On Shots',
    steps: [
      'No reference card needed for this section',
      'Curl each fingertip toward the camera, nail facing the lens',
      'Hold your phone level with your fingertip',
      'Keep your finger steady — the camera will guide you',
    ],
    buttonLabel: 'Begin end-on shots',
  },
  'longitudinal': {
    image: '/example.jpg',
    imageAlt: 'Example side-profile finger photo',
    title: 'Side-Profile Shots',
    steps: [
      'No reference card needed for this section',
      'Hold each finger sideways, tip pointing toward the camera',
      'Keep your fingernail facing to the side, not up',
      'Hold your phone level with your fingertip',
    ],
    buttonLabel: 'Begin side-profile shots',
  },
};

function isNewSection(index: number): boolean {
  if (index === 0) return true;
  return CAPTURE_SEQUENCE[index].shotType !== CAPTURE_SEQUENCE[index - 1].shotType;
}

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
  const [step, setStep] = useState<'capture' | 'section-intro' | 'complete'>('section-intro');

  function handlePhotoTaken(
    file: File,
    preview: string,
    diagnostics: unknown,
    spec: ShotSpec
  ) {
    setCaptures(current => [...current, { file, preview, diagnostics, spec }]);

    const nextIndex = currentShotIndex + 1;
    if (nextIndex >= TOTAL_SHOTS) {
  setStep('complete');
} else {
  setCurrentShotIndex(nextIndex);
  setStep(isNewSection(nextIndex) ? 'section-intro' : 'capture');
}
  }

  function handleRestart() {
    setCaptures([]);
    setCurrentShotIndex(0);
    setStep('section-intro');
  }

  const currentShot = CAPTURE_SEQUENCE[currentShotIndex];

if (step === 'section-intro') {
  const intro = SECTION_INTROS[currentShot.shotType];

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center px-6 py-10 text-white">
      <div className="w-full max-w-sm space-y-5">

        <img
          src={intro.image}
          alt={intro.imageAlt}
          className="w-full rounded-2xl object-contain mx-auto"
          style={{ maxHeight: '40vh' }}
        />

        <h1 className="text-xl font-bold text-gray-100 text-center">{intro.title}</h1>

        {intro.checklist && (
          <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50 space-y-1">
            <p className="text-sm text-gray-400 mb-2">You&apos;ll need:</p>
            {intro.checklist.map((item) => (
              <p key={item} className="text-sm text-gray-300">• {item}</p>
            ))}
          </div>
        )}

        <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50 space-y-2">
          {intro.steps.map((s) => (
            <div key={s} className="flex items-start gap-2">
              <span className="text-blue-400 mt-0.5 shrink-0">•</span>
              <span className="text-sm text-gray-300">{s}</span>
            </div>
          ))}
        </div>

        <button
          onClick={() => setStep('capture')}
          className="w-full rounded-xl bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 px-6 py-3 text-white font-semibold"
        >
          {intro.buttonLabel}
        </button>

      </div>
    </div>
  );
}

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