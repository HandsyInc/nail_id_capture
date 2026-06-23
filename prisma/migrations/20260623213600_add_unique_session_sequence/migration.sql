-- AddUniqueConstraint: CaptureImage(sessionId, sequenceNumber)
-- Prevents duplicate rows when the same shot index is uploaded more than once.

-- Step 1: Remove any existing duplicate rows, keeping the most recently uploaded one.
-- If duplicates already exist in the DB, this cleans them before the constraint is applied.
DELETE FROM "CaptureImage"
WHERE id NOT IN (
  SELECT DISTINCT ON ("sessionId", "sequenceNumber") id
  FROM "CaptureImage"
  ORDER BY "sessionId", "sequenceNumber", "uploadedAt" DESC
);

-- Step 2: Add the unique constraint.
ALTER TABLE "CaptureImage" ADD CONSTRAINT "CaptureImage_sessionId_sequenceNumber_key" UNIQUE ("sessionId", "sequenceNumber");
