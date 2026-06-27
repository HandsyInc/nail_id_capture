/**
 * prisma/audit-d4-10.ts
 *
 * D4.10 post-validation audit.
 *
 * Extends audit-d4-9 to also inspect longitudinalData.longitudinalMeasurements.
 * Checks:
 *   1. All expected fingers have a longitudinalData entry.
 *   2. Each entry contains the required fields (cuticlePx, freeEdgePx, apexPx,
 *      chordLengthPx, heightPx, apexPositionRatio).
 *   3. Internal consistency: if mm fields are present,
 *      |hOverL − heightMm / lengthMm| < 1e-4
 *      and apexPositionPercent ≈ apexPositionRatio × 100 (within 0.01).
 *   4. apexPositionPercent is in [0, 100] when present.
 *   5. heightMm >= 0 and lengthMm > 0 when present.
 *   6. widthData (D4.8) and icData (D4.9) still pass their existing checks.
 *
 * Usage:
 *   SESSION_ID=<id> npx tsx prisma/audit-d4-10.ts   ← explicit session
 *   npx tsx prisma/audit-d4-10.ts                   ← auto-discovers latest session
 *
 * Auto-discovery: finds the most recently created CaptureSession that has
 * a current (isCurrent=true) GeometryPackage — i.e. the latest session where
 * measurement work has actually been written. If no such session exists, the
 * script falls back to the most recent CaptureSession of any kind.
 *
 * Set FINGERS env var to override the default finger list:
 *   FINGERS=LEFT_INDEX,LEFT_MIDDLE npx tsx prisma/audit-d4-10.ts
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

/**
 * Resolve the session ID to audit.
 * Explicit SESSION_ID env var → use it directly.
 * Otherwise → find the most recent session with an isCurrent GeometryPackage,
 * falling back to the most recent session of any kind.
 */
async function resolveSessionId(): Promise<string> {
  if (process.env.SESSION_ID) return process.env.SESSION_ID;

  // Most recent session that has actual measurement data
  const withGp = await prisma.captureSession.findFirst({
    where:   { geometryPackages: { some: { isCurrent: true } } },
    orderBy: { createdAt: 'desc' },
    select:  { id: true, createdAt: true },
  });
  if (withGp) {
    console.log(`\nℹ️  Auto-discovered session with GeometryPackage: ${withGp.id}`);
    console.log(`   (created ${withGp.createdAt.toISOString()})`);
    console.log(`   Override with: SESSION_ID=<id> npx tsx prisma/audit-d4-10.ts\n`);
    return withGp.id;
  }

  // Fallback: most recent session of any kind
  const anySession = await prisma.captureSession.findFirst({
    orderBy: { createdAt: 'desc' },
    select:  { id: true, createdAt: true },
  });
  if (anySession) {
    console.log(`\n⚠️  No session with a GeometryPackage found. Using latest session: ${anySession.id}\n`);
    return anySession.id;
  }

  console.error('\n❌ No CaptureSession records found in the database.\n');
  console.error('   Provide one explicitly: SESSION_ID=<id> npx tsx prisma/audit-d4-10.ts\n');
  process.exit(1);
}

const DEFAULT_FINGERS = ['LEFT_INDEX', 'LEFT_MIDDLE', 'LEFT_RING'] as const;
const FINGERS: readonly string[] = process.env.FINGERS
  ? process.env.FINGERS.split(',').map(s => s.trim())
  : DEFAULT_FINGERS;

function row(label: string, value: unknown, forcePass?: boolean) {
  const icon = (forcePass !== undefined ? forcePass : value !== null && value !== undefined) ? '✅' : '❌';
  const display = typeof value === 'object'
    ? JSON.stringify(value).slice(0, 80)
    : String(value ?? 'null');
  console.log(`    ${icon} ${label.padEnd(38)} ${display}`);
}

function near(a: number, b: number, tol = 1e-4): boolean {
  return Math.abs(a - b) <= tol;
}

