import { NextResponse }       from 'next/server';
import { prisma }             from '@/lib/prisma';
import { getOrCreateArtist }  from '@/lib/artist';
import {
  type MeasurementProvenance,
} from '@/lib/measure/provenance';

/**
 * POST /api/measure/longitudinal/accept
 *
 * D4.10 persistence: saves an accepted longitudinal profile result.
 *
 * Receives three founder-placed landmarks from a side-view (LONGITUDINAL)
 * CaptureImage and all derived geometry computed client-side. Writes to
 * GeometryPackage.longitudinalData.longitudinalMeasurements[HAND_FINGER].
 *
 * Mirrors /api/measure/transverse/accept exactly — same session ownership
 * check, same GeometryPackage auto-provisioning, same provenance shape.
 *
 * ── Record shape ──────────────────────────────────────────────────────────
 *
 *   Pixel-space landmarks (always present):
 *     cuticlePx, freeEdgePx, apexPx, chordLengthPx, heightPx,
 *     apexPositionRatio
 *
 *   mm-space (null when no H matrix was available on the image):
 *     lengthMm, heightMm, hOverL, apexPositionPercent
 *
 *   Provenance:
 *     apexProvenance — MeasurementProvenance<Point>
 *     computerProposal is null for D4.10 (purely founder-placed; no
 *     auto-detection implemented yet). method on the record is
 *     'LONGITUDINAL_FOUNDER_CLICK'. When auto-detection is added in a future
 *     delta, computerProposal.method = 'LONGITUDINAL_CONTOUR' and the
 *     existing provenance shape handles it without schema change.
 *
 * ── Measurement completeness ──────────────────────────────────────────────
 *
 * GeometryPackage.longitudinalData is null until the first longitudinal
 * measurement is accepted. Presence of longitudinalData.longitudinalMeasurements
 * keyed by HAND_FINGER, plus the linked apexProvenance, constitutes a complete
 * D4.10 record. No separate status field is added to CaptureSession (there is
 * no precedent for per-measurement status in the D4.8/D4.9 architecture).
 *
 * Body JSON:
 *   captureImageId       string
 *   sessionId            string
 *   cuticlePx            { x, y }     — cuticle midpoint (natural image px)
 *   freeEdgePx           { x, y }     — free-edge midpoint (natural image px)
 *   apexPx               { x, y }     — apex (natural image px)
 *   chordLengthPx        number       — |cuticle → freeEdge|
 *   heightPx             number       — perpendicular distance apex to chord
 *   apexPositionRatio    number       — [0,1] projection of apex along chord from cuticle
 *   lengthMm             number|null
 *   heightMm             number|null
 *   hOverL               number|null
 *   apexPositionPercent  number|null
 *   apexProvenance       MeasurementProvenance<Point>|null
 *   regionBlurScore      number|null
 *
 * Response JSON:
 *   { persisted: true, location: "geometry_package", recordId: string, key: string }
 */

export type Point = { x: number; y: number };

