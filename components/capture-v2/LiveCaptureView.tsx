'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  normalizeImageForUpload,
  fileToDataUrl,
} from '@/lib/image-normalization';
import CardOverlay from './CardOverlay';
import { detectCard, type Detection } from '@/lib/capture-v2/card-detector';
import {
  computeCardHomography,
  pixelsPerMmAt,
  applyHomography,
  CARD_WIDTH_MM,
  CARD_HEIGHT_MM,
  type CardHomography,
} from '@/lib/capture-v2/card-homography';
import {
  extractExifFocal,
  type ExifFocalData,
} from '@/lib/capture-v2/exif-focal';
import {
  estimateFocalFromHomography,
  type HomographyFocalEstimate,
} from '@/lib/capture-v2/homography-focal';
import {
  computeGuidance,
  computeCurlGuidance,
  GuidanceIssue,
  GuidanceState,
} from '@/lib/capture-v2/capture-guidance';
import {
  extractMultiArc,
  type SagittaResult,
  type MultiArcResult,
} from '@/lib/capture-v2/nail-sagitta';
import {
  isCurlShot,
  type ShotSpec,
} from '@/lib/capture-v2/shot-spec';

/**
 * Diagnostics surfaced after a successful capture so we can verify on real
 * devices that the requested camera constraints, the actual stream settings,
 * the captured frame, and the normalized output are all self-consistent.
 *
 * This isn't permanent UI — it's the kind of thing we surface during Phase 1
 * device testing and quietly drop later. Telemetry hooks will replace it.
 */
export type CaptureDiagnostics = {
  userAgent: string;
  requestedConstraints: MediaStreamConstraints;
  actualSettings: MediaTrackSettings;
  capturedBlobSize: number;
  capturedBlobType: string;
  normalizedSize: number;
  normalizedWidth: number;
  normalizedHeight: number;
  normalizedOrientation: 'portrait' | 'landscape';
  capturedAtMs: number;
  captureLatencyMs: number;
  /**
   * Card-plane homography computed from a card detection run against the
   * captured frame's pixel data (not the live overlay's downsampled
   * preview frame). Null when no card was detected in the captured frame
   * or when the corners produced a degenerate homography.
   *
   * Metadata only — this does not affect the captured bytes or any
   * downstream measurement behaviour. Surfacing it here lets testbed
   * captures carry the geometry information we will eventually use to
   * retire the camera-to-card distance assumption.
   */
  cardHomography: CardHomography | null;
  /**
   * Convenience mirror of `cardHomography.residualPx` — the max corner
   * reprojection error in pixels. Top-level so the dev diagnostics panel
   * can surface it without having to reach into the matrix payload.
   * Null when `cardHomography` is null.
   */
  homographyResidualPx: number | null;
  /**
   * Focal-length metadata extracted from the JPEG EXIF of the raw captured
   * blob. For canvas-sourced captures (getUserMedia + canvas.toBlob) the
   * canvas API strips all metadata, so exifFocal.exifPresent will be false
   * and all numeric fields will be null. For file-picker captures on iOS the
   * fields will be populated. The diagnostics panel surfaces this either way
   * so we can document the path-specific availability.
   */
  exifFocal: ExifFocalData | null;
  /**
   * Focal-length estimate derived from the card-plane homography via the
   * Image of the Absolute Conic constraints. Null when no card was detected
   * at capture time (i.e. cardHomography is null) or when the homography
   * is too degenerate (flat-on card) for either constraint to yield a
   * positive f².
   */
  homographyFocal: HomographyFocalEstimate | null;
  /**
   * Local pixels-per-mm at the card centre, derived from the isotropic
   * Jacobian determinant of `cardToImage` at that point. This is the
   * principled geometric scale: it accounts for perspective distortion
   * across the card's surface rather than measuring only one edge.
   * Null when `cardHomography` is null.
   */
  homographyScalePxPerMm: number | null;
  /**
   * Pixels-per-mm computed from the projected top-edge length divided by
   * CARD_WIDTH_MM. This is the closest analog to what a backend "find the
   * card, measure its pixel width, divide by 85.6 mm" formula produces —
   * it reflects how a simple single-edge measurement would scale the image.
   * For production-flat captures (tilt < 7°) this should agree with
   * `homographyScalePxPerMm` to within a fraction of a percent.
   * Null when `cardHomography` is null.
   */
  naiveCardEdgeScalePxPerMm: number | null;
  /**
   * Best accepted arc from `multiArcResult` (multiArcResult.accepted[0]),
   * or null. Convenience field so callers that only need a single result
   * don't have to reach into multiArcResult.
   *
   * Only populated for `curl-four-finger` shots (and for backwards-compatible
   * callers with no shotSpec). Palm-up and curl-thumb shots produce null.
   */
  nailSagitta: SagittaResult | null;
  /**
   * Full multi-arc extraction result for `curl-four-finger` shots: all
   * candidates (accepted and rejected) with debug coordinates and scores.
   * Null for palm-up shots, curl-thumb shots, and extraction failures.
   *
   * For a four-finger shot this should contain up to 4 accepted candidates.
   * The gap between accepted.length and expectedArcCount (4) is the key
   * diagnostic signal for multi-arc detector development.
   */
  multiArcResult: MultiArcResult | null;
  /**
   * Shot specification in effect at capture time — records which step in the
   * 14-shot sequence produced this capture. Null when the caller has not yet
   * wired the sequencer (backwards-compatible).
   */
  shotSpec: ShotSpec | null;
};

