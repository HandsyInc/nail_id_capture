import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { uploadToR2 } from "@/lib/r2";

export async function POST(
  req: Request,
  { params }: { params: { token: string } }
) {
  try {
    const body = await req.json();

    console.log(
      "capture submit payload",
      JSON.stringify(body, null, 2)
    );

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

    const captures = body.captures ?? [];

    for (let i = 0; i < captures.length; i++) {
      const capture = captures[i];

      const preview = capture.preview;
      if (!preview) continue;

      const base64 = preview.replace(
        /^data:image\/\w+;base64,/,
        ""
      );

      const buffer = Buffer.from(base64, "base64");

      const key = `captures/${params.token}/${i}.jpg`;

      await uploadToR2({
        key,
        body: buffer,
        contentType: "image/jpeg",
      });

      await prisma.captureImage.create({
        data: {
          sessionId: session.id,
          sequenceNumber: i,
          storageKey: key,
          mimeType: "image/jpeg",
          fileSizeBytes: buffer.length,
          imageType: "TOP_DOWN",
          hand: "LEFT",
          finger: "INDEX",
          capturedAt: new Date(),
        },
      });
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

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error(error);

    return NextResponse.json(
      { error: "Failed to submit capture session" },
      { status: 500 }
    );
  }
}