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
    for (const photo of photos) {
  console.log('ROUTE FILE:', photo.name, photo.type, photo.size);
}

    const nailId = String(formData.get('nailId') || '');
    const hand = String(formData.get('hand') || '');
    const finger = String(formData.get('finger') || '');
    const label = hand && finger ? `${hand}-${finger}` : 'photo';
    if (!name || !email || !nailId || photos.length === 0) {
      return NextResponse.json({ error: 'Missing data' }, { status: 400 });
    }

    console.log('Incoming photos count:', photos.length);
    console.log('NAILID:', nailId);


    const attachments = await Promise.all(
      photos.map(async (file: File, i: number) => {
        const buffer = Buffer.from(await file.arrayBuffer());

        return {
          filename: `${label}.jpg`,
          content: buffer.toString('base64'),
        };
      })
    );

    await resend.emails.send({
      from: process.env.HANDSY_FROM_EMAIL!,
      to: 'hello@gethandsy.com',
      subject: `New Handsy Submission — ${nailId} — ${label}`,
      html: `
    <p><strong>Nail ID:</strong> ${nailId}</p>
    <p><strong>Name:</strong> ${name}</p>
    <p><strong>Email:</strong> ${email}</p>
    <p><strong>Hand:</strong> ${hand}</p>
    <p><strong>Finger:</strong> ${finger}</p>
    <p><strong>Photos:</strong> ${photos.length}</p>
`,
      attachments,
    });

    return NextResponse.json({ ok: true, nailId });

  } catch (error) {
    console.error('UPLOAD ERROR:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}