export type LongitudinalMeasurementRecord = {
  captureImageId:      string;
  hand:                string;
  finger:              string;
  // Pixel-space — always available (no homography required)
  cuticlePx:           Point;
  freeEdgePx:          Point;
  apexPx:              Point;
  chordLengthPx:       number;
  heightPx:            number;
  /** Scalar projection of apex onto chord C→F, normalised to [0, 1]. */
  apexPositionRatio:   number;
  // mm-space — null when the LONGITUDINAL image had no H matrix
  lengthMm:            number | null;
  heightMm:            number | null;
  hOverL:              number | null;
  apexPositionPercent: number | null;
  /**
   * Provenance for the apex landmark.
   *
   * D4.10: computerProposal is always null (no auto-detection yet). The
   * buildPointProvenance helper is called with proposal = null, so
   * acceptedProposal and correctionMagnitude are both null.
   *
   * When longitudinal auto-detection is added, computerProposal.method
   * will be 'LONGITUDINAL_CONTOUR' and this field captures the correction
   * signal automatically with no schema change.
   */
  apexProvenance:      MeasurementProvenance<Point> | null;
  regionBlurScore:     number | null;
  method:              'LONGITUDINAL_FOUNDER_CLICK';
  measuredAt:          string;
  acceptedBy:          string;
  acceptedAt:          string;
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
    cuticlePx,
    freeEdgePx,
    apexPx,
    chordLengthPx,
    heightPx,
    apexPositionRatio,
    lengthMm           = null,
    heightMm           = null,
    hOverL             = null,
    apexPositionPercent = null,
    apexProvenance     = null,
    regionBlurScore    = null,
  } = body as {
    captureImageId:       string;
    sessionId:            string;
    cuticlePx:            Point;
    freeEdgePx:           Point;
    apexPx:               Point;
    chordLengthPx:        number;
    heightPx:             number;
    apexPositionRatio:    number;
    lengthMm?:            number | null;
    heightMm?:            number | null;
    hOverL?:              number | null;
    apexPositionPercent?: number | null;
    apexProvenance?:      MeasurementProvenance<Point> | null;
    regionBlurScore?:     number | null;
  };

  // ── Validate required fields ───────────────────────────────────────────────
  if (!captureImageId || typeof captureImageId !== 'string') {
    return NextResponse.json({ error: 'captureImageId is required' }, { status: 400 });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
  }
  if (
    !cuticlePx  || typeof cuticlePx.x  !== 'number' ||
    !freeEdgePx || typeof freeEdgePx.x !== 'number' ||
    !apexPx     || typeof apexPx.x     !== 'number'
  ) {
    return NextResponse.json(
      { error: 'cuticlePx, freeEdgePx, and apexPx are required {x,y} objects' },
      { status: 400 },
    );
  }
  if (typeof chordLengthPx !== 'number' || typeof heightPx !== 'number' || typeof apexPositionRatio !== 'number') {
    return NextResponse.json(
      { error: 'chordLengthPx, heightPx, and apexPositionRatio are required numbers' },
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

  if (capture.imageType !== 'LONGITUDINAL') {
    return NextResponse.json(
      { error: `Longitudinal accept requires LONGITUDINAL images; this is ${capture.imageType}` },
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

  const record: LongitudinalMeasurementRecord = {
    captureImageId,
    hand:              capture.hand,
    finger:            capture.finger,
    cuticlePx,
    freeEdgePx,
    apexPx,
    chordLengthPx,
    heightPx,
    apexPositionRatio,
    lengthMm,
    heightMm,
    hOverL,
    apexPositionPercent,
    apexProvenance,
    regionBlurScore,
    method:     'LONGITUDINAL_FOUNDER_CLICK',
    measuredAt:  now,
    acceptedBy:  artist.id,
    acceptedAt:  now,
  };

  // ── Persistence: always write to GeometryPackage ──────────────────────────
  // Mirrors transverse/accept exactly — prisma.geometryPackage used directly
  // now that `npx prisma generate` has been run with longitudinalData in the
  // schema. JSON data values still cast `as any` to satisfy TS (same as icData
  // in the transverse route). Auto-provisions HandsyFit + GeometryPackage on
  // first use.
  //
  // PREREQUISITE: `npx prisma db push` must have been run after the D4.10
  // migration to add longitudinalData to the GeometryPackage table in Postgres.
  // If the column is missing, the catch block surfaces the Postgres error.

  const key = `${capture.hand}_${capture.finger}`;

  try {
    const gp = await prisma.geometryPackage.findFirst({
      where:   { captureSessionId: sessionId, isCurrent: true },
      orderBy: { version: 'desc' },
      select:  { id: true, longitudinalData: true },
    });

    if (gp) {
      const existing = (gp.longitudinalData as Record<string, unknown> | null) ?? {};
      const longitudinalMeasurements: Record<string, LongitudinalMeasurementRecord> =
        (existing.longitudinalMeasurements as Record<string, LongitudinalMeasurementRecord>) ?? {};
      longitudinalMeasurements[key] = record;

      await prisma.geometryPackage.update({
        where: { id: gp.id },
        data:  { longitudinalData: { ...existing, longitudinalMeasurements } as any },
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
        longitudinalData: { longitudinalMeasurements: { [key]: record } } as any,
      },
    });

    return NextResponse.json({ persisted: true, location: 'geometry_package', recordId: newGp.id, key });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[longitudinal/accept] persistence error:', err);
    // Surface the actual DB/Prisma error to the client so the alert shows a
    // useful message. The most common cause is a missing `npx prisma db push`
    // after the D4.10 migration (longitudinalData column not yet in the table).
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
