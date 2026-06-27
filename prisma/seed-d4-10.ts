/**
 * prisma/seed-d4-10.ts
 *
 * D4.10 test fixture: seeds LONGITUDINAL CaptureImages for the longitudinal
 * measurement page at /measure/longitudinal?sessionId=<id>.
 *
 * ── Two modes ─────────────────────────────────────────────────────────────────
 *
 *   1. Add to an existing session (most common in dev):
 *      SESSION_ID=<id> SEED_ARTIST_ID=<id> npx tsx prisma/seed-d4-10.ts
 *
 *      Appends LONGITUDINAL images to the given session. sequenceNumber is
 *      auto-incremented above the session's current maximum. Safe to run on a
 *      session that already has TOP_DOWN and TRANSVERSE images.
 *
 *   2. Create a new client + session from scratch:
 *      SEED_ARTIST_ID=<id> npx tsx prisma/seed-d4-10.ts
 *
 *      Creates a fresh Client and CaptureSession, then adds the images.
 *      Prints the new sessionId for use with the audit script.
 *
 * ── Image source ──────────────────────────────────────────────────────────────
 *
 *   Default folder: ~/Desktop/Test captures/
 *   Override:       D410_IMAGE_DIR=<path> npx tsx prisma/seed-d4-10.ts
 *
 *   Expected files (side-view / longitudinal captures):
 *     Left Index Longitudinal.jpg
 *     Left Middle Longitudinal.jpg
 *     Left Ring Longitudinal.jpg
 *
 *   If any file is missing the script exits before touching the DB or R2.
 *   Rename or symlink your actual files to match these names, or set
 *   D410_IMAGE_DIR to a folder where they live under those names.
 *
 * ── H matrix ─────────────────────────────────────────────────────────────────
 *
 *   LONGITUDINAL images can carry an h_matrix (card homography) for px→mm
 *   conversion. If your test images were captured with a reference card in
 *   frame and you have the matrix, set H_MATRIX_JSON to a JSON-encoded 3×3:
 *
 *     H_MATRIX_JSON='[[a,b,c],[d,e,f],[g,h,i]]' SESSION_ID=<id> ... npx tsx ...
 *
 *   Otherwise (default) h_matrix is left null and the canvas will store
 *   measurements in px only — functionally correct for UI testing.
 *
 * ── Get IDs ───────────────────────────────────────────────────────────────────
 *
 *   SEED_ARTIST_ID : http://localhost:3000/api/dev/whoami
 *   SESSION_ID     : shown in the browser URL when on /measure/longitudinal
 *                    or /measure/transverse, or run the audit script.
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

// ── Configuration ─────────────────────────────────────────────────────────────

const IMAGE_BASE =
  process.env.D410_IMAGE_DIR ??
  path.join(process.env.HOME ?? '', 'Desktop/Test captures');

const IMAGES = [
  {
    hand:       'LEFT'  as const,
    finger:     'INDEX' as const,
    localFile:  'Left Index Longitudinal.jpg',
    storageKey: 'dev-seed/d4-10-longitudinal-left-index.jpg',
  },
  {
    hand:       'LEFT'  as const,
    finger:     'MIDDLE' as const,
    localFile:  'Left Middle Longitudinal.jpg',
    storageKey: 'dev-seed/d4-10-longitudinal-left-middle.jpg',
  },
  {
    hand:       'LEFT'  as const,
    finger:     'RING'  as const,
    localFile:  'Left Ring Longitudinal.jpg',
    storageKey: 'dev-seed/d4-10-longitudinal-left-ring.jpg',
  },
] as const;

// ── H matrix ──────────────────────────────────────────────────────────────────

function parseHMatrix(): number[][] | null {
  const raw = process.env.H_MATRIX_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed.every(
        row => Array.isArray(row) && row.length === 3 && row.every(n => typeof n === 'number'),
      )
    ) {
      return parsed;
    }
    console.error('⚠️  H_MATRIX_JSON is not a valid 3×3 array — ignoring, h_matrix will be null.');
    return null;
  } catch {
    console.error('⚠️  H_MATRIX_JSON is not valid JSON — ignoring, h_matrix will be null.');
    return null;
  }
}

// ── R2 ────────────────────────────────────────────────────────────────────────

function getR2() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    throw new Error('Missing R2 env vars (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME)');
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const SEED_ARTIST_ID = process.env.SEED_ARTIST_ID ?? null;
  const SESSION_ID     = process.env.SESSION_ID ?? null;

  // ── Resolve artist ────────────────────────────────────────────────────────
  // When SESSION_ID is provided, infer artistId from the session record.
  // SEED_ARTIST_ID is only required when creating a new session.
  let artistId: string;
  let artistEmail: string;

  if (SESSION_ID) {
    const session = await prisma.captureSession.findUnique({
      where:  { id: SESSION_ID },
      select: { artistId: true, artist: { select: { email: true } } },
    });
    if (!session) {
      console.error(`\n⛔  Session ${SESSION_ID} not found.\n`);
      process.exit(1);
    }
    artistId    = session.artistId;
    artistEmail = session.artist.email ?? '(unknown)';
  } else {
    if (!SEED_ARTIST_ID) {
      console.error(
        '\nMissing SEED_ARTIST_ID.\n' +
        'Get it from: http://localhost:3000/api/dev/whoami\n\n' +
        'Usage (add to existing session — no SEED_ARTIST_ID needed):\n' +
        '  SESSION_ID=<id> npx tsx prisma/seed-d4-10.ts\n\n' +
        'Usage (new session):\n' +
        '  SEED_ARTIST_ID=<id> npx tsx prisma/seed-d4-10.ts\n',
      );
      process.exit(1);
    }
    const artist = await prisma.artist.findUniqueOrThrow({ where: { id: SEED_ARTIST_ID } });
    artistId    = artist.id;
    artistEmail = artist.email ?? '(unknown)';
  }

  console.log(`\n  Artist: ${artistId}  (${artistEmail})`);

  // ── Verify all image files exist before touching anything ─────────────────
  for (const img of IMAGES) {
    const p = path.join(IMAGE_BASE, img.localFile);
    if (!fs.existsSync(p)) {
      console.error(`\n⛔  Image not found: ${p}`);
      console.error(
        `\n  Options:\n` +
        `    • Place your side-view image at that path\n` +
        `    • Rename your file to "${img.localFile}"\n` +
        `    • Set D410_IMAGE_DIR=<folder> to point to a folder containing these names\n`,
      );
      process.exit(1);
    }
  }

  const hMatrix = parseHMatrix();
  if (hMatrix) {
    console.log('  H matrix: provided (px→mm conversion will be available in canvas)');
  } else {
    console.log('  H matrix: null (measurements will be stored in px only — OK for UI testing)');
  }

  // ── Upload images to R2 ───────────────────────────────────────────────────
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

  // ── Resolve or create session ─────────────────────────────────────────────
  let sessionId: string;

  if (SESSION_ID) {
    // Already verified above — just use the ID.
    sessionId = SESSION_ID;
    console.log(`\n  Adding LONGITUDINAL images to existing session: ${sessionId}`);
  } else {
    // Create a new client + session.
    const client = await prisma.client.create({
      data: {
        artistId,
        name:     'D4.10 Test Client (Left Hand Longitudinal)',
        email:    `d410-test-${Date.now()}@gethandsy.com`,
        status:   'PENDING_CAPTURE',
      },
    });
    const session = await prisma.captureSession.create({
      data: {
        clientId:             client.id,
        artistId,
        status:               'SUBMITTED',
        captureLinkToken:     `d410-longitudinal-${Date.now()}`,
        captureLinkExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        submittedAt:          new Date(),
      },
    });
    sessionId = session.id;
    console.log(`\n  Created new session: ${sessionId}`);
  }

  // ── Find current max sequenceNumber in this session ───────────────────────
  // sequenceNumber must be unique within a session (@@unique([sessionId, sequenceNumber])).
  const maxSeqRecord = await prisma.captureImage.findFirst({
    where:   { sessionId },
    orderBy: { sequenceNumber: 'desc' },
    select:  { sequenceNumber: true },
  });
  let nextSeq = (maxSeqRecord?.sequenceNumber ?? 0) + 1;

  // ── Create LONGITUDINAL CaptureImage records ──────────────────────────────
  for (const img of IMAGES) {
    await prisma.captureImage.create({
      data: {
        sessionId,
        imageType:      'LONGITUDINAL',
        hand:           img.hand,
        finger:         img.finger,
        sequenceNumber: nextSeq,
        storageKey:     img.storageKey,
        mimeType:       'image/jpeg',
        h_matrix:       hMatrix ?? undefined,
      },
    });
    console.log(`  ✓ CaptureImage: ${img.hand} ${img.finger}  (seq ${nextSeq})`);
    nextSeq += 1;
  }

  console.log('\n══ Done ══════════════════════════════════════════════════════\n');
  console.log('  Open this URL to run D4.10 longitudinal measurement:\n');
  console.log(`  http://localhost:3000/measure/longitudinal?sessionId=${sessionId}\n`);
  if (SESSION_ID) {
    console.log('  Run the audit after measuring all three fingers:\n');
    console.log(`  SESSION_ID=${sessionId} npx tsx prisma/audit-d4-10.ts\n`);
  } else {
    console.log('  Run the audit after measuring all three fingers:\n');
    console.log(`  npx tsx prisma/audit-d4-10.ts\n`);
    console.log('  (auto-discovers the session you just created)\n');
  }
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
