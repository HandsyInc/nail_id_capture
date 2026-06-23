import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { getOrCreateArtist } from '@/lib/artist';
import { WzSessionWorkspace } from '@/components/measure/WzSessionWorkspace';

export default async function WzMeasurePage({
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
        where: { imageType: 'TOP_DOWN' },
        orderBy: { sequenceNumber: 'asc' },
      },
    },
  });

  if (!session) notFound();

  const images = session.images.map((img) => ({
    imageId: img.id,
    hand: img.hand as string,
    finger: img.finger as string,
    sequenceNumber: img.sequenceNumber,
    url: `/api/captures/images/${img.id}`,
  }));

  return (
    <WzSessionWorkspace
      sessionId={session.id}
      clientName={session.client.name}
      images={images}
    />
  );
}
