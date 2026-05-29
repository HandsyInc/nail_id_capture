'use client';

import Link from 'next/link';
import { useState, useRef, useEffect } from 'react';
import JSZip from 'jszip';
import LiveCaptureView, {
  CaptureDiagnostics,
} from '@/components/capture-v2/LiveCaptureView';
import type { ExifFocalData } from '@/lib/capture-v2/exif-focal';
import type { HomographyFocalEstimate } from '@/lib/capture-v2/homography-focal';
import type {
  SagittaResult,
  MultiArcResult,
  ArcCandidateDebug,
  ArcPipelineCounts,
} from '@/lib/capture-v2/nail-sagitta';
import {
  CAPTURE_SEQUENCE,
  isCurlShot,
  icTargetLabel,
  sectionLabel,
  type Finger,
  type ShotSpec,
} from '@/lib/capture-v2/shot-spec';

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

/** One entry in the session capture log — kept after advancing past a step. */
type SessionCapture = {
  preview: string;
  spec: ShotSpec;
  /** Zero-based index into CAPTURE_SEQUENCE — used for filename numbering. */
  stepIndex: number;
  diagnostics: CaptureDiagnostics;
};

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

/**
 * Build the filename for a captured step.
 *
 * Pattern: {step:02d}_{hand}_{finger|group}_{type}.jpg
 *   01_left_thumb_width.jpg
 *   06_right_thumb_width.jpg
 *   11_left_four_finger_curl.jpg
 *   13_left_thumb_curl.jpg
 */
function buildFilename(stepIndex: number, spec: ShotSpec): string {
  const n = String(stepIndex + 1).padStart(2, '0');
  if (spec.shotType === 'palm-up' && spec.finger) {
    return `${n}_${spec.hand}_${spec.finger}_width.jpg`;
  }
  if (spec.shotType === 'curl-four-finger') {
    return `${n}_${spec.hand}_four_finger_curl.jpg`;
  }
  // curl-thumb
  return `${n}_${spec.hand}_thumb_curl.jpg`;
}

/**
 * Bundle all captured images + a session JSON into a single .zip and trigger
 * a browser download. Uses `compression: 'STORE'` for JPEG files (already
 * compressed — DEFLATE would waste time and save almost nothing) and default
 * DEFLATE for the small JSON file.
 *
 * `preview` is a full-resolution data URL (the same bytes sent to the
 * backend); extracting the base64 payload gives us the original JPEG bytes.
 */
async function downloadSession(captures: SessionCapture[]): Promise<void> {
  const zip = new JSZip();
  const images = zip.folder('images')!;

  for (const capture of captures) {
    const filename = buildFilename(capture.stepIndex, capture.spec);
    // preview is "data:image/jpeg;base64,<bytes>" — extract the base64 payload
    const base64 = capture.preview.split(',')[1];
    images.file(filename, base64, { base64: true, compression: 'STORE' });
  }

  const sessionTimestamp = new Date().toISOString();

  // Build a palm-up width lookup: hand → finger → chordWidthMm.
  // Currently null for all fingers because palm-up shots do not run arc
  // extraction (nailSagitta is always null for palm-up). When palm-up W
  // extraction is enabled, this map will populate automatically and
  // correctedICMm will be computed from it.
  const palmUpWidths: Record<string, Record<string, number | null>> = {
    left: { thumb: null, index: null, middle: null, ring: null, pinky: null },
    right: { thumb: null, index: null, middle: null, ring: null, pinky: null },
  };
  for (const c of captures) {
    if (c.spec.shotType === 'palm-up' && c.spec.finger && c.diagnostics.nailSagitta) {
      palmUpWidths[c.spec.hand][c.spec.finger] = c.diagnostics.nailSagitta.chordWidthMm;
    }
  }

  // Session metadata — one row per capture for easy spreadsheet import
  const sessionMeta = {
    sessionTimestamp,
    captureCount: captures.length,
    shots: captures.map((c) => ({
      stepNumber: c.stepIndex + 1,
      filename: buildFilename(c.stepIndex, c.spec),
      label: c.spec.label,
      shotType: c.spec.shotType,
      hand: c.spec.hand,
      finger: c.spec.finger ?? null,
      homographyScalePxPerMm: c.diagnostics.homographyScalePxPerMm,
      naiveCardEdgeScalePxPerMm: c.diagnostics.naiveCardEdgeScalePxPerMm,
      normalizedWidth: c.diagnostics.normalizedWidth,
      normalizedHeight: c.diagnostics.normalizedHeight,
      normalizedOrientation: c.diagnostics.normalizedOrientation,
      captureLatencyMs: c.diagnostics.captureLatencyMs,
      homographyResidualPx: c.diagnostics.homographyResidualPx,
      dimensionsPreserved:
        c.diagnostics.normalizedWidth > 0 &&
        c.diagnostics.normalizedWidth === (c.diagnostics.actualSettings as any)?.width,
      curlResults: (() => {
        if (c.spec.shotType !== 'curl-four-finger') return null;
        const mr = c.diagnostics.multiArcResult;
        if (!mr) return null;
        const { accepted, allCandidatesDebug, pipelineCounts } = mr;
        // Quality gates (including isolation) determine the effective accepted
        // count and confidence tier. Isolated arcs (nearest-neighbour gap >
        // ISOLATION_PX) are structural false positives excluded from
        // effectiveAssigned. This is why acceptedCount and curlConfidence are
        // derived from effectiveAssigned, not from accepted.length.
        // NOTE: assignFingers anchors from image-left. Right-hand pinky-absent
        // misanchoring is a known bug (treated conservatively as
        // 'partial-critical-missing'). TODO: right-hand pinky anchor fix.
        const {
          effectiveAssigned,
          missingFingers,
          curlConfidence,
        } = computeQualityGates(accepted, c.spec.hand);
        const handWidths = palmUpWidths[c.spec.hand];

        return {
          acceptedCount: effectiveAssigned.length,
          curlConfidence,
          detectedFingers: effectiveAssigned.map(({ finger }) => finger),
          missingFingers,
          pipelineCounts,
          fingers: effectiveAssigned.map(({ finger, result }) => {
            const dbg = allCandidatesDebug.find(d => d.result === result) ?? null;
            const [P1, P2] = result.chordEndpointsPx;
            const palmUpW = handWidths[finger] ?? null;
            const h = result.sagittaMm;
            // correctedICMm uses the anatomically correct W from the top-down
            // palm-up shot rather than the end-on arc chord. Formula: (W²+4h²)/(4h).
            // Null until palm-up extraction is enabled.
            const correctedICMm =
              palmUpW !== null && h !== null
                ? (palmUpW * palmUpW + 4 * h * h) / (4 * h)
                : null;
            return {
              finger,
              palmUpWidthMm: palmUpW,
              arcChordWidthMm: result.chordWidthMm,
              sagittaMm: h,
              rawICMm: result.icMm,
              correctedICMm,
              arcScore: result.arcScore,
              strategy: dbg?.strategy ?? null,
              chordMidpointX: Math.round((P1.x + P2.x) / 2),
              chordEndpoints: {
                P1: { x: Math.round(P1.x), y: Math.round(P1.y) },
                P2: { x: Math.round(P2.x), y: Math.round(P2.y) },
              },
            };
          }),
        };
      })(),
    })),
  };
  zip.file('session.json', JSON.stringify(sessionMeta, null, 2));

  // curl_summary.csv — one row per accepted finger per curl-four-finger shot.
  // Designed to be concatenated across multiple session ZIPs for repeatability
  // analysis: cat session-*/curl_summary.csv | sort > combined.csv
  // (header will repeat, filter with grep -v ^session or dedup in a spreadsheet)
  // curl_summary.csv — one row per expected finger per curl-four-finger shot.
  // Missing fingers get explicit rows with present=false so downstream analysis
  // can distinguish "not measured" from "never attempted". Concatenate across
  // sessions with: grep -v ^sessionTimestamp session-*/curl_summary.csv
  const csvHeader =
    'sessionTimestamp,hand,finger,present,curlConfidence,' +
    'sagittaMm,arcChordWidthMm,rawICMm,palmUpWidthMm,correctedICMm,' +
    'arcScore,strategy,chordMidpointX';
  const csvRows: string[] = [csvHeader];
  for (const c of captures) {
    if (c.spec.shotType !== 'curl-four-finger') continue;
    const mr = c.diagnostics.multiArcResult;
    if (!mr) continue;
    // Quality gates match curlResults in session.json — use computeQualityGates
    // so confidence tier and effective accepted count are consistent.
    const {
      effectiveAssigned: csvAssigned,
      missingFingers: csvMissing,
      curlConfidence: csvConfidence,
    } = computeQualityGates(mr.accepted, c.spec.hand);
    const handWidths = palmUpWidths[c.spec.hand];

    // Detected finger rows
    for (const { finger, result } of csvAssigned) {
      const dbg = mr.allCandidatesDebug.find(d => d.result === result);
      const [P1, P2] = result.chordEndpointsPx;
      const midX = Math.round((P1.x + P2.x) / 2);
      const palmUpW = handWidths[finger] ?? null;
      const h = result.sagittaMm;
      const correctedIC =
        palmUpW !== null && h !== null
          ? (palmUpW * palmUpW + 4 * h * h) / (4 * h)
          : null;
      csvRows.push(
        [
          sessionTimestamp,
          c.spec.hand,
          finger,
          'true',
          csvConfidence,
          h?.toFixed(4) ?? '',
          result.chordWidthMm?.toFixed(4) ?? '',
          result.icMm?.toFixed(4) ?? '',
          palmUpW?.toFixed(4) ?? '',
          correctedIC?.toFixed(4) ?? '',
          result.arcScore.toFixed(5),
          dbg?.strategy ?? '',
          midX,
        ].join(','),
      );
    }

    // Missing finger rows — explicit nulls so downstream knows they were
    // expected but not measured (not the same as "session didn't attempt").
    for (const finger of csvMissing) {
      csvRows.push(
        [
          sessionTimestamp,
          c.spec.hand,
          finger,
          'false',
          csvConfidence,
          '', '', '', '', '',
          '', '', '',
        ].join(','),
      );
    }
  }
  zip.file('curl_summary.csv', csvRows.join('\n') + '\n');

  const blob = await zip.generateAsync({ type: 'blob' });

  const timestamp = new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/:/g, '-');
  const zipName = `capture-session-${timestamp}.zip`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = zipName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function CaptureV2Page() {
  const [captured, setCaptured] = useState<Captured | null>(null);
  const [currentStep, setCurrentStep] = useState(0);
  // Accumulates every accepted capture so the completion panel can show a
  // full-session thumbnail grid for label/preview verification.
  const [sessionCaptures, setSessionCaptures] = useState<SessionCapture[]>([]);

  const totalSteps = CAPTURE_SEQUENCE.length; // 14
  const shotSpec =
    currentStep < totalSteps ? CAPTURE_SEQUENCE[currentStep] : null;

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

  function handleAdvance() {
    if (captured && currentStep < totalSteps) {
      setSessionCaptures((prev) => [
        ...prev,
        {
          preview: captured.preview,
          spec: CAPTURE_SEQUENCE[currentStep],
          stepIndex: currentStep,
          diagnostics: captured.diagnostics,
        },
      ]);
    }
    setCaptured(null);
    setCurrentStep((s) => s + 1);
  }

  /** Skip this step without saving a capture — for testing only. */
  function handleSkip() {
    setCaptured(null);
    setCurrentStep((s) => s + 1);
  }

  const isLastStep = currentStep === totalSteps - 1;

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-blue-950 px-5 py-8">
      <div className="max-w-2xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold text-white">
            Capture v2 testbed
          </h1>
          <p className="text-sm text-white/70 mt-1">
            14-shot measurement protocol · {totalSteps} steps
          </p>
          <Link
            href="/"
            className="text-xs text-blue-300 hover:text-blue-200 underline mt-2 inline-block"
          >
            ← Back to v1 capture flow
          </Link>
        </header>

        {currentStep >= totalSteps ? (
          <CompletionPanel
            captures={sessionCaptures}
            onRestart={() => {
              setCaptured(null);
              setCurrentStep(0);
              setSessionCaptures([]);
            }}
          />
        ) : (
          <>
            <StepBanner
              step={currentStep}
              total={totalSteps}
              shotSpec={CAPTURE_SEQUENCE[currentStep]}
            />

            {!captured ? (
              <>
                <LiveCaptureView
                  key={currentStep}
                  onPhotoTaken={handleCapture}
                  shotSpec={shotSpec}
                />
                {/* Skip button — testing only. Advances without saving a capture.
                    Remove once the full 14-step flow is validated on-device. */}
                <button
                  onClick={handleSkip}
                  className="w-full mt-2 rounded-xl border border-white/15 bg-transparent hover:bg-white/5 px-4 py-2 text-white/40 hover:text-white/60 text-xs font-medium transition-colors"
                >
                  Skip this step (testing only)
                </button>
              </>
            ) : (
              <CapturedPanel
                preview={captured.preview}
                diagnostics={captured.diagnostics}
                shotSpec={CAPTURE_SEQUENCE[currentStep]}
                onRetake={handleRetake}
                onAdvance={handleAdvance}
                isLastStep={isLastStep}
              />
            )}
          </>
        )}
      </div>
    </main>
  );
}