type Status =
  | 'idle'         // user has not yet pressed "Start camera"
  | 'requesting'   // getUserMedia is in flight
  | 'streaming'    // live preview is on screen, capture button enabled
  | 'capturing'    // canvas snapshot + normalization in progress
  | 'error';       // permission denied, no camera, or capture failure

type Props = {
  /**
   * Emitted after a frame has been captured, wrapped in a File, and run
   * through the existing image-normalization path. The parent owns what
   * happens next (preview, upload, advance to next finger, etc.).
   */
  onPhotoTaken: (
    file: File,
    preview: string,
    diagnostics: CaptureDiagnostics
  ) => void;
  /**
   * The current shot specification — which hand, finger, and capture geometry
   * this view is being used for. Drives guidance function selection (curl vs
   * planar) and gates sagitta extraction to curl shots only. Optional so
   * callers that have not yet wired the 14-shot sequencer continue to work.
   */
  shotSpec?: ShotSpec | null;
};

/**
 * LiveCaptureView — live camera preview + canvas snapshot.
 *
 * Why this component exists
 * -------------------------
 * The previous live-camera code path in PhotoCapture.tsx was removed because
 * (a) it inherited uncorrected lens distortion from the video stream, and
 * (b) it cropped captured frames to a hard-coded 8.5/11 aspect ratio, silently
 * discarding pixels and potentially clipping the reference card out of frame.
 * Reintroducing live capture is gated on this component AVOIDING both of
 * those mistakes:
 *
 *   - No crop. The capture canvas matches `video.videoWidth/Height` exactly,
 *     so the bytes leaving here are the full sensor frame.
 *   - No resample. `imageSmoothingEnabled = false` and the canvas drawImage
 *     is 1:1. No subpixel transforms.
 *   - No aggressive compression. `canvas.toBlob` uses quality 0.95 — at the
 *     same near-lossless tier as `lib/image-normalization.ts`. Lens distortion
 *     correction is deliberately NOT done here; it's a later increment that
 *     needs its own validation pass before going anywhere near measurement.
 *
 * Captured frames are wrapped as a File and passed through the existing
 * `normalizeImageForUpload` so downstream consumers (preview, upload) see the
 * same shape of object whether the photo came from the v1 file picker or the
 * v2 live capture.
 */
