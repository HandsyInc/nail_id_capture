import { currentUser } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

export async function getOrCreateArtist() {
  const user = await currentUser();

  if (!user) {
    throw new Error("Unauthorized");
  }

  const email = user.emailAddresses[0]?.emailAddress;

  if (!email) {
    throw new Error("User has no email address");
  }

  return prisma.artist.upsert({
    where: {
      clerkId: user.id,
    },
    update: {},
    create: {
      clerkId: user.id,
      email,
      name: user.fullName ?? email,
    },
  });
}