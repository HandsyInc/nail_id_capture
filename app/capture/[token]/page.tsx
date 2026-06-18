import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

export default async function CapturePage({
  params,
}: {
  params: { token: string };
}) {
  const session = await prisma.captureSession.findUnique({
    where: {
      captureLinkToken: params.token,
    },
    include: {
      client: true,
      artist: true,
    },
  });

  if (!session) {
    notFound();
  }

  return (
    <main style={{ padding: "2rem" }}>
      <h1>Handsy Capture</h1>

      <p>Session found.</p>
      <p>Client: {session.client.name}</p>
      <p>Artist: {session.artist.name}</p>
      <p>Status: {session.status}</p>
      <p>Token: {session.captureLinkToken}</p>
    </main>
  );
}