"use server";

import { redirect } from "next/navigation";

import { getOrCreateArtist } from "@/lib/artist";
import { prisma } from "@/lib/prisma";

export async function startCaptureSession(clientId: string) {
  const artist = await getOrCreateArtist();

  const client = await prisma.client.findFirst({
    where: {
      id: clientId,
      artistId: artist.id,
    },
  });

  if (!client) {
    throw new Error("Client not found");
  }

  await prisma.captureSession.create({
    data: {
      clientId: client.id,
      artistId: artist.id,
    },
  });

  redirect(`/clients/${client.id}`);
}