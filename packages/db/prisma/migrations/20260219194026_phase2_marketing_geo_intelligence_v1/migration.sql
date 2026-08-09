-- CreateEnum
CREATE TYPE "ReceiptOcrProvider" AS ENUM ('OPENAI_VISION', 'GOOGLE_VISION', 'TESSERACT');

-- CreateEnum
CREATE TYPE "ReceiptOcrStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobGeoSource" AS ENUM ('PROPERTY_ADDRESS', 'MANUAL_PIN', 'GEOCODED');

-- CreateEnum
CREATE TYPE "ReviewRequestChannel" AS ENUM ('SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "ReviewRequestStatus" AS ENUM ('DRAFT', 'QUEUED_APPROVAL', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "ReferralRewardType" AS ENUM ('CREDIT', 'GIFT_CARD', 'DISCOUNT');

-- CreateEnum
CREATE TYPE "ReferralEventStatus" AS ENUM ('INVITED', 'LEAD_CREATED', 'WON', 'REWARDED', 'VOID');

-- CreateTable
CREATE TABLE "ReceiptOcrResult" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "provider" "ReceiptOcrProvider" NOT NULL,
    "extractedMerchant" TEXT,
    "extractedDate" TIMESTAMP(3),
    "extractedTotalCents" INTEGER,
    "extractedTaxCents" INTEGER,
    "extractedLineItems" JSONB,
    "confidence" JSONB,
    "rawText" JSONB,
    "rawPayload" JSONB NOT NULL,
    "status" "ReceiptOcrStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptOcrResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobGeo" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "source" "JobGeoSource" NOT NULL,
    "addressNormalized" TEXT NOT NULL,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "geohash" TEXT,
    "geocodedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobGeo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeoRollupDaily" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "zip" TEXT,
    "city" TEXT,
    "geohashPrefix" TEXT NOT NULL,
    "leadsCount" INTEGER NOT NULL DEFAULT 0,
    "jobsCount" INTEGER NOT NULL DEFAULT 0,
    "revenueCents" INTEGER NOT NULL DEFAULT 0,
    "spendCents" INTEGER NOT NULL DEFAULT 0,
    "reviewsCount" INTEGER NOT NULL DEFAULT 0,
    "referralsCount" INTEGER NOT NULL DEFAULT 0,
    "closeRatePct" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeoRollupDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewRequest" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "customerId" TEXT,
    "jobId" TEXT,
    "channel" "ReviewRequestChannel" NOT NULL,
    "status" "ReviewRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "destination" TEXT NOT NULL,
    "messageDraft" TEXT NOT NULL,
    "approvalRequestId" TEXT,
    "sentAt" TIMESTAMP(3),
    "providerMeta" JSONB,
    "createdByType" "ActorType" NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralProgram" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "rewardType" "ReferralRewardType" NOT NULL,
    "rewardValueCents" INTEGER NOT NULL,
    "terms" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralProgram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "referrerCustomerId" TEXT NOT NULL,
    "referredLeadId" TEXT,
    "referredCustomerId" TEXT,
    "status" "ReferralEventStatus" NOT NULL DEFAULT 'INVITED',
    "rewardIssued" BOOLEAN NOT NULL DEFAULT false,
    "rewardIssuedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptOcrResult_receiptId_key" ON "ReceiptOcrResult"("receiptId");

-- CreateIndex
CREATE INDEX "ReceiptOcrResult_orgId_createdAt_idx" ON "ReceiptOcrResult"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobGeo_jobId_key" ON "JobGeo"("jobId");

-- CreateIndex
CREATE INDEX "JobGeo_orgId_zip_idx" ON "JobGeo"("orgId", "zip");

-- CreateIndex
CREATE INDEX "JobGeo_orgId_geohash_idx" ON "JobGeo"("orgId", "geohash");

-- CreateIndex
CREATE INDEX "GeoRollupDaily_orgId_date_idx" ON "GeoRollupDaily"("orgId", "date");

-- CreateIndex
CREATE INDEX "GeoRollupDaily_orgId_zip_idx" ON "GeoRollupDaily"("orgId", "zip");

-- CreateIndex
CREATE UNIQUE INDEX "GeoRollupDaily_orgId_date_zip_geohashPrefix_key" ON "GeoRollupDaily"("orgId", "date", "zip", "geohashPrefix");

-- CreateIndex
CREATE INDEX "ReviewRequest_orgId_status_createdAt_idx" ON "ReviewRequest"("orgId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewRequest_orgId_jobId_idx" ON "ReviewRequest"("orgId", "jobId");

-- CreateIndex
CREATE INDEX "ReferralProgram_orgId_isActive_idx" ON "ReferralProgram"("orgId", "isActive");

-- CreateIndex
CREATE INDEX "ReferralEvent_orgId_status_createdAt_idx" ON "ReferralEvent"("orgId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ReferralEvent_orgId_referrerCustomerId_idx" ON "ReferralEvent"("orgId", "referrerCustomerId");

-- AddForeignKey
ALTER TABLE "ReceiptOcrResult" ADD CONSTRAINT "ReceiptOcrResult_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptOcrResult" ADD CONSTRAINT "ReceiptOcrResult_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobGeo" ADD CONSTRAINT "JobGeo_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobGeo" ADD CONSTRAINT "JobGeo_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeoRollupDaily" ADD CONSTRAINT "GeoRollupDaily_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRequest" ADD CONSTRAINT "ReviewRequest_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRequest" ADD CONSTRAINT "ReviewRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRequest" ADD CONSTRAINT "ReviewRequest_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRequest" ADD CONSTRAINT "ReviewRequest_approvalRequestId_fkey" FOREIGN KEY ("approvalRequestId") REFERENCES "ApprovalRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRequest" ADD CONSTRAINT "ReviewRequest_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralProgram" ADD CONSTRAINT "ReferralProgram_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralEvent" ADD CONSTRAINT "ReferralEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralEvent" ADD CONSTRAINT "ReferralEvent_programId_fkey" FOREIGN KEY ("programId") REFERENCES "ReferralProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralEvent" ADD CONSTRAINT "ReferralEvent_referrerCustomerId_fkey" FOREIGN KEY ("referrerCustomerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralEvent" ADD CONSTRAINT "ReferralEvent_referredLeadId_fkey" FOREIGN KEY ("referredLeadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralEvent" ADD CONSTRAINT "ReferralEvent_referredCustomerId_fkey" FOREIGN KEY ("referredCustomerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
