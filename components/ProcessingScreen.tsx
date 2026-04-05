'use client';

import { useState, useEffect } from 'react';

export default function ProcessingScreen() {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    // Simulate progress from 0% to 100% over 3 seconds
    const duration = 3000; // 3 seconds
    const interval = 50; // Update every 50ms
    const increment = 100 / (duration / interval);
    
    let currentProgress = 0;
    
    const progressInterval = setInterval(() => {
      currentProgress += increment;
      
      if (currentProgress >= 100) {
        setProgress(100);
        clearInterval(progressInterval);
      } else {
        setProgress(Math.min(currentProgress, 99)); // Cap at 99% until complete
      }
    }, interval);

    return () => clearInterval(progressInterval);
  }, []);

  return (
    <div className="space-y-6 text-center">
      <div className="flex justify-center">
        <div className="relative">
          <div className="absolute inset-0 bg-gradient-to-r from-blue-500 to-cyan-500 rounded-full blur-2xl opacity-30 animate-pulse" />
          <div className="relative w-20 h-20 rounded-full bg-gradient-to-br from-blue-500/20 to-cyan-500/20 border-2 border-blue-500/50 flex items-center justify-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-400 border-t-transparent"></div>
          </div>
        </div>
      </div>
      
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-100 mb-2">Processing your photos</h1>
        <p className="text-base text-gray-300 max-w-md mx-auto">
          Please wait while we upload and process your photos. This may take a few moments.
        </p>
      </div>

      <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-4 border border-gray-700/50 max-w-md mx-auto">
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-300 font-medium">Uploading photos...</span>
            <span className="text-blue-400 font-semibold">{Math.round(progress)}%</span>
          </div>
          <div className="w-full bg-gray-700/50 rounded-full h-2 overflow-hidden">
            <div 
              className="h-full bg-gradient-to-r from-blue-500 to-cyan-500 rounded-full transition-all duration-300 ease-out"
              style={{ width: `${progress}%` }}
            ></div>
          </div>
          <div className="text-xs text-gray-400">
            {progress < 30 && 'Preparing files...'}
            {progress >= 30 && progress < 60 && 'Uploading images...'}
            {progress >= 60 && progress < 90 && 'Processing data...'}
            {progress >= 90 && progress < 100 && 'Finalizing...'}
            {progress >= 100 && 'Complete!'}
          </div>
        </div>
      </div>
    </div>
  );
}
