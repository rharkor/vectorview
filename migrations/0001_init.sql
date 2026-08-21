-- 0001_init: core VectorView schema.
--
-- NB: no CREATE INDEX CONCURRENTLY in migrations (each migration runs in a
-- transaction). The HNSW index is intentionally NOT created here: pgvector
-- requires a dimensioned column and a populated table. scripts/seed.sql and
-- the in-app import both create it after loading data. For an existing
-- populated table, pin the dimension and build it manually:
--   ALTER TABLE items ALTER COLUMN embedding TYPE vector(<dim>);
--   CREATE INDEX items_embedding_hnsw ON items USING hnsw (embedding vector_cosine_ops);

CREATE EXTENSION IF NOT EXISTS vector;

-- `embedding` is intentionally dimension-agnostic (no vector(N)) so imports
-- with any embedding dimension work; the import flow pins the dimension after
-- copying and before building the HNSW index.
CREATE TABLE IF NOT EXISTS items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding vector,
  cluster integer,
  x double precision,
  y double precision,
  z double precision
);

-- Helps viewport / bbox filtering of projected coordinates.
CREATE INDEX IF NOT EXISTS items_xy_idx ON items (x, y);

-- Single-row metadata about the currently imported dataset.
CREATE TABLE IF NOT EXISTS dataset_meta (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  source_label text,
  source_table text,
  embedding_dim integer,
  imported_at timestamptz NOT NULL DEFAULT now()
);

-- Staging tables for in-app imports (unlogged = no WAL overhead).
CREATE UNLOGGED TABLE IF NOT EXISTS import_stage (
  payload jsonb,
  emb text,
  cluster integer,
  x float8,
  y float8,
  z float8
);

CREATE UNLOGGED TABLE IF NOT EXISTS projection_writeback (
  id bigint PRIMARY KEY,
  x float8,
  y float8,
  z float8
);
