/**
 * prisma/update-h-matrix.ts
 *
 * D4.8 Step 1 — Replace the dummy H matrix in the seeded CaptureImage row
 * with a real production-derived H matrix, using the same functions that run
 * during live capture (detectCard → computeCardHomography → imageToCard).
 *
 * What it does:
 *   1. Loads the seeded test image from disk.
 *   2. Decodes the JPEG to raw RGBA pixels via `sharp`.
 *   3. Runs detectCard() on the pixel data — same function as LiveCaptureView.
 *   4. Runs computeCardHomography() on the detected corners.
 *   5. Extracts `imageToCard` (pixels → card-plane mm).
 *   6. Computes the D4.8.2 self-consistency check: applies H to the four
 *      canonical card corners and measures recovered dimensions vs. ISO 7810.
 *   7. Updates CaptureImage.h_matrix in Neon.
 *   8. Prints a full diagnostic report.
 *
 * Requires sharp for JPEG decoding (not in the main package.json):
 *   npm install --save-dev sharp @types/sharp
 *
 * Usage:
 *   npx tsx prisma/update-h-matrix.ts
 *
 * No session ID required — the script locates the seeded image directly
 * by its fixed storageKey ('dev-seed/IMG_4590-index-left.jpg').
 *
 * Run from the nail_id_capture-master directory so .env.local is found.
 */

import fs from 'fs';
import path from 'path';
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

// ── Env ──────────────────────────────────────────────────────────────────────
config({ path: path.resolve(process.cwd(), '.env.local') });
config({ path: path.resolve(process.cwd(), '.env') });

// ── Config ───────────────────────────────────────────────────────────────────
// The storage key is a fixed constant set by seed-dev.ts — no session ID needed.
const SEED_STORAGE_KEY = 'dev-seed/IMG_4590-index-left.jpg';

const LOCAL_IMAGE_PATH =
  process.env.SEED_IMAGE_PATH ??
  path.join(
    process.env.HOME ?? '',
    'Desktop/Handsy Phase V00 test images/IMG_4590 index left.jpg',
  );

// ── Prisma ───────────────────────────────────────────────────────────────────
const pool    = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma  = new PrismaClient({ adapter });

// ── Production card-geometry functions (same as LiveCaptureView) ─────────────
// Import via relative path so we use the identical code path as live capture.
// tsx resolves these at runtime — no build step required.
import { detectCard }           from '../lib/capture-v2/card-detector';
import {
  computeCardHomography,
  applyHomography,
  CARD_WIDTH_MM,
  CARD_HEIGHT_MM,
  type Matrix3x3,
} from '../lib/capture-v2/card-homography';
import type { Point } from '../lib/capture-v2/cv-primitives';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Decode a JPEG file to raw RGBA via `sharp` and return an ImageData-compatible
 * object.  `detectCard` only reads `.data`, `.width`, `.height` — no DOM needed.
 *
 * sharp is a devDependency of this script only.  If it isn't installed the
 * error message below tells you exactly what to run.
 */
async function loadImageData(
  filePath: string,
): Promise<{ data: Uint8Array; width: number; height: number }> {
  let sharp: typeof import('sharp').default;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.error(
      '\n⛔  sharp is not installed.\n' +
      '    Run: npm install --save-dev sharp @types/sharp\n' +
      '    Then re-run this script.\n',
    );
    process.exit(1);
  }

  const { data, info } = await sharp(filePath)
    .ensureAlpha()           // force 4 channels (RGBA) regardless of source
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

/**
 * D4.8.2 self-consistency check.
 *
 * Applies the recovered imageToCard homography to the four canonical card-pixel
 * corners in image space and measures the resulting card dimensions.
 * For a correct H the recovered width and height must match the ISO/IEC 7810
 * ID-1 spec (85.60 × 53.98 mm) within ±1%.
 *
 * Returns the recovered dimensions and the pass/fail result.
 */
