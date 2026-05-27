/**
 * Minimal JPEG EXIF parser — focal-length tags only.
 *
 * Purpose
 * -------
 * Extract the focal-length metadata that modern phone cameras embed in JPEG
 * EXIF so we can compare it against the focal-length estimate derived from
 * the card-plane homography. Both numbers live in CaptureDiagnostics as
 * read-only, diagnostics-only fields.
 *
 * What this parser does — and deliberately does NOT do
 * -----------------------------------------------------
 * - Reads the APP1 / TIFF IFD chain from JPEG bytes.
 * - Extracts exactly seven tags: FocalLength (0x920A), FocalLengthIn35mmFilm
 *   (0xA405), FocalPlaneXResolution (0xA20E), FocalPlaneYResolution (0xA20F),
 *   FocalPlaneResolutionUnit (0xA210), PixelXDimension (0xA002),
 *   PixelYDimension (0xA003).
 * - Derives focal length in pixels when the FocalPlane resolution tags are
 *   present (focalLengthPxFromExif).
 * - Does NOT modify the file, does NOT parse GPS/thumbnail/MakerNote IFDs,
 *   does NOT use a third-party library.
 *
 * Canvas JPEG limitation
 * ----------------------
 * `canvas.toBlob('image/jpeg')` produces JPEGs without EXIF (the canvas API
 * strips all metadata). Photos taken via the iOS file picker DO carry EXIF.
 * For canvas-sourced captures `extractExifFocal` will return `exifPresent:
 * false` and all-null fields — that result is informative: it confirms EXIF
 * is not available on the canvas capture path and the homography estimate
 * must stand in for it.
 */

export type ExifFocalData = {
  /** True if the JPEG contained an APP1/Exif segment at all. */
  exifPresent: boolean;
  /** Physical focal length in mm (EXIF tag 0x920A, FocalLength). */
  focalLengthMm: number | null;
  /** 35mm film equivalent focal length (EXIF tag 0xA405, FocalLengthIn35mmFilm). */
  focalLength35mmEq: number | null;
  /**
   * Pixels per millimetre on the camera focal plane, derived from
   * FocalPlaneXResolution (0xA20E) and FocalPlaneResolutionUnit (0xA210).
   * Null when either tag is absent.
   */
  focalPlaneXResolutionPxPerMm: number | null;
  /** Same for the Y axis (0xA20F). Null when absent. */
  focalPlaneYResolutionPxPerMm: number | null;
  /** Full pixel width of the captured image (EXIF tag 0xA002, PixelXDimension). */
  exifImageWidth: number | null;
  /** Full pixel height of the captured image (EXIF tag 0xA003, PixelYDimension). */
  exifImageHeight: number | null;
  /**
   * Focal length in pixels: focalLengthMm × focalPlaneXResolutionPxPerMm.
   * Null when either component is absent.
   */
  focalLengthPxFromExif: number | null;
};

// ---------------------------------------------------------------------------
// EXIF TIFF type sizes
// ---------------------------------------------------------------------------

const TYPE_SIZES: Record<number, number> = {
  1: 1,  // BYTE
  2: 1,  // ASCII
  3: 2,  // SHORT
  4: 4,  // LONG
  5: 8,  // RATIONAL (two ULONGs)
  6: 1,  // SBYTE
  7: 1,  // UNDEFINED
  8: 2,  // SSHORT
  9: 4,  // SLONG
  10: 8, // SRATIONAL (two SLONGs)
  11: 4, // FLOAT
  12: 8, // DOUBLE
};

