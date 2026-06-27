import { notFound }           from 'next/navigation';
import { prisma }             from '@/lib/prisma';
import { getOrCreateArtist }  from '@/lib/artist';
import {
  LongitudinalWorkspace,
  type LongitudinalImageMeta,
} from '@/components/measure/LongitudinalWorkspace';

/**
 * /measure/longitudinal?sessionId=<id>
 *
 * D4.10 founder-assisted longitudinal measurement workspace.
 *
 * Fetches all LONGITUDINAL images for the session.
 *
 * ── mm scaling (currently blocked) ───────────────────────────────────────────
 *
 * Architecture decision: longitudinal mm values should come from a top-down
 * cross-reference (mirroring how transverse uses top-down chord width from
 * widthData.chordMeasurements[key].width_mm), NOT from a calibration card in
 * the side-view image. The longitudinal h_matrix is therefore intentionally
 * unused by the canvas.
 *
 * The closest available cross-reference is
 * widthData.chordMeasurements[key].length_mm (MRR long-axis from the top-down
 * SAM2 segmentation). However, that field measures cuticle → nail TIP, whereas
 * D4.10's F landmark is the hyponychium detachment line — not the tip. For
 * nail-enhancement clients the mismatch is several mm and would produce
 * silently wrong h values.
 *
 * Unblock when: a canonical cuticle → hyponychium length is stored in the
 * GeometryPackage (keyed by HAND_FINGER, same pattern as chordMeasurements).
 * Fetch it here and pass as nailBedLengthMm to LongitudinalCanvas; buildResult
 * already has the scale formula ready.
 *
 * Until then, all mm fields remain null. h/L and AP% in px-space are valid
 * ratios and are the primary D4.10 output.
 */

function isMatrix3x3(v: unknown): v is number[][] {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every(
      row =>
        Array.isArray(row) &&
        row.length === 3 &&
        row.every(n => typeof n === 'number' && Number.isFinite(n)),
    )
  );
}

export default async function LongitudinalMeasurePage({
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
        where:   { imageType: 'LONGITUDINAL' },
        orderBy: { sequenceNumber: 'asc' },
      },
    },
  });

  if (!session) notFound();

  const images: LongitudinalImageMeta[] = session.images.map(img => ({
    imageId:        img.id,
    hand:           img.hand   as string,
    finger:         img.finger as string,
    sequenceNumber: img.sequenceNumber,
    url:            `/api/captures/images/${img.id}`,
    // Validate the stored H matrix before passing to client.
    // Pass null (not the raw Json) when it doesn't parse as a valid 3x3.
    hMatrix:        isMatrix3x3(img.h_matrix) ? img.h_matrix : null,
  }));

  return (
    <LongitudinalWorkspace
      sessionId={session.id}
      clientName={session.client.name}
      images={images}
    />
  );
}
