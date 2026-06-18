import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrCreateArtist } from "@/lib/artist";
import { prisma } from "@/lib/prisma";

export default async function ClientDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const artist = await getOrCreateArtist();

  const client = await prisma.client.findFirst({
    where: {
      id: params.id,
      artistId: artist.id,
    },
  });

  if (!client) {
    notFound();
  }

  return (
    <main style={{ padding: "2rem" }}>
      <p>
        <Link href="/dashboard">← Back to Dashboard</Link>
      </p>

      <h1>{client.name}</h1>

      <p>Email: {client.email}</p>
      <p>Status: {client.status}</p>

      <section style={{ marginTop: "2rem" }}>
        <h2>Notes</h2>
        <p>{client.notes ?? "No notes yet."}</p>
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h2>Capture Sessions</h2>
        <p>No capture sessions yet.</p>
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h2>Recommendations</h2>
        <p>No recommendations yet.</p>
      </section>
    </main>
  );
}