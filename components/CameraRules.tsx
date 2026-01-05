interface CameraRulesProps {
  onNext: () => void;
}

export default function CameraRules({ onNext }: CameraRulesProps) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl sm:text-3xl font-bold text-gray-100">Camera setup</h1>
      
      <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-4 border border-gray-700/50">
        <ul className="space-y-2 text-gray-300 text-sm">
          <li className="flex items-start gap-2">
            <span className="text-blue-400 mt-0.5">•</span>
            <span>Use your phone's built-in camera</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-blue-400 mt-0.5">•</span>
            <span>Don't use filters or screenshots</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-blue-400 mt-0.5">•</span>
            <span>Don't use social apps</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-blue-400 mt-0.5">•</span>
            <span>Avoid wide-angle distortion if possible</span>
          </li>
        </ul>
      </div>

      <button
        onClick={onNext}
        className="w-full bg-gradient-to-r from-blue-600 to-cyan-600 text-white py-2.5 px-4 rounded-lg font-semibold text-base hover:from-blue-500 hover:to-cyan-500 transition-all duration-200 shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 transform hover:scale-[1.02] active:scale-[0.98]"
      >
        Continue
      </button>
    </div>
  );
}

