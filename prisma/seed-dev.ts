/**
 * prisma/seed-dev.ts
 *
 * D4.7 dev seed: creates a minimal test fixture in Neon + R2 so the
 * "Measure Chord Width" button appears in the dashboard without a real capture.
 *
 * What it creates:
 *   Client → CaptureSession (SUBMITTED) → CaptureImage (TOP_DOWN, LEFT INDEX, h_matrix)
 *
 * The local test image is uploaded to R2 under dev-seed/<filename>.
 *
 * Usage — pass the artist ID from /api/dev/whoami directly:
 *   SEED_ARTIST_ID=cmqstbeot0000wfcfiu637kz7 \
 *   npx tsx prisma/seed-dev.ts
 *
 * Run from the nail_id_capture-master directory so .env.local is found.
 */

import fs from 'fs';
import path from 'path';
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// ── Load env ────────────────────────────────────────────────────────────────
// Load .env.local first (Next.js convention), then .env as fallback.
config({ path: path.resolve(process.cwd(), '.env.local') });
config({ path: path.resolve(process.cwd(), '.env') });

// ── Config ───────────────────────────────────────────────────────────────────
// Pass the artist ID shown by /api/dev/whoami — avoids any clerkId/DB mismatch.
const SEED_ARTIST_ID = process.env.SEED_ARTIST_ID;

// Local test image — adjust path if needed.
const LOCAL_IMAGE_PATH =
  process.env.SEED_IMAGE_PATH ??
  path.join(
    process.env.HOME ?? '',
    'Desktop/Handsy Phase V00 test images/IMG_4590 index left.jpg',
  );

// R2 key the image will be uploaded/reused under.
const R2_STORAGE_KEY = 'dev-seed/IMG_4590-index-left.jpg';

// Realistic pixel→mm homography for a V00 capture at ~269mm camera distance.
// Scale ≈ 0.125 mm/px (≈ 8 px/mm).  Gives ~12–14 mm for a typical nail width.
// Replace with a real h_matrix from a production capture for accurate numbers.
const DEV_H_MATRIX = [
  [0.125, 0.0,   0.0],
  [0.0,   0.125, 0.0],
  [0.0,   0.0,   1.0],
];

// ── Prisma client ─────────────────────────────────────────────────────────────
const pool    = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma  = new PrismaClient({ adapter });

// ── R2 client ─────────────────────────────────────────────────────────────────
function getR2() {
  const accountId        = process.env.R2_ACCOUNT_ID!;
  const accessKeyId      = process.env.R2_ACCESS_KEY_ID!;
  const secretAccessKey  = process.env.R2_SECRET_ACCESS_KEY!;
  const bucketName       = process.env.R2_BUCKET_NAME!;

  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
    throw new Error(
      'Missing R2 env vars. Ensure R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, ' +
      'R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME are set in .env.local',
    );
  }

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  return { client, bucketName };
}

async function uploadToR2(localPath: string, key: string): Promise<void> {
  if (!fs.existsSync(localPath)) {
    throw new Error(`Local image not found: ${localPath}`);
  }
  const { client, bucketName } = getR2();
  const body = fs.readFileSync(localPath);
  await client.send(
    new PutObjectCommand({
      Bucket:      bucketName,
      Key:         key,
      Body:        body,
      ContentType: 'image/jpeg',
    }),
  );
  console.log(`  ✓ Uploaded to R2: ${key}`);
}

// ── Seed ──────────────────────────────────────────────────────────────────────
async function main() {
  // ── Guard ──────────────────────────────────────────────────────────────────
  if (!SEED_ARTIST_ID) {
    console.error(
      '\nMissing SEED_ARTIST_ID.\n' +
      'Get it from: http://localhost:3000/api/dev/whoami  (field: artist.id)\n\n' +
      'Usage:\n' +
      '  SEED_ARTIST_ID=cmqstbeot0000wfcfiu637kz7 npx tsx prisma/seed-dev.ts\n',
    );
    process.exit(1);
  }

  console.log('\n── D4.7 dev seed ─────────────────────────────────────────');

  // ── 1. Upload image to R2 ──────────────────────────────────────────────────
  console.log('\n1. Uploading test image to R2…');
  await uploadToR2(LOCAL_IMAGE_PATH, R2_STORAGE_KEY);

  // ── 2. Verify artist exists ────────────────────────────────────────────────
  console.log('\n2. Verifying Artist…');
  const artist = await prisma.artist.findUniqueOrThrow({
    where: { id: SEED_ARTIST_ID },
  });
  console.log(`  ✓ Artist id=${artist.id}  email=${artist.email}`);

  // ── 3. Create Client ───────────────────────────────────────────────────────
  console.log('\n3. Creating Client…');
  const client = await prisma.client.create({
    data: {
      artistId: artist.id,
      name:     'Dev Test Client (D4.7)',
      email:    'devtest@gethandsy.com',
      status:   'PENDING_CAPTURE',
    },
  });
  console.log(`  ✓ Client id=${client.id}`);

  // ── 4. Create CaptureSession (SUBMITTED) ───────────────────────────────────
  console.log('\n4. Creating CaptureSession…');
  const session = await prisma.captureSession.create({
    data: {
      clientId:            client.id,
      artistId:            artist.id,
      status:              'SUBMITTED',
      captureLinkToken:    `dev-seed-${Date.now()}`,
      captureLinkExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      submittedAt:         new Date(),
    },
  });
  console.log(`  ✓ CaptureSession id=${session.id}  status=SUBMITTED`);

  // ── 5. Create CaptureImage (TOP_DOWN, LEFT INDEX, h_matrix set) ────────────
  console.log('\n5. Creating CaptureImage…');
  const image = await prisma.captureImage.create({
    data: {
      sessionId:      session.id,
      imageType:      'TOP_DOWN',
      hand:           'LEFT',
      finger:         'INDEX',
      sequenceNumber: 1,
      storageKey:     R2_STORAGE_KEY,
      mimeType:       'image/jpeg',
      h_matrix:       DEV_H_MATRIX,
    },
  });
  console.log(`  ✓ CaptureImage id=${image.id}  h_matrix=populated`);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n── Done ───────────────────────────────────────────────────');
  console.log(`\nOpen the dashboard and navigate to:`);
  console.log(`  /dashboard/captures/${session.id}`);
  console.log(`\nYou should see "Measure Chord Width →" button.`);
  console.log(`\nOr go to the measure page directly:`);
  console.log(`  /measure/chord?sessionId=${session.id}\n`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