function cardSelfConsistencyCheck(
  imageToCard: Matrix3x3,
  detectedCornersPx: Point[],
): {
  recoveredWidthMm: number;
  recoveredHeightMm: number;
  widthErrorPct: number;
  heightErrorPct: number;
  pass: boolean;
} {
  // The four detected corners are in [TL, TR, BR, BL] order.
  const [tl, tr, br, bl] = detectedCornersPx;

  const tlMm = applyHomography(imageToCard, tl);
  const trMm = applyHomography(imageToCard, tr);
  const brMm = applyHomography(imageToCard, br);
  const blMm = applyHomography(imageToCard, bl);

  // Recover width from the top edge (TL → TR) and height from the left edge
  // (TL → BL), then average with the opposite edges for robustness.
  const topWidthMm    = Math.hypot(trMm.x - tlMm.x, trMm.y - tlMm.y);
  const bottomWidthMm = Math.hypot(brMm.x - blMm.x, brMm.y - blMm.y);
  const leftHeightMm  = Math.hypot(blMm.x - tlMm.x, blMm.y - tlMm.y);
  const rightHeightMm = Math.hypot(brMm.x - trMm.x, brMm.y - trMm.y);

  const recoveredWidthMm  = (topWidthMm + bottomWidthMm) / 2;
  const recoveredHeightMm = (leftHeightMm + rightHeightMm) / 2;

  const widthErrorPct  = Math.abs(recoveredWidthMm  - CARD_WIDTH_MM)  / CARD_WIDTH_MM  * 100;
  const heightErrorPct = Math.abs(recoveredHeightMm - CARD_HEIGHT_MM) / CARD_HEIGHT_MM * 100;

  return {
    recoveredWidthMm,
    recoveredHeightMm,
    widthErrorPct,
    heightErrorPct,
    pass: widthErrorPct <= 1.0 && heightErrorPct <= 1.0,
  };
}

