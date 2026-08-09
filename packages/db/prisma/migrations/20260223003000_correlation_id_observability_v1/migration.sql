-- AlterTable
ALTER TABLE "ToolExecution" ADD COLUMN "correlationId" TEXT;

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN "correlationId" TEXT;

-- AlterTable
ALTER TABLE "EventOutbox" ADD COLUMN "correlationId" TEXT;

-- CreateIndex
CREATE INDEX "ToolExecution_orgId_correlationId_idx" ON "ToolExecution"("orgId", "correlationId");

-- CreateIndex
CREATE INDEX "AuditLog_orgId_correlationId_idx" ON "AuditLog"("orgId", "correlationId");

-- CreateIndex
CREATE INDEX "EventOutbox_orgId_correlationId_idx" ON "EventOutbox"("orgId", "correlationId");
