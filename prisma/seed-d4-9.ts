/**
 * prisma/seed-d4-9.ts
 *
 * D4.9 test fixture: creates one proper Client → CaptureSession with three
 * TRANSVERSE CaptureImages (LEFT INDEX, MIDDLE, RING) under a single session.
 *
 * This matches the production data model: one client, one session, multiple
 * images. The transverse measurement page at /measure/transverse?sessionId=<id>
 * will show all three fingers in the left nav.
 *
 * widthMm will be null for all fingers (no GeometryPackage with widthData).
 * IC measurements will be stored in px only. Run chord measurements first if
 * you want mm-scaled IC output.
 *
 * Images sourced from: ~/Desktop/Test captures/
 *   Left Transverse Index.jpg
 *   Left Middle Transverse.jpg
 *   Left Ring Transverse.jpg
 *
 * Usage:
 *   SEED_ARTIST_ID=<id> npx tsx prisma/seed-d4-9.ts
 *
 * Get SEED_ARTIST_ID from: http://localhost:3000/api/dev/whoami
 */

import fs   from 'fs';
import path from 'path';
import { config }       from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg }     from '@prisma/adapter-pg';
import { Pool }         from 'pg';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

config({ path: path.resolve(process.cwd(), '.env.local') });
config({ path: path.resolve(process.cwd(), '.env') });

const pool    = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma  = new PrismaClient({ adapter });

const IMAGE_BASE =
  process.env.D49_IMAGE_DIR ??
  path.join(process.env.HOME ?? '', 'Desktop/Test captures');

const IMAGES = [
  {
    label:      'index',
    hand:       'LEFT'  as const,
    finger:     'INDEX' as const,
    localFile:  'Left Transverse Index.jpg',
    storageKey: 'dev-seed/d4-9-transverse-left-index.jpg',
    seq:        1,
  },
  {
    label:      'middle',
    hand:       'LEFT'  as const,
    finger:     'MIDDLE' as const,
    localFile:  'Left Middle Transverse.jpg',
    storageKey: 'dev-seed/d4-9-transverse-left-middle.jpg',
    seq:        2,
  },
  {
    label:      'ring',
    hand:       'LEFT'  as const,
    finger:     'RING'  as const,
    localFile:  'Left Ring Transverse.jpg',
    storageKey: 'dev-seed/d4-9-transverse-left-ring.jpg',
    seq:        3,
  },
] as const;

function getR2() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    throw new Error('Missing R2 env vars');
  }
  return {
    client: new S3Client({
      region:   'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    }),
    bucketName: R2_BUCKET_NAME,
  };
}

async function main() {
  const SEED_ARTIST_ID = process.env.SEED_ARTIST_ID;
  if (!SEED_ARTIST_ID) {
    console.error(
      '\nMissing SEED_ARTIST_ID.\n' +
      'Get it from: http://localhost:3000/api/dev/whoami\n\n' +
      'Usage:\n  SEED_ARTIST_ID=<id> npx tsx prisma/seed-d4-9.ts\n',
    );
    process.exit(1);
  }

  const artist = await prisma.artist.findUniqueOrThrow({ where: { id: SEED_ARTIST_ID } });
  console.log(`\n  Artist: ${artist.id}  (${artist.email})`);

  // ── Verify all images exist before touching the DB ─────────────────────────
  for (const img of IMAGES) {
    const p = path.join(IMAGE_BASE, img.localFile);
    if (!fs.existsSync(p)) {
      console.error(`\n⛔  Image not found: ${p}`);
      console.error('  Set D49_IMAGE_DIR=<folder> to override.\n');
      process.exit(1);
    }
  }

  // ── Upload to R2 ───────────────────────────────────────────────────────────
  const { client: r2, bucketName } = getR2();
  for (const img of IMAGES) {
    const localPath = path.join(IMAGE_BASE, img.localFile);
    console.log(`  Uploading ${img.localFile} → ${img.storageKey} …`);
    await r2.send(new PutObjectCommand({
      Bucket:      bucketName,
      Key:         img.storageKey,
      Body:        fs.readFileSync(localPath),
      ContentType: 'image/jpeg',
    }));
    console.log('  ✓ Uploaded');
  }

  // ── One client + one session ───────────────────────────────────────────────
  const client = await prisma.client.create({
    data: {
      artistId: artist.id,
      name:     'D4.9 Test Client (Left Hand Transverse)',
      email:    `d49-test@gethandsy.com`,
      status:   'PENDING_CAPTURE',
    },
  });

  const session = await prisma.captureSession.create({
    data: {
      clientId:             client.id,
      artistId:             artist.id,
      status:               'SUBMITTED',
      captureLinkToken:     `d49-transverse-${Date.now()}`,
      captureLinkExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      submittedAt:          new Date(),
    },
  });

  // ── Three TRANSVERSE images in the same session ────────────────────────────
  for (const img of IMAGES) {
    await prisma.captureImage.create({
      data: {
        sessionId:      session.id,
        imageType:      'TRANSVERSE',
        hand:           img.hand,
        finger:         img.finger,
        sequenceNumber: img.seq,
        storageKey:     img.storageKey,
        mimeType:       'image/jpeg',
      },
    });
    console.log(`  ✓ CaptureImage: ${img.hand} ${img.finger} (seq ${img.seq})`);
  }

  console.log('\n══ Done ══════════════════════════════════════════════════════\n');
  console.log('  Open this URL to run D4.9 transverse measurement:\n');
  console.log(`  http://localhost:3000/measure/transverse?sessionId=${session.id}\n`);
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
