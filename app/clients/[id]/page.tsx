import Link from "next/link";
import { notFound } from "next/navigation";

import { getOrCreateArtist } from "@/lib/artist";
import { prisma } from "@/lib/prisma";
import { startCaptureSession } from "./actions";

export default async function ClientPage({
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
    include: {
      captureSessions: {
        orderBy: {
          createdAt: "desc",
        },
      },
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

      <form
        action={async () => {
          "use server";
          await startCaptureSession(client.id);
        }}
      >
        <button type="submit">Start Capture Session</button>
      </form>

      <section style={{ marginTop: "2rem" }}>
  <h2>Capture Sessions</h2>

  {client.captureSessions.length === 0 ? (
    <p>No capture sessions yet.</p>
  ) : (
    <ul>
      {client.captureSessions.map((session) => (
        <li key={session.id} style={{ marginBottom: "1rem" }}>
          <p>
            {session.status} — {session.createdAt.toLocaleDateString()}
          </p>

          {session.captureLinkToken ? (
            <>
              <p>
  Capture Link:{" "}
  <a
    href={`/capture/${session.captureLinkToken}`}
    target="_blank"
    rel="noreferrer"
    style={{ color: "#60a5fa", textDecoration: "underline" }}
  >
    Open Capture
  </a>
</p>

              <p>
                Expires:{" "}
                {session.captureLinkExpiresAt
                  ? session.captureLinkExpiresAt.toLocaleDateString()
                  : "No expiration"}
              </p>
            </>
          ) : (
            <p>No capture link generated.</p>
          )}
        </li>
      ))}
    </ul>
  )}
</section>

      <section style={{ marginTop: "2rem" }}>
        <h2>Recommendations</h2>
        <p>No recommendations yet.</p>
      </section>
    </main>
  );
}