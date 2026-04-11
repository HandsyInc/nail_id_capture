'use client';

import { useEffect, useMemo, useState } from 'react';
import CaptureEntry from '@/components/CaptureEntry';
import CaptureRules from '@/components/CaptureRules';
import CameraRules from '@/components/CameraRules';
import PhotoCapture from '@/components/PhotoCapture';
import PhotoPreview from '@/components/PhotoPreview';
import CaptureConfirm from '@/components/CaptureConfirm';
import SuccessScreen from '@/components/SuccessScreen';
import ErrorScreen from '@/components/ErrorScreen';
import ProcessingScreen from '@/components/ProcessingScreen';
import ProgressIndicator from '@/components/ProgressIndicator';

export type ScreenName =
  | 'capture_entry'
  | 'user_info'
  | 'capture_rules'
  | 'camera_rules'
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
  | 'capture_confirm'
  | 'processing'
  | 'success'
  | 'error';

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

async function getImageOrientationFromDataUrl(dataUrl: string): Promise<'portrait' | 'landscape'> {
  const img = new Image();
  const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error('Unable to read image dimensions.'));
    img.src = dataUrl;
  });

  return dims.h >= dims.w ? 'portrait' : 'landscape';
}

function validateImageBeforeUpload(file: File, preview: string) {
  const allowedTypes = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
  if (!file.type || !allowedTypes.has(file.type)) {
    throw new Error('Unsupported file type. Please use a JPG, PNG, or WebP image.');
  }

  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('File size must be less than 10MB.');
  }

  if (!preview.startsWith('data:image/')) {
    throw new Error('Invalid image data.');
  }
}

function dataUrlToBase64(dataUrl: string): string {
  const parts = dataUrl.split(',');
  if (parts.length < 2) throw new Error('Invalid image encoding.');
  const base64 = parts[1];
  if (!base64) throw new Error('Invalid image encoding.');
  return base64;
}

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
    default:
      return { hand: 'left', image_type: 'top_down', finger: 'thumb' };
  }
}

