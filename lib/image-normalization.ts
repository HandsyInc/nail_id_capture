/**
 * Geometry-safe image normalization.
 *
 * Why this exists
 * ---------------
 * iPhone and most phone cameras store JPEGs with raw landscape pixel data
 * plus an EXIF Orientation flag (commonly 6 = "rotate 90° CW for display").
 * Browsers honor EXIF when rendering an `<img>` element, but the raw pixel
 * data on disk is still landscape. The browser's `naturalWidth` / `naturalHeight`
 * properties report the *raw* pixel dimensions, NOT the EXIF-corrected ones.
 *
 * Meanwhile, our measurement API receives the raw bytes. Whether the API
 * respects EXIF or not depends on how it decodes the JPEG. If client and
 * server interpret orientation differently, we have a silent
 * metadata-vs-pixels mismatch — a hidden variable that affects measurement
 * geometry inconsistently across photos and across devices.
 *
 * What this module does
 * ---------------------
 * Always re-encode every photo through a canvas pipeline that bakes any
 * EXIF rotation into the pixel data and strips EXIF metadata. The bytes
 * leaving this function have self-consistent geometry: pixel orientation
 * matches what a viewer would see, and there is no metadata orientation
 * flag for any downstream consumer to disagree with.
 *
 * This applies to every photo, including those whose EXIF orientation
 * flag is already 1 ("normal"). Uniform processing matters more than
 * preserving raw bytes for the rare unrotated case — the goal is to
 * eliminate variance, not to optimize per-image fidelity.
 *
 * Implementation notes
 * --------------------
 * `createImageBitmap(file, { imageOrientation: 'from-image' })` applies
 * EXIF rotation natively. The resulting bitmap's width/height are the
 * display-correct (post-rotation) dimensions. Drawing the bitmap to a
 * canvas at matching dimensions is a 1:1 copy — no resampling occurs.
 * `imageSmoothingEnabled = false` is set as a belt-and-suspenders guard.
 * Canvas `toBlob` exports without EXIF metadata by default.
 *
 * Browser support
 * ---------------
 * Requires `createImageBitmap` with `imageOrientation: 'from-image'`:
 *   Chrome 81+, Edge 81+, Firefox 89+, Safari 15+ (iOS 15+).
 * Pilot users are expected to be on modern phones; if a device is too old
 * the function throws a clear error rather than silently uploading
 * mis-oriented bytes.
 */

export type NormalizedOrientation = 'portrait' | 'landscape';

export interface NormalizationResult {
  /** The normalized File: JPEG with EXIF baked into pixels and metadata stripped. */
  file: File;
  /** Display-correct pixel width (post-rotation). */
  width: number;
  /** Display-correct pixel height (post-rotation). */
  height: number;
  /** Derived from the normalized pixel dimensions — never metadata. */
  orientation: NormalizedOrientation;
}

/**
 * JPEG quality used for the normalized output.
 *
 * 0.98 is near-lossless for natural images — the artifacts it introduces
 * are well below the noise floor of phone-camera capture. We accept this
 * small compression cost in exchange for uniform processing across every
 * photo entering the pipeline.
 */
const NORMALIZED_JPEG_QUALITY = 0.98;

/**
 * Normalize an image File for upload: bake EXIF orientation into pixels,
 * strip EXIF metadata, produce a self-consistent JPEG.
 *
 * Throws if the browser does not support EXIF-aware bitmap decoding or
 * if the canvas/encode pipeline fails. Callers should surface a clear
 * "please retake on a newer device or browser" message in that case
 * rather than fall back to the un-normalized file.
 */
export async function normalizeImageForUpload(file: File): Promise<NormalizationResult> {
  if (!file.type.startsWith('image/')) {
    throw new Error(`Unsupported file type for normalization: ${file.type || 'unknown'}.`);
  }

  if (typeof createImageBitmap !== 'function') {
    throw new Error(
      'This browser does not support EXIF-aware image decoding. ' +
        'Please update your browser or try on a newer device.'
    );
  }

  // imageOrientation: 'from-image' tells the browser to apply the EXIF
  // Orientation tag during decode. The returned bitmap has display-correct
  // dimensions and pixel data.
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (err) {
    throw new Error(
      'Failed to decode the photo for normalization. The file may be corrupt — please retake.'
    );
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to acquire a 2D canvas context.');
    }

    // We're drawing 1:1 at matching dimensions, so no resampling should
    // occur. Disable smoothing explicitly so that if a browser ever
    // interprets drawImage differently we don't introduce subpixel noise.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, 0, 0);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) =>
          b ? resolve(b) : reject(new Error('Canvas toBlob returned null during normalization.')),
        'image/jpeg',
        NORMALIZED_JPEG_QUALITY
      );
    });

    const baseName = file.name.replace(/\.[^.]+$/, '') || 'photo';
    const normalizedFile = new File([blob], `${baseName}.jpg`, {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });

    const orientation: NormalizedOrientation =
      canvas.height >= canvas.width ? 'portrait' : 'landscape';

    return {
      file: normalizedFile,
      width: canvas.width,
      height: canvas.height,
      orientation,
    };
  } finally {
    bitmap.close();
  }
}

/**
 * Read a File's bytes as a base64 string (no `data:` prefix).
 *
 * Does NOT re-encode — returns the file's exact bytes encoded. Use this
 * after `normalizeImageForUpload` so the bytes sent to the API are
 * identical to the bytes verified by normalization.
 */
export async function fileToBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string result.'));
        return;
      }
      const commaIndex = result.indexOf(',');
      if (commaIndex < 0) {
        reject(new Error('FileReader result is not a valid data URL.'));
        return;
      }
      resolve(result.slice(commaIndex + 1));
    };
    reader.onerror = () => reject(new Error('Failed to read file for base64 encoding.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Read a File as a `data:` URL for use as an <img> src.
 * Convenience wrapper around FileReader.
 */
export async function fileToDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string result.'));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => reject(new Error('Failed to read file as data URL.'));
    reader.readAsDataURL(file);
  });
}
