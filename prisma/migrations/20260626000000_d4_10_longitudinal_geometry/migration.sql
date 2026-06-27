-- D4.10: Consolidate longitudinal geometry schema.
--
-- Two changes:
--   1. Rename GeometryPackage.hlData → longitudinalData.
--      hlData was an early placeholder field name. longitudinalData is the
--      canonical name that matches the full record shape (lengthMm, heightMm,
--      hOverL, apexPositionPercent) and is parallel to icData / widthData.
--
--   2. Drop GeometryPackage.apPercent (standalone Float?).
--      AP% is absorbed into longitudinalData.apexPositionPercent (stored as
--      part of the JSONB longitudinalMeasurements record). Keeping it as a
--      top-level column would duplicate the value and diverge on updates.
--
-- Both columns are null in all existing records — no data migration needed.

ALTER TABLE "GeometryPackage" RENAME COLUMN "hlData" TO "longitudinalData";
ALTER TABLE "GeometryPackage" DROP COLUMN "apPercent";
