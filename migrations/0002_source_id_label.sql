-- 0002: source identity + display label for points.
-- source_id = the id column from the imported dataset (as text); label = an
-- optional human-readable column shown on hover instead of the id.

ALTER TABLE items ADD COLUMN IF NOT EXISTS source_id text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS label text;

-- Backfill for rows loaded before this column existed.
UPDATE items SET source_id = id::text WHERE source_id IS NULL;

CREATE INDEX IF NOT EXISTS items_source_id_idx ON items (source_id);

ALTER TABLE import_stage ADD COLUMN IF NOT EXISTS source_id text;
ALTER TABLE import_stage ADD COLUMN IF NOT EXISTS label text;
