'use client';

import { useState } from 'react';
import { PhotoData } from '@/app/page';
import ImageModal from './ImageModal';

interface CaptureConfirmProps {
  photos: PhotoData[];
  onSubmit: () => void;
}

export default function CaptureConfirm({ photos, onSubmit }: CaptureConfirmProps) {
  const allPhotosReady = photos.every(photo => photo.file !== null);
  const [selectedImage, setSelectedImage] = useState<{ src: string; alt: string } | null>(null);

  return (
    <div className="space-y-4">
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-gradient-to-br from-blue-500/20 to-cyan-500/20 border border-blue-500/30 mb-2">
          <span className="text-xl">✨</span>
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-100 mb-1">Photos ready</h1>
        <p className="text-gray-400 text-sm">
          Tap submit to continue.
        </p>
      </div>

      {/* Photo thumbnails grid */}
      <div className="grid grid-cols-2 gap-3">
        {photos.map((photo, index) => (
          <div
            key={index}
            className="relative aspect-square bg-gray-800/50 backdrop-blur-sm rounded-lg overflow-hidden border-2 border-gray-700/50 shadow-lg cursor-pointer hover:border-blue-500/50 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] group"
            onClick={() => {
              if (photo.preview) {
                setSelectedImage({
                  src: photo.preview,
                  alt: `Photo ${index + 1} - Full size`,
                });
              }
            }}
          >
            {photo.preview ? (
              <>
                <img
                  src={photo.preview}
                  alt={`Photo ${index + 1}`}
                  className="w-full h-full object-cover"
                />
                {/* Overlay hint */}
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                  <div className="bg-black/70 text-white text-xs px-3 py-1.5 rounded-full backdrop-blur-sm flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
                    </svg>
                    Click to enlarge
                  </div>
                </div>
              </>
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-500 bg-gray-800/30">
                <span className="text-xs">Photo {index + 1}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Image Modal */}
      {selectedImage && (
        <ImageModal
          imageSrc={selectedImage.src}
          imageAlt={selectedImage.alt}
          isOpen={!!selectedImage}
          onClose={() => setSelectedImage(null)}
        />
      )}

      <button
        onClick={onSubmit}
        disabled={!allPhotosReady}
        className={`w-full py-2.5 px-4 rounded-lg font-semibold text-base transition-all duration-200 transform ${
          allPhotosReady
            ? 'bg-gradient-to-r from-blue-600 to-cyan-600 text-white hover:from-blue-500 hover:to-cyan-500 shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-2'
            : 'bg-gray-800/30 text-gray-500 cursor-not-allowed border border-gray-700/50'
        }`}
      >
        {allPhotosReady && (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        )}
        Submit photos
      </button>
    </div>
  );
}

