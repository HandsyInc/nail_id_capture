-- D4.7: Chord measurement fallback persistence
-- Nullable JSONB column on CaptureImage.
-- Used when no GeometryPackage exists for the session (handsyFitId not yet set).
-- When a GeometryPackage IS present, accepted chord results are written into
-- GeometryPackage.widthData instead and this column stays NULL.
--
-- Shape of stored object:
-- {
--   captureImageId, hand, finger,
--   width_mm, length_mm, angle_deg,
--   contour_px, mrr_corners_mm, nail_click_px,
--   method: "SAM2_FOUNDER_CLICK_CHORD",
--   measuredAt, acceptedBy, acceptedAt
-- }

ALTER TABLE "CaptureImage" ADD COLUMN "chordMeasurement" JSONB;