async function main() {
  const sessionId = await resolveSessionId();

  const session = await prisma.captureSession.findUnique({
    where:  { id: sessionId },
    select: { id: true, clientId: true, handsyFitId: true },
  });

  if (!session) { console.error(`Session ${sessionId} not found.`); process.exit(1); }

  console.log(`\n══ Session ${session.id}`);
  console.log(`   clientId:     ${session.clientId}`);
  console.log(`   handsyFitId:  ${session.handsyFitId ?? '❌ MISSING'}`);

  const gp = await prisma.geometryPackage.findFirst({
    where:   { captureSessionId: sessionId, isCurrent: true },
    orderBy: { version: 'desc' },
  });

  if (!gp) {
    console.error('\n❌ No current GeometryPackage found for this session.\n');
    process.exit(1);
  }

  console.log(`\n   GeometryPackage ${gp.id}  (version ${gp.version}, isCurrent=${gp.isCurrent})`);
  console.log(`   pipelineVersion:  ${gp.pipelineVersion}`);
  console.log(`   captureSessionId: ${gp.captureSessionId}`);

  // Confirm the old columns are gone
  const gpRaw = gp as Record<string, unknown>;
  if ('hlData' in gpRaw) {
    console.log('\n  ❌ SCHEMA: hlData column still present — migration 20260626000000 not applied.');
  }
  if ('apPercent' in gpRaw) {
    console.log('\n  ❌ SCHEMA: apPercent column still present — migration 20260626000000 not applied.');
  }

  // longitudinalData added in D4.10 migration — cast until prisma generate is re-run.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gpAny = gp as any;
  const widthData        = (gp.widthData             as Record<string, unknown> | null) ?? {};
  const icData           = (gp.icData                as Record<string, unknown> | null) ?? {};
  const longitudinalData = (gpAny.longitudinalData   as Record<string, unknown> | null) ?? {};
  const chordMeas        = (widthData.chordMeasurements        as Record<string, unknown>) ?? {};
  const icMeas           = (icData.icMeasurements              as Record<string, unknown>) ?? {};
  const longMeas         = (longitudinalData.longitudinalMeasurements as Record<string, unknown>) ?? {};

  let allPass = true;

  for (const finger of FINGERS) {
    console.log(`\n  ── ${finger} ─────────────────────────────────────────────`);

    // ── D4.8 chord (unchanged from audit-d4-9) ────────────────────────────
    const chord = chordMeas[finger] as Record<string, unknown> | undefined;
    console.log(`\n  widthData.chordMeasurements[${finger}]:`);
    if (!chord) {
      console.log(`    ❌ MISSING`);
      allPass = false;
    } else {
      row('width_mm', chord.width_mm);
      if (!chord.width_mm) allPass = false;
    }

    // ── D4.9 IC (unchanged from audit-d4-9) ──────────────────────────────
    const ic = icMeas[finger] as Record<string, unknown> | undefined;
    console.log(`\n  icData.icMeasurements[${finger}]:`);
    if (!ic) {
      console.log(`    ❌ MISSING`);
      allPass = false;
    } else {
      row('chordWidthMm',  ic.chordWidthMm);
      row('sagittaMm',     ic.sagittaMm);
      row('icMm',          ic.icMm);
      row('apexProvenance',ic.apexProvenance ? '(present)' : null);
      if (!ic.chordWidthMm || !ic.sagittaMm || !ic.icMm) allPass = false;
    }

    // ── D4.10 longitudinal ────────────────────────────────────────────────
    const lng = longMeas[finger] as Record<string, unknown> | undefined;
    console.log(`\n  longitudinalData.longitudinalMeasurements[${finger}]:`);
    if (!lng) {
      console.log(`    ❌ MISSING`);
      allPass = false;
    } else {
      // Required pixel-space fields
      row('cuticlePx',          lng.cuticlePx);
      row('freeEdgePx',         lng.freeEdgePx);
      row('apexPx',             lng.apexPx);
      row('chordLengthPx',      lng.chordLengthPx);
      row('heightPx',           lng.heightPx);
      row('apexPositionRatio',  lng.apexPositionRatio);
      row('method',             lng.method);

      const missingRequired =
        !lng.cuticlePx || !lng.freeEdgePx || !lng.apexPx ||
        lng.chordLengthPx == null || lng.heightPx == null || lng.apexPositionRatio == null;
      if (missingRequired) allPass = false;

      // mm-space consistency (only when mm fields are present)
      const lengthMm           = lng.lengthMm           as number | null;
      const heightMm           = lng.heightMm           as number | null;
      const hOverL             = lng.hOverL             as number | null;
      const apexPositionPercent = lng.apexPositionPercent as number | null;
      const apexPositionRatio  = lng.apexPositionRatio  as number;

      console.log(`\n    mm-space:`);
      if (lengthMm !== null && heightMm !== null && hOverL !== null) {
        row('lengthMm',            lengthMm);
        row('heightMm',            heightMm);
        row('hOverL',              hOverL);
        row('apexPositionPercent', apexPositionPercent);

        // Internal consistency checks
        const hOverLDerived = lengthMm > 0 ? heightMm / lengthMm : 0;
        const hOverLOk      = near(hOverL, hOverLDerived, 1e-4);
        row(`hOverL consistency (|stored − h/L|<1e-4)`, hOverLOk ? hOverL.toFixed(6) : `FAIL: stored=${hOverL.toFixed(6)} derived=${hOverLDerived.toFixed(6)}`, hOverLOk);
        if (!hOverLOk) allPass = false;

        if (apexPositionPercent !== null) {
          const apPctDerived = apexPositionRatio * 100;
          const apPctOk      = near(apexPositionPercent, apPctDerived, 0.01);
          row(`AP% consistency (|stored − ratio×100|<0.01)`, apPctOk ? apexPositionPercent.toFixed(3) : `FAIL: stored=${apexPositionPercent.toFixed(3)} derived=${apPctDerived.toFixed(3)}`, apPctOk);
          if (!apPctOk) allPass = false;

          const apPctRange = apexPositionPercent >= 0 && apexPositionPercent <= 100;
          row('apexPositionPercent in [0, 100]', apexPositionPercent.toFixed(1) + '%', apPctRange);
          if (!apPctRange) allPass = false;
        }

        const heightOk = heightMm >= 0;
        const lengthOk = lengthMm > 0;
        row('heightMm >= 0', heightMm.toFixed(3), heightOk);
        row('lengthMm > 0',  lengthMm.toFixed(3), lengthOk);
        if (!heightOk || !lengthOk) allPass = false;

      } else {
        console.log(`    ℹ️  mm fields are null — image had no H matrix at capture (px-only record).`);
        row('apexPositionPercent (ratio×100 cross-check)', apexPositionRatio !== undefined ? (apexPositionRatio * 100).toFixed(1) + '% (derived from px ratio)' : null);
      }

      // Provenance
      const prov = lng.apexProvenance as Record<string, unknown> | undefined | null;
      console.log(`\n    provenance:`);
      row('apexProvenance present',   prov ? '(present)' : null, !!prov);
      if (prov) {
        row('  .founderValue',          prov.founderValue);
        row('  .computerProposal',      prov.computerProposal === null ? 'null (expected for D4.10)' : prov.computerProposal, true);
        row('  .attemptCount',          prov.attemptCount);
      } else {
        allPass = false;
      }
    }
  }

  console.log('\n══════════════════════════════════════════════════════════════');
  if (allPass) {
    console.log('✅  All checks passed. D4.10 GeometryPackage is complete.\n');
  } else {
    console.log('❌  Some checks failed — see above.\n');
    process.exit(1);
  }
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
