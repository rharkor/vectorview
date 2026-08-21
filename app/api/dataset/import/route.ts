import type postgres from "postgres";
import { z } from "zod";

import { getDb, hasDatabase } from "@/lib/db";
import { invalidatePointsCache } from "@/lib/points-cache";
import { projectItems } from "@/lib/project";
import { connectSourceReadOnly, redactUrl, validatePostgresUrl } from "@/lib/source";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  url: z.string().max(2000),
  schema: z.string().min(1).max(200),
  table: z.string().min(1).max(200),
  idColumn: z.string().min(1).max(200),
  embeddingColumn: z.string().min(1).max(200),
  clusterColumn: z.string().max(200).nullish(),
  labelColumn: z.string().max(200).nullish(),
  xColumn: z.string().max(200).nullish(),
  yColumn: z.string().max(200).nullish(),
  zColumn: z.string().max(200).nullish(),
});

const COPY_BATCH = 2_000;
let importInProgress = false;

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const body = parsed.data;
  const urlError = validatePostgresUrl(body.url);
  if (urlError) {
    return Response.json({ error: urlError }, { status: 400 });
  }
  if (!hasDatabase()) {
    return Response.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
  }
  if (importInProgress) {
    return Response.json(
      { error: "An import is already running. Wait for it to finish." },
      { status: 409 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  // The client may disconnect mid-import (or a dev-server reload may tear the
  // stream down): swallow late writes instead of crashing with unhandled
  // rejections, and let the import finish server-side.
  let streamClosed = false;
  const send = async (data: Record<string, unknown>) => {
    if (streamClosed) return;
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    } catch {
      streamClosed = true;
    }
  };

  importInProgress = true;
  (async () => {
    const sql = getDb();
    const source = connectSourceReadOnly(body.url);
    try {
      // --- discover source columns for the payload -----------------------
      await send({ phase: "connecting", message: `Connecting to ${redactUrl(body.url)}` });
      const cols = await source<{ column: string; udt: string }[]>`
        SELECT a.attname AS column, t.typname AS udt
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_type t ON t.oid = a.atttypid
        WHERE c.relname = ${body.table} AND n.nspname = ${body.schema}
          AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
      `;
      if (cols.length === 0) {
        throw new Error(`Table ${body.schema}.${body.table} not found on source`);
      }
      const excluded = new Set(
        [body.embeddingColumn, body.xColumn, body.yColumn, body.zColumn].filter(Boolean),
      );
      const payloadCols = cols.map((c) => c.column).filter((c) => !excluded.has(c as string));
      const embCol = cols.find((c) => c.column === body.embeddingColumn);
      if (!embCol || embCol.udt !== "vector") {
        throw new Error(`Column "${body.embeddingColumn}" is not a pgvector vector column`);
      }

      // Exact counts up front: rows without embeddings are useless for
      // visualization, so they are filtered out of the copy entirely.
      const [counts] = await source<{ total: string; with_emb: string }[]>`
        SELECT count(*)::text AS total,
               count(${source(body.embeddingColumn)})::text AS with_emb
        FROM ${source(body.schema)}.${source(body.table)}
      `;
      const estimatedTotal = Number(counts?.with_emb ?? 0);
      if (estimatedTotal === 0) {
        throw new Error(
          `Column "${body.embeddingColumn}" is NULL for all ${Number(counts?.total ?? 0).toLocaleString()} rows — nothing to visualize.`,
        );
      }

      // --- reset local dataset ------------------------------------------
      // Indexes must be dropped BEFORE truncating/inserting: pgvector cannot
      // maintain an HNSW index while the column is dimension-agnostic.
      await send({ phase: "preparing", message: "Clearing current dataset" });
      await sql`DROP INDEX IF EXISTS items_embedding_hnsw`;
      await sql`DROP INDEX IF EXISTS items_xy_idx`;
      await sql`TRUNCATE items RESTART IDENTITY`;
      await sql`TRUNCATE import_stage`;
      // Accept any embedding dimension during copy; pinned again afterwards.
      await sql`ALTER TABLE items ALTER COLUMN embedding TYPE vector`;

      // --- copy rows ------------------------------------------------------
      const hasCoords = Boolean(body.xColumn && body.yColumn);
      const clusterMap = new Map<string, number>();
      let copied = 0;
      await send({ phase: "copying", done: 0, total: estimatedTotal });

      const selectCols = [
        ...payloadCols.map((c) => sql(c)),
        sql`${sql(body.embeddingColumn)}::text AS __emb`,
        sql`${sql(body.idColumn)}::text AS __source_id`,
      ];
      if (body.clusterColumn) selectCols.push(sql`${sql(body.clusterColumn)} AS __cluster`);
      if (body.labelColumn) selectCols.push(sql`${sql(body.labelColumn)}::text AS __label`);
      if (hasCoords) {
        selectCols.push(sql`${sql(body.xColumn!)}::float8 AS __x`);
        selectCols.push(sql`${sql(body.yColumn!)}::float8 AS __y`);
        selectCols.push(
          body.zColumn ? sql`${sql(body.zColumn)}::float8 AS __z` : sql`0::float8 AS __z`,
        );
      }

      interface StageRow {
        payload: postgres.Parameter;
        emb: string | null;
        cluster: number | null;
        source_id: string | null;
        label: string | null;
        x: number | null;
        y: number | null;
        z: number | null;
      }

      // NB: use the async-iterator cursor form — the callback form does not
      // await async callbacks on all completion paths, which raced the
      // projection step into seeing an empty table.
      const cursor = source<Record<string, unknown>[]>`
        SELECT ${selectCols.reduce((a, b) => sql`${a}, ${b}`)}
        FROM ${sql(body.schema)}.${sql(body.table)}
        WHERE ${sql(body.embeddingColumn)} IS NOT NULL
      `.cursor(COPY_BATCH);

      for await (const rows of cursor) {
      const staged: StageRow[] = rows.map((r) => {
        const emb = r.__emb as string | null;
          let cluster: number | null = null;
          if (body.clusterColumn) {
            const raw = r.__cluster;
            if (typeof raw === "number" && Number.isFinite(raw)) {
              cluster = Math.trunc(raw);
            } else if (raw !== null && raw !== undefined) {
              const key = String(raw);
              if (!clusterMap.has(key)) clusterMap.set(key, clusterMap.size);
              cluster = clusterMap.get(key)!;
            }
          }
          const payload: Record<string, unknown> = {};
          for (const c of payloadCols) payload[c as string] = r[c as string];
          return {
            payload: sql.json(payload as postgres.JSONValue),
            emb,
            cluster,
            source_id: r.__source_id as string | null,
            label: (r.__label as string | null) ?? null,
            x: hasCoords ? (r.__x as number) : null,
            y: hasCoords ? (r.__y as number) : null,
            z: hasCoords ? (r.__z as number) : null,
          };
        });
        await sql`
          INSERT INTO import_stage ${sql(staged, "payload", "emb", "cluster", "source_id", "label", "x", "y", "z")}
        `;
        await sql`
          INSERT INTO items (payload, embedding, cluster, source_id, label, x, y, z)
          SELECT payload, emb::vector, cluster, source_id, label, x, y, z FROM import_stage
        `;
        await sql`TRUNCATE import_stage`;
        copied += rows.length;
        await send({ phase: "copying", done: copied, total: estimatedTotal });
      }

      // --- pin the embedding column to the imported dimension ------------
      // (HNSW indexes require a dimensioned vector column.)
      const [dimRow] = await sql<{ dims: number | null }[]>`
        SELECT vector_dims(embedding) AS dims FROM items WHERE embedding IS NOT NULL LIMIT 1
      `;
      const dims = dimRow?.dims ?? null;
      if (dims && Number.isInteger(dims) && dims > 0 && dims <= 16000) {
        await sql.unsafe(
          `ALTER TABLE items ALTER COLUMN embedding TYPE vector(${dims})`,
        );
      }

      // --- project (skip when source already had coordinates) ------------
      if (hasCoords) {
        await send({ phase: "projecting", message: "Using source coordinates", done: 1, total: 1 });
      } else {
        await projectItems(sql, {
          onProgress: (p) => {
            void send({ phase: "projecting", step: p.phase, done: p.done, total: p.total });
          },
        });
      }

      // --- indexes + stats -------------------------------------------------
      await send({ phase: "indexing", message: "Building HNSW index" });
      await sql`
        CREATE INDEX IF NOT EXISTS items_embedding_hnsw
        ON items USING hnsw (embedding vector_cosine_ops)
      `;
      await sql`CREATE INDEX IF NOT EXISTS items_xy_idx ON items (x, y)`;
      await sql`ANALYZE items`;

      await sql`
        INSERT INTO dataset_meta (id, source_label, source_table, embedding_dim, imported_at)
        VALUES (1, ${redactUrl(body.url)}, ${`${body.schema}.${body.table}`}, ${dims}, now())
        ON CONFLICT (id) DO UPDATE SET
          source_label = EXCLUDED.source_label,
          source_table = EXCLUDED.source_table,
          embedding_dim = EXCLUDED.embedding_dim,
          imported_at = EXCLUDED.imported_at
      `;

      invalidatePointsCache();
      await send({ phase: "done", rows: copied, dims });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Import failed";
      await send({ phase: "error", error: message }).catch(() => {});
    } finally {
      importInProgress = false;
      streamClosed = true;
      await source.end({ timeout: 2 }).catch(() => {});
      await writer.close().catch(() => {});
    }
  })();

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
