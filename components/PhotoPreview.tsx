import { PhotoData } from '@/app/page';

interface PhotoPreviewProps {
  photoIndex: number;
  photoData: PhotoData;
  onUsePhoto: () => void;
  onRetake: () => void;
}

export default function PhotoPreview({
  photoIndex,
  photoData,
  onUsePhoto,
  onRetake,
}: PhotoPreviewProps) {
  return (
    <div className="space-y-4">
      <div className="text-center">
        <p className="text-gray-400 text-sm">
          Make sure your hand and the card are clearly visible.
        </p>
      </div>

      {photoData.preview && (
        <div className="w-full aspect-square bg-gray-800/50 backdrop-blur-sm rounded-xl overflow-hidden border-2 border-gray-700/50 shadow-2xl">
          <img
            src={photoData.preview}
            alt={`Photo ${photoIndex + 1} preview`}
            className="w-full h-full object-contain"
          />
        </div>
      )}

      <div className="space-y-2">
        <button
          onClick={onUsePhoto}
          className="w-full bg-gradient-to-r from-blue-600 to-cyan-600 text-white py-2.5 px-4 rounded-lg font-semibold text-base hover:from-blue-500 hover:to-cyan-500 transition-all duration-200 shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 transform hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Use photo
        </button>
        <button
          onClick={onRetake}
          className="w-full bg-gray-800/50 text-gray-300 py-2 px-4 rounded-lg font-semibold text-sm hover:bg-gray-700/50 border border-gray-700/50 transition-all duration-200 transform hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Retake photo
        </button>
      </div>
    </div>
  );
}

