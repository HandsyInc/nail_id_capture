import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getOrCreateArtist } from '@/lib/artist';
import {
  type MeasurementProvenance,
  buildScalarProvenance,
} from '@/lib/measure/provenance';

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
  /**
   * Measurement provenance — the computer's SAM2 proposal vs. what the
   * founder accepted, with attempt count.
   *
   * For chord, the founder cannot numerically override the service result;
   * the correction signal is in provenance.attemptCount (retries before
   * acceptance) rather than a value delta.
   *
   * Null for records created before provenance tracking was added (D4.x).
   */
  provenance:      MeasurementProvenance<number> | null;
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
    attempt_count  = null,
  } = body as {
    captureImageId:  string;
    sessionId:       string;
    width_mm:        number;
    length_mm:       number;
    angle_deg?:      number;
    contour_px:      [number, number][];
    mrr_corners_mm?: [number, number][];
    nail_click_px:   { x: number; y: number };
    /** Number of service calls made before this accepted result. */
    attempt_count?:  number | null;
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

  // Verify ownership and fetch handsyFitId (needed if we must create a GP).
  const session = await prisma.captureSession.findFirst({
    where:  { id: sessionId, artistId: artist.id },
    select: { id: true, handsyFitId: true },
  });

  if (!session) {
    return NextResponse.json(
      { error: 'Session not found or not owned by current artist' },
      { status: 403 },
    );
  }

  const now = new Date().toISOString();

  // Build provenance. For chord the computer always proposes via SAM2 on the
  // founder's seed click, and the founder cannot numerically override — only
  // retry. acceptedProposal = true when this was the first attempt.
  const provenance = buildScalarProvenance(
    {
      value:      width_mm,
      confidence: 'high',       // service result is always emitted at full confidence
      score:      null,         // SAM2 mask quality score not yet surfaced to client
      method:     'SAM2_CONTOUR',
      extra:      {
        length_mm,
        angle_deg: angle_deg ?? null,
      },
    },
    width_mm,
    attempt_count,
  );

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
    provenance,
    method:         'SAM2_FOUNDER_CLICK_CHORD',
    measuredAt:     now,
    acceptedBy:     artist.id,
    acceptedAt:     now,
  };

  // ── Persistence: always write to GeometryPackage ───────────────────────
  //
  // Look for an existing current GeometryPackage for this session.
  // If none exists (e.g. dev seeds, or sessions submitted before the
  // submission flow pre-initialised the GP), create one automatically —
  // creating a HandsyFit first if the session doesn't already have one.
  //
  // The CaptureImage.chordMeasurement fallback is intentionally removed:
  // the transverse page (and all downstream geometry consumers) only read
  // from GeometryPackage.widthData, so falling back silently was breaking
  // the width → IC pipeline.

  const key = `${capture.hand}_${capture.finger}`;

  const gp = await prisma.geometryPackage.findFirst({
    where:   { captureSessionId: sessionId, isCurrent: true },
    orderBy: { version: 'desc' },
    select:  { id: true, widthData: true },
  });

  if (gp) {
    const existing = (gp.widthData as Record<string, unknown> | null) ?? {};
    const chordMeasurements: Record<string, ChordMeasurementRecord> =
      (existing.chordMeasurements as Record<string, ChordMeasurementRecord>) ?? {};
    chordMeasurements[key] = record;

    await prisma.geometryPackage.update({
      where: { id: gp.id },

      data: { widthData: { ...existing, chordMeasurements } as any },
    });

    return NextResponse.json({ persisted: true, location: 'geometry_package', recordId: gp.id, key });
  }

  // No GeometryPackage yet — create one, provisioning a HandsyFit if needed.
  let handsyFitId = session.handsyFitId ?? null;

  if (!handsyFitId) {
    const hf = await prisma.handsyFit.create({
      data: { publicIdentifier: `hf-auto-${sessionId}` },
    });
    handsyFitId = hf.id;
    await prisma.captureSession.update({
      where: { id: sessionId },
      data:  { handsyFitId },
    });
  }

  const newGp = await prisma.geometryPackage.create({
    data: {
      handsyFitId,
      captureSessionId: sessionId,
      version:          1,
      isCurrent:        true,
      pipelineVersion:  'founder-measure-v1',

      widthData: { chordMeasurements: { [key]: record } } as any,
    },
  });

  return NextResponse.json({ persisted: true, location: 'geometry_package', recordId: newGp.id, key });
}
