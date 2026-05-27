'use client';

import Link from 'next/link';
import { useState } from 'react';
import LiveCaptureView, {
  CaptureDiagnostics,
} from '@/components/capture-v2/LiveCaptureView';
import type { ExifFocalData } from '@/lib/capture-v2/exif-focal';
import type { HomographyFocalEstimate } from '@/lib/capture-v2/homography-focal';
import type {
  SagittaResult,
  MultiArcResult,
  ArcCandidateDebug,
} from '@/lib/capture-v2/nail-sagitta';
import {
  CAPTURE_SEQUENCE,
  isCurlShot,
  icTargetLabel,
  sectionLabel,
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
  diagnostics: CaptureDiagnostics;
};

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
 * at a glance before starting a new session. Skipped steps have no tile.
 */
function CompletionPanel({
  captures,
  onRestart,
}: {
  captures: SessionCapture[];
  onRestart: () => void;
}) {
  const palmUp = captures.filter((c) => c.spec.shotType === 'palm-up');
  const curl   = captures.filter((c) => c.spec.shotType !== 'palm-up');

  return (
    <div className="space-y-5">
      {/* Summary header */}
      <div className="rounded-2xl border border-emerald-500/30 bg-emerald-950/40 backdrop-blur p-6 text-center text-white">
        <div className="text-3xl mb-3">&#10003;</div>
        <p className="text-xl font-semibold mb-1">
          {captures.length} shot{captures.length !== 1 ? 's' : ''} captured
        </p>
        <p className="text-sm text-white/60">
          {palmUp.length} width (top-down) · {curl.length} IC (curl)
        </p>
        {captures.length < CAPTURE_SEQUENCE.length && (
          <p className="text-xs text-amber-400/70 mt-1">
            {CAPTURE_SEQUENCE.length - captures.length} step
            {CAPTURE_SEQUENCE.length - captures.length !== 1 ? 's' : ''} skipped
          </p>
        )}
      </div>

      {/* Thumbnail grid — 2 across on mobile, 3 on wider screens */}
      {captures.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-4">
          <p className="text-xs text-white/50 uppercase tracking-wide font-medium mb-3">
            Captured shots — verify labels and framing
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {captures.map((c, i) => {
              const dimOk =
                c.diagnostics.normalizedWidth > 0 &&
                c.diagnostics.normalizedHeight > 0;
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
                  {/* Scale readout — present only when card was detected */}
                  {c.diagnostics.homographyScalePxPerMm !== null && (
                    <p className="text-[10px] text-white/35 text-center font-mono">
                      {c.diagnostics.homographyScalePxPerMm.toFixed(1)} px/mm
                    </p>
                  )}
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
    const { accepted, allCandidatesDebug } = multiArcResult;
    const expected = shotSpec.expectedArcCount; // 4
    const rejected = allCandidatesDebug.filter(d => !d.accepted);

    return (
      <details className="mt-4 text-xs text-white/60" open>
        <summary className="cursor-pointer hover:text-white/80 font-medium">
          Nail sagitta · IC — four-finger curl{' '}
          <span className={accepted.length > 0 ? 'text-emerald-400' : 'text-amber-400'}>
            {accepted.length} / {expected} accepted
          </span>
        </summary>

        {accepted.length === 0 && (
          <p className="mt-2 text-amber-400/80 italic">
            No arcs passed sanity filters. Check the debug table below.
          </p>
        )}

        {accepted.map((r, i) => {
          const [P1, P2] = r.chordEndpointsPx;
          return (
            <div key={i} className="mt-3 border-t border-white/10 pt-3">
              <p className="text-white/70 font-medium mb-1">
                Arc {i + 1}
                {allCandidatesDebug[i] && (
                  <span className="ml-2 text-white/40 font-normal">
                    [{allCandidatesDebug[i].strategy}]
                  </span>
                )}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                <DiagRow label="W (px)"     value={fmtPx(r.chordLengthPx)} />
                <DiagRow label="W (mm)"     value={fmtMm(r.chordWidthMm)} warn={r.chordWidthMm === null} />
                <DiagRow label="h (px)"     value={fmtPx(r.sagittaPx)} />
                <DiagRow label="h (mm)"     value={fmtMm(r.sagittaMm)} warn={r.sagittaMm === null} />
                <DiagRow label="IC radius"  value={fmtMm(r.icMm)} warn={r.icMm === null} />
                <DiagRow label="Arc score"  value={r.arcScore.toFixed(3)} warn={r.arcScore < 0.05} />
                <DiagRow label="Chord cov." value={fmtPct(r.chordFrac)} />
              </div>
              <p className="mt-1 font-mono text-white/40 leading-5">
                P1=({Math.round(P1.x)},{Math.round(P1.y)}){' '}
                P2=({Math.round(P2.x)},{Math.round(P2.y)}){' '}
                apex=({Math.round(r.apexPx.x)},{Math.round(r.apexPx.y)})
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

        {accepted.length < expected && rejected.length === 0 && allCandidatesDebug.length === 0 && (
          <p className="mt-2 text-amber-400/70 italic">
            No arc candidates found — ensure nails are visible end-on and
            well-separated from background.
          </p>
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