export default function LiveCaptureView({ onPhotoTaken, shotSpec = null }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // requestedConstraints stays in a ref (not state) because we only need it
  // at the moment of capture for the diagnostics payload — it doesn't drive
  // any rerenders.
  const requestedConstraintsRef = useRef<MediaStreamConstraints | null>(null);

  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [streamSettings, setStreamSettings] =
    useState<MediaTrackSettings | null>(null);

  // Guidance state for the live prompt. Initialized to the no-card state so
  // the pill has something to say from the moment the camera comes online,
  // even before the detector's first callback lands. Curl shots use the
  // wider-band guidance function; planar shots use the standard one.
  const [guidance, setGuidance] = useState<GuidanceState>(() =>
    shotSpec && isCurlShot(shotSpec)
      ? computeCurlGuidance(null)
      : computeGuidance(null)
  );

  // Raw detection — updated on every CardOverlay callback (~4 Hz) BEFORE
  // the hysteresis filter, so the debug panel always shows the live detector
  // output rather than the smoothed committed state.
  const [liveDetection, setLiveDetection] = useState<Detection | null>(null);

  // Hysteresis refs (see handleDetection). Kept as refs not state so the
  // detector callback can read them without forcing rerenders. `undefined`
  // is the "no committed reading yet" sentinel — distinct from `null`,
  // which is a legitimate "ready" issue.
  const committedIssueRef = useRef<GuidanceIssue | null | undefined>(undefined);
  const pendingIssueRef = useRef<GuidanceIssue | null | undefined>(undefined);

  // Tear down the MediaStream on unmount so the camera indicator goes off.
  useEffect(() => {
    return () => {
      stopStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset hysteresis whenever we leave the streaming state — when the user
  // comes back, the prompt should start from "looking for the card" rather
  // than whatever the last frame happened to say. Use the correct guidance
  // initializer for the current shot geometry.
  useEffect(() => {
    if (status !== 'streaming') {
      committedIssueRef.current = undefined;
      pendingIssueRef.current = undefined;
      setGuidance(
        shotSpec && isCurlShot(shotSpec)
          ? computeCurlGuidance(null)
          : computeGuidance(null)
      );
    }
  }, [status, shotSpec]);

  /**
   * Detection callback: turn the latest Detection into guidance, with a
   * 2-frame hysteresis so the pill doesn't flicker on borderline frames.
   *
   * The rule:
   *   - First reading: commit immediately so the user sees something
   *     quickly.
   *   - Reading matches what's currently displayed: commit (keeps the
   *     metrics fresh; cancels any pending change-of-issue).
   *   - Reading differs from displayed AND matches the previous "pending"
   *     reading: commit the new state — we've seen the same new state
   *     twice in a row, so it's not a single-frame blip.
   *   - Reading differs from displayed and from pending: record it as
   *     the new pending and keep displaying the old state.
   *
   * At CardOverlay's ~4Hz callback rate this gives a minimum 250ms hold
   * before switching, which is enough to feel stable without feeling laggy.
   */
  const handleDetection = useCallback((detection: Detection | null) => {
    // Store raw detection before hysteresis so DebugPanel sees live values.
    setLiveDetection(detection);

    // Route to the appropriate guidance function: curl shots use wider
    // framePct bands and suppress tilt/off-paper checks.
    const computeFn =
      shotSpec && isCurlShot(shotSpec) ? computeCurlGuidance : computeGuidance;
    const next = computeFn(detection);
    const committed = committedIssueRef.current;

    if (committed === undefined) {
      committedIssueRef.current = next.issue;
      pendingIssueRef.current = undefined;
      setGuidance(next);
      return;
    }
    if (next.issue === committed) {
      pendingIssueRef.current = undefined;
      setGuidance(next);
      return;
    }
    if (next.issue === pendingIssueRef.current) {
      committedIssueRef.current = next.issue;
      pendingIssueRef.current = undefined;
      setGuidance(next);
      return;
    }
    pendingIssueRef.current = next.issue;
  }, [shotSpec]);

  function stopStream() {
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }

  async function startCamera() {
    setStatus('requesting');
    setError(null);

    // facingMode is a *preference*, not { exact: 'environment' }, so dev
    // testing on a laptop with only a front-facing camera still works. On
    // a phone, the browser will pick the rear camera.
    //
    // The width/height hints request the highest available resolution. The
    // browser/device picks the closest feasible setting from the camera's
    // capability list — we read back what we actually got via getSettings()
    // and surface it in diagnostics.
    const constraints: MediaStreamConstraints = {
      audio: false,
      video: {
        facingMode: 'environment',
        width: { ideal: 4096 },
        height: { ideal: 4096 },
      },
    };
    requestedConstraintsRef.current = constraints;

    // Pre-flight: navigator.mediaDevices is only defined in secure contexts
    // (HTTPS or localhost). On HTTP origins — including Cloudflare tunnels
    // accessed over http:// — it is simply absent, producing a TypeError
    // that previously leaked through as a raw Safari error message.
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError(
        'Camera access requires a secure connection (HTTPS). ' +
          'Make sure the URL starts with https:// and try again.'
      );
      setStatus('error');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        // play() must be awaited; failing to await it on iOS Safari can
        // produce a black frame because videoWidth is still 0 at capture time.
        await video.play();
      }

      const track = stream.getVideoTracks()[0];
      setStreamSettings(track ? track.getSettings() : null);
      setStatus('streaming');
    } catch (err: any) {
      const name = err?.name ?? '';
      let message = 'Could not access the camera.';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        message =
          'Camera permission denied. Allow camera access in your browser settings and tap "Start camera" again.';
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        message = 'No camera was found on this device.';
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        message =
          'The camera appears to be in use by another application. Close other apps using the camera and try again.';
      } else if (name === 'OverconstrainedError') {
        message =
          'No camera matched the requested settings on this device. This is usually a temporary device-specific issue.';
      } else if (err?.message) {
        message = `${message} (${err.message})`;
      }
      setError(message);
      setStatus('error');
    }
  }

  async function capturePhoto() {
    // Defense-in-depth: captureReady must be true before we read any
    // pixels. The capture button is already disabled when captureReady is
    // false, but this guard closes the race where the button is enabled,
    // the user taps it, and the guidance state changes in the same event
    // loop tick (e.g. a just-missed Otsu threshold flip one frame later).
    //
    // Palm-up shots: captureReady requires card on paper, centered,
    //   framePct ∈ [35 %, 70 %], tilt < 7°.
    // Curl shots: captureReady requires card detected, centered,
    //   framePct ∈ (5 %, 95 %).
    if (!guidance.captureReady) {
      // eslint-disable-next-line no-console
      console.warn(
        '[LiveCaptureView] capture blocked — captureReady is false',
        { issue: guidance.issue, shotType: shotSpec?.shotType ?? 'unknown' }
      );
      return;
    }

    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;

    setStatus('capturing');
    const startMs = performance.now();

    try {
      // Capture canvas dimensions === video stream dimensions. No crop, no
      // resample. If videoWidth is 0 something went wrong upstream — bail
      // rather than ship a black or stretched frame.
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) {
        throw new Error(
          'Video stream has no intrinsic dimensions yet. Wait a moment for the preview to settle and try again.'
        );
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Failed to acquire a 2D canvas context.');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(video, 0, 0, width, height);

      // Read image data once; shared by card detection and sagitta extraction.
      const capturedImageData = ctx.getImageData(0, 0, width, height);

      // Capture-time geometry metadata. We re-run the detector on the
      // captured frame (not on the live preview's downsampled sample
      // canvas) so the resulting corners — and the homography built from
      // them — are in the coordinate space of the bytes actually leaving
      // this component. For canvas-derived captures the normalization
      // path is a re-encode at 1:1 dimensions, so these coords map 1:1
      // onto the normalized image consumers will see downstream.
      //
      // Best-effort: detection or homography failure must not block the
      // capture, so both fields fall to null in that case. The capture
      // path below this point is unchanged.
      let cardHomography: CardHomography | null = null;
      let homographyResidualPx: number | null = null;
      try {
        const detection = detectCard(capturedImageData);
        if (detection) {
          const h = computeCardHomography(detection.corners);
          cardHomography = h;
          homographyResidualPx = h.residualPx;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          '[LiveCaptureView] capture-time homography metadata failed:',
          err
        );
      }

      // Arc extraction — best-effort, must not block the capture.
      //
      // Only `curl-four-finger` shots: these are the shots where multi-arc
      // IC extraction is implemented and validated.
      //
      // `curl-thumb` is intentionally excluded: the thumb's CMC joint makes
      // the current end-on geometry invalid for the thumb arc. Extraction
      // would produce meaningless or misleading values. See icArchitecturePending
      // in ShotSpec.
      //
      // `palm-up` is excluded: no sagitta geometry in a top-down shot.
      //
      // No shotSpec (backwards-compatible caller): run extraction so the
      // existing single-shot test page continues to surface results.
      let nailSagitta: SagittaResult | null = null;
      let multiArcResult: MultiArcResult | null = null;
      const shouldExtractArc =
        !shotSpec || shotSpec.shotType === 'curl-four-finger';
      if (shouldExtractArc) {
        try {
          const extracted = extractMultiArc(capturedImageData, cardHomography, 4);
          multiArcResult = extracted;
          nailSagitta    = extracted.accepted[0] ?? null;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[LiveCaptureView] arc extraction failed:', err);
        }
      }

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) =>
            b
              ? resolve(b)
              : reject(new Error('canvas.toBlob returned null')),
          'image/jpeg',
          0.95
        );
      });

      // EXIF focal extraction — best-effort, must not block capture.
      // canvas.toBlob strips all metadata, so this will return exifPresent:false
      // on the canvas path; that result is informative rather than an error.
      let exifFocal: ExifFocalData | null = null;
      try {
        const rawBytes = await blob.arrayBuffer();
        exifFocal = extractExifFocal(rawBytes);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[LiveCaptureView] EXIF focal extraction failed:', err);
      }

      // Homography-based focal estimate — only when a card was detected.
      const homographyFocal =
        cardHomography !== null
          ? estimateFocalFromHomography(cardHomography, width, height)
          : null;

      // Scale metadata — diagnostics only, best-effort.
      // homographyScalePxPerMm: Jacobian-determinant scale at the card centre.
      // naiveCardEdgeScalePxPerMm: top-edge pixel length / CARD_WIDTH_MM —
      //   proxy for what a backend "card width in pixels / 85.6" formula gives.
      let homographyScalePxPerMm: number | null = null;
      let naiveCardEdgeScalePxPerMm: number | null = null;
      if (cardHomography !== null) {
        try {
          homographyScalePxPerMm = pixelsPerMmAt(
            cardHomography,
            { x: CARD_WIDTH_MM / 2, y: CARD_HEIGHT_MM / 2 },
          );
          const tl = applyHomography(cardHomography.cardToImage, { x: 0,             y: 0 });
          const tr = applyHomography(cardHomography.cardToImage, { x: CARD_WIDTH_MM, y: 0 });
          naiveCardEdgeScalePxPerMm =
            Math.hypot(tr.x - tl.x, tr.y - tl.y) / CARD_WIDTH_MM;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[LiveCaptureView] scale metadata computation failed:', err);
        }
      }

      const ts = Date.now();
      const file = new File([blob], `capture-v2-${ts}.jpg`, {
        type: 'image/jpeg',
        lastModified: ts,
      });

      // Re-encode through the existing geometry-safe normalization path.
      // For canvas-derived bytes there is no EXIF to bake, so this is
      // effectively a re-encode at 0.98 quality — but keeping the path
      // identical to v1 means the bytes leaving here are produced by the
      // same code we already validated.
      const normalized = await normalizeImageForUpload(file);
      const preview = await fileToDataUrl(normalized.file);

      const diagnostics: CaptureDiagnostics = {
        userAgent:
          typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
        requestedConstraints: requestedConstraintsRef.current ?? {},
        actualSettings: streamSettings ?? {},
        capturedBlobSize: blob.size,
        capturedBlobType: blob.type,
        normalizedSize: normalized.file.size,
        normalizedWidth: normalized.width,
        normalizedHeight: normalized.height,
        normalizedOrientation: normalized.orientation,
        capturedAtMs: ts,
        captureLatencyMs: Math.round(performance.now() - startMs),
        cardHomography,
        homographyResidualPx,
        exifFocal,
        homographyFocal,
        homographyScalePxPerMm,
        naiveCardEdgeScalePxPerMm,
        nailSagitta,
        multiArcResult,
        shotSpec: shotSpec ?? null,
      };

      onPhotoTaken(normalized.file, preview, diagnostics);

      // Release the camera once the parent has the result. The parent decides
      // whether to mount LiveCaptureView again (e.g., on "retake") which will
      // re-request the stream.
      stopStream();
      setStatus('idle');
    } catch (err: any) {
      setError(err?.message ?? 'Failed to capture the photo.');
      setStatus('error');
    }
  }

  // ---------- UI ----------

  if (status === 'error') {
    return (
      <div className="rounded-2xl border border-red-500/40 bg-red-950/40 backdrop-blur p-6 text-red-100">
        <p className="font-medium mb-3">Camera unavailable</p>
        <p className="text-sm text-red-200/90 mb-5">{error}</p>
        <button
          onClick={startCamera}
          className="rounded-xl bg-red-500/80 hover:bg-red-500 px-4 py-2 text-sm font-medium text-white"
        >
          Try again
        </button>
      </div>
    );
  }

  if (status === 'idle') {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-8 text-center text-white">
        <p className="text-base mb-1">Ready to test live capture</p>
        <p className="text-sm text-white/60 mb-6">
          Tap below to request camera access. You&rsquo;ll see the live
          preview, then a capture button.
        </p>
        <button
          onClick={startCamera}
          className="rounded-xl bg-blue-600 hover:bg-blue-500 px-6 py-3 text-white font-medium"
        >
          Start camera
        </button>
      </div>
    );
  }

  // Streaming or capturing — render the video preview either way.
  //
  // Capture-button gate:
  //   status === 'streaming'       camera is live and not mid-capture
  //   guidance.captureReady        card passes all checks for this shot type
  //
  // The two conditions are independent and both must hold. captureReady is
  // set by the guidance functions and is the canonical gate:
  //
  //   Palm-up shots (steps 1–10) — computeGuidance, strict ruleset:
  //     captureReady = true  ↔  card on paper, centered,
  //                              framePct ∈ [35 %, 70 %], tilt < 7°.
  //     All five checks (off-paper, off-center, too-far, too-close, tilted)
  //     must clear. The distance thresholds now match the TARGET band exactly
  //     (40–70%). Boundary stability is provided by the 2-frame hysteresis in
  //     handleDetection — no separate deadband is used.
  //
  //   Curl shots (steps 11–14) — computeCurlGuidance, relaxed ruleset:
  //     captureReady = true  ↔  card detected, centered,
  //                              framePct ∈ (5 %, 95 %).
  //     Tilt and off-paper checks are suppressed because the camera must
  //     point at the fingertip end-on (inherently tilted) and the reference
  //     card may not be on paper.
  //
  // Routing is handled in handleDetection — the button and capturePhoto()
  // both gate solely on captureReady. The two rulesets stay completely
  // separate: loosening curl thresholds does NOT affect palm-up requirements.
  //
  // The CardOverlay sits on top of the <video> element via absolute
  // positioning. It samples the live stream and draws a quadrilateral
  // when a card is detected, but it does NOT touch the capture path —
  // the snapshot below still reads from `video` at full sensor resolution
  // and ignores anything the overlay drew. This keeps the dimensions-
  // preserved guarantee from earlier increments intact.
  //
  // The overlay is paused (`active={false}`) the moment we start
  // capturing so we don't waste cycles on detection while normalizing.
  const isCurl = shotSpec != null && isCurlShot(shotSpec);

  // Frame border and mode badge change per shot geometry:
  //   Palm-up  — blue border, "Width · top-down" badge
  //   Curl     — indigo border, "IC · end-on" badge
  // This makes the architectural split visible so a user moving between
  // steps can't accidentally apply curl framing to a palm-up step.
  const frameBorderClass = isCurl ? 'border-indigo-500/60' : 'border-blue-500/40';

  return (
    <div className="space-y-4">
      <div className={`relative overflow-hidden rounded-2xl border bg-black aspect-[3/4] ${frameBorderClass}`}>
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          playsInline
          muted
          autoPlay
        />
        <CardOverlay
          videoRef={videoRef}
          active={status === 'streaming'}
          onDetection={handleDetection}
        />
        {/* Mode badge — bottom-left corner, always visible while streaming.
            Tells the user whether this step is a width (top-down) capture or
            an IC (end-on curl) capture so there's no ambiguity about framing. */}
        {status === 'streaming' && (
          <div className={`absolute z-20 bottom-3 left-3 px-3 py-1 rounded-full text-xs font-semibold text-white pointer-events-none ${isCurl ? 'bg-indigo-600/90' : 'bg-blue-600/90'}`}>
            {isCurl ? 'IC · end-on' : 'Width · top-down'}
          </div>
        )}
        {/* Live debug readout — bottom-right corner. Shows the raw detector
            metrics and guidance state so we can verify framePct behaviour and
            threshold calibration on a real device without opening devtools.
            Remove once threshold calibration is confirmed. */}
        {status === 'streaming' && (
          <DebugPanel
            detection={liveDetection}
            guidance={guidance}
            videoRef={videoRef}
            shotSpec={shotSpec}
          />
        )}
        {status === 'streaming' && <GuidancePill guidance={guidance} />}
        {status === 'requesting' && (
          <div className="absolute inset-0 flex items-center justify-center text-white/80 text-sm bg-black/60">
            Requesting camera access&hellip;
          </div>
        )}
        {status === 'capturing' && (
          <div className="absolute inset-0 flex items-center justify-center text-white text-sm bg-black/60">
            Capturing&hellip;
          </div>
        )}
      </div>

      {/* Capture is gated on guidance.captureReady so that palm-up shots
          enforce the full strict planar ruleset and curl shots enforce the
          curl-specific relaxed ruleset. The guidance pill tells the user
          exactly what to fix; this button locks until they do.
          capturePhoto() carries a matching defense-in-depth guard. */}
      <div className="space-y-2">
        <button
          onClick={capturePhoto}
          disabled={status !== 'streaming' || !guidance.captureReady}
          className="w-full rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/40 disabled:cursor-not-allowed px-6 py-3 text-white font-medium transition-colors"
        >
          {status === 'capturing'
            ? 'Capturing…'
            : guidance.captureReady
              ? 'Capture'
              : 'Waiting for card…'}
        </button>
        {!guidance.captureReady && status === 'streaming' && (
          <p className="text-xs text-white/45 text-center">
            {guidance.issue === 'no-card'
              ? 'Position the reference card in frame'
              : 'Follow the guidance above to unlock capture'}
          </p>
        )}
      </div>

      {streamSettings && (
        <div className="text-xs text-white/60">
          Stream: {streamSettings.width ?? '?'}×{streamSettings.height ?? '?'}
          {streamSettings.frameRate
            ? ` @ ${Math.round(streamSettings.frameRate)}fps`
            : ''}
          {streamSettings.facingMode ? ` · ${streamSettings.facingMode}` : ''}
        </div>
      )}
    </div>
  );
}

