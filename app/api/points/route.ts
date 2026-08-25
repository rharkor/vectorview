import { tableFromArrays, tableToIPC } from "apache-arrow";
import type { NextRequest } from "next/server";

import { config } from "@/lib/config";
import { getDb, hasDatabase } from "@/lib/db";
import {
  getCachedCount,
  getCachedPoints,
  type PointsCacheEntry,
  setCachedCount,
  setCachedPoints,
} from "@/lib/points-cache";
import { getTableMeta } from "@/lib/schema";

export const dynamic = "force-dynamic";

const SAMPLE_BUCKETS = 1_000_000;
const MAX_RENDERED_POINTS = 1_250_000;

async function getTotalCount(sql: ReturnType<typeof getDb>): Promise<number> {
  const cached = getCachedCount();
  if (cached !== null) return cached;
  const rows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM ${sql(config.table)} WHERE x IS NOT NULL
  `;
  const total = Number(rows[0]?.count ?? 0);
  setCachedCount(total);
  return total;
}

export async function GET(request: NextRequest) {
  if (!hasDatabase()) {
    return Response.json(
      { error: "DATABASE_URL is not configured. See .env.example." },
      { status: 503 },
    );
  }

  const params = request.nextUrl.searchParams;
  const sample = Math.min(1, Math.max(0, Number(params.get("sample") ?? "1") || 1));
  const bboxParam = params.get("bbox");
  const bbox = bboxParam?.split(",").map(Number);
  const hasBbox = bbox?.length === 4 && bbox.every((v) => Number.isFinite(v));

  const cacheKey = `${sample}:${hasBbox ? bbox.join(",") : "all"}`;
  const cached = getCachedPoints(cacheKey);
  if (cached) {
    return arrowResponse(cached);
  }

  try {
    const sql = getDb();
    const { columns } = await getTableMeta(sql);
    if (!columns.has("x") || !columns.has("y")) {
      return Response.json(
        { error: "Table has no x/y coordinates yet. Import a dataset to project them." },
        { status: 409 },
      );
    }
    const hasCluster = Boolean(config.clusterColumn) && columns.has(config.clusterColumn);
    const hasZ = columns.has("z");

    const total = await getTotalCount(sql);
    const want = Math.min(
      MAX_RENDERED_POINTS,
      Math.max(1, Math.round(sample * Math.max(total, 1))),
    );
    const subsample = total > 0 && want < total;
    const threshold = Math.max(1, Math.round((want / Math.max(total, 1)) * SAMPLE_BUCKETS));

    const clusterSelect = hasCluster ? sql`${sql(config.clusterColumn)}` : sql`-1`;
    const filters = [
      sql`x IS NOT NULL`,
      ...(subsample
        ? [
            sql`abs(hashtextextended(${sql(config.idColumn)}::text, 42)) % ${SAMPLE_BUCKETS} < ${threshold}`,
          ]
        : []),
      ...(hasBbox
        ? [sql`x BETWEEN ${bbox[0]} AND ${bbox[2]} AND y BETWEEN ${bbox[1]} AND ${bbox[3]}`]
        : []),
    ];
    const where = filters.reduce((acc, f) => sql`${acc} AND ${f}`);

    const rows = await sql`
      SELECT
        COALESCE(source_id, ${sql(config.idColumn)}::text) AS id,
        x, y,
        ${hasZ ? sql`COALESCE(z, 0) AS z` : sql`0 AS z`},
        ${clusterSelect} AS cluster,
        COALESCE(label, '') AS label
      FROM ${sql(config.table)}
      WHERE ${where}
    `.values();

    const n = rows.length;
    const ids: string[] = new Array(n);
    const labels: string[] = new Array(n);
    const xs = new Float32Array(n);
    const ys = new Float32Array(n);
    const zs = new Float32Array(n);
    const clusters = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const row = rows[i];
      ids[i] = String(row[0]);
      xs[i] = Number(row[1]);
      ys[i] = Number(row[2]);
      zs[i] = Number(row[3]);
      clusters[i] = row[4] === null ? -1 : Number(row[4]);
      labels[i] = String(row[5] ?? "");
    }

    const table = tableFromArrays({
      id: ids,
      x: xs,
      y: ys,
      z: zs,
      cluster: clusters,
      label: labels,
    });
    const entry: PointsCacheEntry = {
      ipc: tableToIPC(table, "stream"),
      total,
      rendered: n,
      at: Date.now(),
    };
    setCachedPoints(cacheKey, entry);
    return arrowResponse(entry);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown database error";
    return Response.json({ error: message }, { status: 500 });
  }
}

function arrowResponse(entry: PointsCacheEntry) {
  return new Response(Buffer.from(entry.ipc), {
    headers: {
      "Content-Type": "application/vnd.apache.arrow.stream",
      "X-Total-Count": String(entry.total),
      "X-Rendered-Count": String(entry.rendered),
      "Cache-Control": "private, max-age=30",
    },
  });
}
