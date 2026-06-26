/**
 * prisma/audit-d4-9.ts
 *
 * D4.9 post-validation audit.
 *
 * Inspects the GeometryPackage for a given session and confirms that
 * widthData and icData contain all expected fields for each finger.
 *
 * Usage:
 *   SESSION_ID=<id> npx tsx prisma/audit-d4-9.ts
 */

import path from 'path';
import { config }       from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg }     from '@prisma/adapter-pg';
import { Pool }         from 'pg';

config({ path: path.resolve(process.cwd(), '.env.local') });
config({ path: path.resolve(process.cwd(), '.env') });

const pool    = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma  = new PrismaClient({ adapter });

const SESSION_ID = process.env.SESSION_ID;
if (!SESSION_ID) {
  console.error('\nUsage: SESSION_ID=<id> npx tsx prisma/audit-d4-9.ts\n');
  process.exit(1);
}

const FINGERS = ['LEFT_INDEX', 'LEFT_MIDDLE', 'LEFT_RING'] as const;

function check(label: string, value: unknown): '✅' | '❌' {
  return value !== null && value !== undefined ? '✅' : '❌';
}
function row(label: string, value: unknown) {
  const icon = check(label, value);
  const display = typeof value === 'object' ? JSON.stringify(value).slice(0, 80) : String(value ?? 'null');
  console.log(`    ${icon} ${label.padEnd(30)} ${display}`);
}

async function main() {
  const session = await prisma.captureSession.findUnique({
    where:  { id: SESSION_ID },
    select: { id: true, clientId: true, handsyFitId: true },
  });

  if (!session) { console.error(`Session ${SESSION_ID} not found.`); process.exit(1); }

  console.log(`\n══ Session ${session.id}`);
  console.log(`   clientId:     ${session.clientId}`);
  console.log(`   handsyFitId:  ${session.handsyFitId ?? '❌ MISSING'}`);

  const gp = await prisma.geometryPackage.findFirst({
    where:   { captureSessionId: SESSION_ID, isCurrent: true },
    orderBy: { version: 'desc' },
  });

  if (!gp) {
    console.error('\n❌ No current GeometryPackage found for this session.\n');
    process.exit(1);
  }

  console.log(`\n   GeometryPackage ${gp.id}  (version ${gp.version}, isCurrent=${gp.isCurrent})`);
  console.log(`   pipelineVersion: ${gp.pipelineVersion}`);
  console.log(`   handsyFitId:     ${gp.handsyFitId}`);
  console.log(`   captureSessionId:${gp.captureSessionId}`);

  const widthData  = (gp.widthData  as Record<string, unknown> | null) ?? {};
  const icData     = (gp.icData     as Record<string, unknown> | null) ?? {};
  const chordMeas  = (widthData.chordMeasurements  as Record<string, unknown>) ?? {};
  const icMeas     = (icData.icMeasurements        as Record<string, unknown>) ?? {};

  let allPass = true;

  for (const finger of FINGERS) {
    console.log(`\n  ── ${finger} ─────────────────────────────────────────────`);

    // ── Chord ──────────────────────────────────────────────────────────────
    const chord = chordMeas[finger] as Record<string, unknown> | undefined;
    console.log(`\n  widthData.chordMeasurements[${finger}]:`);
    if (!chord) {
      console.log(`    ❌ MISSING`);
      allPass = false;
    } else {
      row('width_mm',      chord.width_mm);
      row('length_mm',     chord.length_mm);
      row('provenance',    chord.provenance);
      const prov = chord.provenance as Record<string, unknown> | undefined;
      if (prov) {
        row('  .computerProposal',  prov.computerProposal);
        row('  .founderValue',      prov.founderValue);
        row('  .acceptedProposal',  prov.acceptedProposal);
        row('  .correctionMag',     prov.correctionMagnitude);
        row('  .attemptCount',      prov.attemptCount);
      }
      if (!chord.width_mm) allPass = false;
    }

    // ── IC ─────────────────────────────────────────────────────────────────
    const ic = icMeas[finger] as Record<string, unknown> | undefined;
    console.log(`\n  icData.icMeasurements[${finger}]:`);
    if (!ic) {
      console.log(`    ❌ MISSING`);
      allPass = false;
    } else {
      row('chordWidthMm',   ic.chordWidthMm);
      row('sagittaMm',      ic.sagittaMm);
      row('icMm',           ic.icMm);
      row('regionBlurScore',ic.regionBlurScore);
      row('apexProvenance', ic.apexProvenance ? '(present)' : null);
      const ap = ic.apexProvenance as Record<string, unknown> | undefined;
      if (ap) {
        const cp = ap.computerProposal as Record<string, unknown> | undefined;
        row('  .computerProposal', cp ? '(present)' : null);
        if (cp) {
          row('    .value',      cp.value);
          row('    .score',      cp.score);
          row('    .confidence', cp.confidence);
          row('    .method',     cp.method);
          const extra = cp.extra as Record<string, unknown> | undefined;
          if (extra) {
            row('    .extra.arcScore',       extra.arcScore);
            row('    .extra.peakArcScore',   extra.peakArcScore);
            row('    .extra.peakScore',      extra.peakScore);
            row('    .extra.fractionOfPeak', extra.fractionOfPeak);
          }
        }
        row('  .founderValue',      ap.founderValue);
        row('  .acceptedProposal',  ap.acceptedProposal);
        row('  .correctionMag',     ap.correctionMagnitude);
        row('  .attemptCount',      ap.attemptCount);
      }
      if (!ic.chordWidthMm || !ic.sagittaMm || !ic.icMm) allPass = false;
    }
  }

  console.log('\n══════════════════════════════════════════════════════════════');
  if (allPass) {
    console.log('✅  All checks passed. D4.9 GeometryPackage is complete.\n');
  } else {
    console.log('❌  Some checks failed — see above.\n');
    process.exit(1);
  }
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
