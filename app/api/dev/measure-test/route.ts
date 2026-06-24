import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getFromR2 } from '@/lib/r2';

/**
 * POST /api/dev/measure-test
 *
 * Development-only bridge test for the 2A.1 absolute width pipeline.
 *
 * Proves the full chain:
 *   DB (h_matrix JSONB) → R2 (image bytes) → nail-measure-service → width_mm
 *
 * Scoped to TOP_DOWN CaptureImage records only — h_matrix is only meaningful
 * for top-down captures where a calibration card is present. LONGITUDINAL and
 * TRANSVERSE captures do not use a card and are explicitly rejected.
 *
 * Body JSON:
 *   captureImageId  string           — id of a TOP_DOWN CaptureImage with h_matrix populated
 *   contour_px      [number,number][] — nail contour in image pixel coords (≥3 points)
 *   h_mm            number?          — card-to-nail distance in mm (default 25)
 *   D_mm            number?          — camera-to-card distance in mm (default 269)
 *   measureServiceUrl string?        — nail-measure-service base URL (default http://localhost:8001)
 *
 * Response JSON (on success):
 *   captureImageId, h_matrix_retrieved: true, width_mm, mrr_width_raw_mm,
 *   mrr_length_mm, mrr_angle_deg, h_used_mm, D_used_mm, contour_px, status, message
 */

const DEFAULT_MEASURE_URL = 'http://localhost:8001';

function isMatrix3x3(v: unknown): v is number[][] {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 3 &&
        row.every((n) => typeof n === 'number' && Number.isFinite(n))
    )
  );
}

export async function POST(req: Request) {
  const body = await req.json();
  const {
    captureImageId,
    contour_px,
    h_mm = 25,
    D_mm = 269,
    measureServiceUrl = DEFAULT_MEASURE_URL,
  } = body as {
    captureImageId: string;
    contour_px: [number, number][];
    h_mm?: number;
    D_mm?: number;
    measureServiceUrl?: string;
  };

  // ── Input validation ────────────────────────────────────────────────────────

  if (!captureImageId || typeof captureImageId !== 'string') {
    return NextResponse.json(
      { error: 'captureImageId is required' },
      { status: 400 }
    );
  }
  if (!Array.isArray(contour_px) || contour_px.length < 3) {
    return NextResponse.json(
      { error: 'contour_px must be an array of ≥3 [x, y] pairs' },
      { status: 400 }
    );
  }

  // ── Retrieve CaptureImage from DB ───────────────────────────────────────────

  const capture = await prisma.captureImage.findUnique({
    where: { id: captureImageId },
    select: { imageType: true, h_matrix: true, storageKey: true },
  });

  if (!capture) {
    return NextResponse.json(
      { error: `CaptureImage ${captureImageId} not found` },
      { status: 404 }
    );
  }

  // Reject non-TOP_DOWN: h_matrix is only valid for top-down card captures.
  if (capture.imageType !== 'TOP_DOWN') {
    return NextResponse.json(
      {
        error: `h_matrix is only meaningful for TOP_DOWN captures. This record is ${capture.imageType}.`,
        imageType: capture.imageType,
      },
      { status: 422 }
    );
  }

  if (capture.h_matrix === null) {
    return NextResponse.json(
      {
        error:
          'h_matrix is null — card was not detected during this capture, ' +
          'or the capture predates Phase 2 migration.',
        captureImageId,
      },
      { status: 422 }
    );
  }

  if (!isMatrix3x3(capture.h_matrix)) {
    return NextResponse.json(
      {
        error: 'h_matrix retrieved from DB is not a valid 3×3 array of finite numbers',
        value: capture.h_matrix,
      },
      { status: 422 }
    );
  }

  // ── Fetch image bytes from R2 ───────────────────────────────────────────────

  const { body: imageBytes, contentType } = await getFromR2(capture.storageKey);

  // ── POST to nail-measure-service ────────────────────────────────────────────

  const form = new FormData();
  form.append(
    'image',
    new Blob([imageBytes.buffer as ArrayBuffer], { type: contentType }),
    'capture.jpg'
  );
  form.append('H_matrix', JSON.stringify(capture.h_matrix));
  form.append('h_mm', String(h_mm));
  form.append('D_mm', String(D_mm));
  form.append('contour_px', JSON.stringify(contour_px));

  let serviceRes: Response;
  try {
    serviceRes = await fetch(`${measureServiceUrl}/measure`, {
      method: 'POST',
      body: form,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'Could not reach nail-measure-service. Is it running?',
        measureServiceUrl,
        detail: String(err),
      },
      { status: 502 }
    );
  }

  if (!serviceRes.ok) {
    const text = await serviceRes.text();
    return NextResponse.json(
      { error: 'nail-measure-service returned an error', detail: text },
      { status: 502 }
    );
  }

  const result = await serviceRes.json();

  return NextResponse.json({
    captureImageId,
    h_matrix_retrieved: true,
    ...result,
  });
}
