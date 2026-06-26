/**
 * prisma/seed-d4-9-full.ts
 *
 * End-to-end D4.9 validation seed.
 *
 * Creates ONE Client → ONE CaptureSession containing:
 *   • 3 TOP_DOWN images  (LEFT INDEX, MIDDLE, RING) — with real H matrices
 *   • 3 TRANSVERSE images (LEFT INDEX, MIDDLE, RING) — no H matrix needed
 *
 * Workflow after seeding:
 *   1. Open the chord URL  → measure all three top-down fingers
 *      → chord widths stored in GeometryPackage.widthData
 *   2. Open the transverse URL → widthMm is now available per finger
 *      → IC measurements stored in GeometryPackage.icData
 *
 * Usage:
 *   SEED_ARTIST_ID=<id> npx tsx prisma/seed-d4-9-full.ts
 *
 * Get SEED_ARTIST_ID from: http://localhost:3000/api/dev/whoami
 * Override image folder:   D49_IMAGE_DIR=<path>
 */

import fs   from 'fs';
import path from 'path';
import { config }       from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg }     from '@prisma/adapter-pg';
import { Pool }         from 'pg';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

import { detectCard }           from '../lib/capture-v2/card-detector';
import {
  computeCardHomography,
  applyHomography,
  CARD_WIDTH_MM,
  CARD_HEIGHT_MM,
  type Matrix3x3,
} from '../lib/capture-v2/card-homography';
import type { Point } from '../lib/capture-v2/cv-primitives';

config({ path: path.resolve(process.cwd(), '.env.local') });
config({ path: path.resolve(process.cwd(), '.env') });

const pool    = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma  = new PrismaClient({ adapter });

const IMAGE_BASE =
  process.env.D49_IMAGE_DIR ??
  path.join(process.env.HOME ?? '', 'Desktop/Test captures');

// ── Image manifest ────────────────────────────────────────────────────────────

const IMAGES = [
  // TOP_DOWN first (seq 1-3) so chord can be measured before transverse
  {
    seq:        1,
    imageType:  'TOP_DOWN'   as const,
    hand:       'LEFT'       as const,
    finger:     'INDEX'      as const,
    localFile:  'Left Index Top Down.jpg',
    storageKey: 'dev-seed/d4-9-full-top-down-left-index.jpg',
    needsH:     true,
  },
  {
    seq:        2,
    imageType:  'TOP_DOWN'   as const,
    hand:       'LEFT'       as const,
    finger:     'MIDDLE'     as const,
    localFile:  'Left Middle Top Down.jpg',
    storageKey: 'dev-seed/d4-9-full-top-down-left-middle.jpg',
    needsH:     true,
  },
  {
    seq:        3,
    imageType:  'TOP_DOWN'   as const,
    hand:       'LEFT'       as const,
    finger:     'RING'       as const,
    localFile:  'Left Ring Top Down.jpg',
    storageKey: 'dev-seed/d4-9-full-top-down-left-ring.jpg',
    needsH:     true,
  },
  // TRANSVERSE (seq 4-6) — no H matrix; scale comes from chord widthData
  {
    seq:        4,
    imageType:  'TRANSVERSE' as const,
    hand:       'LEFT'       as const,
    finger:     'INDEX'      as const,
    localFile:  'Left Transverse Index.jpg',
    storageKey: 'dev-seed/d4-9-full-transverse-left-index.jpg',
    needsH:     false,
  },
  {
    seq:        5,
    imageType:  'TRANSVERSE' as const,
    hand:       'LEFT'       as const,
    finger:     'MIDDLE'     as const,
    localFile:  'Left Middle Transverse.jpg',
    storageKey: 'dev-seed/d4-9-full-transverse-left-middle.jpg',
    needsH:     false,
  },
  {
    seq:        6,
    imageType:  'TRANSVERSE' as const,
    hand:       'LEFT'       as const,
    finger:     'RING'       as const,
    localFile:  'Left Ring Transverse.jpg',
    storageKey: 'dev-seed/d4-9-full-transverse-left-ring.jpg',
    needsH:     false,
  },
] as const;

// ── R2 ────────────────────────────────────────────────────────────────────────

