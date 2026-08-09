CREATE TABLE IF NOT EXISTS "MarketingMetricDaily" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "orgId" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "zip" TEXT,
  "city" TEXT,
  "spendCents" INTEGER NOT NULL DEFAULT 0
);
