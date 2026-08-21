import { PCA } from "ml-pca";
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
  // pgvector text format: "[1,2,3]"
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

/**
 * Project the internal `items` embeddings to x/y/z in place:
 * PCA (fit on a sample, transform in batches) -> UMAP -> staged write-back.
 */
export async function projectItems(
  sql: postgres.Sql,
  options: ProjectOptions = {},
): Promise<{ rows: number; dims: number }> {
  const components = options.components ?? 3;
  const pcaSampleSize = options.pcaSampleSize ?? 10_000;
  const umapFitMax = options.umapFitMax ?? 100_000;
  const batchSize = options.batchSize ?? 5_000;
  const onProgress = options.onProgress ?? (() => {});

  const [{ count }] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM items WHERE embedding IS NOT NULL
  `;
  const n = Number(count);
  if (n === 0) throw new Error("No embeddings to project");

  // --- PCA fit on a random sample -------------------------------------
  onProgress({ phase: "pca-fit", done: 0, total: 1 });
  const sampleRows = await sql<{ emb: string }[]>`
    SELECT embedding::text AS emb FROM items
    WHERE embedding IS NOT NULL
    ORDER BY random() LIMIT ${Math.min(pcaSampleSize, n)}
  `;
  const sample = sampleRows.map((r) => parseVector(r.emb));
  const dims = sample[0]?.length ?? 0;
  if (dims === 0) throw new Error("Could not read embeddings");
  const pcaDims = Math.min(options.pcaDims ?? 50, dims, sample.length);
  const pca = new PCA(sample, { center: true, scale: false });
  onProgress({ phase: "pca-fit", done: 1, total: 1 });

  // --- PCA transform all rows (streamed) -------------------------------
  const ids = new Float64Array(n);
  const reduced = new Float32Array(n * pcaDims);
  let offset = 0;
  await sql`
    SELECT id, embedding::text AS emb FROM items
    WHERE embedding IS NOT NULL ORDER BY id
  `.cursor(batchSize, (rows) => {
    const batch = rows.map((r) => parseVector(r.emb as string));
    const out = pca.predict(batch, { nComponents: pcaDims }).to2DArray();
    for (let i = 0; i < rows.length; i++) {
      ids[offset + i] = Number(rows[i].id);
      for (let j = 0; j < pcaDims; j++) {
        reduced[(offset + i) * pcaDims + j] = out[i][j];
      }
    }
    offset += rows.length;
    onProgress({ phase: "pca-transform", done: offset, total: n });
  });

  // --- UMAP --------------------------------------------------------------
  const nEpochs = n > 10_000 ? 200 : 500;
  const umap = new UMAP({
    nComponents: components,
    nNeighbors: Math.min(15, n - 1),
    minDist: 0.1,
    nEpochs,
  });

  const coords = new Float32Array(n * components);
  const fitCount = Math.min(n, umapFitMax);
  let fitIndices: Uint32Array;
  if (fitCount === n) {
    fitIndices = new Uint32Array(n);
    for (let i = 0; i < n; i++) fitIndices[i] = i;
  } else {
    fitIndices = new Uint32Array(fitCount);
    const chosen = new Set<number>();
    while (chosen.size < fitCount) chosen.add(Math.floor(Math.random() * n));
    let i = 0;
    for (const idx of chosen) fitIndices[i++] = idx;
    fitIndices.sort();
  }

  const fitData: number[][] = new Array(fitCount);
  for (let i = 0; i < fitCount; i++) {
    const idx = fitIndices[i];
    fitData[i] = Array.from(reduced.subarray(idx * pcaDims, (idx + 1) * pcaDims));
  }

  const fitEmbedding = await umap.fitAsync(fitData, (epoch) => {
    onProgress({ phase: "umap-fit", done: epoch, total: nEpochs });
  });
  for (let i = 0; i < fitCount; i++) {
    const idx = fitIndices[i];
    for (let c = 0; c < components; c++) {
      coords[idx * components + c] = fitEmbedding[i][c];
    }
  }

  if (fitCount < n) {
    // Transform the remaining rows in batches.
    const rest: number[] = [];
    const inFit = new Uint8Array(n);
    for (const idx of fitIndices) inFit[idx] = 1;
    for (let i = 0; i < n; i++) if (!inFit[i]) rest.push(i);

    for (let start = 0; start < rest.length; start += batchSize) {
      const slice = rest.slice(start, start + batchSize);
      const batch = slice.map((idx) =>
        Array.from(reduced.subarray(idx * pcaDims, (idx + 1) * pcaDims)),
      );
      const out = umap.transform(batch);
      for (let i = 0; i < slice.length; i++) {
        for (let c = 0; c < components; c++) {
          coords[slice[i] * components + c] = out[i][c];
        }
      }
      onProgress({
        phase: "umap-transform",
        done: Math.min(start + batchSize, rest.length),
        total: rest.length,
      });
    }
  }

  // --- Write back via staging table --------------------------------------
  await sql`TRUNCATE projection_writeback`;
  for (let start = 0; start < n; start += batchSize) {
    const end = Math.min(start + batchSize, n);
    const rows: { id: number; x: number; y: number; z: number }[] = new Array(end - start);
    for (let i = start; i < end; i++) {
      rows[i - start] = {
        id: ids[i],
        x: coords[i * components],
        y: coords[i * components + 1],
        z: components >= 3 ? coords[i * components + 2] : 0,
      };
    }
    await sql`INSERT INTO projection_writeback ${sql(rows, "id", "x", "y", "z")}`;
    onProgress({ phase: "write-back", done: end, total: n });
  }
  await sql`
    UPDATE items t SET x = w.x, y = w.y, z = w.z
    FROM projection_writeback w WHERE t.id = w.id
  `;
  await sql`TRUNCATE projection_writeback`;

  return { rows: n, dims };
}
