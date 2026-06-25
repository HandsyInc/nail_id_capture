import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { getOrCreateArtist } from '@/lib/artist';
import { ChordWorkspace } from '@/components/measure/ChordWorkspace';

/**
 * /measure/chord?sessionId=<id>
 *
 * D4.7 founder-assisted chord-width measurement page.
 * Mirrors the /measure/wz structure: server-side auth + Prisma fetch,
 * then hands off to ChordWorkspace (client component).
 */
export default async function ChordMeasurePage({
  searchParams,
}: {
  searchParams: { sessionId?: string };
}) {
  const sessionId = searchParams?.sessionId;
  if (!sessionId) notFound();

  const artist = await getOrCreateArtist();

  const session = await prisma.captureSession.findFirst({
    where: {
      id: sessionId,
      client: { artistId: artist.id },
    },
    include: {
      client: true,
      images: {
        where:   { imageType: 'TOP_DOWN' },
        orderBy: { sequenceNumber: 'asc' },
      },
    },
  });

  if (!session) notFound();

  // Only TOP_DOWN images with h_matrix populated can be measured.
  // Show all of them in the workspace (unmeasured ones will show the error
  // inline from the API rather than being silently excluded).
  const images = session.images.map((img) => ({
    imageId:        img.id,
    hand:           img.hand   as string,
    finger:         img.finger as string,
    sequenceNumber: img.sequenceNumber,
    url:            `/api/captures/images/${img.id}`,
  }));

  return (
    <ChordWorkspace
      sessionId={session.id}
      clientName={session.client.name}
      images={images}
    />
  );
}
