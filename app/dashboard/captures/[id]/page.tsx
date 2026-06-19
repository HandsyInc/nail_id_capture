import Link from "next/link";
import { notFound } from "next/navigation";

import { getOrCreateArtist } from "@/lib/artist";
import { prisma } from "@/lib/prisma";

export default async function CaptureViewerPage({
  params,
}: {
  params: { id: string };
}) {
  const artist = await getOrCreateArtist();

  const session = await prisma.captureSession.findFirst({
    where: {
      id: params.id,
      client: {
        artistId: artist.id,
      },
    },
    include: {
      client: true,
      images: true,
      },
  });

  if (!session) {
    notFound();
  }

  return (
    <main style={{ padding: "2rem" }}>
      <p>
        <Link href={`/clients/${session.client.id}`}>← Back to Client</Link>
      </p>

      <h1>Capture Session</h1>

      <p>Client: {session.client.name}</p>
      <p>Status: {session.status}</p>
      <p>Created: {session.createdAt.toLocaleDateString()}</p>

      <section style={{ marginTop: "2rem" }}>
        <h2>Images</h2>

        {session.images.length === 0 ? (
          <p>No images uploaded yet.</p>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
              gap: "1rem",
            }}
          >
            {session.images.map((image: any) => {

              return (
                <div
                  key={image.id}
                  style={{
                    border: "1px solid #ddd",
                    borderRadius: "8px",
                    padding: "0.75rem",
                  }}
                >
                  <img
                    src={`/api/captures/images/${image.id}`}
                    alt="Capture image"
                    style={{
                      width: "100%",
                      borderRadius: "6px",
                    }}
                  />

                  <p style={{ marginTop: "0.5rem" }}>
  Hand: {image.hand || "-"}
  <br />
  Finger: {image.finger || "-"}
  <br />
  Type: {image.imageType || "-"}
</p>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}