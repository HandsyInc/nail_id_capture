import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST(req: NextRequest) {
  try {
    const { name, email, photos } = await req.json();

    if (!name || !email || !photos) {
      return NextResponse.json({ error: "Missing data" }, { status: 400 });
    }

    const attachments = photos.map((photo: any) => {
      const base64Data = photo.data.split(",")[1];

      return {
        filename: `${photo.hand}-${photo.finger}.jpg`,
        content: base64Data,
      };
    });

    const { error: userError } = await resend.emails.send({
      from: `Handsy <${process.env.HANDSY_FROM_EMAIL!}>`,
      to: [email],
      subject: "We received your photos",
      text: `Hi ${name},

We received your photos and are creating your Nail ID.

We’ll be in touch shortly.

— Handsy Team`,
    });

    if (userError) {
      return NextResponse.json(
        { error: JSON.stringify(userError) },
        { status: 500 }
      );
    }

    const { error: internalError } = await resend.emails.send({
  from: `Handsy <${process.env.HANDSY_FROM_EMAIL!}>`,
  to: [process.env.HANDSY_NOTIFY_EMAIL!],
  subject: `New Handsy submission — ${name}`,
  text: `Name: ${name}
Email: ${email}

Photos were submitted successfully.`,
});

    if (internalError) {
      return NextResponse.json(
        { error: JSON.stringify(internalError) },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      photosCount: photos.length,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to send emails" },
      { status: 500 }
    );
  }
}