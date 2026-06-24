-- Add h_matrix to CaptureImage
-- Nullable JSONB column — existing rows receive NULL automatically.
-- Stores the 3×3 imageToCard homography matrix as a nested JSON array:
--   [[h00,h01,h02],[h10,h11,h12],[h20,h21,h22]]
-- Populated at upload time when card detection succeeds; NULL otherwise.

ALTER TABLE "CaptureImage" ADD COLUMN "h_matrix" JSONB;
