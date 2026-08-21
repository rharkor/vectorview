# vectorview

Interactive 2D/3D visualization of millions of vector embeddings stored in
Postgres (pgvector). Click any point to inspect its exact row data and its
nearest neighbors, or run a semantic search powered by the Vercel AI Gateway.

## Stack

- **Next.js (App Router) + TypeScript + Tailwind + shadcn/ui** — app and data API in one deployable
- **deck.gl `ScatterplotLayer`** — WebGL2 rendering with GPU picking; 2D (`OrthographicView`) and 3D (`OrbitView`) modes
- **Apache Arrow IPC** — binary columnar transport from `/api/points` straight into GPU typed arrays
- **Postgres + pgvector (HNSW)** — millisecond approximate kNN for neighbors and search
- **Python PCA → UMAP** (`scripts/project.py`) — offline projection of embeddings to `x/y/z`
- **Vercel AI SDK + `@ai-sdk/gateway`** — query embedding with a per-user gateway token (BYOK)

## Setup

```bash
pnpm install
cp .env.example .env            # set DATABASE_URL
```

Prepare the database (needs the `vector` extension; `pgvector/pgvector:pg17`
docker image works out of the box):

```bash
pnpm db:migrate               # apply migrations/ to your DATABASE_URL
psql "$DATABASE_URL" -f scripts/seed.sql   # optional: ~100k demo embeddings
```

Compute 2D/3D coordinates from your embeddings:

```bash
python -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
.venv/bin/python scripts/project.py --table items
```

Run the app:

```bash
pnpm dev
```

## Migrations

Schema changes live as numbered SQL files in [`migrations/`](migrations/) and are
tracked in a `schema_migrations` table.

- `pnpm db:migrate` — apply pending migrations (each in its own transaction)
- `pnpm db:check` — verify everything is applied
- `pnpm dev` runs the check automatically and refuses to start with pending
  migrations (`SKIP_DB_CHECK=1 pnpm dev` bypasses); a runtime warning is also
  logged via `instrumentation.ts`

To add a migration, create `migrations/0002_<name>.sql` (idempotent statements,
no `CONCURRENTLY` — migrations run inside a transaction).

Open http://localhost:3000 — drag to pan, scroll to zoom, click a point for
details + neighbors, toggle 2D/3D in the top right.

## Semantic search

The search bar is locked until you add a **Vercel AI Gateway token** (key icon,
top right). The token is stored only in your browser's localStorage and sent as
a Bearer token to `/api/search`, which embeds the query via
`EMBEDDING_MODEL` (default `openai/text-embedding-3-small`) and runs a kNN
lookup. The model's dimension must match your stored embeddings.

## Datasets (import / clear)

The app keeps its **own copy** of the data in its internal `items` table — your
source database is only ever connected **read-only** (enforced via a
`default_transaction_read_only` startup parameter on every connection).

Open the **database icon** (top right) to manage the dataset:

- **Import**: paste a source Postgres URL → the app lists tables with row
  estimates and auto-suggests the column mapping (primary key for id, pgvector
  columns with their dimension, name/type hints for cluster and x/y/z
  coordinate columns). Adjust the mapping, then import. A live progress view
  shows each phase: copying rows → PCA → UMAP projection → index build. If the
  source already has x/y/z columns, the projection is skipped. Any embedding
  dimension works — the internal column is re-pinned to the imported dimension.
- **Clear**: wipes the internal table (two-click confirm).

Text cluster columns are automatically dictionary-encoded to integers for
coloring. All non-embedding source columns are preserved in each row's
`payload` and shown in the details panel.

For very large imports (millions of rows), prefer the offline Python pipeline:
bulk-`COPY` your data into `items` yourself, then run `scripts/project.py`.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — | Postgres connection string |
| `PG_TABLE` | `items` | table holding your embeddings |
| `PG_ID_COLUMN` | `id` | primary key column |
| `PG_EMBEDDING_COLUMN` | `embedding` | pgvector column |
| `PG_CLUSTER_COLUMN` | `cluster` | optional column used for point colors (empty to disable) |
| `EMBEDDING_MODEL` | `openai/text-embedding-3-small` | gateway model for search |
| `EMBEDDING_DIM` | `1536` | embedding dimension |

## Scaling notes

- 1–3M points render at 60 fps from a single Arrow payload; beyond that use the
  sample-rate slider (stable hash-based subsampling) to stay interactive.
- kNN cost is independent of row count thanks to the HNSW index.
- `scripts/project.py` fits UMAP on up to `--fit-max` rows (default 500k) and
  transforms the rest in batches; use a GPU stack (cuvs/cuML) for 10M+ rows.
