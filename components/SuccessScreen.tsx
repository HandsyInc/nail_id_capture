export default function SuccessScreen() {
  return (
    <div className="space-y-4 text-center">
      <div className="flex justify-center">
        <div className="relative">
          <div className="absolute inset-0 bg-gradient-to-r from-blue-500 to-cyan-500 rounded-full blur-2xl opacity-50 animate-pulse" />
          <div className="relative w-16 h-16 rounded-full bg-gradient-to-br from-blue-500/20 to-cyan-500/20 border-2 border-blue-500/50 flex items-center justify-center">
            <svg className="w-8 h-8 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          </div>
        </div>
      </div>
      
      <div>
        <h1 className="text-3xl sm:text-4xl font-bold text-gradient mb-2">Photos submitted</h1>
        <p className="text-base text-gray-300 max-w-md mx-auto">
          We&apos;received your photos and are creating your Nail ID!
        </p>
      </div>

      <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-4 border border-gray-700/50 max-w-md mx-auto">
        <p className="text-xs text-gray-400">
          You&apos;ll receive a confirmation email shortly.
        </p>
      </div>
    </div>
  );
}