function getR2() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME)
    throw new Error('Missing R2 env vars');
  return {
    client: new S3Client({
      region:   'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    }),
    bucketName: R2_BUCKET_NAME,
  };
}

// ── H-matrix helpers (mirrors seed-d4-8-5.ts) ────────────────────────────────

async function loadImageData(
  filePath: string,
): Promise<{ data: Uint8Array; width: number; height: number }> {
  let sharp: typeof import('sharp').default;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.error('\n⛔  sharp not installed — run: npm install --save-dev sharp @types/sharp\n');
    process.exit(1);
  }
  const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

function cardSelfConsistencyCheck(
  imageToCard: Matrix3x3,
  cornersForH: Point[],
): { pass: boolean; widthMm: number; heightMm: number; widthErrPct: number; heightErrPct: number } {
  const [tl, tr, br, bl] = cornersForH;
  const tlMm = applyHomography(imageToCard, tl);
  const trMm = applyHomography(imageToCard, tr);
  const brMm = applyHomography(imageToCard, br);
  const blMm = applyHomography(imageToCard, bl);
  const wMm  = (Math.hypot(trMm.x-tlMm.x, trMm.y-tlMm.y) + Math.hypot(brMm.x-blMm.x, brMm.y-blMm.y)) / 2;
  const hMm  = (Math.hypot(blMm.x-tlMm.x, blMm.y-tlMm.y) + Math.hypot(brMm.x-trMm.x, brMm.y-trMm.y)) / 2;
  const wErr = Math.abs(wMm - CARD_WIDTH_MM)  / CARD_WIDTH_MM  * 100;
  const hErr = Math.abs(hMm - CARD_HEIGHT_MM) / CARD_HEIGHT_MM * 100;
  return { pass: wErr <= 1 && hErr <= 1, widthMm: wMm, heightMm: hMm, widthErrPct: wErr, heightErrPct: hErr };
}

async function computeHMatrix(localPath: string): Promise<Matrix3x3> {
  const imageData = await loadImageData(localPath);
  const detection = detectCard(imageData as unknown as ImageData);
  if (!detection) throw new Error(`detectCard returned null for ${localPath}`);

  const [tl, tr, , bl] = detection.corners;
  const isPortrait = Math.hypot(bl.x-tl.x, bl.y-tl.y) > Math.hypot(tr.x-tl.x, tr.y-tl.y);
  const cornersForH: Point[] = isPortrait
    ? [detection.corners[3], detection.corners[0], detection.corners[1], detection.corners[2]]
    : detection.corners;

  const cardHom = computeCardHomography(cornersForH);
  const check   = cardSelfConsistencyCheck(cardHom.imageToCard, cornersForH);

  console.log(
    `    card via ${detection.method} (${isPortrait ? 'PORTRAIT' : 'LANDSCAPE'})` +
    `  recovered ${check.widthMm.toFixed(2)}×${check.heightMm.toFixed(2)} mm` +
    `  err ${check.widthErrPct.toFixed(2)}%/${check.heightErrPct.toFixed(2)}%  ${check.pass ? '✅' : '❌'}`,
  );
  if (!check.pass) throw new Error(`D4.8.2 gate failed for ${localPath}`);

  return cardHom.imageToCard;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const SEED_ARTIST_ID = process.env.SEED_ARTIST_ID;
  if (!SEED_ARTIST_ID) {
    console.error(
      '\nMissing SEED_ARTIST_ID.\n' +
      'Get it from: http://localhost:3000/api/dev/whoami\n\n' +
      'Usage:\n  SEED_ARTIST_ID=<id> npx tsx prisma/seed-d4-9-full.ts\n',
    );
    process.exit(1);
  }

  const artist = await prisma.artist.findUniqueOrThrow({ where: { id: SEED_ARTIST_ID } });
  console.log(`\n  Artist: ${artist.id}  (${artist.email})`);

  // ── Verify all local files exist before touching anything ──────────────────
  for (const img of IMAGES) {
    const p = path.join(IMAGE_BASE, img.localFile);
    if (!fs.existsSync(p)) {
      console.error(`\n⛔  Not found: ${p}`);
      console.error('  Set D49_IMAGE_DIR=<folder> to override.\n');
      process.exit(1);
    }
  }
  console.log('  All source images found.\n');

  // ── Compute H matrices for TOP_DOWN images ─────────────────────────────────
  const hMatrices = new Map<string, Matrix3x3>();
  for (const img of IMAGES) {
    if (!img.needsH) continue;
    console.log(`  Computing H matrix: ${img.localFile}`);
    const h = await computeHMatrix(path.join(IMAGE_BASE, img.localFile));
    hMatrices.set(img.storageKey, h);
  }

  // ── Upload all images to R2 ────────────────────────────────────────────────
  console.log('\n  Uploading to R2…');
  const { client: r2, bucketName } = getR2();
  for (const img of IMAGES) {
    process.stdout.write(`    ${img.imageType.padEnd(10)} ${img.finger.padEnd(6)} → ${img.storageKey} … `);
    await r2.send(new PutObjectCommand({
      Bucket:      bucketName,
      Key:         img.storageKey,
      Body:        fs.readFileSync(path.join(IMAGE_BASE, img.localFile)),
      ContentType: 'image/jpeg',
    }));
    console.log('✓');
  }

  // ── Create DB records: one client, one session, six images ────────────────
  console.log('\n  Creating DB records…');

  const client = await prisma.client.create({
    data: {
      artistId: artist.id,
      name:     'D4.9 Full Validation (Left Hand)',
      email:    `d49-full-${Date.now()}@gethandsy.com`,
      status:   'PENDING_CAPTURE',
    },
  });

  const session = await prisma.captureSession.create({
    data: {
      clientId:             client.id,
      artistId:             artist.id,
      status:               'SUBMITTED',
      captureLinkToken:     `d49-full-${Date.now()}`,
      captureLinkExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      submittedAt:          new Date(),
    },
  });

  for (const img of IMAGES) {
    const hMatrix = hMatrices.get(img.storageKey) ?? null;
    await prisma.captureImage.create({
      data: {
        sessionId:      session.id,
        imageType:      img.imageType,
        hand:           img.hand,
        finger:         img.finger,
        sequenceNumber: img.seq,
        storageKey:     img.storageKey,
        mimeType:       'image/jpeg',
        ...(hMatrix ? { h_matrix: hMatrix as unknown as object } : {}),
      },
    });
    console.log(`    ✓ seq ${img.seq}  ${img.imageType.padEnd(10)}  ${img.hand} ${img.finger}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const sid = session.id;
  console.log('\n══ Done ══════════════════════════════════════════════════════\n');
  console.log('  Measurement workflow:\n');
  console.log('  Step 1 — measure chord widths (top-down):');
  console.log(`    http://localhost:3000/measure/chord?sessionId=${sid}\n`);
  console.log('  Step 2 — measure IC (transverse), same session:');
  console.log(`    http://localhost:3000/measure/transverse?sessionId=${sid}\n`);
  console.log('  Both pages use the same sessionId. After completing Step 1,');
  console.log('  the transverse page will show widthMm for each finger.\n');
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
