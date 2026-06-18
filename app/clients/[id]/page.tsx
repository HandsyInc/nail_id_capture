import Link from "next/link";
import { notFound } from "next/navigation";

import { getOrCreateArtist } from "@/lib/artist";
import { prisma } from "@/lib/prisma";
import { startCaptureSession, startRecaptureSession } from "./actions";

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

  {client.captureSessions.filter(
  (session) => session.type === "INITIAL" && session.status === "SUBMITTED"
).length === 0 ? (
    <p>No capture sessions yet.</p>
  ) : (
    <ul>
      {client.captureSessions.map((session) => (
  <li key={session.id} style={{ marginBottom: "1rem" }}>
    <p>
      {session.status} — {session.createdAt.toLocaleDateString()}
    </p>

    {session.captureLinkToken ? (
      <div>
        <a
          href={`/capture-v2?token=${session.captureLinkToken}`}
          target="_blank"
          rel="noreferrer"
          style={{
            display: "inline-block",
            marginTop: "0.5rem",
            padding: "6px 10px",
            background: "#0f172a",
            color: "white",
            borderRadius: "6px",
            textDecoration: "none",
          }}
        >
          Open Capture
        </a>

        <p style={{ marginTop: "0.5rem" }}>
          Expires:{" "}
          {session.captureLinkExpiresAt
            ? session.captureLinkExpiresAt.toLocaleDateString()
            : "No expiration"}
        </p>
      </div>
    ) : (
      <p style={{ color: "#999" }}>
        No capture link generated.
      </p>
    )}
  </li>
))}
    </ul>
  )}
  <section style={{ marginTop: "2rem" }}>
  <h2>Request Recapture</h2>

  {client.captureSessions.filter((session: any) => session.type === "INITIAL" && session.status === "SUBMITTED").length === 0 ? (
    <p>No parent capture session available yet.</p>
  ) : (
    <form
      action={async (formData) => {
        "use server";

        const parentCaptureSessionId = String(formData.get("parentCaptureSessionId"));
        const hand = String(formData.get("hand"));
        const finger = String(formData.get("finger"));
        const recaptureReason = String(formData.get("recaptureReason")) as
          | "PHOTO_ISSUE"
          | "MEASUREMENT_CONFIRMATION"
          | "OTHER";
        const recaptureNote = String(formData.get("recaptureNote") || "");

        await startRecaptureSession({
          clientId: client.id,
          parentCaptureSessionId,
          recaptureReason,
          recaptureNote,
          recaptureTargets: [
            {
              hand: hand as "LEFT" | "RIGHT",
              finger: finger as "THUMB" | "INDEX" | "MIDDLE" | "RING" | "PINKY",
              views: ["TOP", "FRONT", "SIDE"],
            },
          ],
        });
      }}
    >
      <input
        type="hidden"
        name="parentCaptureSessionId"
        value={client.captureSessions.find((session) => session.type === "INITIAL" && session.status === "SUBMITTED")?.id}
      />

      <p>
        <label>
          Hand{" "}
          <select
  name="hand"
  required
  style={{ color: "black" }}
>
            <option value="LEFT">Left Hand</option>
            <option value="RIGHT">Right Hand</option>
          </select>
        </label>
      </p>

      <p>
        <label>
          Finger{" "}
          <select
  name="finger"
  required
  style={{ color: "black" }}
>
            <option value="THUMB">Thumb</option>
            <option value="INDEX">Index</option>
            <option value="MIDDLE">Middle</option>
            <option value="RING">Ring</option>
            <option value="PINKY">Pinky</option>
          </select>
        </label>
      </p>

      <p>
        Required photos: Top View, Front View, Side View
      </p>

      <p>
        <label>
          Reason{" "}
          <select
  name="recaptureReason"
  required
  style={{ color: "black" }}
>
            <option value="PHOTO_ISSUE">Photo Issue</option>
            <option value="MEASUREMENT_CONFIRMATION">
              Measurement Confirmation
            </option>
            <option value="OTHER">Other</option>
          </select>
        </label>
      </p>

      <p>
        <label>
          Note{" "}
          <textarea
  name="recaptureNote"
  placeholder="Optional note"
  rows={3}
  style={{
    display: "block",
    width: "100%",
    maxWidth: "420px",
    color: "black",
  }}
/>
        </label>
      </p>

      <button type="submit">Generate Recapture Link</button>
    </form>
  )}
</section>
</section>

      <section style={{ marginTop: "2rem" }}>
        <h2>Recommendations</h2>
        <p>No recommendations yet.</p>
      </section>
    </main>
  );
}