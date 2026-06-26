import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getFromR2 } from '@/lib/r2';

// ---------------------------------------------------------------------------
// D4.8 app-layer diagnostic helpers
// ---------------------------------------------------------------------------

/** Local mm/px scale of imageToCard H at an image pixel via Jacobian. */
function scaleMmPerPxAt(H: number[][], xPx: number, yPx: number): number {
  const w  = H[2][0]*xPx + H[2][1]*yPx + H[2][2];
  const Xw = H[0][0]*xPx + H[0][1]*yPx + H[0][2];
  const Yw = H[1][0]*xPx + H[1][1]*yPx + H[1][2];
  const w2 = w * w;
  const j00 = (H[0][0]*w - Xw*H[2][0]) / w2;
  const j01 = (H[0][1]*w - Xw*H[2][1]) / w2;
  const j10 = (H[1][0]*w - Yw*H[2][0]) / w2;
  const j11 = (H[1][1]*w - Yw*H[2][1]) / w2;
  return Math.sqrt(Math.abs(j00*j11 - j01*j10));
}

/** Apply imageToCard H to a single image pixel → {x_mm, y_mm}. */
function applyH(H: number[][], xPx: number, yPx: number): { x: number; y: number } {
  const w = H[2][0]*xPx + H[2][1]*yPx + H[2][2];
  return {
    x: (H[0][0]*xPx + H[0][1]*yPx + H[0][2]) / w,
    y: (H[1][0]*xPx + H[1][1]*yPx + H[1][2]) / w,
  };
}

/**
 * Contour bounding-box analysis.
 *
 * Computes the pixel bbox of the contour, applies H to its four corners,
 * and derives an empirical mm/px scale from the bbox extents.  This
 * cross-checks the Jacobian: if they agree, H and contour coords are in
 * the same pixel space.  If they disagree, the contour coords are likely
 * in a different (e.g. downsampled) pixel space.
 */
function contourBboxDiag(
  contour: [number, number][],
  H: number[][],
): {
  bbox_px:               { minX: number; minY: number; maxX: number; maxY: number };
  bbox_width_px:         number;
  bbox_height_px:        number;
  centroid_px:           { x: number; y: number };
  bbox_mm:               { minX: number; minY: number; maxX: number; maxY: number };
  bbox_width_mm:         number;
  bbox_height_mm:        number;
  bbox_scale_x_mm_per_px: number;   // empirical x-scale from bbox
  bbox_scale_y_mm_per_px: number;   // empirical y-scale from bbox
  jacobian_at_centroid:  number;    // Jacobian scale at contour centroid
} | null {
  if (!contour || contour.length === 0) return null;

  const xs = contour.map(p => p[0]);
  const ys = contour.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  // Apply H to the four bbox corners and extract mm extents
  const tl = applyH(H, minX, minY);
  const tr = applyH(H, maxX, minY);
  const bl = applyH(H, minX, maxY);
  const br = applyH(H, maxX, maxY);

  const mmXs = [tl.x, tr.x, bl.x, br.x];
  const mmYs = [tl.y, tr.y, bl.y, br.y];
  const minXmm = Math.min(...mmXs), maxXmm = Math.max(...mmXs);
  const minYmm = Math.min(...mmYs), maxYmm = Math.max(...mmYs);

  const bboxWidthPx  = maxX - minX;
  const bboxHeightPx = maxY - minY;
  const bboxWidthMm  = maxXmm - minXmm;
  const bboxHeightMm = maxYmm - minYmm;

  return {
    bbox_px:               { minX, minY, maxX, maxY },
    bbox_width_px:         bboxWidthPx,
    bbox_height_px:        bboxHeightPx,
    centroid_px:           { x: cx, y: cy },
    bbox_mm:               { minX: minXmm, minY: minYmm, maxX: maxXmm, maxY: maxYmm },
    bbox_width_mm:         bboxWidthMm,
    bbox_height_mm:        bboxHeightMm,
    bbox_scale_x_mm_per_px: bboxWidthPx  > 0 ? bboxWidthMm  / bboxWidthPx  : 0,
    bbox_scale_y_mm_per_px: bboxHeightPx > 0 ? bboxHeightMm / bboxHeightPx : 0,
    jacobian_at_centroid:  scaleMmPerPxAt(H, cx, cy),
  };
}

