/**
 * prisma/seed-d4-8-5.ts
 *
 * D4.8.5 setup: seeds left index, middle, and ring fingers into Neon + R2,
 * computes the real portrait-corrected H matrix for each image inline, and
 * prints the /measure/chord URLs needed to run the production measurement UI.
 *
 * What it does for each finger:
 *   1. Upload the image to R2 under dev-seed/<key>.
 *   2. detectCard() → portrait check → computeCardHomography() (same code
 *      path as LiveCaptureView and update-h-matrix.ts).
 *   3. D4.8.2 gate: H must reproduce ISO 7810 within ±1 %.
 *   4. Create Client → CaptureSession (SUBMITTED) → CaptureImage with the
 *      real H matrix already populated.
 *   5. Print the /measure/chord?sessionId=<id> URL.
 *
 * Usage:
 *   SEED_ARTIST_ID=<id> npx tsx prisma/seed-d4-8-5.ts
 *
 * Run from nail_id_capture-master so .env.local is found.
 */

import fs from 'fs';
import path from 'path';
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

import { detectCard }            from '../lib/capture-v2/card-detector';
import {
  computeCardHomography,
  applyHomography,
  CARD_WIDTH_MM,
  CARD_HEIGHT_MM,
  type Matrix3x3,
} from '../lib/capture-v2/card-homography';
import type { Point } from '../lib/capture-v2/cv-primitives';

// ── Env ───────────────────────────────────────────────────────────────────────
config({ path: path.resolve(process.cwd(), '.env.local') });
config({ path: path.resolve(process.cwd(), '.env') });

// ── Prisma ────────────────────────────────────────────────────────────────────
const pool    = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma  = new PrismaClient({ adapter });

// ── R2 ────────────────────────────────────────────────────────────────────────
function getR2() {
  const accountId       = process.env.R2_ACCOUNT_ID!;
  const accessKeyId     = process.env.R2_ACCESS_KEY_ID!;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY!;
  const bucketName      = process.env.R2_BUCKET_NAME!;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
    throw new Error('Missing R2 env vars');
  }
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return { client, bucketName };
}

// ── Fingers to validate ───────────────────────────────────────────────────────
const IMAGE_BASE =
  process.env.D485_IMAGE_DIR ??
  path.join(process.env.HOME ?? '', 'Desktop/Handsy Phase V00 test images');

const FINGERS = [
  {
    label:      'index',
    hand:       'LEFT'  as const,
    finger:     'INDEX' as const,
    localFile:  'IMG_4590 index left.jpg',
    storageKey: 'dev-seed/d4-8-5-index-left.jpg',
  },
  {
    label:      'middle',
    hand:       'LEFT'  as const,
    finger:     'MIDDLE' as const,
    localFile:  'IMG_4591 mid left.jpg',
    storageKey: 'dev-seed/d4-8-5-middle-left.jpg',
  },
  {
    label:      'ring',
    hand:       'LEFT'  as const,
    finger:     'RING'  as const,
    localFile:  'IMG_4592 ring left.jpg',
    storageKey: 'dev-seed/d4-8-5-ring-left.jpg',
  },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data:   new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width:  info.width,
    height: info.height,
  };
}

function cardSelfConsistencyCheck(
  imageToCard: Matrix3x3,
  cornersForH: Point[],
): { widthMm: number; heightMm: number; widthErrPct: number; heightErrPct: number; pass: boolean } {
  const [tl, tr, br, bl] = cornersForH;
  const tlMm = applyHomography(imageToCard, tl);
  const trMm = applyHomography(imageToCard, tr);
  const brMm = applyHomography(imageToCard, br);
  const blMm = applyHomography(imageToCard, bl);

  const topW    = Math.hypot(trMm.x - tlMm.x, trMm.y - tlMm.y);
  const botW    = Math.hypot(brMm.x - blMm.x, brMm.y - blMm.y);
  const leftH   = Math.hypot(blMm.x - tlMm.x, blMm.y - tlMm.y);
  const rightH  = Math.hypot(brMm.x - trMm.x, brMm.y - trMm.y);
  const wMm = (topW + botW) / 2;
  const hMm = (leftH + rightH) / 2;
  const wErr = Math.abs(wMm - CARD_WIDTH_MM)  / CARD_WIDTH_MM  * 100;
  const hErr = Math.abs(hMm - CARD_HEIGHT_MM) / CARD_HEIGHT_MM * 100;
  return { widthMm: wMm, heightMm: hMm, widthErrPct: wErr, heightErrPct: hErr, pass: wErr <= 1 && hErr <= 1 };
}

function fmt3x3(m: Matrix3x3): string {
  return m.map(row =>
    '    [' + row.map(v => v.toExponential(5).padStart(14)).join(', ') + ']'
  ).join('\n');
}