function fmt3x3(m: Matrix3x3): string {
  return m.map(row =>
    '  [' + row.map(v => v.toExponential(6).padStart(15)).join(', ') + ']'
  ).join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── Guard ──────────────────────────────────────────────────────────────────
  if (!fs.existsSync(LOCAL_IMAGE_PATH)) {
    console.error(
      `\n⛔  Image not found: ${LOCAL_IMAGE_PATH}\n` +
      '    Set SEED_IMAGE_PATH=<absolute path> to override.\n',
    );
    process.exit(1);
  }

  console.log('\n── D4.8 update-h-matrix ──────────────────────────────────────');
  console.log(`\n  Image : ${path.basename(LOCAL_IMAGE_PATH)}`);
  console.log(`  Path  : ${LOCAL_IMAGE_PATH}`);

  // ── 1. Decode JPEG ─────────────────────────────────────────────────────────
  console.log('\n1. Decoding image…');
  const imageData = await loadImageData(LOCAL_IMAGE_PATH);
  console.log(`  ✓ ${imageData.width}×${imageData.height} px  (${(imageData.data.length / 1_048_576).toFixed(1)} MB RGBA)`);

  // ── 2. Card detection ──────────────────────────────────────────────────────
  console.log('\n2. Running detectCard() [production function, same as LiveCaptureView]…');
  // detectCard expects { data, width, height } — cast suppresses the DOM-type
  // check; the function only reads those three fields at runtime.
  const detection = detectCard(imageData as unknown as ImageData);

  if (!detection) {
    console.error(
      '\n⛔  detectCard() returned null — no card found in the image.\n\n' +
      '    Possible causes:\n' +
      '      • Image does not contain a credit/debit/loyalty card.\n' +
      '      • Card occupies less than 1% or more than 60% of the frame.\n' +
      '      • Lighting conditions prevent Otsu thresholding from isolating the card.\n\n' +
      '    The H matrix has NOT been updated.\n' +
      '    Resolve the detection issue before re-running D4.8 validation.\n',
    );
    process.exit(1);
  }

  console.log(`  ✓ Card detected via ${detection.method} (confidence: ${detection.confidence})`);
  console.log(`    framePct       : ${detection.metrics.framePct.toFixed(1)}%`);
  console.log(`    longEdge       : ${Math.round(detection.metrics.longEdge)} px`);
  console.log(`    shortEdge      : ${Math.round(detection.metrics.shortEdge)} px`);
  console.log(`    ratio          : ${detection.metrics.ratio.toFixed(4)}  (truth ≈ 1.5860)`);
  console.log(`    perspectiveSkew: ${detection.metrics.perspectiveSkew.toFixed(4)}`);
  console.log(`    areaFrac       : ${(detection.metrics.areaFrac * 100).toFixed(1)}%`);
  console.log(`    notes          : ${detection.notes}`);

  console.log('\n    Detected corners (input image coords, px):');
  const labels = ['TL', 'TR', 'BR', 'BL'];
  detection.corners.forEach((c, i) => {
    console.log(`      ${labels[i]}  x=${c.x.toFixed(1)}  y=${c.y.toFixed(1)}`);
  });

  // ── 3. Homography ──────────────────────────────────────────────────────────
  console.log('\n3. Running computeCardHomography() [production function, same as LiveCaptureView]…');

  // Portrait-orientation fix (D4.8):
  // detectCard always returns corners in [TL, TR, BR, BL] image order.
  // computeCardHomography unconditionally maps TL→TR to CARD_WIDTH_MM (85.6mm).
  // When the card is held in portrait orientation (long axis vertical),
  // TL→TR is the short physical edge (53.98mm), so 85.6mm is wrongly assigned
  // to it — creating a ~2.5× anisotropy in H that corrupts nail measurements.
  //
  // Fix: if TL→BL > TL→TR (portrait), rotate corner order to [BL, TL, TR, BR]
  // so the long physical edge (BL→TL, ≈1194px) maps to the 85.6mm axis
  // and the short physical edge (TL→TR, ≈736px) maps to the 53.98mm axis.
  const [tl_det, tr_det, br_det, bl_det] = detection.corners;
  const edgeTR = Math.hypot(tr_det.x - tl_det.x, tr_det.y - tl_det.y);  // TL→TR
  const edgeBL = Math.hypot(bl_det.x - tl_det.x, bl_det.y - tl_det.y);  // TL→BL
  const isPortrait = edgeBL > edgeTR;

  let cornersForH: Point[];
  if (isPortrait) {
    // [BL, TL, TR, BR]: the BL→TL edge (long, ≈1194px) maps to CARD_WIDTH_MM (85.6mm)
    cornersForH = [bl_det, tl_det, tr_det, br_det];
    console.log(`  ⚠  Portrait card detected:`);
    console.log(`       TL→TR = ${edgeTR.toFixed(1)} px  (short physical edge → 53.98 mm)`);
    console.log(`       TL→BL = ${edgeBL.toFixed(1)} px  (long  physical edge → 85.60 mm)`);
    console.log('     Reordering corners to [BL, TL, TR, BR] so 85.60 mm maps to the long axis.');
  } else {
    cornersForH = detection.corners;
    console.log(`  ℹ  Landscape card (TL→TR=${edgeTR.toFixed(1)}px ≥ TL→BL=${edgeBL.toFixed(1)}px), corners unchanged.`);
  }

  const cardHomography = computeCardHomography(cornersForH);

  console.log(`  ✓ residualPx: ${cardHomography.residualPx.toExponential(3)}  (< 1e-6 expected for well-conditioned solve)`);

  if (cardHomography.residualPx > 0.5) {
    console.warn(
      '  ⚠  Residual is above 0.5 px — the corner solve may be degenerate.\n' +
      '     Review the detected corners before trusting this homography.',
    );
  }

  console.log('\n  imageToCard (image px → card-plane mm):');
  console.log(fmt3x3(cardHomography.imageToCard));

  // ── 4. D4.8.2 self-consistency check ──────────────────────────────────────
  console.log('\n4. D4.8.2 self-consistency check (ISO/IEC 7810 ID-1: 85.60 × 53.98 mm)…');
  // Use cornersForH (same order passed to computeCardHomography) so that the
  // recovered dimensions are measured against the correct physical edge assignment.
  const check = cardSelfConsistencyCheck(cardHomography.imageToCard, cornersForH);

  const widthStatus  = check.widthErrorPct  <= 1.0 ? '✅' : '❌';
  const heightStatus = check.heightErrorPct <= 1.0 ? '✅' : '❌';

  console.log(`  Recovered width  : ${check.recoveredWidthMm.toFixed(3)} mm  (spec ${CARD_WIDTH_MM} mm, error ${check.widthErrorPct.toFixed(3)}%)  ${widthStatus}`);
  console.log(`  Recovered height : ${check.recoveredHeightMm.toFixed(3)} mm  (spec ${CARD_HEIGHT_MM} mm, error ${check.heightErrorPct.toFixed(3)}%)  ${heightStatus}`);

  if (!check.pass) {
    console.error(
      '\n⛔  D4.8.2 GATE FAILED.\n\n' +
      '    The H matrix does not reproduce the calibration card\'s physical\n' +
      '    dimensions within ±1%. Per the D4.8 protocol:\n\n' +
      '      Stop. Do not proceed to MRR validation, segmentation, or\n' +
      '      depth correction. The error source is in H and must be fixed first.\n\n' +
      '    The H matrix has NOT been written to the database.\n',
    );
    process.exit(1);
  }

  console.log('\n  ✅  D4.8.2 gate passed — H reproduces card dimensions within ±1%.');
  console.log('      Safe to proceed to D4.8.3 (MRR unit test).');

  // ── 5. Look up seeded CaptureImage ────────────────────────────────────────
  console.log('\n5. Looking up seeded CaptureImage…');
  const captureImage = await prisma.captureImage.findFirst({
    where: { storageKey: SEED_STORAGE_KEY },
    orderBy: { uploadedAt: 'desc' },
    select: { id: true, sessionId: true, hand: true, finger: true, h_matrix: true },
  });

  if (!captureImage) {
    console.error(
      `\n⛔  No CaptureImage found with storageKey '${SEED_STORAGE_KEY}'.\n` +
      '    Re-run prisma/seed-dev.ts to create the fixture, then retry.\n',
    );
    process.exit(1);
  }

  console.log(`  ✓ Found CaptureImage id=${captureImage.id}  hand=${captureImage.hand}  finger=${captureImage.finger}`);
  const previousH = captureImage.h_matrix;
  if (previousH !== null) {
    const prev = previousH as number[][];
    console.log(`    Previous h_matrix[0][0]: ${prev[0][0]}  (0.125 = dummy)`);
  }

  // ── 6. Write imageToCard to Neon ──────────────────────────────────────────
  console.log('\n6. Writing imageToCard to CaptureImage.h_matrix…');
  const updated = await prisma.captureImage.update({
    where: { id: captureImage.id },
    data: { h_matrix: cardHomography.imageToCard as unknown as object },
    select: { id: true, h_matrix: true },
  });

  const written = updated.h_matrix as number[][];
  console.log(`  ✓ Written. h_matrix[0][0]: ${written[0][0].toExponential(4)}  (was ${(previousH as number[][] | null)?.[0]?.[0] ?? 'null'})`);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n── Done ──────────────────────────────────────────────────────');
  console.log(`\n  Image         : ${path.basename(LOCAL_IMAGE_PATH)}`);
  console.log(`  CaptureImage  : ${captureImage.id}`);
  console.log(`  D4.8.2 gate   : PASSED  (width ${check.widthErrorPct.toFixed(3)}% error, height ${check.heightErrorPct.toFixed(3)}% error)`);
  console.log(`  H written     : ✅`);
  console.log('\n  imageToCard:');
  console.log(fmt3x3(cardHomography.imageToCard));
  console.log('\n  Next step: D4.8.3 — MRR unit test with synthetic contour.\n');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