/**
 * POST /api/measure/chord
 *
 * D4.7 founder-assisted chord-width bridge.
 *
 * Accepts a captureImageId and founder nail click, fetches the image from R2
 * and h_matrix from Prisma, then posts to the nail-measure-service stateless
 * /chord_width endpoint.  Returns width_mm, an overlay image, and the contour.
 *
 * Body JSON:
 *   captureImageId  string    — TOP_DOWN CaptureImage id with h_matrix populated
 *   nail_x          number    — founder click x in NATURAL image pixels
 *   nail_y          number    — founder click y in NATURAL image pixels
 *   h_mm?           number    — card-to-nail distance in mm (default 25)
 *   D_mm?           number    — camera-to-card distance in mm (default 269)
 *
 * Response JSON:
 *   width_mm, length_mm, angle_deg,
 *   overlay_image_b64, contour_px, mrr_corners_mm,
 *   nail_click_used, captureImageId
 */

const DEFAULT_MEASURE_URL =
  process.env.NAIL_MEASURE_SERVICE_URL ?? 'http://localhost:8000';

function isMatrix3x3(v: unknown): v is number[][] {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 3 &&
        row.every((n) => typeof n === 'number' && Number.isFinite(n)),
    )
  );
}

export async function POST(req: Request) {
  const body = await req.json();
  const {
    captureImageId,
    nail_x,
    nail_y,
    h_mm = 25,
    D_mm = 269,
  } = body as {
    captureImageId: string;
    nail_x: number;
    nail_y: number;
    h_mm?: number;
    D_mm?: number;
  };

  // ── Input validation ────────────────────────────────────────────────────
  if (!captureImageId || typeof captureImageId !== 'string') {
    return NextResponse.json({ error: 'captureImageId is required' }, { status: 400 });
  }
  if (typeof nail_x !== 'number' || typeof nail_y !== 'number') {
    return NextResponse.json({ error: 'nail_x and nail_y must be numbers' }, { status: 400 });
  }

  // ── Fetch CaptureImage ─────────────────────────────────────────────────
  const capture = await prisma.captureImage.findUnique({
    where: { id: captureImageId },
    select: { imageType: true, h_matrix: true, storageKey: true },
  });

  if (!capture) {
    return NextResponse.json(
      { error: `CaptureImage ${captureImageId} not found` },
      { status: 404 },
    );
  }

  if (capture.imageType !== 'TOP_DOWN') {
    return NextResponse.json(
      { error: `chord_width requires TOP_DOWN images; this is ${capture.imageType}` },
      { status: 422 },
    );
  }

  if (capture.h_matrix === null) {
    return NextResponse.json(
      { error: 'h_matrix is null — card not detected for this capture' },
      { status: 422 },
    );
  }

  if (!isMatrix3x3(capture.h_matrix)) {
    return NextResponse.json(
      { error: 'h_matrix is not a valid 3×3 array', value: capture.h_matrix },
      { status: 422 },
    );
  }

  // ── Fetch image bytes from R2 ───────────────────────────────────────────
  const { body: imageBytes, contentType } = await getFromR2(capture.storageKey);

  // ── POST to nail-measure-service /chord_width ───────────────────────────
  const form = new FormData();
  form.append(
    'image',
    new Blob([imageBytes.buffer as ArrayBuffer], { type: contentType }),
    'capture.jpg',
  );
  form.append('H_matrix', JSON.stringify(capture.h_matrix));
  form.append('nail_x', String(nail_x));
  form.append('nail_y', String(nail_y));
  form.append('h_mm', String(h_mm));
  form.append('D_mm', String(D_mm));

  let serviceRes: Response;
  try {
    serviceRes = await fetch(`${DEFAULT_MEASURE_URL}/api/v1/chord_width`, {
      method: 'POST',
      body: form,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'Could not reach nail-measure-service',
        detail: String(err),
        measureServiceUrl: DEFAULT_MEASURE_URL,
      },
      { status: 502 },
    );
  }

  if (!serviceRes.ok) {
    const text = await serviceRes.text();
    return NextResponse.json(
      { error: 'nail-measure-service returned an error', detail: text },
      { status: 502 },
    );
  }

  const result = await serviceRes.json();

  // ── D4.8 app-layer diagnostics ─────────────────────────────────────────
  const H = capture.h_matrix as number[][];
  const scaleMmPerPx = scaleMmPerPxAt(H, nail_x, nail_y);

  // Service diagnostic fields — explicitly extracted with null fallbacks so
  // they are guaranteed top-level even if the Python service is stale.
  const mrr_width_raw_mm: number | null =
    typeof result.mrr_width_raw_mm === 'number' ? result.mrr_width_raw_mm : null;
  const mrr_length_raw_mm: number | null =
    typeof result.mrr_length_raw_mm === 'number' ? result.mrr_length_raw_mm : null;
  const mrr_width_px: number | null =
    typeof result.mrr_width_px === 'number' ? result.mrr_width_px : null;
  const mrr_length_px: number | null =
    typeof result.mrr_length_px === 'number' ? result.mrr_length_px : null;

  // Implied pixel width cross-check: pre-depth mm ÷ local mm/px scale
  const mrr_width_implied_px: number | null =
    mrr_width_raw_mm !== null && scaleMmPerPx > 0
      ? mrr_width_raw_mm / scaleMmPerPx
      : null;

  // ── D4.8.6 fields — explicitly extracted from Python service result ──────
  // These come from measure.py → /api/v1/chord_width. Explicit extraction
  // (rather than relying on ...result spread) makes them guaranteed top-level.
  const depth_correction_factor: number | null =
    typeof result.depth_correction_factor === 'number' ? result.depth_correction_factor : null;
  const width_mm_sweep: Record<string, number> | null =
    result.width_mm_sweep != null && typeof result.width_mm_sweep === 'object'
      ? result.width_mm_sweep
      : null;
  const contour_bbox_px: number[] | null =
    Array.isArray(result.contour_bbox_px) ? result.contour_bbox_px : null;
  const mrr_width_naive_mm: number | null =
    typeof result.mrr_width_naive_mm === 'number' ? result.mrr_width_naive_mm : null;

  // ── Contour bounding-box cross-check ───────────────────────────────────
  const bboxDiag = contourBboxDiag(
    (result.contour_px ?? []) as [number, number][],
    H,
  );

  // H matrix for direct inspection
  const h_matrix_diag = {
    row0: (H[0] as number[]).map((v: number) => +v.toFixed(8)),
    row1: (H[1] as number[]).map((v: number) => +v.toFixed(8)),
    row2: (H[2] as number[]).map((v: number) => +v.toFixed(8)),
  };

  return NextResponse.json({
    captureImageId,
    ...result,
    // ── D4.8.6 top-level diagnostic fields (explicit, not spread-dependent) ──
    depth_correction_factor,
    width_mm_sweep,
    contour_bbox_px,
    mrr_width_naive_mm,
    // ── diag block (app-layer computed) ─────────────────────────────────────
    diag: {
      scale_mm_per_px_at_click:  scaleMmPerPx,
      h_used_mm:                 h_mm,
      D_used_mm:                 D_mm,
      mrr_width_raw_mm,
      mrr_length_raw_mm,
      mrr_width_px,
      mrr_length_px,
      mrr_width_implied_px,
      bbox:                      bboxDiag,
      h_matrix:                  h_matrix_diag,
    },
  });
}
