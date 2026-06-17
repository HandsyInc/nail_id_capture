-- CreateEnum
CREATE TYPE "NotificationPreference" AS ENUM ('EMAIL', 'SMS', 'BOTH', 'NONE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'TRIAL', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('PENDING_CAPTURE', 'PROCESSING', 'READY', 'ACTIVE', 'NEEDS_RECAPTURE');

-- CreateEnum
CREATE TYPE "CaptureSessionType" AS ENUM ('INITIAL', 'RECAPTURE');

-- CreateEnum
CREATE TYPE "CaptureSessionStatus" AS ENUM ('PENDING', 'SUBMITTED', 'PROCESSING', 'COMPLETE', 'NEEDS_RETAKE');

-- CreateEnum
CREATE TYPE "ImageType" AS ENUM ('TOP_DOWN', 'TRANSVERSE', 'LONGITUDINAL', 'PALM_UP_CURVATURE');

-- CreateEnum
CREATE TYPE "Hand" AS ENUM ('LEFT', 'RIGHT');

-- CreateEnum
CREATE TYPE "Finger" AS ENUM ('THUMB', 'INDEX', 'MIDDLE', 'RING', 'PINKY');

-- CreateEnum
CREATE TYPE "RecaptureReason" AS ENUM ('BLURRY', 'MISSING_ANGLE', 'FINGER_BLOCKED', 'LIGHTING_ISSUE', 'OTHER');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('RECOMMENDED', 'NOT_RECOMMENDED');

-- CreateEnum
CREATE TYPE "FitNoteCategory" AS ENUM ('PRODUCT_LINE', 'PRODUCT', 'LEARNING');

-- CreateEnum
CREATE TYPE "RevisionReason" AS ENUM ('TOO_TIGHT', 'TOO_LOOSE', 'SIDEWALL_GAP', 'CLIENT_PREFERENCE', 'ARTIST_PREFERENCE', 'OTHER');

-- CreateEnum
CREATE TYPE "RevisionDirection" AS ENUM ('UP', 'DOWN');

-- CreateTable
CREATE TABLE "Artist" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'TRIAL',
    "notificationPreference" "NotificationPreference" NOT NULL DEFAULT 'EMAIL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Artist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "artistId" TEXT NOT NULL,
    "handsyFitId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "status" "ClientStatus" NOT NULL DEFAULT 'PENDING_CAPTURE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HandsyFit" (
    "id" TEXT NOT NULL,
    "publicIdentifier" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HandsyFit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeometryPackage" (
    "id" TEXT NOT NULL,
    "handsyFitId" TEXT NOT NULL,
    "captureSessionId" TEXT,
    "version" INTEGER NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "pipelineVersion" TEXT NOT NULL,
    "widthData" JSONB,
    "lengthData" JSONB,
    "icData" JSONB,
    "hlData" JSONB,
    "apPercent" DOUBLE PRECISION,
    "rawVariables" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeometryPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaptureSession" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "artistId" TEXT NOT NULL,
    "handsyFitId" TEXT,
    "type" "CaptureSessionType" NOT NULL DEFAULT 'INITIAL',
    "status" "CaptureSessionStatus" NOT NULL DEFAULT 'PENDING',
    "captureLinkToken" TEXT,
    "captureLinkExpiresAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "retakeReason" "RecaptureReason",
    "retakeFingers" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaptureSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaptureImage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "imageType" "ImageType" NOT NULL,
    "hand" "Hand" NOT NULL,
    "finger" "Finger" NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileSizeBytes" INTEGER,
    "mimeType" TEXT,
    "capturedAt" TIMESTAMP(3),
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaptureImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "productLine" TEXT NOT NULL,
    "shape" TEXT NOT NULL,
    "length" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "architectureData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL,
    "artistId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "handsyFitId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "geometryPackageId" TEXT NOT NULL,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'RECOMMENDED',
    "sizesLeft" JSONB NOT NULL,
    "sizesRight" JSONB NOT NULL,
    "isSaved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FitNote" (
    "id" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "category" "FitNoteCategory" NOT NULL,
    "text" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,

    CONSTRAINT "FitNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Revision" (
    "id" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "artistId" TEXT NOT NULL,
    "hand" "Hand" NOT NULL,
    "finger" "Finger" NOT NULL,
    "originalSize" DECIMAL(65,30) NOT NULL,
    "revisedSize" DECIMAL(65,30) NOT NULL,
    "direction" "RevisionDirection" NOT NULL,
    "reason" "RevisionReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Revision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Artist_handle_key" ON "Artist"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "Artist_email_key" ON "Artist"("email");

-- CreateIndex
CREATE INDEX "Client_artistId_idx" ON "Client"("artistId");

-- CreateIndex
CREATE UNIQUE INDEX "HandsyFit_publicIdentifier_key" ON "HandsyFit"("publicIdentifier");

-- CreateIndex
CREATE INDEX "GeometryPackage_handsyFitId_isCurrent_idx" ON "GeometryPackage"("handsyFitId", "isCurrent");

-- CreateIndex
CREATE UNIQUE INDEX "GeometryPackage_handsyFitId_version_key" ON "GeometryPackage"("handsyFitId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "CaptureSession_captureLinkToken_key" ON "CaptureSession"("captureLinkToken");

-- CreateIndex
CREATE INDEX "CaptureSession_clientId_idx" ON "CaptureSession"("clientId");

-- CreateIndex
CREATE INDEX "CaptureSession_artistId_idx" ON "CaptureSession"("artistId");

-- CreateIndex
CREATE INDEX "CaptureImage_sessionId_idx" ON "CaptureImage"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_brand_productLine_shape_length_key" ON "Product"("brand", "productLine", "shape", "length");

-- CreateIndex
CREATE INDEX "Recommendation_clientId_idx" ON "Recommendation"("clientId");

-- CreateIndex
CREATE INDEX "Recommendation_artistId_idx" ON "Recommendation"("artistId");

-- CreateIndex
CREATE INDEX "FitNote_recommendationId_idx" ON "FitNote"("recommendationId");

-- CreateIndex
CREATE INDEX "Revision_recommendationId_idx" ON "Revision"("recommendationId");

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_handsyFitId_fkey" FOREIGN KEY ("handsyFitId") REFERENCES "HandsyFit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeometryPackage" ADD CONSTRAINT "GeometryPackage_handsyFitId_fkey" FOREIGN KEY ("handsyFitId") REFERENCES "HandsyFit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeometryPackage" ADD CONSTRAINT "GeometryPackage_captureSessionId_fkey" FOREIGN KEY ("captureSessionId") REFERENCES "CaptureSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaptureSession" ADD CONSTRAINT "CaptureSession_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaptureSession" ADD CONSTRAINT "CaptureSession_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaptureSession" ADD CONSTRAINT "CaptureSession_handsyFitId_fkey" FOREIGN KEY ("handsyFitId") REFERENCES "HandsyFit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaptureImage" ADD CONSTRAINT "CaptureImage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CaptureSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_handsyFitId_fkey" FOREIGN KEY ("handsyFitId") REFERENCES "HandsyFit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_geometryPackageId_fkey" FOREIGN KEY ("geometryPackageId") REFERENCES "GeometryPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitNote" ADD CONSTRAINT "FitNote_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
