'use client';

import { useEffect, useMemo, useState } from 'react';
import CaptureEntry from '@/components/CaptureEntry';
import CaptureRules from '@/components/CaptureRules';
import CameraRules from '@/components/CameraRules';
import CaptureReady from '@/components/CaptureReady';
import PhotoCapture from '@/components/PhotoCapture';
import PhotoPreview from '@/components/PhotoPreview';
import CaptureConfirm from '@/components/CaptureConfirm';
import SuccessScreen from '@/components/SuccessScreen';
import ErrorScreen from '@/components/ErrorScreen';
import ProcessingScreen from '@/components/ProcessingScreen';
import ProgressIndicator from '@/components/ProgressIndicator';
import { normalizeImageForUpload, fileToBase64 } from '@/lib/image-normalization';

export type ScreenName =
  | 'capture_entry'
  | 'user_info'
  | 'capture_rules'
  | 'camera_rules'
  | 'palm_up_rules'
  | 'capture_ready'
  | 'photo_left_thumb'
  | 'photo_preview_left_thumb'
  | 'photo_left_index'
  | 'photo_preview_left_index'
  | 'photo_left_middle'
  | 'photo_preview_left_middle'
  | 'photo_left_ring'
  | 'photo_preview_left_ring'
  | 'photo_left_pinky'
  | 'photo_preview_left_pinky'
  | 'photo_right_thumb'
  | 'photo_preview_right_thumb'
  | 'photo_right_index'
  | 'photo_preview_right_index'
  | 'photo_right_middle'
  | 'photo_preview_right_middle'
  | 'photo_right_ring'
  | 'photo_preview_right_ring'
  | 'photo_right_pinky'
  | 'photo_preview_right_pinky'
  | 'photo_left_palm_up'
  | 'photo_preview_left_palm_up'
  | 'photo_right_palm_up'
  | 'photo_preview_right_palm_up'
  | 'capture_confirm'
  | 'processing'
  | 'success'
  | 'error'

export type PhotoData = {
  file: File | null;
  preview: string | null;
  imageId: string | null;
};

type CreateProjectRequest = {
  user_name: string;
  project_name: string;
  description?: string | null;
};

type CreateProjectResponse = {
  project_id: string;
  status?: string;
};

type UploadRequest = {
  image_data: string; // base64 (no data: prefix)
  image_metadata: {
    project_id: string;
    image_type: string;
    hand: string;
    finger: string;
    orientation: 'portrait' | 'landscape';
  };
};