function CapturedPanel({
  preview,
  diagnostics,
  shotSpec,
  onRetake,
  onAdvance,
  isLastStep,
}: {
  preview: string;
  diagnostics: CaptureDiagnostics;
  shotSpec: ShotSpec;
  onRetake: () => void;
  onAdvance: () => void;
  isLastStep: boolean;
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
      <ShotContextSection shotSpec={shotSpec} />

      <ArcOverlayImage
        preview={preview}
        multiArcResult={diagnostics.multiArcResult}
        hand={shotSpec.hand}
        normalizedWidth={diagnostics.normalizedWidth}
        normalizedHeight={diagnostics.normalizedHeight}
        shotSpec={shotSpec}
      />

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
          <DiagRow
            label="Card homography"
            value={
              diagnostics.cardHomography
                ? `present · residual ${formatResidual(
                    diagnostics.homographyResidualPx
                  )} px`
                : 'absent (no card detected at capture)'
            }
            warn={
              diagnostics.cardHomography !== null &&
              (diagnostics.homographyResidualPx ?? 0) > 1
            }
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

        {diagnostics.cardHomography && (
          <details className="mt-2 text-xs text-white/60">
            <summary className="cursor-pointer hover:text-white/80">
              Card homography matrices (metadata only)
            </summary>
            <div className="mt-2 font-mono leading-5 space-y-3">
              <div>
                <div className="text-white/50 mb-1">cardToImage (mm → px)</div>
                <MatrixReadout matrix={diagnostics.cardHomography.cardToImage} />
              </div>
              <div>
                <div className="text-white/50 mb-1">imageToCard (px → mm)</div>
                <MatrixReadout matrix={diagnostics.cardHomography.imageToCard} />
              </div>
              <div className="text-white/50">
                residualPx = {formatResidual(diagnostics.homographyResidualPx)}
              </div>
            </div>
          </details>
        )}

        <FocalMetadataSection
          exifFocal={diagnostics.exifFocal}
          homographyFocal={diagnostics.homographyFocal}
        />

        <ScaleCalibrationSection
          homographyScalePxPerMm={diagnostics.homographyScalePxPerMm}
          naiveCardEdgeScalePxPerMm={diagnostics.naiveCardEdgeScalePxPerMm}
        />

        <SagittaSection
          nailSagitta={diagnostics.nailSagitta}
          multiArcResult={diagnostics.multiArcResult}
          shotSpec={shotSpec}
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onRetake}
          className="rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 px-4 py-3 text-white font-medium text-sm"
        >
          Retake
        </button>
        <button
          onClick={onAdvance}
          className="flex-1 rounded-xl bg-blue-600 hover:bg-blue-500 px-6 py-3 text-white font-medium"
        >
          {isLastStep ? 'Finish' : 'Next shot →'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step sequencer UI components
// ---------------------------------------------------------------------------

/**
 * Full-width banner rendered above the capture view for each step. Shows the
 * current step position in the 14-step sequence, a segmented progress bar,
 * the shot label, and the user instruction. Curl shots also show IC targets
 * and the multi-arc-pending note for the four-finger shot.
 */
function StepBanner({
  step,
  total,
  shotSpec,
}: {
  step: number;
  total: number;
  shotSpec: ShotSpec;
}) {
  const section = sectionLabel(shotSpec);
  const curl = isCurlShot(shotSpec);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-5 mb-4 text-white">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-white/50 font-medium uppercase tracking-wide">
          {section}
        </span>
        <span className="text-xs text-white/50">
          Step {step + 1} of {total}
        </span>
      </div>

      {/* Segmented progress bar — filled green for done, blue for current,
          grey for upcoming */}
      <div className="flex gap-0.5 mb-4">
        {Array.from({ length: total }, (_, i) => (
          <div
            key={i}
            className={`flex-1 h-1 rounded-full transition-colors ${
              i < step
                ? 'bg-emerald-500'
                : i === step
                  ? 'bg-blue-400'
                  : 'bg-white/15'
            }`}
          />
        ))}
      </div>

      <p className="text-base font-semibold mb-1">{shotSpec.label}</p>
      <p className="text-sm text-white/70">{shotSpec.instruction}</p>

      {curl && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center px-2 py-0.5 rounded bg-indigo-500/20 border border-indigo-400/30 text-indigo-300 text-xs font-medium">
            end-on curl
          </span>
          {!shotSpec.icArchitecturePending && (
            <span className="text-xs text-white/50">
              IC targets: {icTargetLabel(shotSpec)}
            </span>
          )}
          {shotSpec.shotType === 'curl-four-finger' && (
            <span className="text-xs text-amber-400/80">
              · multi-arc (up to 4 nails)
            </span>
          )}
          {shotSpec.icArchitecturePending && (
            <span className="text-xs text-amber-400/80">
              · thumb IC architecture pending — capture only
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Compact shot-context chip bar rendered at the top of CapturedPanel. Lets
 * the user confirm at a glance what was just captured without re-reading the
 * pre-capture instruction.
 */
function ShotContextSection({ shotSpec }: { shotSpec: ShotSpec }) {
  const typeLabel =
    shotSpec.shotType === 'palm-up'
      ? 'palm-up'
      : shotSpec.shotType === 'curl-four-finger'
        ? 'four-finger curl'
        : 'thumb curl';

  const handLabel = shotSpec.hand === 'left' ? 'left hand' : 'right hand';

  const fingerLabel =
    shotSpec.finger !== null
      ? shotSpec.finger
      : null;

  return (
    <div className="flex flex-wrap gap-2">
      <Chip
        label={typeLabel}
        color={shotSpec.shotType === 'palm-up' ? 'slate' : 'indigo'}
      />
      <Chip label={handLabel} color="slate" />
      {fingerLabel && <Chip label={fingerLabel} color="slate" />}
      {shotSpec.extractsIC.length > 0 && (
        <Chip
          label={`IC: ${shotSpec.extractsIC.join(', ')}`}
          color="indigo"
        />
      )}
    </div>
  );
}

function Chip({
  label,
  color,
}: {
  label: string;
  color: 'slate' | 'indigo';
}) {
  const cls =
    color === 'indigo'
      ? 'bg-indigo-500/20 border-indigo-400/30 text-indigo-300'
      : 'bg-white/10 border-white/15 text-white/70';
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium ${cls}`}
    >
      {label}
    </span>
  );
}

/**
 * Completion panel shown after the last step. Displays a thumbnail grid of
 * every accepted capture so you can verify labels, framing, and resolution
 * at a glance. The "Download session" button bundles all images + a JSON
 * diagnostics file into a single .zip for offline Postman testing.
 */
function CompletionPanel({
  captures,
  onRestart,
}: {
  captures: SessionCapture[];
  onRestart: () => void;
}) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const palmUp = captures.filter((c) => c.spec.shotType === 'palm-up');
  const curl   = captures.filter((c) => c.spec.shotType !== 'palm-up');

  async function handleDownload() {
    if (captures.length === 0) return;
    setIsDownloading(true);
    setDownloadError(null);
    try {
      await downloadSession(captures);
    } catch (err: any) {
      setDownloadError(err?.message ?? 'Download failed — check the browser console.');
    } finally {
      setIsDownloading(false);
    }
  }

  // px/mm stats across palm-up captures that have a homography scale value
  const scaleValues = palmUp
    .map((c) => c.diagnostics.homographyScalePxPerMm)
    .filter((v): v is number => v !== null);
  const scaleMin = scaleValues.length > 0 ? Math.min(...scaleValues) : null;
  const scaleMax = scaleValues.length > 0 ? Math.max(...scaleValues) : null;
  const scaleMean =
    scaleValues.length > 0
      ? scaleValues.reduce((a, b) => a + b, 0) / scaleValues.length
      : null;

  return (
    <div className="space-y-5">
      {/* Summary header */}
      <div className="rounded-2xl border border-emerald-500/30 bg-emerald-950/40 backdrop-blur p-6 text-white">
        <div className="flex items-center justify-between mb-1">
          <p className="text-xl font-semibold">
            {captures.length} shot{captures.length !== 1 ? 's' : ''} captured
          </p>
          <span className="text-2xl">&#10003;</span>
        </div>
        <p className="text-sm text-white/60">
          {palmUp.length} width (top-down)
          {curl.length > 0 ? ` · ${curl.length} curl` : ''}
        </p>
        {captures.length < CAPTURE_SEQUENCE.length && (
          <p className="text-xs text-amber-400/70 mt-1">
            {CAPTURE_SEQUENCE.length - captures.length} step
            {CAPTURE_SEQUENCE.length - captures.length !== 1 ? 's' : ''} skipped
          </p>
        )}

        {/* px/mm consistency summary — key repeatability signal */}
        {scaleValues.length > 1 && scaleMin !== null && scaleMax !== null && scaleMean !== null && (
          <div className="mt-3 pt-3 border-t border-white/10">
            <p className="text-xs text-white/50 uppercase tracking-wide mb-1">px/mm — width shots</p>
            <p className="text-sm font-mono text-white/80">
              {scaleMean.toFixed(2)} avg
              <span className="text-white/45 ml-2">
                ({scaleMin.toFixed(2)} – {scaleMax.toFixed(2)} range,{' '}
                {((scaleMax - scaleMin) / scaleMean * 100).toFixed(1)}% spread)
              </span>
            </p>
            <p className="text-xs text-white/40 mt-0.5">
              {((scaleMax - scaleMin) / scaleMean * 100) < 3
                ? 'Spread < 3% — consistent framing ✓'
                : ((scaleMax - scaleMin) / scaleMean * 100) < 6
                  ? 'Spread 3–6% — acceptable for testing'
                  : 'Spread > 6% — framing varied significantly'}
            </p>
          </div>
        )}
      </div>

      {/* Download button */}
      {captures.length > 0 && (
        <div className="space-y-2">
          <button
            onClick={handleDownload}
            disabled={isDownloading}
            className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/40 disabled:cursor-not-allowed px-6 py-3 text-white font-medium transition-colors"
          >
            {isDownloading
              ? 'Preparing download…'
              : `Download session (${captures.length} image${captures.length !== 1 ? 's' : ''} + JSON)`}
          </button>
          <p className="text-xs text-white/40 text-center">
            ZIP contains labeled JPEGs + session.json with px/mm diagnostics
          </p>
          {downloadError && (
            <p className="text-xs text-red-400 text-center">{downloadError}</p>
          )}
        </div>
      )}

      {/* Thumbnail grid — 2 across on mobile, 3 on wider screens */}
      {captures.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-4">
          <p className="text-xs text-white/50 uppercase tracking-wide font-medium mb-3">
            Verify labels and framing
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {captures.map((c, i) => {
              const dimOk =
                c.diagnostics.normalizedWidth > 0 &&
                c.diagnostics.normalizedHeight > 0;
              const scale = c.diagnostics.homographyScalePxPerMm;
              // Flag if this shot's px/mm is >5% from session mean
              const scaleOutlier =
                scale !== null && scaleMean !== null
                  ? Math.abs(scale - scaleMean) / scaleMean > 0.05
                  : false;
              return (
                <div key={i} className="space-y-1.5">
                  <div className="rounded-xl overflow-hidden border border-white/10 bg-black aspect-[3/4]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={c.preview}
                      alt={c.spec.label}
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <p className="text-xs text-white/80 text-center leading-tight font-medium">
                    {c.spec.label}
                  </p>
                  <p className="text-[10px] text-white/40 text-center font-mono">
                    {dimOk
                      ? `${c.diagnostics.normalizedWidth}×${c.diagnostics.normalizedHeight}`
                      : 'dims unknown'}
                  </p>
                  {scale !== null && (
                    <p className={`text-[10px] text-center font-mono ${scaleOutlier ? 'text-amber-400' : 'text-white/35'}`}>
                      {scale.toFixed(2)} px/mm{scaleOutlier ? ' ⚠' : ''}
                    </p>
                  )}
                  <p className="text-[10px] text-white/25 text-center font-mono">
                    {buildFilename(c.stepIndex, c.spec)}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <button
        onClick={onRestart}
        className="w-full rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 px-6 py-3 text-white font-medium"
      >
        Start over
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diagnostics helpers
// ---------------------------------------------------------------------------

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

/**
 * Compact display for the corner-reprojection residual. Captures on real
 * devices should sit at machine-epsilon (≈1e-13) for clean detections;
 * exponential form keeps the magnitude readable across that range.
 */
function formatResidual(residual: number | null): string {
  if (residual === null || !Number.isFinite(residual)) return '—';
  if (residual === 0) return '0';
  return residual.toExponential(2);
}

/**
 * Scale calibration section: homography-derived px/mm vs naive edge px/mm.
 *
 * homographyScalePxPerMm — Jacobian-determinant scale at the card centre.
 *   The "right" answer: accounts for perspective across the card surface.
 *
 * naiveCardEdgeScalePxPerMm — top-edge projected length / 85.6 mm.
 *   Proxy for what a backend "card pixel width / CARD_WIDTH_MM" formula
 *   would produce. For flat cards (current production guidance) these two
 *   values should agree to within a fraction of a percent.
 *
 * The agreement row is the key diagnostic: near-zero difference validates
 * that the homography value is safe to use as a drop-in replacement for the
 * naive measurement. The implied mm/px row shows the multiplier that would
 * be applied to pixel nail measurements to get millimetres — compare this
 * to the backend's output over time.
 */
function ScaleCalibrationSection({
  homographyScalePxPerMm,
  naiveCardEdgeScalePxPerMm,
}: {
  homographyScalePxPerMm: number | null;
  naiveCardEdgeScalePxPerMm: number | null;
}) {
  const absent = homographyScalePxPerMm === null;

  const homoLabel = absent
    ? 'absent (no card detected)'
    : `${homographyScalePxPerMm!.toFixed(4)} px/mm`;

  const naiveLabel = absent
    ? '—'
    : naiveCardEdgeScalePxPerMm !== null
      ? `${naiveCardEdgeScalePxPerMm.toFixed(4)} px/mm`
      : '—';

  let agreementLabel = '—';
  let agreementWarn = false;
  if (homographyScalePxPerMm !== null && naiveCardEdgeScalePxPerMm !== null) {
    const pct =
      (Math.abs(homographyScalePxPerMm - naiveCardEdgeScalePxPerMm) /
        homographyScalePxPerMm) *
      100;
    agreementLabel = `${pct.toFixed(2)} %`;
    // Flag if > 1 % — would be unexpected on a flat card.
    agreementWarn = pct > 1;
  }

  const impliedMmPerPx =
    homographyScalePxPerMm !== null && homographyScalePxPerMm > 0
      ? `${(1 / homographyScalePxPerMm).toFixed(5)} mm/px`
      : '—';

  // Long-edge implied pixel width: naive_px/mm × 85.6 mm
  const impliedCardPx =
    naiveCardEdgeScalePxPerMm !== null
      ? `${Math.round(naiveCardEdgeScalePxPerMm * 85.6)} px`
      : '—';

  return (
    <details className="mt-4 text-xs text-white/60">
      <summary className="cursor-pointer hover:text-white/80">
        Scale calibration (experiment)
      </summary>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
        <DiagRow label="Homography scale" value={homoLabel} />
        <DiagRow label="Naive edge scale" value={naiveLabel} />
        <DiagRow
          label="Scale agreement"
          value={agreementLabel}
          warn={agreementWarn}
        />
        <DiagRow label="Implied mm/px (homo)" value={impliedMmPerPx} />
        <DiagRow label="Implied card long edge" value={impliedCardPx} />
      </div>
    </details>
  );
}

/**
 * Focal metadata section: EXIF tags + homography estimate side-by-side.
 *
 * For canvas-captured photos EXIF is always absent (canvas.toBlob strips
 * metadata). The section surfaces that explicitly so device-test notes
 * can record "EXIF path: absent on canvas, present on file-picker."
 *
 * The agreement row is only rendered when both an EXIF-derived f_px and a
 * homography-derived f_px are available. For typical canvas captures the
 * agreement will always show "—" because EXIF will be absent; this is the
 * expected and informative result.
 */
function FocalMetadataSection({
  exifFocal,
  homographyFocal,
}: {
  exifFocal: ExifFocalData | null;
  homographyFocal: HomographyFocalEstimate | null;
}) {
  const exifPresent = exifFocal?.exifPresent ?? false;

  // EXIF display strings
  const exifFlMm =
    exifFocal?.focalLengthMm != null
      ? `${exifFocal.focalLengthMm.toFixed(2)} mm`
      : null;
  const exifFl35 =
    exifFocal?.focalLength35mmEq != null
      ? `${exifFocal.focalLength35mmEq} mm 35eq`
      : null;
  const exifFlLabel =
    exifFlMm && exifFl35
      ? `${exifFlMm} · ${exifFl35}`
      : exifFlMm ?? exifFl35 ?? (exifPresent ? 'tag absent' : 'absent — canvas strips EXIF');

  const exifFpxLabel =
    exifFocal?.focalLengthPxFromExif != null
      ? `${Math.round(exifFocal.focalLengthPxFromExif)} px`
      : exifPresent
        ? 'no FocalPlane* tags in EXIF'
        : '—';

  // Homography estimate display
  const homoOrtho =
    homographyFocal?.focalLengthPxOrtho != null
      ? `${Math.round(homographyFocal.focalLengthPxOrtho)} px (ortho)`
      : null;
  const homoNorms =
    homographyFocal?.focalLengthPxNorms != null
      ? `${Math.round(homographyFocal.focalLengthPxNorms)} px (norms)`
      : null;
  const homoLabel =
    homographyFocal?.focalLengthPx != null
      ? [homoOrtho, homoNorms].filter(Boolean).join(' · ')
      : homographyFocal !== null
        ? 'degenerate (flat-on card)'
        : 'absent (no card detected)';

  // Agreement: percentage difference between EXIF f_px and homography f_px
  const exifFpx = exifFocal?.focalLengthPxFromExif ?? null;
  const homoFpx = homographyFocal?.focalLengthPx ?? null;
  let agreementLabel = '—';
  if (exifFpx !== null && homoFpx !== null && exifFpx > 0) {
    const pct = (Math.abs(exifFpx - homoFpx) / exifFpx) * 100;
    agreementLabel = `${pct.toFixed(1)} % difference`;
  }
  const agreementWarn =
    exifFpx !== null &&
    homoFpx !== null &&
    Math.abs(exifFpx - homoFpx) / exifFpx > 0.15;

  return (
    <details className="mt-4 text-xs text-white/60">
      <summary className="cursor-pointer hover:text-white/80">
        Focal metadata experiment
      </summary>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
        <DiagRow label="EXIF focal length" value={exifFlLabel} />
        <DiagRow label="EXIF focal length (px)" value={exifFpxLabel} />
        <DiagRow label="Homography focal est." value={homoLabel} />
        <DiagRow
          label="EXIF vs. homography"
          value={agreementLabel}
          warn={agreementWarn}
        />
      </div>
      {homographyFocal !== null && (
        <div className="mt-2 font-mono text-white/50 leading-5 text-xs">
          ortho f²={homographyFocal.focalLengthPxOrtho !== null
            ? `${(homographyFocal.focalLengthPxOrtho ** 2).toExponential(3)}`
            : 'n/a'}{' '}
          · norms f²={homographyFocal.focalLengthPxNorms !== null
            ? `${(homographyFocal.focalLengthPxNorms ** 2).toExponential(3)}`
            : 'n/a'}
        </div>
      )}
    </details>
  );
}

// ---------------------------------------------------------------------------
// Finger assignment
// ---------------------------------------------------------------------------

// Verified by dot-test on left-hand curl shot (2026-05-28):
// In portrait mode with back-facing camera, the thumb anchors to the left side
// of the image, placing index leftmost and pinky rightmost for the left hand.
// Right hand is mirrored — pinky leftmost, index rightmost.
const FINGER_ORDER_LEFT:  Finger[] = ['index', 'middle', 'ring', 'pinky'];
const FINGER_ORDER_RIGHT: Finger[] = ['pinky', 'ring', 'middle', 'index'];

/**
 * Sort accepted arc results by x-midpoint of their chord and assign finger
 * identities based on hand. Returns arcs sorted left-to-right in the image,
 * paired with their finger name.
 *
 * When fewer than 4 arcs are accepted only the leftmost N fingers are assigned.
 * The caller should display each entry's `finger` label alongside its IC values.
 */
function assignFingers(
  accepted: SagittaResult[],
  hand: 'left' | 'right',
): { finger: Finger; result: SagittaResult }[] {
  const order = hand === 'left' ? FINGER_ORDER_LEFT : FINGER_ORDER_RIGHT;
  const sorted = [...accepted].sort(
    (a, b) =>
      (a.chordEndpointsPx[0].x + a.chordEndpointsPx[1].x) -
      (b.chordEndpointsPx[0].x + b.chordEndpointsPx[1].x),
  );
  return sorted.map((result, i) => ({ finger: order[i], result }));
}

// ---------------------------------------------------------------------------
// Quality gates
// ---------------------------------------------------------------------------

/**
 * Thresholds used by computeQualityGates — module-level so they are shared
 * between the diagnostics display (SagittaSection) and the session JSON export
 * (downloadSession). Do not inline per-call; changes here affect both paths.
 */
/** Arc chord above this → finger likely wasn't end-on (side-wall in view). */
const WIDE_CHORD_MM = 15;
/** Two arc midpoints closer than this → double-detection of a single finger. */
const COLLISION_PX = 50;
/**
 * An accepted arc whose nearest-neighbour midpoint gap exceeds this is treated
 * as a structural false positive — card edge, white-paper region, or reflection
 * that fell outside the card-footprint exclusion zone. These arcs are excluded
 * from effectiveAssigned and treated as missing fingers for curlConfidence.
 */
const ISOLATION_PX = 400;
/**
 * Three consecutive accepted arcs (by x-order) whose midpoints span less than
 * this are almost certainly multiple detections from a single finger's CC.
 */
const MIN_TRIPLET_SPREAD_PX = 200;

type QualityGateResult = {
  /** All assigned arcs sorted left-to-right by x-midpoint (pre-isolation). */
  assigned: { finger: Finger; result: SagittaResult }[];
  /**
   * Assigned arcs after removing spatially isolated false positives (gap from
   * nearest neighbour > ISOLATION_PX). Use this for the effective accepted count,
   * curlConfidence, and the fingers[] export — isolated arcs inflate raw
   * accepted.length without providing valid nail measurements.
   */
  effectiveAssigned: { finger: Finger; result: SagittaResult }[];
  /** Fingers whose accepted arc chord exceeded WIDE_CHORD_MM. */
  wideFingers: Finger[];
  /** Adjacent arc pairs whose midpoints are closer than COLLISION_PX. */
  collisionPairs: { label: string; gapPx: number }[];
  /** Three-arc runs whose total x-span is below MIN_TRIPLET_SPREAD_PX. */
  clusteredTriplets: { label: string; spreadPx: number }[];
  /**
   * Arcs excluded from effectiveAssigned because their nearest-neighbour gap
   * exceeded ISOLATION_PX. Listed here so the retry banner can name them.
   */
  isolatedArcs: { finger: Finger; gapPx: number }[];
  /** Fingers in the expected hand order absent from effectiveAssigned. */
  missingFingers: Finger[];
  /** Confidence tier based on effectiveAssigned (isolated arcs treated as missing). */
  curlConfidence: 'full' | 'partial-pinky-missing' | 'partial-critical-missing' | 'insufficient';
  /** True when any quality flag fired — drives the retry banner. */
  shouldRetry: boolean;
};

/**
 * Apply all post-assignment quality gates to a set of accepted arc results.
 *
 * The isolation gate is the most consequential: arcs more than ISOLATION_PX
 * from their nearest accepted neighbour are excluded from effectiveAssigned and
 * treated as missing fingers for confidence-tier purposes. This prevents a
 * far-right card-edge artifact from producing a false "4/4 full" result while
 * the retry banner simultaneously says the capture is unusable.
 *
 * Called from both SagittaSection (UI display) and downloadSession (JSON/CSV
 * export) so confidence tier and effective count are consistent everywhere.
 */
function computeQualityGates(
  accepted: SagittaResult[],
  hand: 'left' | 'right',
): QualityGateResult {
  const fingerOrder = hand === 'left' ? FINGER_ORDER_LEFT : FINGER_ORDER_RIGHT;
  const assigned = assignFingers(accepted, hand);

  const sortedByX = [...assigned]
    .map(({ finger, result }) => {
      const [P1, P2] = result.chordEndpointsPx;
      return {
        finger,
        midX: (P1.x + P2.x) / 2,
        minX: Math.min(P1.x, P2.x),
        maxX: Math.max(P1.x, P2.x),
        result,
      };
    })
    .sort((a, b) => a.midX - b.midX);

  const wideFingers = assigned
    .filter(({ result }) => (result.chordWidthMm ?? 0) > WIDE_CHORD_MM)
    .map(({ finger }) => finger);

  const collisionPairs: { label: string; gapPx: number }[] = [];
  for (let i = 1; i < sortedByX.length; i++) {
    const gapPx = Math.round(sortedByX[i].midX - sortedByX[i - 1].midX);
    if (gapPx < COLLISION_PX) {
      collisionPairs.push({
        label: `${sortedByX[i - 1].finger}/${sortedByX[i].finger}`,
        gapPx,
      });
    }
  }

  const clusteredTriplets: { label: string; spreadPx: number }[] = [];
  for (let i = 0; i + 2 < sortedByX.length; i++) {
    const spreadPx = Math.round(sortedByX[i + 2].midX - sortedByX[i].midX);
    if (spreadPx < MIN_TRIPLET_SPREAD_PX) {
      clusteredTriplets.push({
        label: `${sortedByX[i].finger}/${sortedByX[i + 1].finger}/${sortedByX[i + 2].finger}`,
        spreadPx,
      });
    }
  }

  const isolatedArcs: { finger: Finger; gapPx: number }[] = [];
  for (let i = 0; i < sortedByX.length; i++) {
    const prevGap = i > 0 ? sortedByX[i].midX - sortedByX[i - 1].midX : Infinity;
    const nextGap =
      i < sortedByX.length - 1 ? sortedByX[i + 1].midX - sortedByX[i].midX : Infinity;
    const nearestGap = Math.round(Math.min(prevGap, nextGap));
    if (nearestGap > ISOLATION_PX) {
      isolatedArcs.push({ finger: sortedByX[i].finger, gapPx: nearestGap });
    }
  }

  // Effective assignment: remove isolated false positives before computing confidence.
  const isolatedFingerSet = new Set(isolatedArcs.map(a => a.finger));
  const effectiveAssigned = assigned.filter(({ finger }) => !isolatedFingerSet.has(finger));
  const effectiveDetectedSet = new Set(effectiveAssigned.map(({ finger }) => finger));
  const missingFingers = fingerOrder.filter(f => !effectiveDetectedSet.has(f));
  const isPinkyOnlyMissing = missingFingers.length === 1 && missingFingers[0] === 'pinky';
  const curlConfidence: QualityGateResult['curlConfidence'] =
    missingFingers.length === 0 ? 'full' :
    isPinkyOnlyMissing          ? 'partial-pinky-missing' :
    effectiveAssigned.length >= 3 ? 'partial-critical-missing' :
                                    'insufficient';

  const shouldRetry =
    wideFingers.length > 0 ||
    collisionPairs.length > 0 ||
    clusteredTriplets.length > 0 ||
    isolatedArcs.length > 0;

  return {
    assigned,
    effectiveAssigned,
    wideFingers,
    collisionPairs,
    clusteredTriplets,
    isolatedArcs,
    missingFingers,
    curlConfidence,
    shouldRetry,
  };
}

// ---------------------------------------------------------------------------
// Arc overlay visualization
// ---------------------------------------------------------------------------

/** Per-finger stroke/fill colours used in the curl-shot arc overlay. */
const FINGER_COLORS: Record<string, string> = {
  index:  '#60a5fa', // blue-400
  middle: '#34d399', // emerald-400
  ring:   '#f472b6', // pink-400
  pinky:  '#fbbf24', // amber-400
};

/**
 * Preview image with a canvas arc-annotation overlay for curl-four-finger shots.
 *
 * For every accepted arc (post quality-gate) the overlay draws:
 *   • The quadratic Bezier arc from P1 → apex → P2 (coloured by finger)
 *   • The chord line P1–P2 (semi-transparent)
 *   • Dots at P1, P2, and apex
 *   • Finger name label near the apex
 *
 * Arcs removed by the isolation gate are drawn in dashed red so the investigator
 * can see what was caught as a false positive alongside the accepted nails.
 *
 * For any other shot type the component renders as a plain image with no overlay.
 */
function ArcOverlayImage({
  preview,
  multiArcResult,
  hand,
  normalizedWidth,
  normalizedHeight,
  shotSpec,
}: {
  preview: string;
  multiArcResult: MultiArcResult | null | undefined;
  hand: 'left' | 'right';
  normalizedWidth: number;
  normalizedHeight: number;
  shotSpec: ShotSpec | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const showOverlay =
    shotSpec?.shotType === 'curl-four-finger' &&
    !!multiArcResult &&
    normalizedWidth > 0 &&
    normalizedHeight > 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !showOverlay || !multiArcResult) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const { effectiveAssigned, isolatedArcs, assigned } = computeQualityGates(
      multiArcResult.accepted,
      hand,
    );
    const isolatedFingerSet = new Set(isolatedArcs.map(a => a.finger));

    // Draw isolated arcs first so effective arcs render on top.
    for (const { finger, result } of assigned) {
      if (isolatedFingerSet.has(finger)) {
        drawArcAnnotation(
          ctx, result, 'rgba(239,68,68,0.6)', `${finger} ✕`, normalizedWidth, true,
        );
      }
    }
    for (const { finger, result } of effectiveAssigned) {
      drawArcAnnotation(
        ctx, result, FINGER_COLORS[finger] ?? '#ffffff', finger, normalizedWidth, false,
      );
    }
  }, [multiArcResult, hand, normalizedWidth, normalizedHeight, showOverlay]);

  return (
    <div className="rounded-2xl overflow-hidden border border-white/10 bg-black relative">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={preview}
        alt="Captured photo preview"
        className="w-full h-auto block"
      />
      {showOverlay && (
        <canvas
          ref={canvasRef}
          width={normalizedWidth}
          height={normalizedHeight}
          className="absolute inset-0 w-full h-full pointer-events-none"
        />
      )}
    </div>
  );
}

/**
 * Draw chord, arc, endpoint dots, and finger label for one arc result.
 *
 * Arc curve: quadratic Bezier with control point cp = 2·apex − ½(P1+P2).
 * At t = 0.5 the curve passes exactly through apex. For arc scores < 0.4
 * (all physically plausible nail plates) this is visually identical to the
 * true circumscribed-circle arc and avoids angle-direction edge cases.
 *
 * All sizes scale with imageWidth so annotations look proportionate across
 * device resolutions (iPhone rear ≈ 3024 px wide, front ≈ 1440 px wide).
 *
 * @param isolated  When true, renders with a dashed stroke and reduced opacity
 *                  to indicate the arc was excluded by the isolation gate.
 */
function drawArcAnnotation(
  ctx: CanvasRenderingContext2D,
  result: SagittaResult,
  color: string,
  label: string,
  imageWidth: number,
  isolated: boolean,
): void {
  const [P1, P2] = result.chordEndpointsPx;
  const apex = result.apexPx;

  const lw       = Math.max(8,  Math.round(imageWidth * 0.005));
  const dotR     = Math.max(12, Math.round(imageWidth * 0.008));
  const apexR    = Math.max(18, Math.round(imageWidth * 0.012));
  const fontSize = Math.max(40, Math.round(imageWidth * 0.022));

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle   = color;
  ctx.lineWidth   = lw;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  if (isolated) ctx.globalAlpha = 0.6;

  // ── Bezier arc ─────────────────────────────────────────────────────────────
  if (isolated) ctx.setLineDash([lw * 3, lw * 2]);
  const cpX = 2 * apex.x - (P1.x + P2.x) / 2;
  const cpY = 2 * apex.y - (P1.y + P2.y) / 2;
  ctx.beginPath();
  ctx.moveTo(P1.x, P1.y);
  ctx.quadraticCurveTo(cpX, cpY, P2.x, P2.y);
  ctx.stroke();

  // ── Chord (solid, lower alpha) ──────────────────────────────────────────────
  ctx.setLineDash([]);
  ctx.globalAlpha = isolated ? 0.2 : 0.3;
  ctx.beginPath();
  ctx.moveTo(P1.x, P1.y);
  ctx.lineTo(P2.x, P2.y);
  ctx.stroke();

  // ── Endpoint and apex dots ─────────────────────────────────────────────────
  ctx.globalAlpha = isolated ? 0.6 : 1.0;
  for (const pt of [P1, P2]) {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, dotR, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(apex.x, apex.y, apexR, 0, 2 * Math.PI);
  ctx.fill();

  // ── Label with drop shadow for legibility over any background ─────────────
  ctx.font         = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.textBaseline = 'bottom';
  ctx.shadowColor   = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur    = Math.round(fontSize * 0.4);
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillText(label, apex.x + apexR + 4, apex.y - apexR);

  ctx.restore();
}

/**
 * Nail sagitta / IC diagnostics section.
 *
 * Three rendering modes:
 *
 *   palm-up shot           → "not extracted" note (no sagitta geometry)
 *   curl-thumb shot        → "architecture pending" note (thumb IC unresolved)
 *   curl-four-finger shot  → multi-arc candidate table (0–4 accepted arcs plus
 *                            rejected candidates with debug info)
 *   no shotSpec (compat)   → single-arc result or "nothing detected"
 *
 * For four-finger shots the accepted count vs. expected-4 is the key
 * diagnostic: it tracks progress of the multi-arc detector.
 */
function SagittaSection({
  nailSagitta,
  multiArcResult,
  shotSpec,
}: {
  nailSagitta: SagittaResult | null;
  multiArcResult?: MultiArcResult | null;
  shotSpec?: ShotSpec | null;
}) {
  const fmtMm  = (v: number | null) => v !== null ? `${v.toFixed(2)} mm` : '—';
  const fmtPx  = (v: number)        => `${Math.round(v)} px`;
  const fmtPct = (v: number)        => `${(v * 100).toFixed(1)} %`;

  // ── Palm-up shot: extraction deliberately skipped ───────────────────────
  if (shotSpec && shotSpec.shotType === 'palm-up') {
    return (
      <details className="mt-4 text-xs text-white/60">
        <summary className="cursor-pointer hover:text-white/80">
          Nail sagitta · IC
        </summary>
        <p className="mt-2 text-white/40 italic">
          Palm-up shot — sagitta not extracted. IC is measured from curl
          shots only.
        </p>
      </details>
    );
  }

  // ── Thumb curl: architecture pending ────────────────────────────────────
  if (shotSpec?.icArchitecturePending) {
    return (
      <details className="mt-4 text-xs text-white/60">
        <summary className="cursor-pointer hover:text-white/80">
          Nail sagitta · IC — thumb (architecture pending)
        </summary>
        <p className="mt-2 text-white/40 italic">
          Thumb IC extraction is architecturally unresolved. The thumb&rsquo;s
          CMC joint rotates it ~90° from the finger plane; the current end-on
          sagitta extractor assumes nail-faces-camera geometry that does not
          hold for the thumb in all poses. This shot is captured for future
          development only — no extraction is attempted.
        </p>
      </details>
    );
  }

  // ── Four-finger curl: multi-arc candidate display ────────────────────────
  if (shotSpec?.shotType === 'curl-four-finger' && multiArcResult) {
    const { accepted, allCandidatesDebug, pipelineCounts } = multiArcResult;
    const expected = shotSpec.expectedArcCount; // 4
    const rejected = allCandidatesDebug.filter(d => !d.accepted);
    const poolEmpty = pipelineCounts.postNmsCount === 0 && pipelineCounts.prefilterRejectCount === 0;

    // Match each accepted SagittaResult back to its ArcCandidateDebug entry by
    // reference so we can display the correct strategy label. The debug array
    // contains both accepted and rejected entries in raw-score order, which does
    // not align with the accepted array's arc-score order.
    const debugForResult = (r: SagittaResult) =>
      allCandidatesDebug.find(d => d.result === r) ?? null;

    // Quality gates: assign fingers, detect wide chords, collisions, isolated
    // arcs, and clustered triplets. effectiveAssigned excludes isolated false
    // positives, so curlConfidence reflects actual usable measurements rather
    // than the raw pipeline accepted count.
    const {
      assigned,
      effectiveAssigned,
      wideFingers,
      collisionPairs,
      clusteredTriplets,
      isolatedArcs,
      missingFingers,
      curlConfidence,
      shouldRetry,
    } = computeQualityGates(accepted, shotSpec.hand);

    // LOW_H_MM: sagitta this small means the arc is nearly flat. IC becomes
    // hypersensitive to h errors at this scale (small h → large IC, steep slope).
    // Soft warning per finger only — does not trigger the retry banner.
    const LOW_H_MM = 1.5;

    const isPinkyOnlyMissing = curlConfidence === 'partial-pinky-missing';

    return (
      <details className="mt-4 text-xs text-white/60" open>
        <summary className="cursor-pointer hover:text-white/80 font-medium">
          Nail sagitta · IC — four-finger curl{' '}
          <span className={
            curlConfidence === 'full'                  ? 'text-emerald-400' :
            curlConfidence === 'partial-pinky-missing' ? 'text-amber-400' :
                                                         'text-red-400'
          }>
            {effectiveAssigned.length} / {expected} accepted
            {curlConfidence === 'partial-pinky-missing' && ' — pinky IC absent'}
            {curlConfidence === 'partial-critical-missing' && ' — critical finger absent'}
            {curlConfidence === 'insufficient' && ' — insufficient'}
          </span>
        </summary>

        {/* Pipeline counts — always shown so we can diagnose empty-pool vs
            geometry-gate failures on-device without devtools. */}
        <PipelineCountsSection counts={pipelineCounts} />

        {accepted.length === 0 && !poolEmpty && (
          <p className="mt-2 text-amber-400/80 italic">
            Candidates found but none passed geometry gates. Check rejected
            candidates below.
          </p>
        )}

        {/* Partial-confidence note — pinky absent but all quality gates pass */}
        {isPinkyOnlyMissing && !shouldRetry && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-950/30 px-3 py-2">
            <p className="text-amber-300 text-xs font-medium">
              3/4 detected — pinky IC not measured
            </p>
            <p className="mt-1 text-amber-300/70 text-xs">
              Index, middle, and ring arcs look clean. Pinky sizing will use
              width-only estimate. Acceptable for fitting if pinky IC is
              non-critical for this user.
            </p>
          </div>
        )}

        {/* Partial-confidence note — critical finger absent, suggest retry */}
        {(curlConfidence === 'partial-critical-missing' || curlConfidence === 'insufficient') && !shouldRetry && (
          <div className="mt-3 rounded-lg border border-red-500/40 bg-red-950/40 px-3 py-2">
            <p className="text-red-300 text-xs font-medium">
              Missing finger:{' '}
              <span className="font-semibold">{missingFingers.join(', ')}</span>
              {' '}— retry recommended
            </p>
            <p className="mt-1 text-red-300/70 text-xs">
              {curlConfidence === 'insufficient'
                ? 'Fewer than 3 arcs detected — IC data is insufficient for fitting.'
                : 'A critical finger\'s IC is missing — sizing accuracy will be reduced.'}
            </p>
          </div>
        )}

        {/* Retry banner — shown when any finger has suspicious geometry */}
        {shouldRetry && (
          <div className="mt-3 rounded-lg border border-red-500/40 bg-red-950/40 px-3 py-2">
            <p className="text-red-300 font-medium">
              ⚠ Retry curl capture — one or more fingers may not be end-on
            </p>
            {wideFingers.length > 0 && (
              <p className="mt-1 text-red-300/70 text-xs">
                Arc chord &gt;{WIDE_CHORD_MM} mm:{' '}
                <span className="font-medium">{wideFingers.join(', ')}</span>
                {' '}— finger side-wall visible, not nail plate.
              </p>
            )}
            {collisionPairs.length > 0 && (
              <p className="mt-1 text-red-300/70 text-xs">
                Midpoint collision:{' '}
                {collisionPairs.map(({ label, gapPx }) => (
                  <span key={label} className="font-medium">{label} ({gapPx}px apart)</span>
                ))}
                {' '}— fingertips may be overlapping.
              </p>
            )}
            {clusteredTriplets.length > 0 && (
              <p className="mt-1 text-red-300/70 text-xs">
                Arc cluster too tight:{' '}
                {clusteredTriplets.map(({ label, spreadPx }) => (
                  <span key={label} className="font-medium">{label} ({spreadPx}px span)</span>
                ))}
                {' '}— 3 arcs in one finger&apos;s x-territory.
              </p>
            )}
            {isolatedArcs.length > 0 && (
              <p className="mt-1 text-red-300/70 text-xs">
                Spatially isolated arc:{' '}
                {isolatedArcs.map(({ finger, gapPx }) => (
                  <span key={finger} className="font-medium">{finger} ({gapPx}px from nearest)</span>
                ))}
                {' '}— likely card edge or stray reflection, not a nail.
              </p>
            )}
          </div>
        )}

        {effectiveAssigned.map(({ finger, result }, i) => {
          const [P1, P2] = result.chordEndpointsPx;
          const dbg = debugForResult(result);
          const chordWide = (result.chordWidthMm ?? 0) > WIDE_CHORD_MM;
          const hLow = result.sagittaMm !== null && result.sagittaMm < LOW_H_MM;
          return (
            <div key={finger} className={`mt-3 border-t pt-3 ${chordWide ? 'border-red-500/30' : 'border-white/10'}`}>
              <p className={`font-medium mb-1 ${chordWide ? 'text-red-300' : 'text-white/70'}`}>
                {finger}
                {chordWide && (
                  <span className="ml-2 text-red-400/80 font-normal text-xs">
                    arc-chord &gt;{WIDE_CHORD_MM} mm
                  </span>
                )}
                {hLow && (
                  <span className="ml-2 text-amber-400/80 font-normal text-xs">
                    h &lt;{LOW_H_MM} mm — IC unreliable
                  </span>
                )}
                {dbg && (
                  <span className="ml-2 text-white/40 font-normal">
                    [{dbg.strategy}]
                  </span>
                )}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                <DiagRow label="arc-chord (px)" value={fmtPx(result.chordLengthPx)} />
                <div className={`flex items-baseline justify-between gap-3 py-1 border-b border-white/5 last:border-b-0`}>
                  <span className="text-white/60">arc-chord (mm)</span>
                  <span className={chordWide ? 'text-red-400 font-medium' : 'text-white font-medium'}>
                    {fmtMm(result.chordWidthMm)}
                  </span>
                </div>
                <DiagRow label="h (px)"     value={fmtPx(result.sagittaPx)} />
                <DiagRow label="h (mm)"     value={fmtMm(result.sagittaMm)} warn={result.sagittaMm === null || hLow} />
                <DiagRow label="IC radius"  value={fmtMm(result.icMm)} warn={result.icMm === null} />
                <DiagRow label="Arc score"  value={result.arcScore.toFixed(3)} warn={result.arcScore < 0.05} />
                <DiagRow label="Chord cov." value={fmtPct(result.chordFrac)} />
              </div>
              <p className="mt-1 font-mono text-white/40 leading-5">
                P1=({Math.round(P1.x)},{Math.round(P1.y)}){' '}
                P2=({Math.round(P2.x)},{Math.round(P2.y)}){' '}
                apex=({Math.round(result.apexPx.x)},{Math.round(result.apexPx.y)})
              </p>
            </div>
          );
        })}

        {rejected.length > 0 && (
          <details className="mt-3 text-white/40">
            <summary className="cursor-pointer hover:text-white/60">
              Rejected candidates ({rejected.length})
            </summary>
            {rejected.map((d, i) => (
              <ArcRejectionRow key={i} debug={d} />
            ))}
          </details>
        )}
      </details>
    );
  }

  // ── Fallback / backwards-compat: single-arc result ───────────────────────
  if (nailSagitta === null) {
    return (
      <details className="mt-4 text-xs text-white/60">
        <summary className="cursor-pointer hover:text-white/80">
          Nail sagitta · IC (curl shot)
        </summary>
        <p className="mt-2 text-white/40 italic">
          No nail arc detected — capture a curl (end-on) shot with the nail
          visible and a reference card in frame.
        </p>
      </details>
    );
  }

  const [P1, P2] = nailSagitta.chordEndpointsPx;
  return (
    <details className="mt-4 text-xs text-white/60">
      <summary className="cursor-pointer hover:text-white/80">
        Nail sagitta · IC (curl shot)
      </summary>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
        <DiagRow label="Chord width W (px)" value={fmtPx(nailSagitta.chordLengthPx)} />
        <DiagRow label="Chord width W (mm)" value={fmtMm(nailSagitta.chordWidthMm)} warn={nailSagitta.chordWidthMm === null} />
        <DiagRow label="Sagitta h (px)"     value={fmtPx(nailSagitta.sagittaPx)} />
        <DiagRow label="Sagitta h (mm)"     value={fmtMm(nailSagitta.sagittaMm)} warn={nailSagitta.sagittaMm === null} />
        <DiagRow label="IC radius"          value={fmtMm(nailSagitta.icMm)} warn={nailSagitta.icMm === null} />
        <DiagRow label="Arc score (h/W)"    value={nailSagitta.arcScore.toFixed(3)} warn={nailSagitta.arcScore < 0.05} />
        <DiagRow label="Chord coverage"     value={fmtPct(nailSagitta.chordFrac)} />
      </div>
      <div className="mt-2 font-mono text-white/50 leading-5">
        P1=({Math.round(P1.x)},{Math.round(P1.y)}){' '}
        P2=({Math.round(P2.x)},{Math.round(P2.y)}){' '}
        apex=({Math.round(nailSagitta.apexPx.x)},{Math.round(nailSagitta.apexPx.y)})
      </div>
    </details>
  );
}

/**
 * Compact pipeline-stage count display for the four-finger curl diagnostics
 * panel. Answers the "why is the pool empty?" question on-device without
 * needing browser devtools.
 *
 * Interprets the counts into one of four failure-mode labels:
 *   (A) Pool empty, CCs=0          → contrast / background issue
 *   (B) Pool empty, CCs>0          → all CCs filtered by area/chord/score
 *   (C) Pool non-empty, accepted=0 → geometry gate failure (pose / scale)
 *   (D) Accepted > 0               → success (or partial success)
 */
function PipelineCountsSection({ counts }: { counts: ArcPipelineCounts }) {
  const {
    otsuThreshold,
    ccBrightTotal, ccBrightPass,
    ccBrightTooSmall, ccBrightTooLarge, ccBrightTooNarrow,
    ccDarkTotal, ccDarkPass,
    ccDarkTooSmall, ccDarkTooLarge, ccDarkTooNarrow,
    poolBeforePrefilter, prefilterRejectCount, postNmsCount,
    cardRegionRejectCount,
    ccBrightHiPass,
  } = counts;

  // Otsu quality heuristic: values near 0 or 255 indicate low bi-modal contrast.
  const otsuOk   = otsuThreshold >= 30 && otsuThreshold <= 220;
  const otsuLabel = otsuOk ? `${otsuThreshold} (ok)` : `${otsuThreshold} ← low contrast`;
  const otsuWarn  = !otsuOk;

  const totalCCs = ccBrightTotal + ccDarkTotal;
  const totalPass = ccBrightPass + ccDarkPass;
  const poolEmpty = postNmsCount === 0 && prefilterRejectCount === 0;
  const poolNonEmpty = postNmsCount > 0 || prefilterRejectCount > 0;

  // Failure mode label
  let failMode: string | null = null;
  let failColor = 'text-amber-400/80';
  if (poolEmpty && totalCCs === 0) {
    failMode = 'Mode A: no CC components — try dark background + directional lighting';
  } else if (poolEmpty && totalPass === 0) {
    failMode = 'Mode B: CCs found but all filtered — framing or lighting issue';
  } else if (poolNonEmpty && poolBeforePrefilter > 0) {
    failMode = 'Mode C: candidates found — see rejected list for geometry reasons';
    failColor = 'text-white/50';
  }

  return (
    <div className="mt-2 border-t border-white/8 pt-2 space-y-1">
      <p className="text-[10px] text-white/40 uppercase tracking-wide font-medium">Pipeline</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px] font-mono">
        <span className={otsuWarn ? 'text-amber-400' : 'text-white/50'}>
          otsu {otsuLabel}
        </span>
        <span className="text-white/35">pool→NMS {poolBeforePrefilter}→{postNmsCount}</span>
        <span className="text-white/50 col-span-2">
          cc-bright {ccBrightTotal} total / {ccBrightPass} pass
          <span className="text-white/30 ml-1">
            ({ccBrightTooSmall}sm {ccBrightTooLarge}lg {ccBrightTooNarrow}nw)
          </span>
        </span>
        <span className={`col-span-2 ${ccBrightHiPass > 0 ? 'text-emerald-400/70' : 'text-white/35'}`}>
          cc-bright-hi sweep / {ccBrightHiPass} cands
          <span className="text-white/25 ml-1">(+30/+40/+50/+60 above otsu)</span>
        </span>
        <span className="text-white/50 col-span-2">
          cc-dark {ccDarkTotal} total / {ccDarkPass} pass
          <span className="text-white/30 ml-1">
            ({ccDarkTooSmall}sm {ccDarkTooLarge}lg {ccDarkTooNarrow}nw)
          </span>
        </span>
        {prefilterRejectCount > 0 && (
          <span className="text-white/35 col-span-2">
            scale-prefilter removed {prefilterRejectCount}
          </span>
        )}
        {cardRegionRejectCount > 0 && (
          <span className="text-white/35 col-span-2">
            card-region removed {cardRegionRejectCount}
          </span>
        )}
      </div>
      {failMode && (
        <p className={`text-[10px] italic ${failColor}`}>{failMode}</p>
      )}
    </div>
  );
}

/** One-line debug row for a rejected arc candidate. */
function ArcRejectionRow({ debug }: { debug: ArcCandidateDebug }) {
  return (
    <div className="mt-2 border-t border-white/5 pt-2">
      <span className="text-white/50 mr-2">[{debug.strategy}]</span>
      <span className="text-amber-400/70 mr-2">
        score={debug.rawScore.toFixed(3)}
      </span>
      <span className="text-white/30 mr-2">
        chord={( debug.chordFrac * 100).toFixed(1)}%
      </span>
      <span className="text-red-400/70">{debug.rejectionReason}</span>
      <span className="ml-2 font-mono text-white/25">
        P1=({Math.round(debug.detectionP1.x)},{Math.round(debug.detectionP1.y)}){' '}
        P2=({Math.round(debug.detectionP2.x)},{Math.round(debug.detectionP2.y)})
      </span>
    </div>
  );
}

/**
 * Three-row monospace readout of a 3×3 matrix. Used only by the dev
 * diagnostics panel; we render the raw numbers so a tester can paste
 * them into a spreadsheet or notebook for offline validation against
 * the corresponding captured image.
 */
function MatrixReadout({
  matrix,
}: {
  matrix: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];
}) {
  return (
    <div className="text-white/80">
      {matrix.map((row, i) => (
        <div key={i}>
          [{' '}
          {row
            .map((v) =>
              Math.abs(v) >= 1000 || (Math.abs(v) > 0 && Math.abs(v) < 0.01)
                ? v.toExponential(4)
                : v.toFixed(6)
            )
            .join('  ')}{' '}
          ]
        </div>
      ))}
    </div>
  );
}
