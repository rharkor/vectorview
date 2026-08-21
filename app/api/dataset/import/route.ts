import type postgres from "postgres";
import { z } from "zod";

import { getDb, hasDatabase } from "@/lib/db";
import { invalidatePointsCache } from "@/lib/points-cache";
import { projectItems } from "@/lib/project";
import {
  connectSourceReadOnly,
  estimatedTableRows,
  logImport,
  redactUrl,
  validatePostgresUrl,
} from "@/lib/source";

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

const COPY_BATCH = 150;
const SOURCE_FETCH_MS = 120_000;
let importInProgress = false;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `${label} timed out after ${ms}ms — the kube port-forward may have reset`,
        ),
      );
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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
  logImport("start", {
    target: redactUrl(body.url),
    table: `${body.schema}.${body.table}`,
    idColumn: body.idColumn,
    embeddingColumn: body.embeddingColumn,
    batch: COPY_BATCH,
  });
  (async () => {
    const sql = getDb();
    const source = connectSourceReadOnly(body.url, {
      statementTimeoutMs: 0,
      idleTimeout: 600,
      connectTimeout: 45,
      max: 1,
    });
    try {
      await send({ phase: "connecting", message: `Connecting to ${redactUrl(body.url)}` });
      logImport("discover-columns");
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
      logImport("discover-columns:done", { columns: cols.length });
      if (cols.length === 0) {
        throw new Error(`Table ${body.schema}.${body.table} not found on source`);
      }
      const embCol = cols.find((c) => c.column === body.embeddingColumn);
      if (!embCol || embCol.udt !== "vector") {
        throw new Error(`Column "${body.embeddingColumn}" is not a pgvector vector column`);
      }

      // Avoid COUNT(*) on a distant table — it can run for minutes and the
      // copy cursor is itself one statement. Progress uses the planner estimate.
      const estimatedTotal = await estimatedTableRows(source, body.schema, body.table);

      // --- reset local dataset ------------------------------------------
      // Indexes must be dropped BEFORE truncating/inserting: pgvector cannot
      // maintain an HNSW index while the column is dimension-agnostic.
      logImport("estimated-total", { estimatedTotal });
      await send({ phase: "preparing", message: "Clearing current dataset" });
      logImport("clear-local");
      await sql`DROP INDEX IF EXISTS items_embedding_hnsw`;
      await sql`DROP INDEX IF EXISTS items_xy_idx`;
      await sql`TRUNCATE items RESTART IDENTITY`;
      await sql`TRUNCATE import_stage`;
      // Accept any embedding dimension during copy; pinned again afterwards.
      await sql`ALTER TABLE items ALTER COLUMN embedding TYPE vector`;
      logImport("clear-local:done");

      // --- copy rows ------------------------------------------------------
      const hasCoords = Boolean(body.xColumn && body.yColumn);
      const clusterMap = new Map<string, number>();
      let copied = 0;
      await send({ phase: "copying", done: 0, total: estimatedTotal });

      // Only the mapped viz columns — skip the rest of the row (json, text, …).
      const selectCols = [
        source`${source(body.embeddingColumn)}::text AS __emb`,
        source`${source(body.idColumn)}::text AS __source_id`,
        source`${source(body.idColumn)} AS __cursor_id`,
      ];
      if (body.clusterColumn) selectCols.push(source`${source(body.clusterColumn)} AS __cluster`);
      if (body.labelColumn) selectCols.push(source`${source(body.labelColumn)}::text AS __label`);
      if (hasCoords) {
        selectCols.push(source`${source(body.xColumn as string)}::float8 AS __x`);
        selectCols.push(source`${source(body.yColumn as string)}::float8 AS __y`);
        selectCols.push(
          body.zColumn
            ? source`${source(body.zColumn)}::float8 AS __z`
            : source`0::float8 AS __z`,
        );
      }
      const selectList = selectCols.reduce((a, b) => source`${a}, ${b}`);

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

      // Keyset pages instead of a held cursor: a server cursor stays idle-in-
      // transaction while we write locally, and distant hosts (or PgBouncer)
      // close that session after the first chunk — which looked like a hang
      // at 400 rows.
      const fetchPage = async (after: unknown) => {
        logImport("source-fetch:start", { after: after ?? "(first page)", limit: COPY_BATCH });
        const started = Date.now();
        const where =
          after === undefined
            ? source`${source(body.embeddingColumn)} IS NOT NULL`
            : source`${source(body.embeddingColumn)} IS NOT NULL AND ${source(body.idColumn)} > ${after}`;
        const rows = await withTimeout(
          source<Record<string, unknown>[]>`
            SELECT ${selectList}
            FROM ${source(body.schema)}.${source(body.table)}
            WHERE ${where}
            ORDER BY ${source(body.idColumn)}
            LIMIT ${COPY_BATCH}
          `,
          SOURCE_FETCH_MS,
          `source fetch after ${String(after ?? "start")}`,
        );
        const embChars = rows.reduce(
          (sum, row) => sum + (typeof row.__emb === "string" ? row.__emb.length : 0),
          0,
        );
        logImport("source-fetch:done", {
          rows: rows.length,
          ms: Date.now() - started,
          embeddingChars: embChars,
          lastId: rows.at(-1)?.__cursor_id ?? null,
        });
        return rows;
      };

      const writePage = async (rows: Record<string, unknown>[]) => {
        logImport("local-write:start", { rows: rows.length });
        const started = Date.now();
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
              cluster = clusterMap.get(key) ?? 0;
            }
          }
          const payload: Record<string, unknown> = {
            [body.idColumn]: r.__source_id,
          };
          if (body.clusterColumn && r.__cluster !== undefined) {
            payload[body.clusterColumn] = r.__cluster;
          }
          if (body.labelColumn && r.__label != null) {
            payload[body.labelColumn] = r.__label;
          }
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
        logImport("local-write:done", { rows: rows.length, ms: Date.now() - started });
      };

      await send({ phase: "copying", done: 0, total: estimatedTotal, message: "Fetching rows" });
      let after: unknown;
      for (;;) {
        const page = await fetchPage(after);
        if (page.length === 0) {
          logImport("copy:no-more-rows", { copied });
          break;
        }
        await send({
          phase: "copying",
          done: copied,
          total: estimatedTotal,
          message: `Writing ${page.length.toLocaleString()} rows`,
        });
        await writePage(page);
        copied += page.length;
        after = page[page.length - 1].__cursor_id;
        logImport("copy:progress", { copied, lastId: after });
        await send({ phase: "copying", done: copied, total: estimatedTotal, message: "Fetching rows" });
      }

      if (copied === 0) {
        throw new Error(
          `Column "${body.embeddingColumn}" is NULL for every copied row — nothing to visualize.`,
        );
      }

      // --- pin the embedding column to the imported dimension ------------
      // (HNSW indexes require a dimensioned vector column.)
      const [dimRow] = await sql<{ dims: number | null }[]>`
        SELECT vector_dims(embedding) AS dims FROM items WHERE embedding IS NOT NULL LIMIT 1
      `;
      const dims = dimRow?.dims ?? null;
      logImport("pin-embedding-dim", { dims });
      if (dims && Number.isInteger(dims) && dims > 0 && dims <= 16000) {
        await sql.unsafe(
          `ALTER TABLE items ALTER COLUMN embedding TYPE vector(${dims})`,
        );
      }

      // --- project (skip when source already had coordinates) ------------
      logImport("copy:done", { copied });
      if (hasCoords) {
        logImport("project:using-source-coords");
        await send({ phase: "projecting", message: "Using source coordinates", done: 1, total: 1 });
      } else {
        logImport("project:start");
        await projectItems(sql, {
          onProgress: (p) => {
            logImport(`project:${p.phase}`, { done: p.done, total: p.total });
            void send({ phase: "projecting", step: p.phase, done: p.done, total: p.total });
          },
        });
        logImport("project:done");
      }

      // --- indexes + stats -------------------------------------------------
      logImport("index:start");
      await send({ phase: "indexing", message: "Building indexes" });
      await sql`CREATE INDEX IF NOT EXISTS items_xy_idx ON items (x, y)`;
      try {
        await sql`
          CREATE INDEX IF NOT EXISTS items_embedding_hnsw
          ON items USING hnsw (embedding vector_cosine_ops)
        `;
      } catch (error) {
        logImport("index:hnsw-skipped", {
          error: error instanceof Error ? error.message : error,
        });
      }
      await sql`ANALYZE items`.catch((error) => {
        logImport("analyze:failed", { error: error instanceof Error ? error.message : error });
      });
      logImport("index:done");

      const clusterLabels: Record<string, string> = {};
      if (clusterMap.size > 0) {
        for (const [name, id] of clusterMap) clusterLabels[String(id)] = name;
      } else if (body.clusterColumn) {
        const distinct = await sql<{ cluster: number }[]>`
          SELECT DISTINCT cluster FROM items WHERE cluster IS NOT NULL
        `;
        for (const row of distinct) clusterLabels[String(row.cluster)] = String(row.cluster);
      }

      try {
        await sql`
          INSERT INTO dataset_meta (id, source_label, source_table, embedding_dim, imported_at, cluster_labels, cluster_column)
          VALUES (
            1,
            ${redactUrl(body.url)},
            ${`${body.schema}.${body.table}`},
            ${dims},
            now(),
            ${sql.json(clusterLabels)},
            ${body.clusterColumn ?? null}
          )
          ON CONFLICT (id) DO UPDATE SET
            source_label = EXCLUDED.source_label,
            source_table = EXCLUDED.source_table,
            embedding_dim = EXCLUDED.embedding_dim,
            imported_at = EXCLUDED.imported_at,
            cluster_labels = EXCLUDED.cluster_labels,
            cluster_column = EXCLUDED.cluster_column
        `;
      } catch (error) {
        const code = typeof error === "object" && error && "code" in error ? error.code : null;
        if (code !== "42703") throw error;
        await sql`
          INSERT INTO dataset_meta (id, source_label, source_table, embedding_dim, imported_at)
          VALUES (1, ${redactUrl(body.url)}, ${`${body.schema}.${body.table}`}, ${dims}, now())
          ON CONFLICT (id) DO UPDATE SET
            source_label = EXCLUDED.source_label,
            source_table = EXCLUDED.source_table,
            embedding_dim = EXCLUDED.embedding_dim,
            imported_at = EXCLUDED.imported_at
        `;
      }

      invalidatePointsCache();
      logImport("done", { rows: copied, dims });
      await send({ phase: "done", rows: copied, dims });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Import failed";
      logImport("error", { message, stack: error instanceof Error ? error.stack : undefined });
      await send({ phase: "error", error: message }).catch(() => {});
    } finally {
      logImport("close-source");
      importInProgress = false;
      streamClosed = true;
      await source.end({ timeout: 2 }).catch((error) => {
        logImport("close-source:failed", {
          error: error instanceof Error ? error.message : error,
        });
      });
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
