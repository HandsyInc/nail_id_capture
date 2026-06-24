import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { uploadToR2 } from "@/lib/r2";
import type { ImageType, Hand, Finger } from "@prisma/client";

/**
 * POST /api/capture/[token]/image
 *
 * Accepts a single capture image. Called once per shot by the client so the
 * payload stays small (one JPEG) and no server-side loop can timeout.
 *
 * Body: {
 *   index:   number          — 0-based sequence number
 *   preview: string          — data:image/jpeg;base64,… from canvas snapshot
 *   spec: {
 *     shotType: 'top-down' | 'transverse' | 'longitudinal'
 *     hand:     'left' | 'right'
 *     finger:   'thumb' | 'index' | 'middle' | 'ring' | 'pinky'
 *   }
 * }
 */

function toImageType(shotType: string): ImageType {
  switch (shotType) {
    case 'transverse':   return 'TRANSVERSE';
    case 'longitudinal': return 'LONGITUDINAL';
    default:             return 'TOP_DOWN';
  }
}

function toHand(h: string): Hand {
  return h.toUpperCase() as Hand;
}

function toFinger(f: string): Finger {
  return f.toUpperCase() as Finger;
}

export async function POST(
  req: Request,
  { params }: { params: { token: string } }
) {
  try {
    const body = await req.json();
    const { index, preview, hMatrix, spec } = body as {
      index: number;
      preview: string;
      /** 3×3 imageToCard homography from CardHomography; null when no card detected. */
      hMatrix: [[number,number,number],[number,number,number],[number,number,number]] | null;
      spec: { shotType: string; hand: string; finger: string };
    };

    // Log metadata only — never log the base64 body.
    console.log('[capture/image] upload', {
      token: params.token,
      index,
      shotType: spec?.shotType,
      hand: spec?.hand,
      finger: spec?.finger,
    });

    if (typeof index !== 'number' || !preview || !spec?.shotType) {
      return NextResponse.json(
        { error: 'Missing required fields: index, preview, spec' },
        { status: 400 }
      );
    }

    const session = await prisma.captureSession.findUnique({
      where: { captureLinkToken: params.token },
    });

    if (!session) {
      return NextResponse.json(
        { error: 'Capture session not found' },
        { status: 404 }
      );
    }

    const base64 = preview.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    const key = `captures/${params.token}/${String(index).padStart(2, '0')}.jpg`;

    await uploadToR2({ key, body: buffer, contentType: 'image/jpeg' });

    // Upsert: if this (sessionId, sequenceNumber) already exists (e.g. a retry),
    // overwrite the metadata instead of creating a duplicate row.
    await prisma.captureImage.upsert({
      where: {
        sessionId_sequenceNumber: {
          sessionId:      session.id,
          sequenceNumber: index,
        },
      },
      create: {
        sessionId:      session.id,
        sequenceNumber: index,
        storageKey:     key,
        mimeType:       'image/jpeg',
        fileSizeBytes:  buffer.length,
        imageType:      toImageType(spec.shotType),
        hand:           toHand(spec.hand),
        finger:         toFinger(spec.finger),
        capturedAt:     new Date(),
        h_matrix:       hMatrix ?? undefined,
      },
      update: {
        storageKey:    key,
        mimeType:      'image/jpeg',
        fileSizeBytes: buffer.length,
        imageType:     toImageType(spec.shotType),
        hand:          toHand(spec.hand),
        finger:        toFinger(spec.finger),
        capturedAt:    new Date(),
        // hMatrix ?? undefined: a null from a retry without card detection does
        // not overwrite a valid H stored from the first successful upload.
        h_matrix:      hMatrix ?? undefined,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[capture/image] error', error);
    return NextResponse.json(
      { error: 'Failed to upload image' },
      { status: 500 }
    );
  }
}
