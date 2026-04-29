interface CaptureReadyProps {
  onNext: () => void;
}

export default function CaptureReady({ onNext }: CaptureReadyProps) {
  return (
    <div className="space-y-6 text-center pt-16 px-4">
      <h1 className="text-2xl sm:text-3xl font-bold text-gray-100">
        Take your photos first
      </h1>

      <p className="text-gray-300 max-w-md mx-auto">
        Leave this page, take all 12 photos on your phone, then come back here when you’re ready to upload them.
      </p>

      <p className="text-sm text-gray-400 max-w-md mx-auto">
        Take them in order: Left hand (thumb → pinky), then Right hand (thumb → pinky).
        Followed by each hand, palm up.
      </p>

      <button
        onClick={onNext}
        className="w-full bg-gradient-to-r from-blue-600 to-cyan-600 text-white py-2.5 px-4 rounded-lg font-semibold text-base"
      >
        I’m ready
      </button>
    </div>
  );
}