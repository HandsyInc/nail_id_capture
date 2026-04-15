'use client';

import { useRef, useState, useEffect } from 'react';
import { ScreenName } from '@/app/page';

interface PhotoCaptureProps {
  screenName: ScreenName;
  photoIndex: number;
  onPhotoTaken: (file: File, preview: string) => void;
}

const photoConfigs = {
  photo_left_thumb: {
    header: 'LEFT THUMB',
    bodyCopy: [
      'Place ONLY your left thumb on a white piece of paper',
      'Let the rest of your hand hang off the edge of the table',
      'Place a card vertically next to your finger',
      "Hold your phone directly above your finger in a top-down (bird’s-eye) view",
      'Tap your nail on screen to focus before taking the photo'
    ],
    helperText: 'The white paper should fill the frame. Keep the card fully visible.'
  },

  photo_left_index: {
    header: 'LEFT INDEX',
    bodyCopy: [
      'Place ONLY your index finger on the paper',
      'Keep finger relaxed — do not press down',
      'Place the card vertically next to your finger',
      "Hold your phone directly above your finger (top-down view)",
      'Tap to focus on the nail'
    ],
    helperText: 'Keep the camera parallel to the paper — do not tilt.'
  },

  photo_left_middle: {
    header: 'LEFT MIDDLE',
    bodyCopy: [
      'Place ONLY your middle finger on the paper',
      'Let other fingers hang off the edge',
      'Keep the card vertical next to your finger',
      "Hold your phone directly above your finger (top-down view)",
      'Tap to focus on the nail'
    ],
    helperText: 'Avoid shadows and keep lighting even.'
  },

  photo_left_ring: {
    header: 'LEFT RING',
    bodyCopy: [
      'Place ONLY your ring finger on the paper',
      'Keep finger relaxed — do not press',
      'Place the card vertically next to your finger',
      "Hold your phone directly above your finger (top-down view)",
      'Tap to focus on the nail'
    ],
    helperText: 'Keep the camera flat and steady — this finger can be tricky.'
  },

  photo_left_pinky: {
    header: 'LEFT PINKY',
    bodyCopy: [
      'Place ONLY your pinky on the paper',
      'Keep the finger straight and relaxed',
      'Place the card vertically next to your finger',
      "Hold your phone directly above your finger (top-down view)",
      'Tap to focus before capturing'
    ],
    helperText: 'Make sure the nail is sharp and clearly visible.'
  },

  photo_right_thumb: {
    header: 'RIGHT THUMB',
    bodyCopy: [
      'Switch hands — place ONLY your right thumb on the paper',
      'Let the rest of your hand hang off the edge',
      'Place the card vertically next to your finger',
      "Hold your phone directly above your finger (top-down view)",
      'Tap to focus on the nail'
    ],
    helperText: 'Keep the camera parallel to the paper — do not tilt.'
  },

  photo_right_index: {
    header: 'RIGHT INDEX',
    bodyCopy: [
      'Place ONLY your index finger on the paper',
      'Keep finger relaxed',
      'Place the card vertically next to your finger',
      "Hold your phone directly above your finger (top-down view)",
      'Tap to focus'
    ],
    helperText: 'Match the positioning from your left hand.'
  },

  photo_right_middle: {
    header: 'RIGHT MIDDLE',
    bodyCopy: [
      'Place ONLY your middle finger on the paper',
      'Keep lighting even',
      'Place the card vertically next to your finger',
      "Hold your phone directly above your finger (top-down view)",
      'Tap to focus'
    ],
    helperText: 'Keep the camera flat — avoid tilting.'
  },

  photo_right_ring: {
    header: 'RIGHT RING',
    bodyCopy: [
      'Place ONLY your ring finger on the paper',
      'Relax finger — do not press',
      'Place the card vertically next to your finger',
      "Hold your phone directly above your finger (top-down view)",
      'Tap to focus'
    ],
    helperText: 'Take a moment here — accuracy matters.'
  },

  photo_right_pinky: {
    header: 'RIGHT PINKY',
    bodyCopy: [
      'Place ONLY your pinky on the paper',
      'Keep finger straight',
      'Place the card vertically next to your finger',
      "Hold your phone directly above your finger (top-down view)",
      'Tap to focus before capture'
    ],
    helperText: 'Last one — make sure it’s sharp and clear.'
  }
};

