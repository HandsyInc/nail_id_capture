"use server";

import { randomUUID } from "crypto";
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

  const token = randomUUID();

  await prisma.captureSession.create({
    data: {
      clientId: client.id,
      artistId: artist.id,
      captureLinkToken: token,
      captureLinkExpiresAt: new Date(
        Date.now() + 1000 * 60 * 60 * 24 * 30
      ),
    },
  });

  redirect(`/clients/${client.id}`);
}