type IFDEntry = {
  type: number;
  count: number;
  /** Absolute byte offset within the ArrayBuffer where the value data lives. */
  absDataOffset: number;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse focal-length EXIF metadata from raw JPEG bytes.
 *
 * Safe to call on any ArrayBuffer — returns the empty/absent result for
 * non-JPEG, EXIF-free, and canvas-captured bytes without throwing.
 */
export function extractExifFocal(jpegBytes: ArrayBuffer): ExifFocalData {
  const absent: ExifFocalData = {
    exifPresent: false,
    focalLengthMm: null,
    focalLength35mmEq: null,
    focalPlaneXResolutionPxPerMm: null,
    focalPlaneYResolutionPxPerMm: null,
    exifImageWidth: null,
    exifImageHeight: null,
    focalLengthPxFromExif: null,
  };

  try {
    const view = new DataView(jpegBytes);
    const len = jpegBytes.byteLength;

    // Must start with JPEG SOI FF D8
    if (len < 4 || view.getUint16(0) !== 0xffd8) return absent;

    // Scan APP markers for APP1 (FF E1)
    let tiffBase = -1;
    let pos = 2;
    while (pos + 4 <= len) {
      const marker = view.getUint16(pos);
      if (marker === 0xffe1) {
        // Check for "Exif\0\0" identifier at bytes +4..+9
        if (
          pos + 10 <= len &&
          view.getUint8(pos + 4) === 0x45 && // E
          view.getUint8(pos + 5) === 0x78 && // x
          view.getUint8(pos + 6) === 0x69 && // i
          view.getUint8(pos + 7) === 0x66 && // f
          view.getUint8(pos + 8) === 0x00 &&
          view.getUint8(pos + 9) === 0x00
        ) {
          tiffBase = pos + 10;
          break;
        }
      }
      // FF DA = SOS — data segment starts, no more app markers follow
      if (marker === 0xffda) break;
      const segLen = view.getUint16(pos + 2);
      if (segLen < 2) break; // malformed
      pos += 2 + segLen;
    }

    if (tiffBase < 0) return absent;

    // TIFF header: byte-order mark + magic 0x002A + IFD0 offset
    const bo1 = view.getUint8(tiffBase);
    const bo2 = view.getUint8(tiffBase + 1);
    let le: boolean;
    if (bo1 === 0x49 && bo2 === 0x49) le = true;       // "II" little-endian
    else if (bo1 === 0x4d && bo2 === 0x4d) le = false; // "MM" big-endian
    else return absent;

    if (view.getUint16(tiffBase + 2, le) !== 0x002a) return absent;

    const ifd0Offset = view.getUint32(tiffBase + 4, le);
    const ifd0Tags = readIFD(view, tiffBase, tiffBase + ifd0Offset, le, len);

    // ExifSubIFD pointer (tag 0x8769, LONG)
    const exifPtrEntry = ifd0Tags.get(0x8769);
    if (!exifPtrEntry) return { ...absent, exifPresent: true };

    const exifIFDOffset = readScalar(view, exifPtrEntry, le, len);
    if (exifIFDOffset === null) return { ...absent, exifPresent: true };

    const exifTags = readIFD(
      view,
      tiffBase,
      tiffBase + exifIFDOffset,
      le,
      len,
    );

    const result: ExifFocalData = { ...absent, exifPresent: true };

    // FocalLength (0x920A) — RATIONAL
    const fl = exifTags.get(0x920a);
    if (fl) {
      const v = readRational(view, fl, le, len);
      if (v !== null) result.focalLengthMm = v;
    }

    // FocalLengthIn35mmFilm (0xA405) — SHORT
    const fl35 = exifTags.get(0xa405);
    if (fl35) {
      const v = readScalar(view, fl35, le, len);
      if (v !== null) result.focalLength35mmEq = v;
    }

    // FocalPlaneResolutionUnit (0xA210) — SHORT (1=none, 2=inch, 3=cm)
    let resUnit = 2; // default: inch
    const fpUnit = exifTags.get(0xa210);
    if (fpUnit) {
      const v = readScalar(view, fpUnit, le, len);
      if (v !== null) resUnit = v;
    }
    // Convert resolution unit to mm
    const unitToMm = resUnit === 3 ? 10 : resUnit === 2 ? 25.4 : 1;

    // FocalPlaneXResolution (0xA20E) — RATIONAL (pixels per resolution-unit)
    const fpxr = exifTags.get(0xa20e);
    if (fpxr) {
      const v = readRational(view, fpxr, le, len);
      if (v !== null) result.focalPlaneXResolutionPxPerMm = v / unitToMm;
    }

    // FocalPlaneYResolution (0xA20F) — RATIONAL
    const fpyr = exifTags.get(0xa20f);
    if (fpyr) {
      const v = readRational(view, fpyr, le, len);
      if (v !== null) result.focalPlaneYResolutionPxPerMm = v / unitToMm;
    }

    // PixelXDimension (0xA002) — SHORT or LONG
    const pxw = exifTags.get(0xa002);
    if (pxw) {
      const v = readScalar(view, pxw, le, len);
      if (v !== null) result.exifImageWidth = v;
    }

    // PixelYDimension (0xA003) — SHORT or LONG
    const pxh = exifTags.get(0xa003);
    if (pxh) {
      const v = readScalar(view, pxh, le, len);
      if (v !== null) result.exifImageHeight = v;
    }

    // Derived focal length in pixels
    if (
      result.focalLengthMm !== null &&
      result.focalPlaneXResolutionPxPerMm !== null
    ) {
      result.focalLengthPxFromExif =
        result.focalLengthMm * result.focalPlaneXResolutionPxPerMm;
    }

    return result;
  } catch {
    return absent;
  }
}

// ---------------------------------------------------------------------------
// IFD parsing helpers
// ---------------------------------------------------------------------------

/**
 * Read all entries from one IFD and return a tag→entry map.
 * `ifdStart` is an absolute byte offset within the ArrayBuffer.
 */
function readIFD(
  view: DataView,
  tiffBase: number,
  ifdStart: number,
  le: boolean,
  byteLength: number,
): Map<number, IFDEntry> {
  const tags = new Map<number, IFDEntry>();
  if (ifdStart + 2 > byteLength) return tags;

  const count = view.getUint16(ifdStart, le);
  for (let i = 0; i < count; i++) {
    const eOff = ifdStart + 2 + i * 12;
    if (eOff + 12 > byteLength) break;

    const tag = view.getUint16(eOff, le);
    const type = view.getUint16(eOff + 2, le);
    const cnt = view.getUint32(eOff + 4, le);
    const valOffsetField = view.getUint32(eOff + 8, le);

    const typeSize = TYPE_SIZES[type] ?? 1;
    const totalSize = typeSize * cnt;
    // If total value size fits in the 4-byte field it's stored inline;
    // otherwise bytes 8-11 of the entry are a TIFF-relative offset.
    const absDataOffset =
      totalSize <= 4 ? eOff + 8 : tiffBase + valOffsetField;

    tags.set(tag, { type, count: cnt, absDataOffset });
  }
  return tags;
}

/**
 * Read a single integer scalar from an IFD entry (SHORT, LONG, or SLONG).
 * Returns null for unsupported types or out-of-bounds reads.
 */
function readScalar(
  view: DataView,
  entry: IFDEntry,
  le: boolean,
  byteLength: number,
): number | null {
  const { type, absDataOffset: off } = entry;
  const needed = TYPE_SIZES[type] ?? 1;
  if (off + needed > byteLength) return null;
  switch (type) {
    case 3: return view.getUint16(off, le); // SHORT
    case 4: return view.getUint32(off, le); // LONG
    case 9: return view.getInt32(off, le);  // SLONG
    default: return null;
  }
}

/**
 * Read a RATIONAL (two ULONGs, numerator/denominator) or SRATIONAL entry.
 * Returns null for a zero denominator, unsupported type, or out-of-bounds.
 */
function readRational(
  view: DataView,
  entry: IFDEntry,
  le: boolean,
  byteLength: number,
): number | null {
  const { type, absDataOffset: off } = entry;
  if (type !== 5 && type !== 10) return null; // RATIONAL or SRATIONAL
  if (off + 8 > byteLength) return null;
  const signed = type === 10;
  const num = signed ? view.getInt32(off, le) : view.getUint32(off, le);
  const den = signed
    ? view.getInt32(off + 4, le)
    : view.getUint32(off + 4, le);
  if (den === 0) return null;
  return num / den;
}
