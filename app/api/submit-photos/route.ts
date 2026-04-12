import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function GET() {
  return NextResponse.json({ ok: true, message: "route live" });
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const name = String(formData.get('name') || '');
    const email = String(formData.get('email') || '');
    const photos = formData.getAll('photos') as unknown as File[];

    const nailId = `NAILID-${Math.floor(1000 + Math.random() * 9000)}`;

    if (!name || !email || photos.length === 0) {
      return NextResponse.json({ error: 'Missing data' }, { status: 400 });
    }

    console.log('Incoming photos count:', photos.length);
    console.log('NAILID:', nailId);

    const orderedLabels = [
      'left-thumb',
      'left-index',
      'left-middle',
      'left-ring',
      'left-pinky',
      'right-thumb',
      'right-index',
      'right-middle',
      'right-ring',
      'right-pinky',
    ];

    const attachments = await Promise.all(
      photos.map(async (file: File, i: number) => {
        const buffer = Buffer.from(await file.arrayBuffer());

        return {
          filename: `${orderedLabels[i] || `photo-${i + 1}`}.jpg`,
          content: buffer.toString('base64'),
        };
      })
    );

    await resend.emails.send({
      from: process.env.HANDSY_FROM_EMAIL!,
      to: 'hello@gethandsy.com',
      subject: `New Handsy Submission — ${nailId}`,
      html: `
        <p><strong>Nail ID:</strong> ${nailId}</p>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Photos:</strong> ${photos.length}</p>
      `,
      attachments,
    });

    await resend.emails.send({
      from: process.env.HANDSY_FROM_EMAIL!,
      to: email,
      subject: `We received your photos — ${nailId}`,
      html: `
        <p>Hi ${name},</p>
        <p>Your photos were received successfully.</p>
        <p><strong>Nail ID:</strong> ${nailId}</p>
      `,
    });

    return NextResponse.json({ ok: true, nailId });

  } catch (error) {
    console.error('UPLOAD ERROR:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}