/**
 * Dev debug panel — bottom-right corner of the camera frame.
 *
 * Shows live detector metrics + guidance state so threshold calibration can
 * be done from real device output rather than guesswork. Remove once the
 * framePct ↔ distance relationship is confirmed on the target device.
 *
 * Fields shown:
 *   vid          — video.videoWidth × videoHeight (the frames being captured)
 *   framePct     — card long edge / sample-frame short side × 100
 *                  This is the key distance metric. Threshold: 35–70% ok.
 *   longEdge     — card long edge in pixels (detection-canvas space)
 *   shortEdge    — card short edge in pixels (detection-canvas space)
 *   areaFrac     — card area / frame area (sanity cross-check)
 *   ratio        — detected card long/short ratio (truth ≈ 1.586)
 *   skew         — perspectiveSkew (tilt proxy; threshold 0.05)
 *   surround     — minSurroundMean / edgeSurroundSpread (off-paper check)
 *   issue        — committed guidance issue (hysteresis-filtered)
 *   captureReady — the shutter gate value
 *   shotType     — which geometry is active for this step
 */
function DebugPanel({
  detection,
  guidance,
  videoRef,
  shotSpec,
}: {
  detection: Detection | null;
  guidance: GuidanceState;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  shotSpec: ShotSpec | null;
}) {
  const vid = videoRef.current;
  const vidW = vid?.videoWidth ?? 0;
  const vidH = vid?.videoHeight ?? 0;

  // CardOverlay pre-downsamples to DETECT_LONG_EDGE (1200) before calling
  // detectCard. The framePct denominator is the SHORT side of that canvas —
  // show it so the user can verify: framePct = longEdge / sShort × 100.
  const DETECT_LONG = 1200;
  const vidLong = Math.max(vidW, vidH);
  const sScale = vidLong > DETECT_LONG ? DETECT_LONG / vidLong : 1;
  const sShort = vidW > 0 && vidH > 0
    ? Math.min(Math.round(vidW * sScale), Math.round(vidH * sScale))
    : 0;

  const m = detection?.metrics;

  // For palm-up shots these are the active threshold boundaries.
  const isCurlMode = shotSpec != null && isCurlShot(shotSpec);
  const loThr = isCurlMode ? 5 : 35;
  const hiThr = isCurlMode ? 95 : 70;

  return (
    <div className="absolute z-30 bottom-3 right-3 px-2 py-1.5 rounded bg-black/75 text-white text-[9px] font-mono leading-snug pointer-events-none max-w-[170px]">
      <div className="text-white/50 mb-0.5 text-[8px] uppercase tracking-wide">debug</div>
      <div>vid {vidW}×{vidH}</div>
      <div className="text-white/60">sShort {sShort}px (÷ for %)</div>
      {m ? (
        <>
          <div className={`font-bold ${m.framePct < loThr ? 'text-red-400' : m.framePct > hiThr ? 'text-amber-400' : 'text-emerald-400'}`}>
            framePct {m.framePct.toFixed(1)}%
            {m.framePct < loThr ? ' too-far' : m.framePct > hiThr ? ' too-close' : ' ✓ok'}
          </div>
          <div>longEdge {Math.round(m.longEdge)}px</div>
          <div>shortEdge {Math.round(m.shortEdge)}px</div>
          <div>areaFrac {(m.areaFrac * 100).toFixed(1)}%</div>
          <div>ratio {m.ratio.toFixed(3)}</div>
          <div className={m.perspectiveSkew > 0.05 ? 'text-amber-400' : ''}>
            skew {m.perspectiveSkew.toFixed(3)}{m.perspectiveSkew > 0.05 ? ' ←tilt' : ''}
          </div>
          <div className={(m.minSurroundMean < 170 && m.edgeSurroundSpread > 50) ? 'text-amber-400' : ''}>
            surr {Math.round(m.minSurroundMean)}/{Math.round(m.edgeSurroundSpread)}
            {(m.minSurroundMean < 170 && m.edgeSurroundSpread > 50) ? ' off-paper' : ''}
          </div>
          <div>corners min-edge {m.minCornerEdgeFrac < 0.05 ? <span className="text-amber-400">off-ctr</span> : 'ok'}</div>
        </>
      ) : (
        <div className="text-red-400">no card</div>
      )}
      <div className="mt-0.5 border-t border-white/20 pt-0.5">
        <div className={guidance.captureReady ? 'text-emerald-400' : 'text-red-400'}>
          ready={String(guidance.captureReady)}
        </div>
        <div className="text-white/70">
          issue={guidance.issue ?? 'none'}
        </div>
        <div className="text-white/70">
          shot={shotSpec?.shotType ?? 'n/a'}
        </div>
        <div className="text-white/50 text-[8px]">
          {isCurlMode ? 'thr 5–95%' : 'thr 35–70%'}
        </div>
      </div>
    </div>
  );
}

