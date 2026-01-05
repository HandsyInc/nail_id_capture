interface ErrorScreenProps {
  onRetry: () => void;
  errorMessage?: string;
}

export default function ErrorScreen({ onRetry, errorMessage }: ErrorScreenProps) {
  return (
    <div className="space-y-4">
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-red-900/20 border-2 border-red-500/30 mb-2">
          <svg className="w-7 h-7 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-100">Something went wrong</h1>
      </div>
      
      {errorMessage ? (
        <div className="bg-red-900/30 border border-red-500/50 text-red-200 px-4 py-3 rounded-lg backdrop-blur-sm text-sm">
          {errorMessage}
        </div>
      ) : (
        <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-4 border border-gray-700/50">
          <p className="text-gray-300 text-center text-sm">
            We encountered an error while processing your photos. Please try again.
          </p>
        </div>
      )}

      <button
        onClick={onRetry}
        className="w-full bg-gradient-to-r from-blue-600 to-cyan-600 text-white py-2.5 px-4 rounded-lg font-semibold text-base hover:from-blue-500 hover:to-cyan-500 transition-all duration-200 shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 transform hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-2"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        Try again
      </button>
    </div>
  );
}

