'use client';

import { useRef, useState } from 'react';
import { ScreenName } from '@/app/page';

interface PhotoCaptureProps {
  screenName: ScreenName;
  photoIndex: number;
  onPhotoTaken: (file: File, preview: string) => void;
}

/**
 * Per-finger instructional copy.
 *
 * Currently only `header` is rendered. `bodyCopy` and `helperText` are
 * preserved here so the wording is available for re-use when a
 * guided live-preview overlay is introduced later in Phase 1.
 */
const photoConfigs = {
  photo_left_thumb: {
    header: 'LEFT THUMB',
    bodyCopy: [
      'Place ONLY your left thumb on a white piece of paper',
      'Let the rest of your hand hang off the edge of the table',
      'Place a card vertically next to your finger',
      "Hold your phone directly above your finger in a top-down (bird’s-eye) view",
      'Tap your nail on screen to focus before taking the photo',
    ],
    helperText: 'The white paper should fill the frame. Keep the card fully visible.',
  },

  photo_left_index: {
    header: 'LEFT INDEX',
    bodyCopy: [
      'Place ONLY your index finger on the paper',
      'Keep finger relaxed — do not press down',
      'Place the card vertically next to your finger',
      "Hold your phone directly above your finger (top-down view)",
      'Tap to focus on the nail',
    ],
    helperText: 'Keep the camera parallel to the paper — do not tilt.',
  },

  photo_left_middle: {
    header: 'LEFT MIDDLE',
    bodyCopy: [
      'Place ONLY your middle finger on the paper',
      'Let other fingers hang off the edge',
      'Keep the card vertical next to your finger',
      "Hold your phone directly above your finger (top-down view)",
      'Tap to focus on the nail',
    ],
    helperText: 'Avoid shadows and keep lighting even.',
  },

  photo_left_ring: {
    header: 'LEFT RING',
    bodyCopy: [
      'Place ONLY your ring finger on the paper',
      'Keep finger relaxed — do not press',
      'Place the card vertically next to your finger',
      "Hold your phone directly above your finger (top-down view)",
      'Tap to focus on the nail',
    ],
    helperText: 'Keep the camera flat and steady — this finger can be tricky.',
  },

  photo_left_pinky: {
    header: 'LEFT PINKY',
    bodyCopy: [
      'Place ONLY your pinky on the paper',
      'Keep the finger straight and relaxed',
      'Place the card vertically next to your finger',
      "Hold your phone directly above your finger (top-down view)",
      'Tap to focus before capturing',
    ],
    helperText: 'Make sure the nail is sharp and clearly visible.',
  },

  photo_right_thumb: {
    header: 'RIGHT THUMB',
    bodyCopy: [
      'Switch hands — place ONLY your right thumb on the paper',
      'Let the rest of your hand hang off the edge',
      'Place the card vertically next to your finger',
      "Hold your phone directly above your finger (top-down view)",
      'Tap to focus on the nail',
    ],
    helperText: 'Keep the camera parallel to the paper — do not tilt.',
  },

  photo_right_index: {
    header: 'RIGHT INDEX',
    bodyCopy: [
      'Place ONLY your index finger on the paper',
      'Keep finger relaxed',
      'Place the card vertically next to your finger',
      "Hold your phone directly above your finger (top-down view)",
      'Tap to focus',
    ],
    helperText: 'Match the positioning from your left hand.',
  },

  photo_right_middle: {
    header: 'RIGHT MIDDLE',
    bodyCopy: [
      'Place ONLY your middle finger on the paper',
      'Keep lighting even',
      'Place the card vertically next to your finger',
      "Hold your phone directly above your finger (top-down view)",
      'Tap to focus',
    ],
    helperText: 'Keep the camera flat — avoid tilting.',
  },

  photo_right_ring: {
    header: 'RIGHT RING',
    bodyCopy: [
      'Place ONLY your ring finger on the paper',
      'Relax finger — do not press',
      'Place the card vertically next to your finger',
      "Hold your phone directly above your finger (top-down view)",
      'Tap to focus',
    ],
    helperText: 'Take a moment here — accuracy matters.',
  },

  photo_right_pinky: {
    header: 'RIGHT PINKY',
    bodyCopy: [
      'Place ONLY your pinky on the paper',
      'Keep finger straight',
      'Place the card vertically next to your finger',
      "Hold your phone directly above your finger (top-down view)",
      'Tap to focus before capture',
    ],
    helperText: 'Last one — make sure it’s sharp and clear.',
  },

  photo_left_palm_up: {
    header: 'LEFT PALM-UP',
    bodyCopy: [
      'Flip your hand palm-up',
      'Slightly curl your fingers so we can see the underside of your nails',
      'Keep your hand relaxed',
      'Hold your phone directly above your hand',
      'Tap to focus before taking the photo',
    ],
    helperText: 'Make sure all nails are visible from underneath.',
  },

  photo_right_palm_up: {
    header: 'RIGHT PALM-UP',
    bodyCopy: [
      'Flip your hand palm-up',
      'Slightly curl your fingers so we can see the underside of your nails',
      'Keep your hand relaxed',
      'Hold your phone directly above your hand',
      'Tap to focus before taking the photo',
    ],
    helperText: 'Make sure all nails are visible from underneath.',
  },
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * PhotoCapture — file-upload entry point for a single finger photo.
 *
 * The previous live-camera code path was removed because it
 * (a) inherited barrel/lens distortion from getUserMedia without any
 *     correction layer and was already disabled in production, and
 * (b) cropped captured frames to a hard-coded 8.5/11 aspect ratio in
 *     the old `capturePhoto` function, silently discarding pixels and
 *     potentially cropping the reference card out of frame.
 *
 * Removing it eliminates a dormant path that could re-enter the
 * measurement pipeline. A guided live-preview overlay will be
 * re-introduced in a later Phase 1 increment after the bounded
 * EXIF-normalization fix is verified.
 *
 * This component now only accepts a file via the native file picker,
 * does basic type/size validation, and hands the file to the parent.
 * EXIF orientation normalization happens at upload time in app/page.tsx
 * so the geometry-safety boundary is concentrated in one place during
 * this bounded test.
 */
export default function PhotoCapture({
  screenName,
  photoIndex: _photoIndex,
  onPhotoTaken,
}: PhotoCaptureProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const config = photoConfigs[screenName as keyof typeof photoConfigs];

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0];

    // Reset value so re-selecting the same file still fires the change event.
    input.value = '';

    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setError('Please select an image file.');
      return;
    }

    if (file.size > MAX_IMAGE_BYTES) {
      setError('File size must be less than 10MB.');
      return;
    }

    setError(null);

    const reader = new FileReader();
    reader.onloadend = () => {
      const preview = reader.result as string;
      onPhotoTaken(file, preview);
    };
    reader.onerror = () => {
      setError('Could not read the photo. Please try again.');
    };
    reader.readAsDataURL(file);
  };

  if (!config) {
    return (
      <div className="text-center py-8">
        <div className="text-red-400 text-lg">Error: Invalid photo screen</div>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-blue-950 flex items-center justify-center px-6">
      <div className="w-full max-w-md text-center">
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-white mb-4">
          {config.header}
        </h1>

        <div className="mb-8 space-y-1">
          <p className="text-white text-base font-medium">
            Upload your {config.header.toLowerCase()} photo
          </p>
          <p className="text-white/80 text-sm">
            Choose the matching photo from your library
          </p>
        </div>

        {error && (
          <div className="mb-6 bg-red-900/30 border border-red-500/50 text-red-200 px-4 py-3 rounded-lg backdrop-blur-sm text-sm">
            {error}
          </div>
        )}

        <label className="inline-flex cursor-pointer items-center justify-center rounded-xl bg-blue-600 px-6 py-3 text-white font-medium hover:bg-blue-500">
          Choose Photo
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileSelect}
          />
        </label>
      </div>
    </main>
  );
}
