import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(
  req: Request,
  { params }: { params: { token: string } }
) {
  try {
    const session = await prisma.captureSession.findUnique({
      where: {
        captureLinkToken: params.token,
      },
    });

    if (!session) {
      return NextResponse.json(
        { error: "Capture session not found" },
        { status: 404 }
      );
    }

    await prisma.captureSession.update({
      where: {
        id: session.id,
      },
      data: {
        status: "SUBMITTED",
        submittedAt: new Date(),
      },
    });

    return NextResponse.json({
      success: true,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      { error: "Failed to submit capture session" },
      { status: 500 }
    );
  }
}