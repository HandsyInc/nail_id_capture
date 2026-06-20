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
    image: '/front_profile_example.jpg',
    imageAlt: 'Example front profile nail photo',
    title: 'Front Profile Shots',
    steps: [
      'No reference card is needed',
      'Rotate your phone 180° so the camera is level with the table',
      'Use your front-facing camera for these captures',
      'Move close enough to clearly see the nail\'s natural curve',
      'Keep the nail centered in frame',
      'Avoid blurry images',
    ],
    buttonLabel: 'Begin front profile shots',
  },
  'longitudinal': {
    image: '/side_profile_example.jpg',
    imageAlt: 'Example side-profile finger photo',
    title: 'Side-Profile Shots',
    steps: [
      'No reference card is needed',
      'Rotate your phone 180° so the camera is close to table height',
      'Hold your finger sideways so the full nail profile is visible',
      'Keep the nail edge and fingertip in frame',
      'Move close enough to see the curve clearly while keeping the image sharp',
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitted, setIsSubmitted] = useState(false);

  async function handleSubmit() {
    if (!captures || captures.length === 0) return;
    if (isSubmitting || isSubmitted) return;
    if (!sessionToken) {
      setSubmitError('No session token — cannot submit.');
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);
    setUploadProgress(0);

    try {
      // Upload each capture individually to stay under Vercel's 4.5 MB body limit.
      for (let i = 0; i < captures.length; i++) {
        const capture = captures[i];

        const res = await fetch(`/api/capture/${sessionToken}/image`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            index: i,
            preview: capture.preview,
            spec: {
              shotType: capture.spec.shotType,
              hand: capture.spec.hand,
              finger: capture.spec.finger,
            },
          }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error ?? `Upload failed at shot ${i + 1}`);
        }

        setUploadProgress(i + 1);
      }

      // All images uploaded — mark session SUBMITTED.
      const finalRes = await fetch(`/api/capture/${sessionToken}/submit`, {
        method: 'POST',
      });

      if (!finalRes.ok) {
        const body = await finalRes.json().catch(() => ({}));
        throw new Error(body?.error ?? 'Submit finalization failed');
      }

      setIsSubmitted(true);
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setIsSubmitting(false);
    }
  }

  const total = CAPTURE_SEQUENCE.length;

  if (isSubmitted) {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center px-6 py-10 text-white">
        <div className="w-full max-w-sm space-y-5 text-center">
          <div className="text-5xl">✓</div>
          <h2 className="text-2xl font-bold text-gray-100">All done!</h2>
          <p className="text-gray-400">Your capture has been sent for processing.</p>
          <button
            onClick={onRestart}
            className="w-full rounded-xl border border-gray-600 px-6 py-3 text-gray-300 text-sm"
          >
            Capture Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center px-6 py-10 text-white">
      <div className="w-full max-w-sm space-y-5">

        <div className="text-center space-y-1">
          <h2 className="text-xl font-bold text-gray-100">
            {isSubmitting ? 'Uploading…' : 'Ready to submit'}
          </h2>
          <p className="text-gray-400 text-sm">
            {isSubmitting
              ? `${uploadProgress} of ${total} shots uploaded`
              : `${captures.length} of ${total} shots captured`}
          </p>
        </div>

        {isSubmitting && (
          <div className="w-full bg-gray-800 rounded-full h-2">
            <div
              className="bg-blue-500 h-2 rounded-full transition-all duration-300"
              style={{ width: `${(uploadProgress / total) * 100}%` }}
            />
          </div>
        )}

        {submitError && (
          <p className="text-red-400 text-sm text-center">{submitError}</p>
        )}

        <button
          onClick={handleSubmit}
          disabled={isSubmitting}
          className="w-full rounded-xl bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 px-6 py-3 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSubmitting ? `Uploading ${uploadProgress}/${total}…` : `Submit ${captures.length} shots`}
        </button>

      </div>
    </div>
  );
}