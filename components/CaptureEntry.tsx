interface CaptureEntryProps {
  onStart: () => void;
  isStarting?: boolean;
  errorMessage?: string | null;
}

export default function CaptureEntry({
  onStart,
  isStarting = false,
  errorMessage,
}: CaptureEntryProps) {
  return (
    <div className="space-y-4 animate-fade-in">
      <div className="text-center space-y-2">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-gradient-to-br from-blue-500/20 to-cyan-500/20 border border-blue-500/30 mb-2">
          <span className="text-3xl">💅</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold text-gradient">
          Create Your Nail ID
        </h1>
      </div>
      
      <div className="space-y-2 text-gray-300 text-base leading-relaxed">
        <p className="text-center">
          You&apos;ll take a few photos to create your Nail ID — a one-time scan for perfect fit.
        </p>
        <div className="flex items-center justify-center gap-2 text-gray-400 text-sm">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>This takes about 2–3 minutes.</span>
        </div>
        <p className="text-center text-gray-400 text-sm">Small retakes are normal.</p>
      </div>

      {errorMessage && (
        <div className="bg-red-900/30 border border-red-500/50 text-red-200 px-4 py-3 rounded-lg backdrop-blur-sm text-sm">
          {errorMessage}
        </div>
      )}

      <button
        onClick={onStart}
        disabled={isStarting}
        className={`w-full bg-gradient-to-r from-blue-600 to-cyan-600 text-white py-2.5 px-4 rounded-lg font-semibold text-base transition-all duration-200 shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 transform flex items-center justify-center gap-2 ${
          isStarting
            ? 'opacity-70 cursor-not-allowed'
            : 'hover:from-blue-500 hover:to-cyan-500 hover:scale-[1.02] active:scale-[0.98]'
        }`}
      >
        {isStarting && (
          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
            />
          </svg>
        )}
        {isStarting ? 'Starting…' : 'Start Scan'}
      </button>
    </div>
  );
}

