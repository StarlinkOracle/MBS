-- CreateEnum
CREATE TYPE "ContractClauseStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'DEPRECATED');

-- CreateEnum
CREATE TYPE "ContractTemplateStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "ContractClause" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "stableId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "placeholders" TEXT[],
    "status" "ContractClauseStatus" NOT NULL DEFAULT 'DRAFT',
    "metadata" JSONB,
    "publishedAt" TIMESTAMP(3),
    "deprecatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractClause_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractTemplate" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "templateStableId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bodyText" TEXT,
    "clauseStableIds" TEXT[],
    "structureJson" JSONB NOT NULL,
    "variableSchemaJson" JSONB,
    "status" "ContractTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "metadata" JSONB,
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegalPack" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "packStableId" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sourceRepo" TEXT,
    "sourceTag" TEXT,
    "templateStableIds" TEXT[],
    "legalPackJson" JSONB NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegalPack_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ContractClause_orgId_stableId_version_key" ON "ContractClause"("orgId", "stableId", "version");

-- CreateIndex
CREATE INDEX "ContractClause_orgId_stableId_status_version_idx" ON "ContractClause"("orgId", "stableId", "status", "version");

-- CreateIndex
CREATE INDEX "ContractClause_orgId_jurisdiction_status_idx" ON "ContractClause"("orgId", "jurisdiction", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ContractTemplate_orgId_templateStableId_version_key" ON "ContractTemplate"("orgId", "templateStableId", "version");

-- CreateIndex
CREATE INDEX "ContractTemplate_orgId_templateStableId_status_version_idx" ON "ContractTemplate"("orgId", "templateStableId", "status", "version");

-- CreateIndex
CREATE INDEX "ContractTemplate_orgId_jurisdiction_status_idx" ON "ContractTemplate"("orgId", "jurisdiction", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LegalPack_orgId_packStableId_version_key" ON "LegalPack"("orgId", "packStableId", "version");

-- CreateIndex
CREATE INDEX "LegalPack_orgId_packStableId_createdAt_idx" ON "LegalPack"("orgId", "packStableId", "createdAt");

-- AddForeignKey
ALTER TABLE "ContractClause" ADD CONSTRAINT "ContractClause_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractTemplate" ADD CONSTRAINT "ContractTemplate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegalPack" ADD CONSTRAINT "LegalPack_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
