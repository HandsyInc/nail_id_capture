import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { getFromR2 } from "@/lib/r2";

export async function GET(
  req: Request,
  { params }: { params: { imageId: string } }
) {
  const image = await prisma.captureImage.findUnique({
    where: {
      id: params.imageId,
    },
  });

  if (!image) {
    return new NextResponse("Image not found", {
      status: 404,
    });
  }

  const file = await getFromR2(image.storageKey);

  return new NextResponse(Buffer.from(file.body), {
    headers: {
      "Content-Type": file.contentType,
      "Cache-Control": "private, max-age=3600",
    },
  });
}