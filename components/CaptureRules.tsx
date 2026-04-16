interface CaptureRulesProps {
  onNext: () => void;
}

export default function CaptureRules({ onNext }: CaptureRulesProps) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl sm:text-3xl font-bold text-gray-100">Before you start</h1>
      
      <p className="text-gray-300 mt-4">
  You’ll need:
</p>

<ul className="text-gray-200 space-y-2 mt-4 mb-8">
  <li>• A plain white sheet of paper (8.5 × 11)</li>
  <li>• A credit, debit, or loyalty card</li>
</ul>

      <button
        onClick={onNext}
        className="w-full bg-gradient-to-r from-blue-600 to-cyan-600 text-white py-2.5 px-4 rounded-lg font-semibold text-base hover:from-blue-500 hover:to-cyan-500 transition-all duration-200 shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 transform hover:scale-[1.02] active:scale-[0.98]"
      >
        Got it
      </button>
    </div>
  );
}

