/*
  Warnings:

  - Made the column `captureLinkToken` on table `CaptureSession` required. This step will fail if there are existing NULL values in that column.
  - Made the column `captureLinkExpiresAt` on table `CaptureSession` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "CaptureSession" ALTER COLUMN "captureLinkToken" SET NOT NULL,
ALTER COLUMN "captureLinkExpiresAt" SET NOT NULL;
