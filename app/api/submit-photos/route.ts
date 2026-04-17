import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const name = String(formData.get('name') || '');
    const email = String(formData.get('email') || '');
    const photo = formData.get('photos') as File | null;

    const nailId = String(formData.get('nailId') || '');
    const hand = String(formData.get('hand') || '');
    const finger = String(formData.get('finger') || '');
    const label = hand && finger ? `${hand}-${finger}` : 'photo';

    if (!name || !email || !nailId || !photo) {
      return NextResponse.json({ error: 'Missing data' }, { status: 400 });
    }

    console.log('ROUTE FILE:', photo.name, photo.type, photo.size);
    console.log('NAILID:', nailId, label);

    // ✅ SINGLE PHOTO (no map, no array logic)
    const buffer = Buffer.from(await photo.arrayBuffer());

    const attachments = [
      {
        filename: `${label}.jpg`,
        content: buffer.toString('base64'),
      },
    ];

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
      `,
      attachments,
    });

    return NextResponse.json({ ok: true });

  } catch (error) {
    console.error('UPLOAD ERROR:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}