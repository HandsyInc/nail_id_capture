import Link from "next/link";
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
    },
  });

  if (!session) {
    notFound();
  }

  return (
    <main style={{ padding: "2rem" }}>
      <h1>Welcome {session.client.name}</h1>

      <p>
        Your nail artist has invited you to complete a Handsy capture.
      </p>

      <p>
        This should take about 5 minutes.
      </p>

      <div style={{ marginTop: "2rem" }}>
        <Link href={`/capture-v2?session=${session.captureLinkToken}`}>
          Begin Capture
        </Link>
      </div>
    </main>
  );
}