import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function GET() {
  return NextResponse.json({ ok: true, message: "route live" });
}

export async function POST(req: NextRequest) {
  try {
    const { name, email, photos } = await req.json();

    // ✅ 4-digit Nail ID
    const nailId = `NAILID-${Math.floor(1000 + Math.random() * 9000)}`;

    if (!name || !email || !photos || !Array.isArray(photos) || photos.length === 0) {
      return NextResponse.json({ error: "Missing data" }, { status: 400 });
    }

    console.log("Incoming photos count:", photos.length);
    console.log("NAILID:", nailId);

    const orderedLabels = [
      "left-thumb",
      "left-index",
      "left-middle",
      "left-ring",
      "left-pinky",
      "right-thumb",
      "right-index",
      "right-middle",
      "right-ring",
      "right-pinky",
    ];

    const attachments = photos.map((photo: any, i: number) => {
      if (!photo?.preview || typeof photo.preview !== "string") {
        throw new Error(`Photo ${i} is missing valid data`);
      }

      const mimeMatch = photo.preview.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
      const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";

      const extension =
        mimeType === "image/png"
          ? "png"
          : mimeType === "image/webp"
          ? "webp"
          : mimeType === "image/heic" || mimeType === "image/heif"
          ? "heic"
          : "jpg";

      const parts = photo.preview.split(",");
      const base64Data = parts.length > 1 ? parts[1] : parts[0];

      if (!base64Data) {
        throw new Error(`Photo ${i} has empty base64 data`);
      }

      const label = orderedLabels[i] || `photo-${i + 1}`;

      return {
        filename: `${nailId}-${label}.${extension}`,
        content: base64Data,
      };
    });

    console.log("Built attachments:", attachments.length);

    // ✅ USER EMAIL
    const userResult = await resend.emails.send({
      from: `Handsy <${process.env.HANDSY_FROM_EMAIL!}>`,
      to: [email],
      subject: "We received your photos",
      text: `Hi ${name},

We received your photos and are creating your Nail ID.

We’ll be in touch shortly.

— Handsy Team`,
    });

    if (userResult.error) {
      return NextResponse.json(
        { step: "user email", error: JSON.stringify(userResult.error) },
        { status: 500 }
      );
    }

    // ✅ INTERNAL EMAIL
    const internalResult = await resend.emails.send({
      from: `Handsy <${process.env.HANDSY_FROM_EMAIL!}>`,
      to: "hello@gethandsy.com",
      subject: `New Handsy submission — ${name} (${nailId})`,
      text: `NAILID: ${nailId}

Name: ${name}
Email: ${email}

Photos attached.`,
      attachments,
    });

    if (internalResult.error) {
  console.error("Internal email failed:", internalResult.error);
}

    return NextResponse.json({
      success: true,
      nailId,
      photosCount: photos.length,
    });
  } catch (err: any) {
    console.error("submit-photos route error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to send emails" },
      { status: 500 }
    );
  }
}