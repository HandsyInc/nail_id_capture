import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getOrCreateArtist } from '@/lib/artist';

/**
 * POST /api/measure/chord/accept
 *
 * D4.7 persistence: saves an accepted chord-width result.
 *
 * Persistence decision:
 *   1. If a GeometryPackage with captureSessionId = sessionId AND isCurrent = true
 *      exists → merge into GeometryPackage.widthData.chordMeasurements[HAND_FINGER].
 *   2. Otherwise → write to CaptureImage.chordMeasurement (nullable JSONB fallback).
 *
 * The service endpoint (/api/measure/chord) remains stateless.  This route owns
 * all Prisma writes.
 *
 * Body JSON:
 *   captureImageId   string
 *   sessionId        string
 *   width_mm         number
 *   length_mm        number
 *   angle_deg?       number
 *   contour_px       [number, number][]
 *   mrr_corners_mm?  [number, number][]
 *   nail_click_px    { x: number; y: number }
 *
 * Response JSON:
 *   { persisted: true, location: "geometry_package" | "capture_image", recordId: string }
 */

export type ChordMeasurementRecord = {
  captureImageId:  string;
  hand:            string;
  finger:          string;
  width_mm:        number;
  length_mm:       number;
  angle_deg:       number | null;
  contour_px:      [number, number][];
  mrr_corners_mm:  [number, number][] | null;
  nail_click_px:   { x: number; y: number };
  method:          'SAM2_FOUNDER_CLICK_CHORD';
  measuredAt:      string;
  acceptedBy:      string;        // artist.id
  acceptedAt:      string;
};

export async function POST(req: Request) {
  // ── Auth ───────────────────────────────────────────────────────────────
  let artist: Awaited<ReturnType<typeof getOrCreateArtist>>;
  try {
    artist = await getOrCreateArtist();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const {
    captureImageId,
    sessionId,
    width_mm,
    length_mm,
    angle_deg = null,
    contour_px,
    mrr_corners_mm = null,
    nail_click_px,
  } = body as {
    captureImageId:  string;
    sessionId:       string;
    width_mm:        number;
    length_mm:       number;
    angle_deg?:      number;
    contour_px:      [number, number][];
    mrr_corners_mm?: [number, number][];
    nail_click_px:   { x: number; y: number };
  };

  // ── Validate required fields ────────────────────────────────────────────
  if (!captureImageId || !sessionId) {
    return NextResponse.json(
      { error: 'captureImageId and sessionId are required' },
      { status: 400 },
    );
  }
  if (typeof width_mm !== 'number' || typeof length_mm !== 'number') {
    return NextResponse.json(
      { error: 'width_mm and length_mm are required numbers' },
      { status: 400 },
    );
  }

  // ── Fetch CaptureImage for hand / finger ────────────────────────────────
  const capture = await prisma.captureImage.findUnique({
    where: { id: captureImageId },
    select: { hand: true, finger: true, sessionId: true },
  });

  if (!capture) {
    return NextResponse.json(
      { error: `CaptureImage ${captureImageId} not found` },
      { status: 404 },
    );
  }

  // Verify ownership: the image's session must belong to this artist.
  const session = await prisma.captureSession.findFirst({
    where: { id: sessionId, artistId: artist.id },
    select: { id: true },
  });

  if (!session) {
    return NextResponse.json(
      { error: 'Session not found or not owned by current artist' },
      { status: 403 },
    );
  }

  const now = new Date().toISOString();

  const record: ChordMeasurementRecord = {
    captureImageId,
    hand:           capture.hand,
    finger:         capture.finger,
    width_mm,
    length_mm,
    angle_deg:      angle_deg ?? null,
    contour_px,
    mrr_corners_mm: mrr_corners_mm ?? null,
    nail_click_px,
    method:         'SAM2_FOUNDER_CLICK_CHORD',
    measuredAt:     now,
    acceptedBy:     artist.id,
    acceptedAt:     now,
  };

  // ── Persistence decision ────────────────────────────────────────────────
  // Try GeometryPackage first (isCurrent, linked to this session).
  const gp = await prisma.geometryPackage.findFirst({
    where: { captureSessionId: sessionId, isCurrent: true },
    orderBy: { version: 'desc' },
    select: { id: true, widthData: true },
  });

  if (gp) {
    // Merge into GeometryPackage.widthData.chordMeasurements[HAND_FINGER]
    const existing = (gp.widthData as Record<string, unknown> | null) ?? {};
    const chordMeasurements: Record<string, ChordMeasurementRecord> =
      (existing.chordMeasurements as Record<string, ChordMeasurementRecord>) ?? {};

    const key = `${capture.hand}_${capture.finger}`;
    chordMeasurements[key] = record;

    await prisma.geometryPackage.update({
      where: { id: gp.id },
      data: { widthData: { ...existing, chordMeasurements } },
    });

    return NextResponse.json({
      persisted:  true,
      location:   'geometry_package',
      recordId:   gp.id,
      key,
    });
  }

  // Fallback: CaptureImage.chordMeasurement
  await prisma.captureImage.update({
    where: { id: captureImageId },
    data:  { chordMeasurement: record as unknown as object },
  });

  return NextResponse.json({
    persisted:  true,
    location:   'capture_image',
    recordId:   captureImageId,
  });
}
