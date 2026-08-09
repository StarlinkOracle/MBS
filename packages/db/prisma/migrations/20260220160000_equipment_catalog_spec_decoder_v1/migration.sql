-- CreateEnum
CREATE TYPE "EquipmentCatalogSourceType" AS ENUM ('CSV');

-- CreateEnum
CREATE TYPE "EquipmentCatalogSourceStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AssessmentAttachmentKind" AS ENUM ('NAMEPLATE_PHOTO');

-- CreateTable
CREATE TABLE "SystemAssessment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "existingManufacturer" TEXT,
    "existingModel" TEXT,
    "existingSystemType" TEXT,
    "existingTonnage" DOUBLE PRECISION,
    "existingFurnaceBtu" INTEGER,
    "existingSeer" DOUBLE PRECISION,
    "existingAfue" DOUBLE PRECISION,
    "verifiedBySupplyHouse" BOOLEAN NOT NULL DEFAULT false,
    "supplyHouseNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentCatalogSource" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "EquipmentCatalogSourceType" NOT NULL DEFAULT 'CSV',
    "status" "EquipmentCatalogSourceStatus" NOT NULL DEFAULT 'PENDING',
    "attachmentRefId" TEXT,
    "mappingJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EquipmentCatalogSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentCatalogEntry" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "rawSku" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "manufacturer" TEXT,
    "systemTypeHint" TEXT,
    "rawJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EquipmentCatalogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentSpecNormalized" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "systemType" TEXT NOT NULL,
    "tonnage" DOUBLE PRECISION,
    "btu" INTEGER,
    "seer" DOUBLE PRECISION,
    "afue" DOUBLE PRECISION,
    "stages" INTEGER,
    "refrigerant" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EquipmentSpecNormalized_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentLookupRun" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "results" JSONB NOT NULL,
    "selectedSpecId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EquipmentLookupRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentAttachment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "attachmentRefId" TEXT NOT NULL,
    "kind" "AssessmentAttachmentKind" NOT NULL DEFAULT 'NAMEPLATE_PHOTO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssessmentAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SystemAssessment_orgId_createdAt_idx" ON "SystemAssessment"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "EquipmentCatalogSource_orgId_status_createdAt_idx" ON "EquipmentCatalogSource"("orgId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "EquipmentCatalogSource_attachmentRefId_idx" ON "EquipmentCatalogSource"("attachmentRefId");

-- CreateIndex
CREATE INDEX "EquipmentCatalogEntry_orgId_sourceId_createdAt_idx" ON "EquipmentCatalogEntry"("orgId", "sourceId", "createdAt");

-- CreateIndex
CREATE INDEX "EquipmentSpecNormalized_orgId_manufacturer_model_idx" ON "EquipmentSpecNormalized"("orgId", "manufacturer", "model");

-- CreateIndex
CREATE INDEX "EquipmentSpecNormalized_orgId_systemType_createdAt_idx" ON "EquipmentSpecNormalized"("orgId", "systemType", "createdAt");

-- CreateIndex
CREATE INDEX "EquipmentLookupRun_orgId_assessmentId_createdAt_idx" ON "EquipmentLookupRun"("orgId", "assessmentId", "createdAt");

-- CreateIndex
CREATE INDEX "EquipmentLookupRun_selectedSpecId_idx" ON "EquipmentLookupRun"("selectedSpecId");

-- CreateIndex
CREATE INDEX "AssessmentAttachment_orgId_assessmentId_kind_createdAt_idx" ON "AssessmentAttachment"("orgId", "assessmentId", "kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentAttachment_assessmentId_attachmentRefId_key" ON "AssessmentAttachment"("assessmentId", "attachmentRefId");

-- AddForeignKey
ALTER TABLE "SystemAssessment" ADD CONSTRAINT "SystemAssessment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentCatalogSource" ADD CONSTRAINT "EquipmentCatalogSource_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentCatalogSource" ADD CONSTRAINT "EquipmentCatalogSource_attachmentRefId_fkey" FOREIGN KEY ("attachmentRefId") REFERENCES "AttachmentRef"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentCatalogEntry" ADD CONSTRAINT "EquipmentCatalogEntry_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentCatalogEntry" ADD CONSTRAINT "EquipmentCatalogEntry_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "EquipmentCatalogSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentSpecNormalized" ADD CONSTRAINT "EquipmentSpecNormalized_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentLookupRun" ADD CONSTRAINT "EquipmentLookupRun_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentLookupRun" ADD CONSTRAINT "EquipmentLookupRun_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "SystemAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentLookupRun" ADD CONSTRAINT "EquipmentLookupRun_selectedSpecId_fkey" FOREIGN KEY ("selectedSpecId") REFERENCES "EquipmentSpecNormalized"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentAttachment" ADD CONSTRAINT "AssessmentAttachment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentAttachment" ADD CONSTRAINT "AssessmentAttachment_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "SystemAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentAttachment" ADD CONSTRAINT "AssessmentAttachment_attachmentRefId_fkey" FOREIGN KEY ("attachmentRefId") REFERENCES "AttachmentRef"("id") ON DELETE CASCADE ON UPDATE CASCADE;
