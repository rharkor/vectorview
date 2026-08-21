-- Synthetic demo data: ~100k embeddings in 12 gaussian blobs (dim 1536).
-- Run AFTER applying migrations (pnpm db:migrate):
--   psql "$DATABASE_URL" -f scripts/seed.sql
-- Then compute 2D/3D coordinates:
--   python scripts/project.py

-- Uncomment to re-seed from scratch:
-- TRUNCATE items;

-- NB: the LATERAL subqueries reference the outer row (`c AS _force` /
-- `i AS _force`) so Postgres evaluates random() per row instead of caching
-- one InitPlan result. (A correlated reference inside the aggregate argument
-- would trigger GROUP BY errors; inside the SELECT list it is safe.)
CREATE TEMP TABLE cluster_centers AS
SELECT c, v.center
FROM generate_series(0, 11) AS c,
LATERAL (
  SELECT array_agg(random() * 2 - 1)::vector AS center, c AS _force
  FROM generate_series(1, 1536) AS g
) v;

INSERT INTO items (payload, embedding, cluster, source_id, label)
SELECT
  jsonb_build_object(
    'name', 'item-' || (c * 8334 + i),
    'cluster', c,
    'score', round(random()::numeric, 4),
    'tags', jsonb_build_array('demo', 'cluster-' || c)
  ),
  center + noise,
  c,
  'item-' || (c * 8334 + i),
  'item-' || (c * 8334 + i)
FROM cluster_centers,
     generate_series(1, 8334) AS i,
     LATERAL (
       SELECT array_agg((random() - 0.5) * 0.35)::vector AS noise, i AS _force
       FROM generate_series(1, 1536) AS g
     ) v;

ANALYZE items;

-- Pin the embedding dimension, then build the ANN index on the populated
-- table (HNSW requires dimensions and must not be created on an empty table).
ALTER TABLE items ALTER COLUMN embedding TYPE vector(1536);
DROP INDEX IF EXISTS items_embedding_hnsw;
CREATE INDEX items_embedding_hnsw ON items USING hnsw (embedding vector_cosine_ops);
