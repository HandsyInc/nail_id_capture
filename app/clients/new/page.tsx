import { redirect } from "next/navigation";
import { getOrCreateArtist } from "@/lib/artist";
import { prisma } from "@/lib/prisma";

async function createClient(formData: FormData) {
  "use server";

  const artist = await getOrCreateArtist();

  const name = formData.get("name")?.toString().trim();
  const email = formData.get("email")?.toString().trim();

  if (!name || !email) {
    throw new Error("Name and email are required");
  }

  await prisma.client.create({
    data: {
      artistId: artist.id,
      name,
      email,
    },
  });

  redirect("/dashboard");
}

export default function NewClientPage() {
  return (
    <main style={{ padding: "2rem" }}>
      <h1>New Client</h1>

      <form action={createClient}>
        <div>
          <label>Name</label>
          <br />
          <input
            type="text"
            name="name"
            required
            style={{
              color: "black",
              padding: "0.5rem",
            }}
          />
        </div>

        <br />

        <div>
          <label>Email</label>
          <br />
          <input
            type="email"
            name="email"
            required
            style={{
              color: "black",
              padding: "0.5rem",
            }}
          />
        </div>

        <br />

        <button type="submit">Create Client</button>
      </form>
    </main>
  );
}