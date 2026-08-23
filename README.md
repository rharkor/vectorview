# VectorView

**See your embeddings.** Paste a Postgres URL, project millions of vectors into 2D or 3D, and explore them as a living constellation — click any point for the exact row, its neighbors, and a semantic search bar when you bring a gateway token.

<p align="center">
  <img src="docs/screenshots/hero-2d.png" alt="VectorView 2D constellation of embedding clusters" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/rharkor/vectorview/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-skyblue" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/Next.js-16-black" alt="Next.js 16" />
  <img src="https://img.shields.io/badge/Postgres-pgvector-336791" alt="pgvector" />
  <img src="https://img.shields.io/badge/WebGL-Three.js-000000" alt="Three.js" />
  <img src="https://img.shields.io/badge/search-Vercel%20AI%20Gateway-black" alt="Vercel AI Gateway" />
</p>

Embeddings are usually a blob in a table. VectorView turns them into a map you can pan, zoom, and interrogate — built for product catalogs, document stores, user personas, or anything you already keep in Postgres.

## Why people use it

- **Import from the database you already have.** Read-only connection, auto-detected tables and columns, live progress while PCA + UMAP run.
- **It looks like a web, not a spreadsheet.** Glowing points, constellation filaments, and a neighbor graph when you hover or click.
- **Click through to the truth.** The original row payload, syntax-highlighted, plus cosine neighbors in milliseconds (HNSW).
- **Search when you want it.** Locked until you paste a Vercel AI Gateway token. The token never leaves your browser except as a Bearer header to your own server.
- **Stays fast.** Apache Arrow over the wire, GPU picking, hash-stable sampling for millions of points.

<p align="center">
  <img src="docs/screenshots/details.png" alt="Point details drawer with payload JSON and nearest neighbors" width="100%" />
</p>

## Quick start

You need Node 20+, [pnpm](https://pnpm.io), Postgres with [pgvector](https://github.com/pgvector/pgvector), and (for the first projection) Python 3.10+.

```bash
git clone https://github.com/rharkor/vectorview.git
cd vectorview
pnpm install
cp .env.example .env          # set DATABASE_URL
```

A one-liner Postgres if you don't have one:

```bash
docker run -d --name vectorview-pg -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 pgvector/pgvector:pg17
# DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
```

```bash
pnpm db:migrate
pnpm dev                      # http://localhost:3000
```

Open the **database** icon, paste a source Postgres URL, pick the table with embeddings, and import. VectorView copies the rows into its own `items` table, projects them, and builds the HNSW index. Your source stays **read-only** — enforced on every connection.

Already have coordinates? Map `x` / `y` / `z` and the projection step is skipped.

### Large table on CloudNativePG

CNPG backups are physical (whole volume) — they cannot dump one table. Run a throwaway pod next to the cluster, `COPY` only the columns you need, then load the gzip locally. That avoids `kubectl relay` for millions of embeddings.

```bash
scripts/k8s-dump-table.sh \
  -n database \
  --service database-cluster-pooler-ro \
  --secret database-cluster-app \
  --table public.Creator \
  --id id \
  --embedding persona_embedding \
  --cluster category \
  --label name \
  -o dumps/creator.csv.gz

pnpm db:load-dump dumps/creator.csv.gz
```

The scan stays in-cluster. `kubectl cp` still goes through the API server, but it is **one** compressed file instead of thousands of paged queries. Needs `kubectl`, `psql` on your machine, and the CNPG `*-app` secret (`username` / `password` / `dbname`).

### Optional: 100k demo cloud

```bash
psql "$DATABASE_URL" -f scripts/seed.sql
python -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
.venv/bin/python scripts/project.py --table items
```

## Tour

| | |
| --- | --- |
| **2D constellation** | Pan, damped zoom, hover a stack of overlapping points — the tooltip lists all of them. |
| **3D orbit** | Same cloud, perspective camera. Switch in the top-right pill. |
| **Selection web** | Click a point: arcs to embedding-space neighbors, details drawer with the full payload. |
| **Import** | Source URL is remembered in this browser. Tables are searchable; columns are suggested from types. |
| **Search** | Key icon → gateway token → `⌘K`. Embeds the query and flies to the top hit. |

<p align="center">
  <img src="docs/screenshots/hero-3d.png" alt="VectorView 3D orbit view of the same embedding cloud" width="100%" />
</p>

<p align="center">
  <img src="docs/screenshots/import.png" alt="Dataset dialog for importing from a read-only Postgres URL" width="100%" />
</p>

## How it works

```
your Postgres (read-only)
        │  copy + map columns
        ▼
  VectorView DB  ── pgvector HNSW ── /api/points/[id]/neighbors
        │
        │  PCA → UMAP  (in-app, or scripts/project.py for huge sets)
        ▼
   x / y / z
        │  Apache Arrow IPC
        ▼
  Three.js constellation  (GPU pick, spatial index, kNN web)
```

The app never writes to your source. It keeps a local copy so rendering, neighbors, and search stay on one schema you control.

For **millions of rows**, skip the in-app UMAP and run the offline pipeline:

```bash
# COPY or import into items yourself, then:
.venv/bin/python scripts/project.py --table items --fit-max 500000
```

`project.py` fits IncrementalPCA, then UMAP on up to `--fit-max` rows, and transforms the rest in batches. For 10M+ look at a GPU stack (cuML / cuVS).

## Stack

| Layer | Choice |
| --- | --- |
| App | Next.js 16 App Router, TypeScript, Tailwind v4, shadcn/ui |
| View | Three.js + React Three Fiber — custom point shaders, constellation edges, GPU picking |
| Transport | Apache Arrow IPC from `/api/points` into typed arrays |
| Neighbors / search | pgvector HNSW, cosine distance |
| Projection | In-app PCA + UMAP, or `scripts/project.py` |
| Search embeddings | Vercel AI SDK + AI Gateway (BYOK) |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — | VectorView's own Postgres (pgvector required) |
| `PG_TABLE` | `items` | Internal table |
| `PG_ID_COLUMN` | `id` | Primary key |
| `PG_EMBEDDING_COLUMN` | `embedding` | Vector column |
| `PG_CLUSTER_COLUMN` | `cluster` | Optional color key (empty to disable) |
| `EMBEDDING_MODEL` | `openai/text-embedding-3-small` | Gateway model for search |
| `EMBEDDING_DIM` | `1536` | Must match stored embeddings |

Copy [`.env.example`](.env.example) to `.env`. Secrets stay local (`.env*` is gitignored).

## Migrations

Numbered SQL in [`migrations/`](migrations/), applied with `pnpm db:migrate`. `pnpm dev` refuses to start if something is pending (`SKIP_DB_CHECK=1` to bypass). Add the next file as `migrations/0003_<name>.sql` — keep statements idempotent; they run inside a transaction.

## Scaling notes

- **1–3M points** typically hold 60 fps from one Arrow payload. Past that, use the sample-rate slider (stable hash subsample).
- **kNN** cost does not grow with table size once HNSW is built.
- Dense overlaps use a spatial grid for hover, not blended pick colors — stacked points stay selectable.

## License

[MIT](LICENSE). Use it, fork it, put it in front of your embeddings.