/**
 * Top-of-frame pill showing the current guidance prompt.
 *
 * Color rules:
 *   - 'no-card' (waiting for the user to bring a card into frame) → slate.
 *     Deliberately neutral, not alarming — this is the expected initial
 *     state, not an error.
 *   - any other warn issue → amber. Conveys "something needs adjusting"
 *     without the urgency of red.
 *   - ok / ready → emerald. The capture button becomes enabled when this
 *     lights up — the pill is the visible signal that the gate has opened.
 *
 * pointer-events-none so the pill never intercepts taps meant for the
 * video or the capture button beneath it.
 *
 * z-20 is load-bearing on iOS Safari. Video and canvas siblings get
 * promoted to their own GPU compositing layers and the pill (with no
 * explicit z-index) was rendering behind them despite being later in
 * document order. The dev chip inside CardOverlay's fragment isn't
 * affected because it shares the canvas's layer. Make this explicit
 * before something else later in the layout decides it wants the same
 * stacking spot.
 */
function GuidancePill({ guidance }: { guidance: GuidanceState }) {
  const isNoCard = guidance.issue === 'no-card';
  const bgClass = isNoCard
    ? 'bg-slate-800/85'
    : guidance.captureReady
      ? 'bg-emerald-500/90'
      : 'bg-amber-500/95';

  return (
    <div
      className={`absolute z-20 top-3 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full backdrop-blur-sm shadow-lg text-white text-sm font-medium pointer-events-none transition-colors max-w-[90%] text-center ${bgClass}`}
    >
      {guidance.message}
    </div>
  );
}
