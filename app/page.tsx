'use client';

import { useState } from 'react';
import CaptureEntry from '@/components/CaptureEntry';
import CaptureRules from '@/components/CaptureRules';
import CameraRules from '@/components/CameraRules';
import PhotoCapture from '@/components/PhotoCapture';
import PhotoPreview from '@/components/PhotoPreview';
import CaptureConfirm from '@/components/CaptureConfirm';
import SuccessScreen from '@/components/SuccessScreen';
import ErrorScreen from '@/components/ErrorScreen';
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
  | 'success'
  | 'error';

export type PhotoData = {
  file: File | null;
  preview: string | null;
};

export default function Home() {
  const [currentScreen, setCurrentScreen] = useState<ScreenName>('capture_entry');
  const [photos, setPhotos] = useState<PhotoData[]>([
    { file: null, preview: null },
    { file: null, preview: null },
    { file: null, preview: null },
    { file: null, preview: null },
  ]);
  const [currentPhotoIndex, setCurrentPhotoIndex] = useState(0);
  const [previewPhotoIndex, setPreviewPhotoIndex] = useState<number | null>(null);

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
      photo_preview: 'Review photo',
      capture_entry: undefined,
      capture_rules: undefined,
      camera_rules: undefined,
      capture_confirm: undefined,
      success: undefined,
      error: undefined,
    };
    return headers[currentScreen];
  };

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

  const handlePhotoTaken = (file: File, preview: string) => {
    const newPhotos = [...photos];
    newPhotos[currentPhotoIndex] = { file, preview };
    setPhotos(newPhotos);
    setPreviewPhotoIndex(currentPhotoIndex);
    setCurrentScreen('photo_preview');
  };

  const handleUsePhoto = () => {
    if (previewPhotoIndex !== null) {
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
    }
  };

  const handleRetakePhoto = () => {
    if (previewPhotoIndex !== null) {
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
    // Placeholder for Week 2 - API integration
    setCurrentScreen('success');
  };

  const renderScreen = () => {
    switch (currentScreen) {
      case 'capture_entry':
        return <CaptureEntry onNext={handleNext} />;
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
          />
        );
      case 'capture_confirm':
        return <CaptureConfirm photos={photos} onSubmit={handleSubmit} />;
      case 'success':
        return <SuccessScreen />;
      case 'error':
        return <ErrorScreen onRetry={() => setCurrentScreen('capture_entry')} />;
      default:
        return <CaptureEntry onNext={handleNext} />;
    }
  };

  return (
    <main className="min-h-screen">
      {showProgress && (
        <ProgressIndicator
          currentPhoto={getCurrentPhotoNumber()}
          totalPhotos={4}
          header={getHeaderText()}
        />
      )}
      <div className="container mx-auto px-4 py-6 sm:py-8 max-w-2xl">
        {renderScreen()}
      </div>
    </main>
  );
}