type UploadResponse = {
  status?: string;
  image_id?: string;
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SESSION_PROJECT_ID_KEY = 'handsy_project_id';

function randomString(length: number) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function generateUUID() {
  // Generate a UUID v4 compatible string
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // Set version (4) and variant bits
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function getApiBase(): string {
  return 'https://uw-handsy-107520900999.us-central1.run.app';
}

async function readJsonSafely(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatApiErrorPayload(payload: any): string | null {
  if (!payload) return null;
  if (typeof payload === 'string') return payload;
  if (payload?.error && typeof payload.error === 'string') return payload.error;
  // FastAPI style validation errors
  if (Array.isArray(payload?.detail)) {
    const msgs = payload.detail
      .map((d: any) => d?.msg)
      .filter(Boolean)
      .slice(0, 3);
    if (msgs.length) return msgs.join(' ');
  }
  if (payload?.detail && typeof payload.detail === 'string') return payload.detail;
  return null;
}

// Removed in the phase1/exif-normalization-bounded branch:
//   - getImageOrientationFromDataUrl: read raw <img> naturalWidth/naturalHeight
//     without honoring EXIF rotation, producing inconsistent orientation
//     decisions for iPhone JPEGs (raw landscape pixels + EXIF rotate-90 flag).
//   - dataUrlToBase64: replaced by `fileToBase64` from @/lib/image-normalization,
//     which works on the normalized File's bytes verbatim rather than a
//     potentially-re-encoded data URL.
//   - validateImageBeforeUpload: type/size checks are now done in PhotoCapture
//     pre-handoff and post-normalization in handleUsePhoto.
// All three are superseded by `normalizeImageForUpload`, which produces a
// File whose pixel orientation and metadata are self-consistent. See
// lib/image-normalization.ts for the full rationale.

function getUploadMetadataForPhotoIndex(photoIndex: number) {
  switch (photoIndex) {
    case 0:
      return { hand: 'left', image_type: 'top_down', finger: 'thumb' };
    case 1:
      return { hand: 'left', image_type: 'top_down', finger: 'index' };
    case 2:
      return { hand: 'left', image_type: 'top_down', finger: 'middle' };
    case 3:
      return { hand: 'left', image_type: 'top_down', finger: 'ring' };
    case 4:
      return { hand: 'left', image_type: 'top_down', finger: 'pinky' };
    case 5:
      return { hand: 'right', image_type: 'top_down', finger: 'thumb' };
    case 6:
      return { hand: 'right', image_type: 'top_down', finger: 'index' };
    case 7:
      return { hand: 'right', image_type: 'top_down', finger: 'middle' };
    case 8:
      return { hand: 'right', image_type: 'top_down', finger: 'ring' };
    case 9:
      return { hand: 'right', image_type: 'top_down', finger: 'pinky' };
    case 10:
      return { hand: 'left', image_type: 'palm_up', finger: 'palm_up' };
    case 11:
      return { hand: 'right', image_type: 'palm_up', finger: 'palm_up' };
    default:
      return { hand: 'left', image_type: 'top_down', finger: 'thumb' };
  }
}

// `compressImageFile` was removed in the phase1/exif-normalization-bounded
// branch. It downsampled to a 1000px max width and re-encoded JPEG at 0.6
// quality — a measurement-destroying combination of resample + heavy
// compression. It was defined but never invoked. Removed outright rather
// than left dormant to prevent any future code path from wiring it into
// the measurement pipeline. DO NOT reintroduce a function with this
// behavior in the capture or upload path. If a true upload-size constraint
// is needed later, address it server-side or with an explicit, geometry-
// preserving compression strategy that is reviewed against measurement
// variance.
export default function Home() {
  console.log('HOME COMPONENT IS RENDERING');
  const MAINTENANCE_MODE = false;
  const [currentScreen, setCurrentScreen] = useState<ScreenName>('capture_entry');

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')

  const [photos, setPhotos] = useState<PhotoData[]>([
    { file: null, preview: null, imageId: null },
    { file: null, preview: null, imageId: null },
    { file: null, preview: null, imageId: null },
    { file: null, preview: null, imageId: null },
    { file: null, preview: null, imageId: null },
    { file: null, preview: null, imageId: null },
    { file: null, preview: null, imageId: null },
    { file: null, preview: null, imageId: null },
    { file: null, preview: null, imageId: null },
    { file: null, preview: null, imageId: null },
    { file: null, preview: null, imageId: null },
    { file: null, preview: null, imageId: null },
  ]);
  const [currentPhotoIndex, setCurrentPhotoIndex] = useState(0);
  const [previewPhotoIndex, setPreviewPhotoIndex] = useState<number | null>(null);

  const [projectId, setProjectId] = useState<string | null>(null);
  const [nailId, setNailId] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const [isUploading, setIsUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Load any existing project id (optional continuity)
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(SESSION_PROJECT_ID_KEY);
      if (saved) setProjectId(saved);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      if (projectId) sessionStorage.setItem(SESSION_PROJECT_ID_KEY, projectId);
    } catch {
      // ignore
    }
  }, [projectId]);

  const showProgress = currentScreen?.startsWith('photo_');

  const getCurrentPhotoNumber = () => {
    if (currentScreen?.startsWith('photo_preview_') && previewPhotoIndex !== null) {
      return previewPhotoIndex + 1;
    }
    return currentPhotoIndex + 1;
  };

  const getHeaderText = (): string | undefined => {
    const headers: Record<ScreenName, string | undefined> = {
      capture_entry: undefined,
      capture_rules: undefined,
      camera_rules: undefined,
      palm_up_rules: undefined,
      capture_ready: undefined,
      user_info: undefined,

      photo_left_thumb: 'Left Thumb',
      photo_preview_left_thumb: uploadSuccess ? 'Upload Success' : 'Review Left Thumb',

      photo_left_index: 'Left Index',
      photo_preview_left_index: uploadSuccess ? 'Upload Success' : 'Review Left Index',

      photo_left_middle: 'Left Middle',
      photo_preview_left_middle: uploadSuccess ? 'Upload Success' : 'Review Left Middle',

      photo_left_ring: 'Left Ring',
      photo_preview_left_ring: uploadSuccess ? 'Upload Success' : 'Review Left Ring',

      photo_left_pinky: 'Left Pinky',
      photo_preview_left_pinky: uploadSuccess ? 'Upload Success' : 'Review Left Pinky',

      photo_right_thumb: 'Right Thumb',
      photo_preview_right_thumb: uploadSuccess ? 'Upload Success' : 'Review Right Thumb',

      photo_right_index: 'Right Index',
      photo_preview_right_index: uploadSuccess ? 'Upload Success' : 'Review Right Index',

      photo_right_middle: 'Right Middle',
      photo_preview_right_middle: uploadSuccess ? 'Upload Success' : 'Review Right Middle',

      photo_right_ring: 'Right Ring',
      photo_preview_right_ring: uploadSuccess ? 'Upload Success' : 'Review Right Ring',

      photo_right_pinky: 'Right Pinky',
      photo_preview_right_pinky: uploadSuccess ? 'Upload Success' : 'Review Right Pinky',

      photo_left_palm_up: 'Left Hand Palm-Up',
      photo_preview_left_palm_up: uploadSuccess ? 'Upload Success' : 'Review Left Hand Palm-Up',

      photo_right_palm_up: 'Right Hand Palm-Up',
      photo_preview_right_palm_up: uploadSuccess ? 'Upload Success' : 'Review Right Hand Palm-Up',


      capture_confirm: undefined,
      processing: undefined,
      success: undefined,
      error: undefined,
    };

    return headers[currentScreen];
  };

  const canSubmit = useMemo(() => photos.every((p) => p.file !== null), [photos]);

  const handleNext = () => {
    const flow: ScreenName[] = [
      'capture_entry',
      'capture_rules',
      'camera_rules',

      'photo_left_thumb',
      'photo_left_index',
      'photo_left_middle',
      'photo_left_ring',
      'photo_left_pinky',

      'photo_right_thumb',
      'photo_right_index',
      'photo_right_middle',
      'photo_right_ring',
      'photo_right_pinky',

      'photo_left_palm_up',
      'photo_right_palm_up',

      'capture_confirm',
    ];

    const currentIndex = flow.indexOf(currentScreen);
    if (currentIndex < flow.length - 1) {
      setCurrentScreen(flow[currentIndex + 1]);
    }
  };

  const handleStart = async () => {
    setStartError(null);
    setUploadError(null);
    setIsStarting(true);

    try {
      const base = getApiBase();
      const url = new URL('/api/v1/create_project', base).toString();

      const requestBody: CreateProjectRequest = {
        user_name: generateUUID(),
        project_name: `scan-${randomString(10)}`,
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!res.ok) {
        const payload = await readJsonSafely(res);
        const details = formatApiErrorPayload(payload);
        throw new Error(details ?? `Failed to start scan (HTTP ${res.status}).`);
      }

      const data = (await res.json()) as CreateProjectResponse;
      if (!data?.project_id) {
        throw new Error('Create project succeeded but no project_id was returned.');
      }

      setProjectId(data.project_id);
      const newNailId = `NAILID-${Math.floor(1000 + Math.random() * 9000)}`;
      setNailId(newNailId); 

      // Reset state for a fresh run
      setPhotos([
        { file: null, preview: null, imageId: null },
        { file: null, preview: null, imageId: null },
        { file: null, preview: null, imageId: null },
        { file: null, preview: null, imageId: null },
        { file: null, preview: null, imageId: null },
        { file: null, preview: null, imageId: null },
        { file: null, preview: null, imageId: null },
        { file: null, preview: null, imageId: null },
        { file: null, preview: null, imageId: null },
        { file: null, preview: null, imageId: null },
        { file: null, preview: null, imageId: null },
        { file: null, preview: null, imageId: null },
        
      ]);
      setCurrentPhotoIndex(0);
      setPreviewPhotoIndex(null);

      setCurrentScreen('user_info');
    } catch (err: any) {
      setStartError(err?.message ?? 'Failed to start scan.');
    } finally {
      setIsStarting(false);
    }
  };

  const handlePhotoTaken = (file: File, preview: string) => {
    const newPhotos = [...photos];
    newPhotos[currentPhotoIndex] = { file, preview, imageId: null };

    setPhotos(newPhotos);
    setPreviewPhotoIndex(currentPhotoIndex);
    setUploadSuccess(false);

    const previewScreens: ScreenName[] = [
      'photo_preview_left_thumb',
      'photo_preview_left_index',
      'photo_preview_left_middle',
      'photo_preview_left_ring',
      'photo_preview_left_pinky',
      'photo_preview_right_thumb',
      'photo_preview_right_index',
      'photo_preview_right_middle',
      'photo_preview_right_ring',
      'photo_preview_right_pinky',
      'photo_preview_left_palm_up',
      'photo_preview_right_palm_up',
    ];

    setCurrentScreen(previewScreens[currentPhotoIndex]);
  };

  const handleUsePhoto = async () => {
    if (previewPhotoIndex === null) return;
    setUploadError(null);

    const photo = photos[previewPhotoIndex];
    if (!photo?.file) {
      setUploadError('Missing image data. Please retake the photo.');
      return;
    }
    if (!projectId) {
      setUploadError('Project is not initialized yet. Please go back and start the scan again.');
      return;
    }

    const meta = getUploadMetadataForPhotoIndex(previewPhotoIndex);
    const uploadStartedAt = Date.now();

    // Structured log context. `[handsy.upload]` and `[handsy.email]` prefixes
    // make the bounded-fix logs easy to grep in browser devtools and in
    // Vercel logs while we verify the API path is reliable.
    const logCtx = {
      projectId,
      previewPhotoIndex,
      hand: meta.hand,
      finger: meta.finger,
      imageType: meta.image_type,
    };
    console.log('[handsy.upload] start', {
      ...logCtx,
      originalFileSize: photo.file.size,
      originalFileType: photo.file.type,
    });

    setIsUploading(true);
    try {
      // Bake EXIF rotation into pixels and strip EXIF metadata.
      // Result: the bytes sent below are pixel-orientation-correct with
      // no orientation metadata remaining, so the client and the
      // measurement service cannot disagree on which way the image is
      // meant to be read. See lib/image-normalization.ts for full
      // rationale.
      const normalized = await normalizeImageForUpload(photo.file);

      if (normalized.file.size > MAX_IMAGE_BYTES) {
        throw new Error('Photo is larger than 10MB after normalization. Please retake.');
      }
      if (normalized.orientation !== 'portrait') {
        throw new Error('Please use portrait orientation. Rotate your phone and retake.');
      }

      console.log('[handsy.upload] normalized', {
        ...logCtx,
        normalizedWidth: normalized.width,
        normalizedHeight: normalized.height,
        normalizedFileSize: normalized.file.size,
      });

      const imageBase64 = await fileToBase64(normalized.file);
      const base = getApiBase();
      const url = new URL('/api/v1/upload', base).toString();
      const body: UploadRequest = {
        image_data: imageBase64,
        image_metadata: {
          project_id: projectId,
          image_type: meta.image_type,
          hand: meta.hand,
          finger: meta.finger,
          // Always 'portrait' — pixel orientation is now guaranteed by
          // normalization. No metadata-vs-pixels mismatch is possible.
          orientation: 'portrait',
        },
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const payload = await readJsonSafely(res);
        const details = formatApiErrorPayload(payload);
        console.error('[handsy.upload] api_failure', {
          ...logCtx,
          httpStatus: res.status,
          errorDetail: details,
          durationMs: Date.now() - uploadStartedAt,
        });
        throw new Error(details ?? `Failed to upload photo (HTTP ${res.status}).`);
      }

      const data = (await res.json()) as UploadResponse;

      // Absence of image_id on a 200 response is a soft failure: the API
      // answered OK but we have no retrieval handle. Log it loudly so we
      // can detect silent-success regressions during this bounded test.
      if (!data?.image_id) {
        console.warn('[handsy.upload] api_success_no_image_id', {
          ...logCtx,
          responseStatus: data?.status,
          durationMs: Date.now() - uploadStartedAt,
        });
      } else {
        console.log('[handsy.upload] api_success', {
          ...logCtx,
          imageId: data.image_id,
          apiStatus: data.status,
          durationMs: Date.now() - uploadStartedAt,
        });
      }

      // Mirror the normalized photo via email for human review / records.
      const emailStartedAt = Date.now();
      const emailFormData = new FormData();
      emailFormData.append('name', name);
      emailFormData.append('email', email);
      emailFormData.append('nailId', nailId || '');
      emailFormData.append('photos', normalized.file, normalized.file.name);
      emailFormData.append('hand', meta.hand);
      emailFormData.append('finger', meta.finger);

      const emailRes = await fetch('/api/submit-photos', {
        method: 'POST',
        body: emailFormData,
      });

      if (!emailRes.ok) {
        const errorText = await emailRes.text();
        console.error('[handsy.email] failure', {
          ...logCtx,
          httpStatus: emailRes.status,
          errorBody: errorText,
          durationMs: Date.now() - emailStartedAt,
        });
        throw new Error(`Failed to send photo email: ${errorText}`);
      }

      console.log('[handsy.email] success', {
        ...logCtx,
        durationMs: Date.now() - emailStartedAt,
      });

      // Persist the normalized file back to state so any subsequent
      // operation on this photo entry works on the normalized bytes.
      setPhotos((prev) => {
        const next = [...prev];
        next[previewPhotoIndex] = {
          ...next[previewPhotoIndex],
          file: normalized.file,
          imageId: data?.image_id ?? next[previewPhotoIndex].imageId,
        };
        return next;
      });

      setUploadSuccess(true);

      // Auto-continue after 2.5 seconds.
      setTimeout(() => {
        if (previewPhotoIndex < 11) {
          const nextPhotoIndex = previewPhotoIndex + 1;
          setCurrentPhotoIndex(nextPhotoIndex);

          const nextPhotoScreens: ScreenName[] = [
            'photo_left_thumb',
            'photo_left_index',
            'photo_left_middle',
            'photo_left_ring',
            'photo_left_pinky',
            'photo_right_thumb',
            'photo_right_index',
            'photo_right_middle',
            'photo_right_ring',
            'photo_right_pinky',
            'photo_left_palm_up',
            'photo_right_palm_up',
          ];

          setPreviewPhotoIndex(null);
          setIsUploading(false);
          const nextScreen = nextPhotoScreens[nextPhotoIndex];

          if (!nextScreen) {
            setCurrentScreen('capture_confirm');
            return;
          }

          setCurrentScreen(nextScreen);
        } else {
          setPreviewPhotoIndex(null);
          setIsUploading(false);
          setCurrentScreen('capture_confirm');
        }
        setUploadSuccess(false);
      }, 2500);
    } catch (error: any) {
      console.error('[handsy.upload] failure', {
        ...logCtx,
        message: error?.message ?? String(error),
        durationMs: Date.now() - uploadStartedAt,
      });
      setUploadError(error?.message ?? 'We couldn’t save this photo right now. Please try again.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleRetakePhoto = () => {
    if (previewPhotoIndex !== null) {
      setUploadError(null);
      setUploadSuccess(false);
      const photoScreens: ScreenName[] = [
        'photo_left_thumb',
        'photo_left_index',
        'photo_left_middle',
        'photo_left_ring',
        'photo_left_pinky',
        'photo_right_thumb',
        'photo_right_index',
        'photo_right_middle',
        'photo_right_ring',
        'photo_right_pinky',
        'photo_left_palm_up',
        'photo_right_palm_up',
      ];
      setCurrentScreen(photoScreens[previewPhotoIndex]);
      setPreviewPhotoIndex(null);
    }
  };

  const handleSubmit = async () => {
  if (!name || !email || !nailId) return;

  setCurrentScreen('processing');

  try {
    const response = await fetch('/api/send-confirmation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        email,
        nailId: nailId || '',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to send confirmation: ${errorText}`);
    }

    setCurrentScreen('success');
  } catch (error: any) {
    console.error('Confirmation failed:', error);
    alert('We couldn’t send your confirmation right now. Please try again.');
    setCurrentScreen('capture_confirm');
  }
};

  const renderScreen = () => {
    switch (currentScreen) {
      case 'capture_entry':
        return (
          <CaptureEntry
            onStart={handleStart}
            isStarting={isStarting}
            errorMessage={startError}
          />
        );
      case 'user_info':
        return (
          <div className="space-y-6 text-center">
            <h1 className="text-2xl font-bold text-gray-100">
              Tell us where to send your Nail ID
            </h1>

            <input
              type="text"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full p-3 rounded-lg bg-gray-800 text-white"
            />

            <input
              type="email"
              placeholder="Your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full p-3 rounded-lg bg-gray-800 text-white"
            />

            <button
              onClick={() => setCurrentScreen('capture_rules')}
              disabled={!name || !email}
              className="w-full py-4 rounded-xl bg-gradient-to-r from-blue-500 to-teal-400 text-white font-semibold text-lg"
            >
              Continue
            </button>
          </div>
        )
      case 'capture_rules':
        return (
          <div className="space-y-6 text-center">
            <h1 className="text-2xl font-bold text-gray-100">
              Before you start
            </h1>

            <p className="text-gray-400">
              You’ll need:
            </p>

            <div className="space-y-2 text-gray-300">
              <p>• A plain white sheet of standard printer paper (8.5 × 11)</p>
              <p>• A dark credit, debit, or loyalty card (not white)</p>
            </div>

            <button
              onClick={() => setCurrentScreen('camera_rules')}
              className="w-full py-4 rounded-xl bg-gradient-to-r from-blue-500 to-teal-400 text-white font-semibold text-lg"
            >
              Got it
            </button>
          </div>
        );
      case 'camera_rules':
        return (
          <div className="space-y-6 text-center">
            <h1 className="text-2xl font-bold text-gray-100">
              Set up each finger - 10 photos total - like this
            </h1>

            <ul className="space-y-3 text-gray-300 text-sm text-left list-disc pl-5">
  <li>Place white paper flat on the table</li>
  <li>Remove all rings</li>
  <li>Lay one finger flat on the paper beside the card, keeping the nail facing up</li>
  <li>Let your other fingers hang off the table edge</li>
  <li>Hold your phone straight above, not angled</li>
  <li>Keep the full finger and full card in the frame</li>
  <li>Move closer or farther until the white paper fills the screen</li>
</ul>
<p className="text-sm text-gray-400 mt-4">
  This ensures accurate measurements.
</p>

            <img
              src="/example.jpg"
              alt="Example nail photo"
              className="rounded-xl"
            />

            <button
              onClick={() => setCurrentScreen('palm_up_rules')}
              className="w-full py-4 rounded-xl bg-gradient-to-r from-blue-500 to-teal-400 text-white font-semibold text-lg"
            >
              Next
            </button>
          </div>
        );
        case 'palm_up_rules':
  return (
    <div className="space-y-6 text-center px-4 pt-16">
      <h1 className="text-2xl font-bold text-gray-100">
        Take 2 more photos, palm-up
      </h1>

      <p className="text-gray-300">
        Take one photo of your Left hand and one of your Right hand.
      </p>

      <p className="text-sm text-gray-400">
        Flip your hand palm-up and slightly curl your fingers so we can see the underside of your nails.
      </p>

      <img
        src="/palm_up_example.jpg"
        alt="Palm-up hand photo"
        className="rounded-xl"
      />

      <button
        onClick={() => setCurrentScreen('capture_ready')}
        className="w-full py-4 rounded-xl bg-gradient-to-r from-blue-500 to-teal-400 text-white font-semibold text-lg"
      >
        Next
      </button>
    </div>
  );
        case 'capture_ready':
  return (
    <CaptureReady
      onNext={() => setCurrentScreen('photo_left_thumb')}
    />
  );
      case 'photo_left_thumb':
      case 'photo_left_index':
      case 'photo_left_middle':
      case 'photo_left_ring':
      case 'photo_left_pinky':
      case 'photo_right_thumb':
      case 'photo_right_index':
      case 'photo_right_middle':
      case 'photo_right_ring':
      case 'photo_right_pinky':
      case 'photo_left_palm_up':
      case 'photo_right_palm_up':
        return (
          <PhotoCapture
            screenName={currentScreen}
            photoIndex={currentPhotoIndex}
            onPhotoTaken={handlePhotoTaken}
          />
        );
      case 'photo_preview_left_thumb':
      case 'photo_preview_left_index':
      case 'photo_preview_left_middle':
      case 'photo_preview_left_ring':
      case 'photo_preview_left_pinky':
      case 'photo_preview_right_thumb':
      case 'photo_preview_right_index':
      case 'photo_preview_right_middle':
      case 'photo_preview_right_ring':
      case 'photo_preview_right_pinky':
      case 'photo_preview_left_palm_up':
      case 'photo_preview_right_palm_up':
        return (
          <PhotoPreview
            photoIndex={previewPhotoIndex ?? 0}
            photoData={photos[previewPhotoIndex ?? 0]}
            onUsePhoto={handleUsePhoto}
            onRetake={handleRetakePhoto}
            isUploading={isUploading}
            uploadSuccess={uploadSuccess}
            errorMessage={uploadError}
          />
        );
  

      case 'capture_confirm':
        return <CaptureConfirm photos={photos} onSubmit={handleSubmit} />;
      case 'processing':
        return <ProcessingScreen />;
      case 'success':
        return <SuccessScreen />;
      case 'error':
        return <ErrorScreen onRetry={() => setCurrentScreen('capture_entry')} />;
      default:
              return (
        <CaptureEntry
          onStart={handleStart}
          isStarting={isStarting}
          errorMessage={startError}
        />
      );
    }
  };

  if (MAINTENANCE_MODE) {
    return (
  <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-blue-950 flex items-center justify-center px-6">
    <div className="max-w-xl text-center">
      <div className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-sm text-white/70 mb-6">
        Handsy
      </div>

      <h1 className="text-4xl md:text-5xl font-semibold tracking-tight text-white mb-4">
        We’re fine-tuning our system to deliver the most accurate fit
      </h1>

      <p className="text-lg text-white/70 leading-relaxed">
      
        Back very soon.
      </p>
    </div>
  </main>
);
  }

  return renderScreen();
}