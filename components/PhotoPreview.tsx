import { PhotoData } from '@/app/page';

interface PhotoPreviewProps {
  photoIndex: number;
  photoData: PhotoData;
  onUsePhoto: () => void;
  onRetake: () => void;
  isUploading?: boolean;
  uploadSuccess?: boolean;
  errorMessage?: string | null;
}

export default function PhotoPreview({
  photoIndex,
  photoData,
  onUsePhoto,
  onRetake,
  isUploading = false,
  uploadSuccess = false,
  errorMessage,
}: PhotoPreviewProps) {
  const photoNames = [
  'Left Thumb',
  'Left Index',
  'Left Middle',
  'Left Ring',
  'Left Pinky',
  'Right Thumb',
  'Right Index',
  'Right Middle',
  'Right Ring',
  'Right Pinky',
];
  
  return (
    <div className="space-y-4">
      <div className="text-center">
        <p className="text-gray-400 text-sm">
          Make sure your hand and the card are clearly visible.
        </p>
      </div>

      {errorMessage && (
        <div className="bg-red-900/30 border border-red-500/50 text-red-200 px-4 py-3 rounded-lg backdrop-blur-sm text-sm">
          {errorMessage}
        </div>
      )}

      {photoData.preview && (
        <div className="relative w-full aspect-square bg-gray-800/50 backdrop-blur-sm rounded-xl overflow-hidden border-2 border-gray-700/50 shadow-2xl">
          <img
            src={photoData.preview}
            alt={`Photo ${photoIndex + 1} preview`}
            className="w-full h-full object-contain"
          />
          
          {/* Success Overlay */}
          {uploadSuccess && (
            <div className="absolute inset-0 bg-gray-900/95 backdrop-blur-sm flex flex-col items-center justify-center animate-[fadeIn_0.3s_ease-out]">
              <div className="text-center space-y-4">
                <div className="flex justify-center">
                  <div className="relative">
                    <div className="absolute inset-0 bg-gradient-to-r from-green-500 to-emerald-500 rounded-full blur-2xl opacity-50 animate-pulse" />
                    <div className="relative w-20 h-20 rounded-full bg-gradient-to-br from-green-500/20 to-emerald-500/20 border-2 border-green-500/50 flex items-center justify-center">
                      <svg className="w-10 h-10 text-green-400 animate-[scaleIn_0.3s_ease-out]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                  </div>
                </div>
                
                <div>
                  <h2 className="text-2xl font-bold text-gradient mb-1">Uploaded!</h2>
                  <p className="text-sm text-gray-300">
                    {photoNames[photoIndex]} photo uploaded successfully
                  </p>
                </div>

                <div className="flex items-center justify-center space-x-2 text-sm text-gray-400">
                  <div className="animate-pulse">
                    <svg className="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <span>
                    {photoIndex < 9 ? 'Moving to next photo...' : 'Preparing final review...'}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="space-y-2">
        <button
          onClick={onUsePhoto}
          disabled={isUploading || uploadSuccess}
          className={`w-full bg-gradient-to-r from-blue-600 to-cyan-600 text-white py-2.5 px-4 rounded-lg font-semibold text-base transition-all duration-200 shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 transform flex items-center justify-center gap-2 ${
            isUploading || uploadSuccess
              ? 'opacity-70 cursor-not-allowed'
              : 'hover:from-blue-500 hover:to-cyan-500 hover:scale-[1.02] active:scale-[0.98]'
          }`}
        >
          {isUploading ? (
            <>
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                />
              </svg>
              Uploading…
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Use photo
            </>
          )}
        </button>
        <button
          onClick={onRetake}
          disabled={isUploading || uploadSuccess}
          className="w-full bg-gray-800/50 text-gray-300 py-2 px-4 rounded-lg font-semibold text-sm hover:bg-gray-700/50 border border-gray-700/50 transition-all duration-200 transform hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Choose another photo
        </button>
      </div>
    </div>
  );
}