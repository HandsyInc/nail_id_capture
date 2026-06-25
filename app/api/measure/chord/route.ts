import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getFromR2 } from '@/lib/r2';

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

  return NextResponse.json({ captureImageId, ...result });
}
