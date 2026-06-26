import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getOrCreateArtist } from '@/lib/artist';
import { type MeasurementProvenance } from '@/lib/measure/provenance';

/**
 * POST /api/measure/transverse/accept
 *
 * D4.9 persistence: saves an accepted IC (inter-curvature) result from a
 * transverse (end-on curl) capture.
 *
 * Persistence decision mirrors /api/measure/chord/accept:
 *   1. GeometryPackage with captureSessionId = sessionId AND isCurrent = true
 *      → merge into GeometryPackage.icData.icMeasurements[HAND_FINGER].
 *   2. Otherwise → write to CaptureImage.chordMeasurement (JSONB fallback).
 *
 * Body JSON:
 *   captureImageId     string
 *   sessionId          string
 *   chordEndpointsPx   [{ x, y }, { x, y }]   — chord in full-res image pixels
 *   apexPx             { x, y }                — arc apex in full-res image pixels
 *   chordLengthPx      number
 *   sagittaPx          number
 *   arcScore           number                  — sagittaPx / chordLengthPx
 *   chordWidthMm       number | null           — null when no homography at capture
 *   sagittaMm          number | null
 *   icMm               number | null
 *   apexProvenance     MeasurementProvenance<Point> | null
 *
 * Response JSON:
 *   { persisted: true, location: "geometry_package" | "capture_image", recordId: string, key: string }
 */

export type Point = { x: number; y: number };

export type ICMeasurementRecord = {
  captureImageId:    string;
  hand:              string;
  finger:            string;
  // Pixel-space — always available (extraction runs without homography)
  chordEndpointsPx:  [Point, Point];
  apexPx:            Point;
  chordLengthPx:     number;
  sagittaPx:         number;
  arcScore:          number;
  // mm-space — null when no card homography was present at capture time
  chordWidthMm:      number | null;
  sagittaMm:         number | null;
  icMm:              number | null;
  /**
   * Full provenance for the apex landmark.
   *
   * - computerProposal.value       = auto-detected apex (Point, px)
   * - computerProposal.score       = peak Sobel gradient score
   * - computerProposal.confidence  = 'high' | 'low'
   * - computerProposal.method      = 'PERP_BISECTOR_GRADIENT'
   * - computerProposal.extra.arcScore = sagittaPx/chordPx at proposed apex
   * - founderValue                 = the apex the founder accepted
   * - acceptedProposal             = true when founder pressed "Accept apex"
   * - correctionMagnitude          = Euclidean px between proposed and accepted
   *
   * Null when auto-detection was skipped (canvas unavailable, SecurityError,
   * chord too short, gradient below threshold, arcScore outside gates).
   */
  apexProvenance:    MeasurementProvenance<Point> | null;
  /**
   * Laplacian variance of the nail ROI at measurement time.
   * Higher = sharper. Null when the canvas was unavailable.
   * Stored so detector training can correlate proposal accuracy with image
   * quality — failures on blurry images are a different problem than failures
   * on sharp images with difficult anatomy.
   */
  regionBlurScore:   number | null;
  method:            'SAGITTA_CLIENT_EXTRACT';
  measuredAt:        string;
  acceptedBy:        string;
  acceptedAt:        string;
};

export async function POST(req: Request) {
  // ── Auth ───────────────────────────────────────────────────────────────────
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
    chordEndpointsPx,
    apexPx,
    chordLengthPx,
    sagittaPx,
    arcScore,
    chordWidthMm    = null,
    sagittaMm       = null,
    icMm            = null,
    apexProvenance  = null,
    regionBlurScore = null,
  } = body as {
    captureImageId:    string;
    sessionId:         string;
    chordEndpointsPx:  [Point, Point];
    apexPx:            Point;
    chordLengthPx:     number;
    sagittaPx:         number;
    arcScore:          number;
    chordWidthMm?:     number | null;
    sagittaMm?:        number | null;
    icMm?:             number | null;
    apexProvenance?:   MeasurementProvenance<Point> | null;
    regionBlurScore?:  number | null;
  };

  // ── Validate required fields ───────────────────────────────────────────────
  if (!captureImageId || typeof captureImageId !== 'string') {
    return NextResponse.json({ error: 'captureImageId is required' }, { status: 400 });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
  }
  if (
    !Array.isArray(chordEndpointsPx) ||
    chordEndpointsPx.length !== 2 ||
    !apexPx ||
    typeof chordLengthPx !== 'number' ||
    typeof sagittaPx     !== 'number' ||
    typeof arcScore      !== 'number'
  ) {
    return NextResponse.json(
      { error: 'chordEndpointsPx, apexPx, chordLengthPx, sagittaPx, arcScore are required' },
      { status: 400 },
    );
  }

  // ── Fetch CaptureImage for hand / finger ───────────────────────────────────
  const capture = await prisma.captureImage.findUnique({
    where:  { id: captureImageId },
    select: { hand: true, finger: true, sessionId: true, imageType: true },
  });

  if (!capture) {
    return NextResponse.json(
      { error: `CaptureImage ${captureImageId} not found` },
      { status: 404 },
    );
  }

  if (capture.imageType !== 'TRANSVERSE') {
    return NextResponse.json(
      { error: `IC accept requires TRANSVERSE images; this is ${capture.imageType}` },
      { status: 422 },
    );
  }

  // ── Verify session ownership ───────────────────────────────────────────────
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

  const record: ICMeasurementRecord = {
    captureImageId,
    hand:             capture.hand,
    finger:           capture.finger,
    chordEndpointsPx,
    apexPx,
    chordLengthPx,
    sagittaPx,
    arcScore,
    chordWidthMm,
    sagittaMm,
    icMm,
    apexProvenance,
    regionBlurScore,
    method:      'SAGITTA_CLIENT_EXTRACT',
    measuredAt:  now,
    acceptedBy:  artist.id,
    acceptedAt:  now,
  };

  // ── Persistence: always write to GeometryPackage ──────────────────────────
  // Same pattern as chord accept: create a HandsyFit + GeometryPackage on
  // first use if none exists yet. The CaptureImage fallback is removed so
  // all geometry lives in one place and widthData → icData linkage works.

  const key = `${capture.hand}_${capture.finger}`;

  const gp = await prisma.geometryPackage.findFirst({
    where:   { captureSessionId: sessionId, isCurrent: true },
    orderBy: { version: 'desc' },
    select:  { id: true, icData: true },
  });

  if (gp) {
    const existing = (gp.icData as Record<string, unknown> | null) ?? {};
    const icMeasurements: Record<string, ICMeasurementRecord> =
      (existing.icMeasurements as Record<string, ICMeasurementRecord>) ?? {};
    icMeasurements[key] = record;

    await prisma.geometryPackage.update({
      where: { id: gp.id },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data:  { icData: { ...existing, icMeasurements } as any },
    });

    return NextResponse.json({ persisted: true, location: 'geometry_package', recordId: gp.id, key });
  }

  // No GeometryPackage yet — provision one (and a HandsyFit if needed).
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      icData: { icMeasurements: { [key]: record } } as any,
    },
  });

  return NextResponse.json({ persisted: true, location: 'geometry_package', recordId: newGp.id, key });
}
