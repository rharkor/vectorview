import { NipalsPca } from "@/lib/pca";
import { UMAP } from "umap-js";
import type postgres from "postgres";

export type ProjectionPhase =
  | "pca-fit"
  | "pca-transform"
  | "umap-fit"
  | "umap-transform"
  | "write-back";

export interface ProjectionProgress {
  phase: ProjectionPhase;
  done: number;
  total: number;
}

interface ProjectOptions {
  pcaDims?: number;
  components?: number;
  pcaSampleSize?: number;
  umapFitMax?: number;
  batchSize?: number;
  onProgress?: (p: ProjectionProgress) => void;
}

function parseVector(text: string): number[] {
  const out: number[] = [];
  let start = 1;
  const len = text.length - 1;
  for (let i = 1; i <= len; i++) {
    if (text.charCodeAt(i) === 44 || i === len) {
      out.push(Number(text.slice(start, i)));
      start = i + 1;
    }
  }
  return out;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function strideFor(n: number, want: number): number {
  return Math.max(1, Math.floor(n / Math.max(want, 1)));
}

/**
 * Project `items` embeddings to x/y/z:
 * PCA (fit on a sample, transform in batches into a staging table) → UMAP
 * on a bounded subset → transform the rest → write-back.
 *
 * Intermediate PCA components live in Postgres so Node memory stays bounded
 * for large imports.
 */
export async function projectItems(
  sql: postgres.Sql,
  options: ProjectOptions = {},
): Promise<{ rows: number; dims: number }> {
  const components = options.components ?? 3;
  const pcaSampleSize = options.pcaSampleSize ?? 3_000;
  const umapFitMax = options.umapFitMax ?? 12_000;
  const batchSize = options.batchSize ?? 1_500;
  const onProgress = options.onProgress ?? (() => {});

  const [{ count }] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM items WHERE embedding IS NOT NULL
  `;
  const n = Number(count);
  if (n === 0) throw new Error("No embeddings to project");

  await sql`
    CREATE UNLOGGED TABLE IF NOT EXISTS projection_pca (
      id bigint PRIMARY KEY,
      comps jsonb NOT NULL
    )
  `;
  await sql`TRUNCATE projection_pca`;
  await sql`TRUNCATE projection_writeback`;

  const sampleLimit = Math.min(pcaSampleSize, n);
  const pcaDimsHint = options.pcaDims ?? 40;
  onProgress({ phase: "pca-fit", done: 0, total: pcaDimsHint + 1 });
  const sampleRows = await sql<{ emb: string }[]>`
    SELECT embedding::text AS emb FROM items
    WHERE embedding IS NOT NULL AND id % ${strideFor(n, sampleLimit)} = 0
    ORDER BY id
    LIMIT ${sampleLimit}
  `;
  let sample = sampleRows
    .map((r) => parseVector(r.emb))
    .filter((v) => v.length > 0 && v.every(Number.isFinite));
  if (sample.length < Math.min(32, n)) {
    const extra = await sql<{ emb: string }[]>`
      SELECT embedding::text AS emb FROM items
      WHERE embedding IS NOT NULL
      ORDER BY id
      LIMIT ${sampleLimit}
    `;
    sample = extra
      .map((r) => parseVector(r.emb))
      .filter((v) => v.length > 0 && v.every(Number.isFinite));
  }
  const dims = sample[0]?.length ?? 0;
  if (dims === 0 || sample.length < 2) throw new Error("Could not read embeddings");
  const pcaDims = Math.min(pcaDimsHint, dims, sample.length - 1);
  onProgress({ phase: "pca-fit", done: 1, total: pcaDims + 1 });
  await yieldToEventLoop();
  const pca = new NipalsPca();
  await pca.fit(sample, pcaDims, {
    onComponent: (done, total) => {
      onProgress({ phase: "pca-fit", done: 1 + done, total: 1 + total });
    },
  });

  let transformed = 0;
  const pcaCursor = sql<{ id: string; emb: string }[]>`
    SELECT id, embedding::text AS emb FROM items
    WHERE embedding IS NOT NULL
    ORDER BY id
  `.cursor(batchSize);
  for await (const rows of pcaCursor) {
    const batch = rows.map((r) => parseVector(r.emb));
    const out = pca.predict(batch, pcaDims);
    const staged = rows.map((r, i) => ({
      id: Number(r.id),
      comps: sql.json(out[i].slice(0, pcaDims)),
    }));
    await sql`INSERT INTO projection_pca ${sql(staged, "id", "comps")}`;
    transformed += rows.length;
    onProgress({ phase: "pca-transform", done: transformed, total: n });
    await yieldToEventLoop();
  }

  if (n < 8) {
    await writePcaAsCoords(sql, components, pcaDims);
    return { rows: n, dims };
  }

  const fitCount = Math.min(n, umapFitMax);
  const fitRows = await sql<{ id: string; comps: number[] }[]>`
    SELECT id, comps FROM projection_pca
    WHERE id % ${strideFor(n, fitCount)} = 0
    ORDER BY id
    LIMIT ${fitCount}
  `;
  const fitData = fitRows.map((r) => r.comps.map(Number));
  if (fitData.length < 3) {
    await writePcaAsCoords(sql, components, pcaDims);
    return { rows: n, dims };
  }

  const nEpochs = n > 10_000 ? 150 : 400;
  const umap = new UMAP({
    nComponents: components,
    nNeighbors: Math.min(15, fitData.length - 1),
    minDist: 0.1,
    nEpochs,
  });
  const fitEmbedding = await umap.fitAsync(fitData, (epoch) => {
    onProgress({ phase: "umap-fit", done: epoch, total: nEpochs });
  });

  const fitIds = new Set(fitRows.map((r) => Number(r.id)));
  const fitWrite = fitRows.map((r, i) => ({
    id: Number(r.id),
    x: fitEmbedding[i][0],
    y: fitEmbedding[i][1],
    z: components >= 3 ? fitEmbedding[i][2] : 0,
  }));
  await sql`INSERT INTO projection_writeback ${sql(fitWrite, "id", "x", "y", "z")}`;

  if (fitCount < n) {
    let done = 0;
    const restTotal = n - fitRows.length;
    const restCursor = sql<{ id: string; comps: number[] }[]>`
      SELECT id, comps FROM projection_pca ORDER BY id
    `.cursor(batchSize);
    for await (const rows of restCursor) {
      const slice = rows.filter((r) => !fitIds.has(Number(r.id)));
      if (slice.length === 0) continue;
      const batch = slice.map((r) => r.comps.map(Number));
      let write: { id: number; x: number; y: number; z: number }[];
      try {
        const out = umap.transform(batch);
        write = slice.map((r, i) => ({
          id: Number(r.id),
          x: out[i][0],
          y: out[i][1],
          z: components >= 3 ? out[i][2] : 0,
        }));
      } catch {
        write = slice.map((r) => ({
          id: Number(r.id),
          x: Number(r.comps[0] ?? 0),
          y: Number(r.comps[1] ?? 0),
          z: components >= 3 ? Number(r.comps[2] ?? 0) : 0,
        }));
      }
      await sql`INSERT INTO projection_writeback ${sql(write, "id", "x", "y", "z")}`;
      done += slice.length;
      onProgress({
        phase: "umap-transform",
        done: Math.min(done, restTotal),
        total: restTotal,
      });
      await yieldToEventLoop();
    }
  }

  onProgress({ phase: "write-back", done: 0, total: n });
  await sql`
    UPDATE items t SET x = w.x, y = w.y, z = w.z
    FROM projection_writeback w WHERE t.id = w.id
  `;
  await sql`TRUNCATE projection_writeback`;
  await sql`TRUNCATE projection_pca`;
  onProgress({ phase: "write-back", done: n, total: n });

  return { rows: n, dims };
}

async function writePcaAsCoords(
  sql: postgres.Sql,
  components: number,
  pcaDims: number,
) {
  await sql`
    INSERT INTO projection_writeback (id, x, y, z)
    SELECT
      id,
      COALESCE((comps->>0)::float8, 0),
      CASE WHEN ${pcaDims} >= 2 THEN COALESCE((comps->>1)::float8, 0) ELSE 0 END,
      CASE WHEN ${components} >= 3 AND ${pcaDims} >= 3 THEN COALESCE((comps->>2)::float8, 0) ELSE 0 END
    FROM projection_pca
  `;
  await sql`
    UPDATE items t SET x = w.x, y = w.y, z = w.z
    FROM projection_writeback w WHERE t.id = w.id
  `;
  await sql`TRUNCATE projection_writeback`;
  await sql`TRUNCATE projection_pca`;
}
