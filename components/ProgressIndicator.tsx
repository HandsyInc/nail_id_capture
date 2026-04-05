interface ProgressIndicatorProps {
  currentPhoto: number;
  totalPhotos: number;
  isUploading?: boolean;
  header?: string;
}

export default function ProgressIndicator({
  currentPhoto,
  totalPhotos,
  isUploading = false,
  header,
}: ProgressIndicatorProps) {
  const progress = (currentPhoto / totalPhotos) * 100;
  
  return (
    <div className="bg-gray-800/50 backdrop-blur-sm border-b border-gray-700/50 py-3 sticky top-0 z-10">
      <div className="container mx-auto px-4 max-w-2xl">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-gradient-to-br from-blue-500/20 to-cyan-500/20 border border-blue-500/30">
              <span className="text-lg">📸</span>
            </div>
            <div>
              <div className="text-xs font-semibold text-gray-400 mb-0.5">
                Photo {currentPhoto} of {totalPhotos}
              </div>
              {header && (
                <h1 className="text-lg sm:text-xl font-bold text-gray-100">{header}</h1>
              )}
            </div>
          </div>
          {isUploading && (
            <span className="text-xs text-blue-400 animate-pulse">Uploading photo…</span>
          )}
        </div>
        <div className="w-full bg-gray-700/50 rounded-full h-1 overflow-hidden">
          <div 
            className="h-full bg-gradient-to-r from-blue-500 to-cyan-500 rounded-full transition-all duration-300 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  );
}

