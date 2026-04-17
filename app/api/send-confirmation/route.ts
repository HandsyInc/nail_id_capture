import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST(req: NextRequest) {
  try {
    const { name, email, nailId } = await req.json();

    if (!name || !email || !nailId) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    const { error } = await resend.emails.send({
      from: `Handsy <${process.env.HANDSY_FROM_EMAIL!}>`,
      to: [email],
      subject: `We received your photos — ${nailId}`,
      html: `
        <p>Hi ${name},</p>
        <p>Your photos were received successfully.</p>
        <p><strong>Nail ID:</strong> ${nailId}</p>
        <p>We’ll be in touch shortly.</p>
      `,
    });

    if (error) {
      return NextResponse.json(
        { error: JSON.stringify(error) },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || 'Failed to send confirmation email' },
      { status: 500 }
    );
  }
}