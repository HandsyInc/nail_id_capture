import Link from "next/link";
import { getOrCreateArtist } from "@/lib/artist";
import { prisma } from "@/lib/prisma";

export default async function DashboardPage() {
  const artist = await getOrCreateArtist();

  const clients = await prisma.client.findMany({
  where: {
    artistId: artist.id,
  },
  include: {
    captureSessions: {
      orderBy: {
        createdAt: "desc",
      },
      include: {
        images: true,
      },
    },
  },
  orderBy: {
    createdAt: "desc",
  },
});

  const pendingReviews = await prisma.captureSession.findMany({
  where: {
    artistId: artist.id,
    status: "SUBMITTED",
    type: "INITIAL",
  },
  include: {
    client: true,
  },
  orderBy: {
    updatedAt: "desc",
  },
});

  return (
    <main style={{ padding: "2rem" }}>
      <h1>Handsy FIT Dashboard</h1>

      <p>Welcome, {artist.name}</p>

      <section>
        <h2>Overview</h2>
        <p>Clients: {artist._count.clients}</p>
        <p>Capture Sessions: {artist._count.captureSessions}</p>
        <p>Recommendations: {artist._count.recommendations}</p>
        <p>Revisions: {artist._count.revisions}</p>
      </section>
<section style={{ marginTop: "2rem" }}>
  <h2>Needs Review</h2>

  {pendingReviews.length === 0 ? (
    <p>No submitted captures awaiting review.</p>
  ) : (
    <ul>
      {pendingReviews.map((session: any) => (
        <li key={session.id}>
          <Link href={`/clients/${session.clientId}`}>
            {session.client.name}
          </Link>
        </li>
      ))}
    </ul>
  )}
</section>
      <section style={{ marginTop: "2rem" }}>
        <h2>Clients</h2>

        <p>
          <Link href="/clients/new">+ New Client</Link>
        </p>

        {clients.length === 0 ? (
          <p>No clients yet.</p>
        ) : (
          <ul>
            {clients.map((client: any) => (
              <li key={client.id}>
                <Link href={`/clients/${client.id}`}>{client.name}</Link>{" "}
                — {client.email}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}