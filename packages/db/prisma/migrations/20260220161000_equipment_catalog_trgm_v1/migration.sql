CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "EquipmentCatalogEntry_rawSku_trgm_idx"
  ON "EquipmentCatalogEntry"
  USING gin ("rawSku" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "EquipmentCatalogEntry_rawText_trgm_idx"
  ON "EquipmentCatalogEntry"
  USING gin ("rawText" gin_trgm_ops);
