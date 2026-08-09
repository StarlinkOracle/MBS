-- CreateEnum
CREATE TYPE "QuoteKind" AS ENUM ('INSTALL', 'SERVICE');

-- CreateEnum
CREATE TYPE "ServiceTiming" AS ENUM ('NORMAL', 'AFTER_HOURS');

-- CreateEnum
CREATE TYPE "PricebookItemKind" AS ENUM ('SERVICE', 'ADDON', 'FEE');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "QuoteLineItemType" AS ENUM ('PRICEBOOK_ITEM', 'CUSTOM');

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "diagnosticCreditCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "diagnosticFeeCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "discountCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "discountPctBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "discountReason" TEXT,
ADD COLUMN     "discountTotalCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "finalTotalCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "guardrailReasons" JSONB,
ADD COLUMN     "guardrailStatus" "GuardrailStatus" NOT NULL DEFAULT 'OK',
ADD COLUMN     "isMember" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kind" "QuoteKind" NOT NULL DEFAULT 'INSTALL',
ADD COLUMN     "laborHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "laborHoursRounded" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "laborRateCents" INTEGER NOT NULL DEFAULT 10000,
ADD COLUMN     "laborTotalCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "repairSubtotalCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "subtotalCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "timing" "ServiceTiming" NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "totalBeforeDiscountCents" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PricebookCategory" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricebookCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricebookItem" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "kind" "PricebookItemKind" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unitType" TEXT NOT NULL DEFAULT 'EA',
    "defaultSellCents" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricebookItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenancePlan" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "benefits" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenancePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerMembership" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceBundleTemplate" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "includeDiagnostic" BOOLEAN NOT NULL DEFAULT true,
    "defaultLaborHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "baseItemIds" JSONB NOT NULL,
    "recommendedAddOnItemIds" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceBundleTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteLineItem" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "itemType" "QuoteLineItemType" NOT NULL,
    "pricebookItemId" TEXT,
    "categorySlugSnapshot" TEXT,
    "kindSnapshot" TEXT,
    "nameSnapshot" TEXT NOT NULL,
    "descriptionSnapshot" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "unitPriceCents" INTEGER NOT NULL,
    "lineTotalCents" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PricebookCategory_orgId_name_idx" ON "PricebookCategory"("orgId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PricebookCategory_orgId_slug_key" ON "PricebookCategory"("orgId", "slug");

-- CreateIndex
CREATE INDEX "PricebookItem_orgId_categoryId_active_idx" ON "PricebookItem"("orgId", "categoryId", "active");

-- CreateIndex
CREATE INDEX "PricebookItem_orgId_name_idx" ON "PricebookItem"("orgId", "name");

-- CreateIndex
CREATE INDEX "MaintenancePlan_orgId_active_idx" ON "MaintenancePlan"("orgId", "active");

-- CreateIndex
CREATE INDEX "MaintenancePlan_orgId_name_idx" ON "MaintenancePlan"("orgId", "name");

-- CreateIndex
CREATE INDEX "CustomerMembership_orgId_customerId_status_startAt_idx" ON "CustomerMembership"("orgId", "customerId", "status", "startAt");

-- CreateIndex
CREATE INDEX "CustomerMembership_orgId_planId_status_idx" ON "CustomerMembership"("orgId", "planId", "status");

-- CreateIndex
CREATE INDEX "ServiceBundleTemplate_orgId_active_createdAt_idx" ON "ServiceBundleTemplate"("orgId", "active", "createdAt");

-- CreateIndex
CREATE INDEX "ServiceBundleTemplate_orgId_name_idx" ON "ServiceBundleTemplate"("orgId", "name");

-- CreateIndex
CREATE INDEX "QuoteLineItem_orgId_quoteId_sortOrder_createdAt_idx" ON "QuoteLineItem"("orgId", "quoteId", "sortOrder", "createdAt");

-- CreateIndex
CREATE INDEX "QuoteLineItem_pricebookItemId_idx" ON "QuoteLineItem"("pricebookItemId");

-- CreateIndex
CREATE INDEX "Quote_orgId_kind_status_createdAt_idx" ON "Quote"("orgId", "kind", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "PricebookCategory" ADD CONSTRAINT "PricebookCategory_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricebookItem" ADD CONSTRAINT "PricebookItem_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricebookItem" ADD CONSTRAINT "PricebookItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "PricebookCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePlan" ADD CONSTRAINT "MaintenancePlan_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMembership" ADD CONSTRAINT "CustomerMembership_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMembership" ADD CONSTRAINT "CustomerMembership_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMembership" ADD CONSTRAINT "CustomerMembership_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MaintenancePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceBundleTemplate" ADD CONSTRAINT "ServiceBundleTemplate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLineItem" ADD CONSTRAINT "QuoteLineItem_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLineItem" ADD CONSTRAINT "QuoteLineItem_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLineItem" ADD CONSTRAINT "QuoteLineItem_pricebookItemId_fkey" FOREIGN KEY ("pricebookItemId") REFERENCES "PricebookItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
