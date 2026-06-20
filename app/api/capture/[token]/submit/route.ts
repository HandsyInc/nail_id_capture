import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/capture/[token]/submit
 *
 * Finalizes a capture session. Images are already uploaded individually via
 * POST /api/capture/[token]/image before this is called.
 * This endpoint only marks the session SUBMITTED.
 */
export async function POST(
  _req: Request,
  { params }: { params: { token: string } }
) {
  try {
    console.log('[capture/submit] finalizing session', params.token);

    const session = await prisma.captureSession.findUnique({
      where: { captureLinkToken: params.token },
    });

    if (!session) {
      return NextResponse.json(
        { error: 'Capture session not found' },
        { status: 404 }
      );
    }

    await prisma.captureSession.update({
      where: { id: session.id },
      data: {
        status: 'SUBMITTED',
        submittedAt: new Date(),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[capture/submit] error', error);
    return NextResponse.json(
      { error: 'Failed to submit capture session' },
      { status: 500 }
    );
  }
}
