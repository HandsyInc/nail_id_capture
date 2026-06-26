import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { getOrCreateArtist } from '@/lib/artist';
import { TransverseWorkspace } from '@/components/measure/TransverseWorkspace';

/**
 * /measure/transverse?sessionId=<id>
 *
 * D4.9 founder-assisted IC review workspace.
 *
 * Fetches:
 *   - All TRANSVERSE images for the session (index–pinky; thumbs excluded
 *     from the transverse capture protocol).
 *   - The current GeometryPackage's widthData.chordMeasurements so that each
 *     transverse canvas knows the accepted top-down width for its finger and
 *     can compute mm-space IC values.
 */
export default async function TransverseMeasurePage({
  searchParams,
}: {
  searchParams: { sessionId?: string };
}) {
  const sessionId = searchParams?.sessionId;
  if (!sessionId) notFound();

  const artist = await getOrCreateArtist();

  const session = await prisma.captureSession.findFirst({
    where: {
      id:     sessionId,
      client: { artistId: artist.id },
    },
    include: {
      client: true,
      images: {
        where:   { imageType: 'TRANSVERSE' },
        orderBy: { sequenceNumber: 'asc' },
      },
    },
  });

  if (!session) notFound();

  // ── Pull widthData from the current GeometryPackage ─────────────────────
  // widthData.chordMeasurements is keyed by "HAND_FINGER" (e.g. "LEFT_INDEX")
  // and each value has a width_mm field from the accepted top-down measurement.
  const gp = await prisma.geometryPackage.findFirst({
    where:   { captureSessionId: sessionId, isCurrent: true },
    orderBy: { version: 'desc' },
    select:  { widthData: true },
  });

  type ChordEntry = { width_mm: number };
  const chordMeasurements: Record<string, ChordEntry> =
    ((gp?.widthData as Record<string, unknown> | null)?.chordMeasurements as Record<string, ChordEntry>) ?? {};

  // ── Build image list with widthMm per finger ─────────────────────────────
  const images = session.images.map(img => {
    const key     = `${img.hand}_${img.finger}`;            // e.g. LEFT_INDEX
    const widthMm = chordMeasurements[key]?.width_mm ?? null;
    return {
      imageId:        img.id,
      hand:           img.hand   as string,
      finger:         img.finger as string,
      sequenceNumber: img.sequenceNumber,
      url:            `/api/captures/images/${img.id}`,
      widthMm,
    };
  });

  return (
    <TransverseWorkspace
      sessionId={session.id}
      clientName={session.client.name}
      images={images}
    />
  );
}