async function uploadToR2(localPath: string, key: string): Promise<void> {
  const { client, bucketName } = getR2();
  const body = fs.readFileSync(localPath);
  await client.send(new PutObjectCommand({
    Bucket: bucketName, Key: key, Body: body, ContentType: 'image/jpeg',
  }));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const SEED_ARTIST_ID = process.env.SEED_ARTIST_ID;
  if (!SEED_ARTIST_ID) {
    console.error(
      '\nMissing SEED_ARTIST_ID.\n' +
      'Get it from: http://localhost:3000/api/dev/whoami\n\n' +
      'Usage:\n  SEED_ARTIST_ID=<id> npx tsx prisma/seed-d4-8-5.ts\n',
    );
    process.exit(1);
  }

  console.log('\n══ D4.8.5 Seed ═══════════════════════════════════════════════');

  // Verify artist
  const artist = await prisma.artist.findUniqueOrThrow({ where: { id: SEED_ARTIST_ID } });
  console.log(`\n  Artist: ${artist.id}  (${artist.email})`);

  const sessionUrls: { label: string; sessionId: string }[] = [];

  for (const f of FINGERS) {
    const localPath = path.join(IMAGE_BASE, f.localFile);
    console.log(`\n─── ${f.label.toUpperCase()} ───────────────────────────────────`);
    console.log(`  File: ${f.localFile}`);

    if (!fs.existsSync(localPath)) {
      console.error(`  ⛔  Not found: ${localPath}`);
      console.error('  Set D485_IMAGE_DIR=<folder> to override.');
      process.exit(1);
    }

    // ── 1. Decode image ──────────────────────────────────────────────────────
    console.log('  Decoding…');
    const imageData = await loadImageData(localPath);
    console.log(`  ✓ ${imageData.width}×${imageData.height} px`);

    // ── 2. Detect card ───────────────────────────────────────────────────────
    console.log('  Detecting card…');
    const detection = detectCard(imageData as unknown as ImageData);
    if (!detection) {
      console.error('  ⛔  detectCard() returned null');
      process.exit(1);
    }
    const [tl, tr, , bl] = detection.corners;
    const edgeTR = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const edgeBL = Math.hypot(bl.x - tl.x, bl.y - tl.y);
    const isPortrait = edgeBL > edgeTR;
    console.log(`  ✓ Card via ${detection.method} (${isPortrait ? 'PORTRAIT' : 'LANDSCAPE'})  TL→TR=${edgeTR.toFixed(0)}px  TL→BL=${edgeBL.toFixed(0)}px`);

    // ── 3. Portrait fix → compute H ──────────────────────────────────────────
    let cornersForH: Point[];
    if (isPortrait) {
      const [tl_d, tr_d, br_d, bl_d] = detection.corners;
      cornersForH = [bl_d, tl_d, tr_d, br_d];  // long edge BL→TL → 85.6 mm
    } else {
      cornersForH = detection.corners;
    }
    const cardHom = computeCardHomography(cornersForH);
    console.log(`  ✓ residualPx: ${cardHom.residualPx.toExponential(2)}`);

    // ── 4. D4.8.2 gate ───────────────────────────────────────────────────────
    const check = cardSelfConsistencyCheck(cardHom.imageToCard, cornersForH);
    const gate = check.pass ? '✅' : '❌';
    console.log(
      `  D4.8.2 ${gate}  recovered ${check.widthMm.toFixed(3)}×${check.heightMm.toFixed(3)} mm  ` +
      `(err ${check.widthErrPct.toFixed(3)}%, ${check.heightErrPct.toFixed(3)}%)`,
    );
    if (!check.pass) {
      console.error('  ⛔  D4.8.2 GATE FAILED — aborting');
      process.exit(1);
    }
    console.log('  imageToCard:');
    console.log(fmt3x3(cardHom.imageToCard));

    // ── 5. Upload to R2 ──────────────────────────────────────────────────────
    console.log(`  Uploading to R2 → ${f.storageKey}…`);
    await uploadToR2(localPath, f.storageKey);
    console.log('  ✓ Uploaded');

    // ── 6. Create DB records ─────────────────────────────────────────────────
    console.log('  Creating DB records…');

    const client = await prisma.client.create({
      data: {
        artistId: artist.id,
        name:     `D4.8.5 ${f.label} (left)`,
        email:    `d485-${f.label}@gethandsy.com`,
        status:   'PENDING_CAPTURE',
      },
    });

    const session = await prisma.captureSession.create({
      data: {
        clientId:             client.id,
        artistId:             artist.id,
        status:               'SUBMITTED',
        captureLinkToken:     `d485-${f.label}-${Date.now()}`,
        captureLinkExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        submittedAt:          new Date(),
      },
    });

    await prisma.captureImage.create({
      data: {
        sessionId:      session.id,
        imageType:      'TOP_DOWN',
        hand:           f.hand,
        finger:         f.finger,
        sequenceNumber: 1,
        storageKey:     f.storageKey,
        mimeType:       'image/jpeg',
        h_matrix:       cardHom.imageToCard as unknown as object,
      },
    });

    console.log(`  ✓ Session ${session.id}`);
    sessionUrls.push({ label: f.label, sessionId: session.id });
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n══ Done ══════════════════════════════════════════════════════\n');
  console.log('  Open these URLs in the browser to measure each finger:\n');
  for (const { label, sessionId } of sessionUrls) {
    console.log(`  ${label.padEnd(8)}  http://localhost:3000/measure/chord?sessionId=${sessionId}`);
  }
  console.log('\n  Click on the nail in each image to trigger the production measurement.\n');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
