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
  | 'capture_rules'
  | 'camera_rules'
  | 'photo_1_top_down'
  | 'photo_2_forward_lean'
  | 'photo_3_thumb_top_down'
  | 'photo_4_thumb_oblique'
  | 'photo_preview'
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

function getApiBase(): string {
  const base = process.env.API_ENDPOINT;
  if (!base) {
    throw new Error('API endpoint is not configured. Set API_ENDPOINT in your .env file.');
  }
  return base;
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
  const base = {
    hand: 'right',
  };

  switch (photoIndex) {
    case 0:
      return { ...base, image_type: 'top_down', finger: 'index' };
    case 1:
      return { ...base, image_type: 'slight_angle', finger: 'index' };
    case 2:
      return { ...base, image_type: 'thumb_top_down', finger: 'thumb' };
    case 3:
      return { ...base, image_type: 'thumb_angle', finger: 'thumb' };
    default:
      return { ...base, image_type: 'unknown', finger: 'index' };
  }
}

export default function Home() {
  const [currentScreen, setCurrentScreen] = useState<ScreenName>('capture_entry');
  const [photos, setPhotos] = useState<PhotoData[]>([
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

  const showProgress = currentScreen.startsWith('photo_') || currentScreen === 'photo_preview';

  const getCurrentPhotoNumber = () => {
    if (currentScreen === 'photo_preview' && previewPhotoIndex !== null) {
      return previewPhotoIndex + 1;
    }
    return currentPhotoIndex + 1;
  };

  const getHeaderText = (): string | undefined => {
    const headers: Record<ScreenName, string | undefined> = {
      photo_1_top_down: 'Top-Down',
      photo_2_forward_lean: 'Slight Angle',
      photo_3_thumb_top_down: 'Thumb',
      photo_4_thumb_oblique: 'Thumb Angle',
      photo_preview: uploadSuccess ? 'Upload Success' : 'Review photo',
      capture_entry: undefined,
      capture_rules: undefined,
      camera_rules: undefined,
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
      'photo_1_top_down',
      'photo_2_forward_lean',
      'photo_3_thumb_top_down',
      'photo_4_thumb_oblique',
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
        user_name: crypto.randomUUID(),
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
      ]);
      setCurrentPhotoIndex(0);
      setPreviewPhotoIndex(null);

      setCurrentScreen('capture_rules');
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
    setCurrentScreen('photo_preview');
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
          if (previewPhotoIndex < 3) {
            setCurrentPhotoIndex(previewPhotoIndex + 1);
            const nextPhotoScreens: ScreenName[] = [
              'photo_2_forward_lean',
              'photo_3_thumb_top_down',
              'photo_4_thumb_oblique',
            ];
            setCurrentScreen(nextPhotoScreens[previewPhotoIndex]);
          } else {
            setCurrentScreen('capture_confirm');
          }
          setPreviewPhotoIndex(null);
          setUploadSuccess(false);
        }, 2500);
      } catch (err: any) {
        setUploadError(err?.message ?? 'Failed to upload photo.');
      } finally {
        setIsUploading(false);
      }
    }
  };

  const handleRetakePhoto = () => {
    if (previewPhotoIndex !== null) {
      setUploadError(null);
      setUploadSuccess(false);
      const photoScreens: ScreenName[] = [
        'photo_1_top_down',
        'photo_2_forward_lean',
        'photo_3_thumb_top_down',
        'photo_4_thumb_oblique',
      ];
      setCurrentScreen(photoScreens[previewPhotoIndex]);
      setPreviewPhotoIndex(null);
    }
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    if (!projectId) {
      setCurrentScreen('error');
      return;
    }
    // Show processing state
    setCurrentScreen('processing');
    
    // Simulate processing delay (mockup - no actual API call)
    setTimeout(() => {
      setCurrentScreen('success');
    }, 3000); // 3 second delay for demo
  };

  const renderScreen = () => {
    switch (currentScreen) {
      case 'capture_entry':
        return <CaptureEntry onStart={handleStart} isStarting={isStarting} errorMessage={startError} />;
      case 'capture_rules':
        return <CaptureRules onNext={handleNext} />;
      case 'camera_rules':
        return <CameraRules onNext={handleNext} />;
      case 'photo_1_top_down':
      case 'photo_2_forward_lean':
      case 'photo_3_thumb_top_down':
      case 'photo_4_thumb_oblique':
        return (
          <PhotoCapture
            screenName={currentScreen}
            photoIndex={currentPhotoIndex}
            onPhotoTaken={handlePhotoTaken}
          />
        );
      case 'photo_preview':
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
          totalPhotos={4}
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

