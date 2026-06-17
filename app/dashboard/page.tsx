import { getOrCreateArtist } from "@/lib/artist";

export default async function DashboardPage() {
  const artist = await getOrCreateArtist();

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
    </main>
  );
}