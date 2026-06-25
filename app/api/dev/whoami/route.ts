import { NextResponse } from 'next/server';
import { currentUser } from '@clerk/nextjs/server';
import { prisma } from '@/lib/prisma';

/** GET /api/dev/whoami — returns Clerk user ID and matching Prisma Artist row. */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const artist = await prisma.artist.findUnique({
    where: { clerkId: user.id },
    include: { _count: { select: { clients: true, captureSessions: true } } },
  });

  return NextResponse.json({
    clerkId:  user.id,
    email:    user.emailAddresses[0]?.emailAddress,
    artist:   artist
      ? { id: artist.id, clientCount: artist._count.clients, sessionCount: artist._count.captureSessions }
      : null,
  });
}
