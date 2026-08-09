-- CreateEnum
CREATE TYPE "AttributionSourceType" AS ENUM ('WEB_FORM', 'CHAT', 'BOOKING', 'CALL', 'IMPORT');

-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateTable
CREATE TABLE "AttributionEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "leadId" TEXT,
    "customerId" TEXT,
    "contactId" TEXT,
    "sourceType" "AttributionSourceType" NOT NULL,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmContent" TEXT,
    "utmTerm" TEXT,
    "gclid" TEXT,
    "gbraid" TEXT,
    "wbraid" TEXT,
    "fbclid" TEXT,
    "landingUrl" TEXT,
    "referrerUrl" TEXT,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "AttributionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerCallId" TEXT,
    "direction" "CallDirection" NOT NULL,
    "fromNumber" TEXT NOT NULL,
    "toNumber" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "answered" BOOLEAN NOT NULL,
    "recordingUrl" TEXT,
    "transcriptionUrl" TEXT,
    "disposition" TEXT,
    "matchedLeadId" TEXT,
    "matchedCustomerId" TEXT,
    "matchedContactId" TEXT,
    "attributionEventId" TEXT,
    "rawPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingNumber" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "numberE164" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackingNumber_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttributionEvent_orgId_capturedAt_idx" ON "AttributionEvent"("orgId", "capturedAt");

-- CreateIndex
CREATE INDEX "AttributionEvent_leadId_idx" ON "AttributionEvent"("leadId");

-- CreateIndex
CREATE INDEX "AttributionEvent_customerId_idx" ON "AttributionEvent"("customerId");

-- CreateIndex
CREATE INDEX "CallEvent_orgId_startedAt_idx" ON "CallEvent"("orgId", "startedAt");

-- CreateIndex
CREATE INDEX "CallEvent_fromNumber_idx" ON "CallEvent"("fromNumber");

-- CreateIndex
CREATE INDEX "CallEvent_toNumber_idx" ON "CallEvent"("toNumber");

-- CreateIndex
CREATE INDEX "CallEvent_matchedLeadId_idx" ON "CallEvent"("matchedLeadId");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingNumber_orgId_numberE164_key" ON "TrackingNumber"("orgId", "numberE164");

-- AddForeignKey
ALTER TABLE "AttributionEvent" ADD CONSTRAINT "AttributionEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributionEvent" ADD CONSTRAINT "AttributionEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributionEvent" ADD CONSTRAINT "AttributionEvent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallEvent" ADD CONSTRAINT "CallEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallEvent" ADD CONSTRAINT "CallEvent_matchedLeadId_fkey" FOREIGN KEY ("matchedLeadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallEvent" ADD CONSTRAINT "CallEvent_matchedCustomerId_fkey" FOREIGN KEY ("matchedCustomerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallEvent" ADD CONSTRAINT "CallEvent_attributionEventId_fkey" FOREIGN KEY ("attributionEventId") REFERENCES "AttributionEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingNumber" ADD CONSTRAINT "TrackingNumber_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
