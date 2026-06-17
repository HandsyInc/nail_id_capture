import { getOrCreateArtist } from "@/lib/artist";

export default async function DashboardPage() {
  const artist = await getOrCreateArtist();

  return (
    <main style={{ padding: "2rem" }}>
      <h1>Handsy FIT Dashboard</h1>
      <p>Artist ID: {artist.id}</p>
      <p>Artist Name: {artist.name}</p>
      <p>Artist Email: {artist.email}</p>
      <p>Clerk ID: {artist.clerkId}</p>
    </main>
  );
}