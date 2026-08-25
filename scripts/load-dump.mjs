#!/usr/bin/env node
/**
 * Load a gzip CSV produced by scripts/k8s-dump-table.sh into items, then project.
 *
 *   node --env-file-if-exists=.env scripts/load-dump.mjs dumps/creator.csv.gz
 *   node --env-file-if-exists=.env scripts/load-dump.mjs dumps/creator.csv.gz --no-project
 */
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import process from "node:process";
import { createGunzip } from "node:zlib";
import postgres from "postgres";

const file = process.argv[2];
const noProject = process.argv.includes("--no-project");
const skipHnsw = process.argv.includes("--no-hnsw");

if (!file || file.startsWith("-")) {
  console.error(
    "Usage: node --env-file-if-exists=.env scripts/load-dump.mjs <dump.csv.gz> [--no-project] [--no-hnsw]",
  );
  process.exit(1);
}
if (!existsSync(file)) {
  console.error(`File not found: ${file}`);
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const sql = postgres(url, { max: 2, prepare: false, onnotice: () => {} });

function copyViaPsql() {
  return new Promise((resolve, reject) => {
    const psql = spawn(
      "psql",
      [
        url,
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `COPY dump_in (source_id, emb, cluster_text, label) FROM STDIN WITH (FORMAT csv, HEADER true)`,
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    const input = file.endsWith(".gz")
      ? createReadStream(file).pipe(createGunzip())
      : createReadStream(file);
    input.on("error", reject);
    psql.on("error", reject);
    psql.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`psql COPY exited ${code}`));
    });
    input.pipe(psql.stdin);
  });
}

try {
  console.log("Preparing local tables…");
  await sql`DROP INDEX IF EXISTS items_embedding_hnsw`;
  await sql`DROP INDEX IF EXISTS items_xy_idx`;
  await sql`TRUNCATE items RESTART IDENTITY`;
  await sql`ALTER TABLE items ALTER COLUMN embedding TYPE vector`;
  await sql`DROP TABLE IF EXISTS dump_in`;
  await sql`
    CREATE UNLOGGED TABLE dump_in (
      source_id text,
      emb text,
      cluster_text text,
      label text
    )
  `;

  console.log(`COPY ${file} -> dump_in`);
  await copyViaPsql();

  console.log("Inserting into items…");
  await sql`
    INSERT INTO items (payload, embedding, cluster, source_id, label)
    SELECT
      jsonb_strip_nulls(jsonb_build_object(
        'id', source_id,
        'cluster', NULLIF(cluster_text, ''),
        'label', NULLIF(label, '')
      )),
      emb::vector,
      CASE
        WHEN cluster_text ~ '^-?[0-9]+$' THEN cluster_text::int
        WHEN cluster_text IS NULL OR cluster_text = '' THEN NULL
        ELSE (dense_rank() OVER (ORDER BY cluster_text) - 1)::int
      END,
      source_id,
      NULLIF(label, '')
    FROM dump_in
    WHERE emb IS NOT NULL AND emb <> ''
  `;
  await sql`DROP TABLE dump_in`;

  const [dimRow] =
    await sql`SELECT vector_dims(embedding) AS dims FROM items WHERE embedding IS NOT NULL LIMIT 1`;
  const dims = dimRow?.dims ?? null;
  if (dims && Number.isInteger(dims) && dims > 0 && dims <= 16000) {
    await sql.unsafe(`ALTER TABLE items ALTER COLUMN embedding TYPE vector(${dims})`);
  }
  const [{ count }] = await sql`SELECT count(*)::text AS count FROM items`;
  console.log(`Loaded ${Number(count).toLocaleString()} rows (dim ${dims ?? "?"})`);

  if (!noProject) {
    const python = existsSync(".venv/bin/python") ? ".venv/bin/python" : null;
    if (python) {
      console.log("Projecting with scripts/project.py…");
      await new Promise((resolve, reject) => {
        const child = spawn(python, ["scripts/project.py", "--table", "items"], {
          stdio: "inherit",
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`project.py exited ${code}`));
        });
      });
    } else {
      console.log(
        "No .venv — skip projection. Then: python -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt && .venv/bin/python scripts/project.py",
      );
    }
  }

  await sql`CREATE INDEX IF NOT EXISTS items_xy_idx ON items (x, y)`;
  if (!skipHnsw) {
    console.log("Building HNSW…");
    try {
      await sql`
        CREATE INDEX IF NOT EXISTS items_embedding_hnsw
        ON items USING hnsw (embedding vector_cosine_ops)
      `;
    } catch (error) {
      console.warn("HNSW skipped:", error instanceof Error ? error.message : error);
    }
  }
  await sql`ANALYZE items`.catch(() => {});

  const labels = {};
  const distinct =
    await sql`SELECT DISTINCT cluster, payload->>'cluster' AS name FROM items WHERE cluster IS NOT NULL`;
  for (const row of distinct) {
    labels[String(row.cluster)] = row.name ?? String(row.cluster);
  }
  try {
    await sql`
      INSERT INTO dataset_meta (id, source_label, source_table, embedding_dim, imported_at, cluster_labels, cluster_column)
      VALUES (1, ${file}, ${"dump"}, ${dims}, now(), ${sql.json(labels)}, ${"cluster"})
      ON CONFLICT (id) DO UPDATE SET
        source_label = EXCLUDED.source_label,
        source_table = EXCLUDED.source_table,
        embedding_dim = EXCLUDED.embedding_dim,
        imported_at = EXCLUDED.imported_at,
        cluster_labels = EXCLUDED.cluster_labels,
        cluster_column = EXCLUDED.cluster_column
    `;
  } catch {
    await sql`
      INSERT INTO dataset_meta (id, source_label, source_table, embedding_dim, imported_at)
      VALUES (1, ${file}, ${"dump"}, ${dims}, now())
      ON CONFLICT (id) DO UPDATE SET
        source_label = EXCLUDED.source_label,
        source_table = EXCLUDED.source_table,
        embedding_dim = EXCLUDED.embedding_dim,
        imported_at = EXCLUDED.imported_at
    `;
  }
  console.log("Done.");
} finally {
  await sql.end({ timeout: 2 }).catch(() => {});
}
