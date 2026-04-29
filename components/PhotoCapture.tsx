'use client';

import { useRef, useState, useEffect } from 'react';
import { ScreenName } from '@/app/page';
import CaptureReady from './CaptureReady';

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
  },
  photo_left_palm_up: {
  header: 'LEFT PALM-UP',
  bodyCopy: [
    'Flip your hand palm-up',
    'Slightly curl your fingers so we can see the underside of your nails',
    'Keep your hand relaxed',
    'Hold your phone directly above your hand',
    'Tap to focus before taking the photo',
  ],
  helperText: 'Make sure all nails are visible from underneath.',
},

photo_right_palm_up: {
  header: 'RIGHT PALM-UP',
  bodyCopy: [
    'Flip your hand palm-up',
    'Slightly curl your fingers so we can see the underside of your nails',
    'Keep your hand relaxed',
    'Hold your phone directly above your hand',
    'Tap to focus before taking the photo',
  ],
  helperText: 'Make sure all nails are visible from underneath.',
},
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
  
    
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment', // Use back camera on mobile
          width: { ideal: 4032 },
          height: { ideal: 3024 },
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
        const video = videoRef.current!;
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
      console.log('Video dimensions:', video.videoWidth, 'x', video.videoHeight);

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
    console.log('SELECTED FILE:', file.name, file.type, file.size);

const img = new Image();
img.onload = () => {
  console.log('SELECTED FILE DIMENSIONS:', img.naturalWidth, 'x', img.naturalHeight);
};
img.src = URL.createObjectURL(file);

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
  <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-blue-950 flex items-center justify-center px-6">
    <div className="w-full max-w-md text-center">

      <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-white mb-4">
  {config.header}
</h1>

     <div className="mb-8 space-y-1">
  <p className="text-white text-base font-medium">
    Upload your {config.header.toLowerCase()} photo
  </p>
  <p className="text-white/80 text-sm">
    Choose the matching photo from your library
  </p>
</div>

      <label className="inline-flex cursor-pointer items-center justify-center rounded-xl bg-blue-600 px-6 py-3 text-white font-medium hover:bg-blue-500">
        Choose Photo
        <input
  type="file"
  accept="image/*"
  className="hidden"
  onChange={handleFileSelect}
/>
      </label>
    </div>
  </main>
);
}