export default function PhotoCapture({
  screenName,
  photoIndex,
  onPhotoTaken,
}: PhotoCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const hasAutoStartedRef = useRef(false);
  
  const [error, setError] = useState<string | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [cameraSupported, setCameraSupported] = useState(true);
  const [hasRequestedPermission, setHasRequestedPermission] = useState(false);
  const config = photoConfigs[screenName as keyof typeof photoConfigs];

  // Check if camera is supported and auto-start camera
  useEffect(() => {
  setCameraSupported(false);
}, []);

  // Cleanup camera on unmount or when screenName/photoIndex changes
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
        setIsCameraActive(false);
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [screenName, photoIndex]);

  const startCamera = async () => {
      setCameraSupported(false);
  return;
      
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraSupported(false);
      setError('Camera is not supported on this device.');
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      setHasRequestedPermission(true);
      
      // Stop any existing stream first
      const currentStream = streamRef.current;
currentStream?.getTracks().forEach((track: MediaStreamTrack) => track.stop());
streamRef.current = null;
        streamRef.current = null;
      }
    
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment', // Use back camera on mobile
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });

      // Verify stream is active before proceeding
      if (!stream.active) {
        throw new Error('Stream is not active');
      }

      const videoTracks = stream.getVideoTracks();
      if (videoTracks.length === 0) {
        throw new Error('No video tracks in stream');
      }

      console.log('Stream obtained - active:', stream.active, 'tracks:', videoTracks.length);

      if (videoRef.current) {
        const video = videoRef.current;
        streamRef.current = stream;
        
        // Clear any existing srcObject first
        if (video.srcObject) {
          video.srcObject = null;
        }
        
        // Assign stream
        video.srcObject = stream;
        
        // Set video attributes
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        
        // Activate camera immediately since we have a valid stream
        // The video will start playing and we'll show it
        setIsCameraActive(true);
        setIsLoading(false);
        console.log('Camera activated immediately - stream is active');
        
        // Try to play the video
        video.play()
          .then(() => {
            console.log('Video play() succeeded');
          })
          .catch(err => {
            console.error('Error playing video:', err);
            // Even if play fails, camera is already activated
            // The video should still work
          });
        
        // Event handlers for debugging
        const handleLoadedMetadata = () => {
          console.log('loadedmetadata - dimensions:', video.videoWidth, 'x', video.videoHeight);
        };
        
        const handleCanPlay = () => {
          console.log('canplay - dimensions:', video.videoWidth, 'x', video.videoHeight);
        };
        
        const handlePlaying = () => {
          console.log('playing - dimensions:', video.videoWidth, 'x', video.videoHeight);
        };
        
        // Add event listeners for debugging
        video.addEventListener('loadedmetadata', handleLoadedMetadata, { once: true });
        video.addEventListener('canplay', handleCanPlay, { once: true });
        video.addEventListener('playing', handlePlaying, { once: true });
      } else {
        // Video ref not available, but stream is active - activate anyway
        setIsCameraActive(true);
        setIsLoading(false);
      }
     } catch (err: any) {
       console.error('Error accessing camera:', err);
       setIsLoading(false);
       
       if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
         // Check if it's a security context issue
         const isSecureContext = window.isSecureContext || location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
         
         if (!isSecureContext) {
           setError('Camera requires a secure connection (HTTPS). In development, use localhost or enable HTTPS. You can still upload a photo from your device.');
         } else {
           setError('Camera permission was denied. Please allow camera access in your browser settings and try again, or upload a photo from your device.');
         }
       } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
         setError('No camera found on this device. Please upload a photo from your device.');
         setCameraSupported(false);
       } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
         setError('Camera is being used by another application. Please close other apps using the camera and try again.');
       } else {
         setError('Unable to access camera. You can still upload a photo from your device.');
         setCameraSupported(false);
       }
     }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        track.stop();
        console.log('Stopped track:', track.kind, track.label);
      });
      streamRef.current = null;
      setIsCameraActive(false);
    }
    
    // Clear video srcObject
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  const capturePhoto = () => {
    if (!videoRef.current || !canvasRef.current) {
      setError('Camera not ready. Please wait a moment and try again.');
      return;
    }

    const video = videoRef.current;
    const canvas = canvasRef.current;

    // Check if video stream is active
    if (!streamRef.current || !streamRef.current.active) {
      setError('Camera stream is not active. Please enable the camera first.');
      return;
    }

    // Check if video is ready
    if (!video.videoWidth || !video.videoHeight) {
      setError('Video is not ready yet. Please wait a moment and try again.');
      console.error('Video dimensions:', video.videoWidth, 'x', video.videoHeight);
      return;
    }

    const context = canvas.getContext('2d', { willReadFrequently: false });
    if (!context) {
      setError('Failed to initialize canvas. Please try again.');
      return;
    }

    try {
      // Set canvas dimensions to match video
      const videoWidth = video.videoWidth;
const videoHeight = video.videoHeight;

// Paper preview (8.5:11)
const previewAspect = 8.5 / 11;

let sourceX = 0;
let sourceY = 0;
let sourceWidth = videoWidth;
let sourceHeight = videoHeight;

const videoAspect = videoWidth / videoHeight;

if (videoAspect > previewAspect) {
  // Video is wider → crop left/right
  sourceWidth = videoHeight * previewAspect;
  sourceX = (videoWidth - sourceWidth) / 2;
} else if (videoAspect < previewAspect) {
  // Video is taller → crop top/bottom
  sourceHeight = videoWidth / previewAspect;
  sourceY = (videoHeight - sourceHeight) / 2;
}

// Output is square
canvas.width = Math.round(sourceWidth);
canvas.height = Math.round(sourceHeight);

context.drawImage(
  video,
  sourceX,
  sourceY,
  sourceWidth,
  sourceHeight,
  0,
  0,
  canvas.width,
  canvas.height
);

      console.log('Photo captured - dimensions:', canvas.width, 'x', canvas.height);

      // Convert canvas to blob, then to File
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            setError('Failed to capture photo. Please try again.');
            console.error('Canvas toBlob returned null');
            return;
          }

          console.log('Photo blob created - size:', blob.size, 'bytes');

          const file = new File([blob], `photo-${photoIndex + 1}.jpg`, {
            type: 'image/jpeg',
          });

          // Create preview
          const preview = canvas.toDataURL('image/jpeg', 0.95);
          
          console.log('Photo preview created - length:', preview.length);
          
          // Stop camera
          stopCamera();
          
          // Pass to parent
          onPhotoTaken(file, preview);
          setError(null);
        },
        'image/jpeg',
        0.95
      );
    } catch (err) {
      console.error('Error capturing photo:', err);
      setError('Failed to capture photo. Please try again.');
    }
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Client-side validation
    if (!file.type.startsWith('image/')) {
      setError('Please select an image file.');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setError('File size must be less than 10MB.');
      return;
    }

    // Create preview
    const reader = new FileReader();
    reader.onloadend = () => {
      const preview = reader.result as string;
      onPhotoTaken(file, preview);
      setError(null);
    };
    reader.readAsDataURL(file);
  };

  const handleUseFileInput = () => {
    fileInputRef.current?.click();
  };

  if (!config) {
    return (
      <div className="text-center py-8">
        <div className="text-red-400 text-lg">Error: Invalid photo screen</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-4 border border-gray-700/50">
        
        <h1 className="text-5xl font-bold text-center tracking-wide mb-4">
  {config.header.toUpperCase()}
</h1>

<p className="text-lg text-center font-semibold mb-2">
  One finger only
</p>

<p className="text-center text-sm font-medium mb-1">
  Use a colored or dark card only — white cards will not work
</p>

<p className="text-center text-sm font-medium mb-4">
  Use 1x only — no zoom
</p>
<ul className="space-y-2 text-gray-300 text-sm">
          {config.bodyCopy.map((item, index) => (
            <li key={index} className="flex items-start gap-2">
              <span className="text-blue-400 mt-0.5">•</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
        {config.helperText && (
          <p className="text-xs text-blue-300/80 italic mt-4 pt-4 border-t border-gray-700/50">
            {config.helperText}
          </p>
        )}
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-500/50 text-red-200 px-3 py-2 rounded-lg backdrop-blur-sm text-sm">
          <p className="font-semibold mb-1">⚠️ {error}</p>
          {error.includes('secure connection') && (
            <div className="mt-2 pt-2 border-t border-red-500/30 text-xs">
              <p className="mb-1"><strong>Development Tip:</strong></p>
              <ul className="list-disc list-inside space-y-0.5 text-red-300/80">
                <li>Use <code className="bg-red-900/50 px-1 rounded">localhost</code> or <code className="bg-red-900/50 px-1 rounded">127.0.0.1</code> - camera works without HTTPS</li>
                <li>Or enable HTTPS in development (see DEVELOPMENT.md)</li>
                <li>You can still upload photos using the file button below</li>
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Camera Preview - Always visible */}
      <div className="relative w-full aspect-[8.5/11] bg-gray-900 rounded-xl overflow-hidden border-2 border-gray-700/50">
        {/* Video element - always rendered, visible when camera is active */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover"
          style={{ 
            opacity: isCameraActive ? 1 : 0,
            pointerEvents: isCameraActive ? 'auto' : 'none',
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            zIndex: 1
          }}
          onLoadedMetadata={() => {
            // Video is ready when metadata is loaded
            console.log('Video loadedmetadata - dimensions:', videoRef.current?.videoWidth, 'x', videoRef.current?.videoHeight);
          }}
          onCanPlay={() => {
            console.log('Video canplay - dimensions:', videoRef.current?.videoWidth, 'x', videoRef.current?.videoHeight);
          }}
          onPlaying={() => {
            console.log('Video playing - dimensions:', videoRef.current?.videoWidth, 'x', videoRef.current?.videoHeight);
          }}
        />
        
        {/* Overlay frame */}
        {isCameraActive && (
          <div className="absolute inset-0 pointer-events-none z-10">
            <div className="absolute inset-4 border-2 border-white/30 rounded-xl"></div>
          </div>
        )}
        
        {/* Loading overlay */}
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/90 z-20">
            <div className="text-center">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500 mx-auto mb-3"></div>
              <p className="text-gray-300 text-sm">Requesting camera access...</p>
              <p className="text-xs text-gray-400 mt-1">Please allow camera permission in your browser</p>
            </div>
          </div>
        )}
        
        {/* Placeholder when camera is not active */}
        {!isCameraActive && !isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/50 z-10">
            <div className="text-center space-y-2 p-4">
              <div className="text-3xl mb-1">📷</div>
              <p className="text-gray-300 text-sm mb-2">
                {cameraSupported 
                  ? 'Camera not available. Please upload a photo from your device.'
                  : 'Camera not available. Please upload a photo from your device.'}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Hidden canvas for capturing */}
      <canvas ref={canvasRef} className="hidden" />

      {/* File input fallback */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFileSelect}
        className="hidden"
      />

      {/* Action Buttons */}
      <div className="space-y-2">
        {cameraSupported && isCameraActive && (
          <button
            onClick={capturePhoto}
            className="w-full bg-gradient-to-r from-blue-600 to-cyan-600 text-white py-2.5 px-4 rounded-lg font-semibold text-base hover:from-blue-500 hover:to-cyan-500 transition-all duration-200 shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 transform hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Capture Photo
          </button>
        )}
        
        {/* Always show file upload option as fallback */}
        {(!cameraSupported || !isCameraActive) && (
          <button
            onClick={handleUseFileInput}
            className="w-full bg-gradient-to-r from-blue-600 to-cyan-600 text-white py-2.5 px-4 rounded-lg font-semibold text-base hover:from-blue-500 hover:to-cyan-500 transition-all duration-200 shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 transform hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            {hasRequestedPermission ? 'Upload Photo from Device' : 'Choose Photo from Device'}
          </button>
        )}
        
        {/* Show file upload as secondary option when camera is active */}
        {cameraSupported && isCameraActive && (
          <button
            onClick={handleUseFileInput}
            className="w-full bg-gray-800/50 text-gray-300 py-2 px-4 rounded-lg font-medium hover:bg-gray-700/50 border border-gray-700/50 transition-all duration-200 flex items-center justify-center gap-2 text-sm"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            Or upload from device
          </button>
        )}
      </div>
    </div>
  );
}

