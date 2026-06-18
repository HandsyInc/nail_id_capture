"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";

import { getOrCreateArtist } from "@/lib/artist";
import { prisma } from "@/lib/prisma";
import type { RecaptureTarget } from "@/lib/recapture";
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

export async function startRecaptureSession({
  clientId,
  parentCaptureSessionId,
  recaptureReason,
  recaptureNote,
  recaptureTargets,
}: {
  clientId: string;
  parentCaptureSessionId: string;
  recaptureReason: "PHOTO_ISSUE" | "MEASUREMENT_CONFIRMATION" | "OTHER";
  recaptureNote?: string;
  recaptureTargets: RecaptureTarget[];
}) {
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

  const parentCaptureSession = await prisma.captureSession.findFirst({
    where: {
      id: parentCaptureSessionId,
      clientId: client.id,
      artistId: artist.id,
    },
  });

  if (!parentCaptureSession) {
    throw new Error("Parent capture session not found");
  }

  const token = `rec_${randomUUID()}`;

  await prisma.captureSession.create({
    data: {
      clientId: client.id,
      artistId: artist.id,
      handsyFitId: parentCaptureSession.handsyFitId,
      type: "RECAPTURE",
      status: "PENDING",
      captureLinkToken: token,
      captureLinkExpiresAt: new Date(
        Date.now() + 1000 * 60 * 60 * 24 * 30
      ),
      parentCaptureSessionId: parentCaptureSession.id,
      recaptureReason,
      recaptureNote,
      recaptureTargets,
    },
  });

  redirect(`/clients/${client.id}`);
}