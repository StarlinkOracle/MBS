-- CreateEnum
CREATE TYPE "InstallType" AS ENUM ('COMBO', 'FURNACE_ONLY', 'AC_ONLY');

-- CreateEnum
CREATE TYPE "InstallAccessType" AS ENUM ('STANDARD', 'ATTIC', 'CONFINED_CRAWLSPACE');

-- CreateEnum
CREATE TYPE "QuotePricingMode" AS ENUM ('INSTALL_CUSHION20_FLOOR_ACCESS500_SALES5_DISCOUNT');

-- CreateEnum
CREATE TYPE "GuardrailStatus" AS ENUM ('OK', 'WARNING', 'REQUIRE_APPROVAL', 'BLOCK');

-- AlterTable
ALTER TABLE "SystemAssessment"
ADD COLUMN "installType" "InstallType" NOT NULL DEFAULT 'COMBO',
ADD COLUMN "accessType" "InstallAccessType" NOT NULL DEFAULT 'STANDARD',
ADD COLUMN "baseLaborCostCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "manualLaborAdjustmentCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "manualLaborReason" TEXT,
ADD COLUMN "permitCostCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "equipmentCostCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "materialsCostCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Quote"
ADD COLUMN "leadId" TEXT,
ADD COLUMN "assessmentId" TEXT;

-- CreateTable
CREATE TABLE "QuoteOption" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "quoteId" TEXT NOT NULL,
  "optionKey" TEXT NOT NULL,
  "label" TEXT,
  "pricingMode" "QuotePricingMode" NOT NULL,
  "cushionPct" INTEGER NOT NULL DEFAULT 20,
  "equipmentAdjustedCents" INTEGER NOT NULL,
  "materialsAdjustedCents" INTEGER NOT NULL,
  "laborTotalCents" INTEGER NOT NULL,
  "adjustedCostCents" INTEGER NOT NULL,
  "profitFloorCents" INTEGER NOT NULL,
  "accessAddOnCents" INTEGER NOT NULL,
  "basePriceCents" INTEGER NOT NULL,
  "salesCushionPct" INTEGER NOT NULL DEFAULT 5,
  "priceBeforeDiscountCents" INTEGER NOT NULL,
  "discountPctBps" INTEGER NOT NULL DEFAULT 0,
  "discountCents" INTEGER NOT NULL DEFAULT 0,
  "discountTotalCents" INTEGER NOT NULL DEFAULT 0,
  "discountReason" TEXT,
  "finalSellPriceCents" INTEGER NOT NULL,
  "rawCostTotalCents" INTEGER NOT NULL,
  "effectiveProfitCents" INTEGER NOT NULL,
  "effectiveMarginBps" INTEGER NOT NULL,
  "guardrailStatus" "GuardrailStatus" NOT NULL,
  "guardrailReasons" JSONB,
  "equipmentSelection" JSONB,
  "materialsSelection" JSONB,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "QuoteOption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuoteOption_quoteId_optionKey_key" ON "QuoteOption"("quoteId", "optionKey");

-- CreateIndex
CREATE INDEX "QuoteOption_orgId_quoteId_idx" ON "QuoteOption"("orgId", "quoteId");

-- CreateIndex
CREATE INDEX "QuoteOption_orgId_guardrailStatus_createdAt_idx" ON "QuoteOption"("orgId", "guardrailStatus", "createdAt");

-- CreateIndex
CREATE INDEX "Quote_orgId_leadId_createdAt_idx" ON "Quote"("orgId", "leadId", "createdAt");

-- CreateIndex
CREATE INDEX "Quote_assessmentId_idx" ON "Quote"("assessmentId");

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "SystemAssessment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteOption" ADD CONSTRAINT "QuoteOption_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteOption" ADD CONSTRAINT "QuoteOption_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
