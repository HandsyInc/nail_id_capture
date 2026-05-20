'use client';

import { useEffect, useRef, useState } from 'react';
import {
  normalizeImageForUpload,
  fileToDataUrl,
} from '@/lib/image-normalization';

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
export default function LiveCaptureView({ onPhotoTaken }: Props) {
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

  // Tear down the MediaStream on unmount so the camera indicator goes off.
  useEffect(() => {
    return () => {
      stopStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Streaming or capturing — render the video preview either way; only the
  // capture button's enabled state changes.
  return (
    <div className="space-y-4">
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black aspect-[3/4]">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          playsInline
          muted
          autoPlay
        />
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

      <div className="flex items-center justify-between gap-3">
        <button
          onClick={capturePhoto}
          disabled={status !== 'streaming'}
          className="flex-1 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/40 disabled:cursor-not-allowed px-6 py-3 text-white font-medium"
        >
          {status === 'capturing' ? 'Capturing…' : 'Capture'}
        </button>
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