export default function Home() {
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
]);
  const [currentPhotoIndex, setCurrentPhotoIndex] = useState(0);
  const [previewPhotoIndex, setPreviewPhotoIndex] = useState<number | null>(null);

  const [projectId, setProjectId] = useState<string | null>(null);
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

  const showProgress = currentScreen.startsWith('photo_');

  const getCurrentPhotoNumber = () => {
    if (currentScreen.startsWith('photo_preview_') && previewPhotoIndex !== null) {
      return previewPhotoIndex + 1;
    }
    return currentPhotoIndex + 1;
  };

  const getHeaderText = (): string | undefined => {
    const headers: Record<ScreenName, string | undefined> = {
      capture_entry: undefined,
      capture_rules: undefined,
      camera_rules: undefined,
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
  ];

  setCurrentScreen(previewScreens[currentPhotoIndex]);
};

  const handleUsePhoto = async () => {
    if (previewPhotoIndex !== null) {
      setUploadError(null);

      const photo = photos[previewPhotoIndex];
      if (!photo?.file || !photo.preview) {
        setUploadError('Missing image data. Please retake the photo.');
        return;
      }

      if (!projectId) {
        setUploadError('Project is not initialized yet. Please go back and start the scan again.');
        return;
      }

      setIsUploading(true);
      try {
        // Client-side validations before upload
        validateImageBeforeUpload(photo.file, photo.preview);
        const orientation = await getImageOrientationFromDataUrl(photo.preview);

        // Orientation validation
        if (orientation !== 'portrait') {
          throw new Error('Please use portrait orientation. Rotate your phone and retake the photo.');
        }

        const base = getApiBase();
        const url = new URL('/api/v1/upload', base).toString();

        const meta = getUploadMetadataForPhotoIndex(previewPhotoIndex);
        const body: UploadRequest = {
          image_data: dataUrlToBase64(photo.preview),
          image_metadata: {
            project_id: projectId,
            image_type: meta.image_type,
            hand: meta.hand,
            finger: meta.finger,
            orientation,
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
          throw new Error(details ?? `Failed to upload photo (HTTP ${res.status}).`);
        }

        const data = (await res.json()) as UploadResponse;

        // Save returned image_id when available
        setPhotos((prev) => {
          const next = [...prev];
          next[previewPhotoIndex] = {
            ...next[previewPhotoIndex],
            imageId: data?.image_id ?? next[previewPhotoIndex].imageId,
          };
          return next;
        });

        // Show success state on preview
        setUploadSuccess(true);
        
        // Auto-continue after 2.5 seconds
        setTimeout(() => {
          // Move to next photo or confirmation
         if (previewPhotoIndex < 9) {
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
  ];

  setCurrentScreen(nextPhotoScreens[nextPhotoIndex]);
} else {
  setCurrentScreen('capture_confirm');
}
          setPreviewPhotoIndex(null);
          setUploadSuccess(false);
        }, 2500);
      } catch (error: any) {
  console.error('Submission failed:', error);
  alert(`Submission failed: ${error?.message || error}`);
  setCurrentScreen('capture_confirm');
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
  ];
      setCurrentScreen(photoScreens[previewPhotoIndex]);
      setPreviewPhotoIndex(null);
    }
  };

  const handleSubmit = async () => {
  if (!canSubmit || !projectId) return;

  setCurrentScreen('processing');

  try {
    const cleanedPhotos = photos.map((p: any) => ({
  ...p,
  data: (
    p.data ||
    p.dataUrl ||
    p.dataURL ||
    ''
  ).split(',')[1] || (
    p.data ||
    p.dataUrl ||
    p.dataURL ||
    ''
  ),
}));

    const response = await fetch('/api/submit-photos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        email,
        photos: cleanedPhotos,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to submit photos: ${errorText}`);
    }

    setCurrentScreen('success');
  } catch (error: any) {
    console.error('Submission failed:', error);
    alert(`Submission failed: ${error?.message || error}`);
    setCurrentScreen('capture_confirm');
  }
};

  const renderScreen = () => {
    switch (currentScreen) {
      case 'capture_entry':
        return <CaptureEntry onStart={handleStart} isStarting={isStarting} errorMessage={startError} />;
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
        <p>• A credit, debit, or loyalty card</p>
      </div>

      <button
        onClick={() => setCurrentScreen('camera_rules')}
        className="w-full py-4 rounded-xl bg-gradient-to-r from-blue-500 to-teal-400 text-white font-semibold text-lg"
      >
        I’m ready
      </button>
    </div>
  );
      case 'camera_rules':
        return (
    <div className="space-y-6 text-center">
      <h1 className="text-2xl font-bold text-gray-100">
        Here’s exactly how your photo should look
      </h1>

      <img
        src="/example.jpg"
        alt="Example nail photo"
        className="rounded-xl"
      />

      <div className="space-y-2 text-gray-300 text-sm">
        <p>• One finger at a time</p>
        <p>• Place the card flat on the paper, right beside your finger</p>
        <p>• Hold your phone directly above your finger, parallel to the table (not tilted)</p>
        <p>• Make sure both your finger and the card are fully visible on screen</p>
        <p>• Let the white paper fill the entire screen, edge to edge</p>
      </div>

      <button
        onClick={() => setCurrentScreen('photo_left_thumb')}
        className="w-full py-4 rounded-xl bg-gradient-to-r from-blue-500 to-teal-400 text-white font-semibold text-lg"
      >
        Start taking photos
      </button>
    </div>
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
        return <CaptureEntry onStart={handleStart} isStarting={isStarting} errorMessage={startError} />;
    }
  };

  return (
    <main className="min-h-screen">
      {showProgress && (
        <ProgressIndicator
          currentPhoto={getCurrentPhotoNumber()}
          totalPhotos={10}
          header={getHeaderText()}
          isUploading={isUploading}
        />
      )}
      <div className="container mx-auto px-4 py-6 sm:py-8 max-w-2xl">
        {renderScreen()}
      </div>
    </main>
  );
}

