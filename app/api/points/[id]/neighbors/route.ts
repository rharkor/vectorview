import { NextRequest } from "next/server";

import { config } from "@/lib/config";
import { getDb, hasDatabase } from "@/lib/db";
import { getScalarColumns, getTableMeta, toJsonSafe } from "@/lib/schema";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!hasDatabase()) {
    return Response.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
  }

  const { id } = await params;
  const k = Math.min(
    100,
    Math.max(1, Number(request.nextUrl.searchParams.get("k") ?? "20") || 20),
  );

  try {
    const sql = getDb();
    const scalarCols = await getScalarColumns(sql);

    const ref = await sql<{ emb: string | null }[]>`
      SELECT ${sql(config.embeddingColumn)}::text AS emb
      FROM ${sql(config.table)}
      WHERE source_id = ${id}
      LIMIT 1
    `;
    if (ref.length === 0) {
      return Response.json({ error: `Point ${id} not found` }, { status: 404 });
    }
    if (!ref[0].emb) {
      return Response.json(
        { error: `Point ${id} has no embedding; cannot compute neighbors.` },
        { status: 409 },
      );
    }

    const { columns } = await getTableMeta(sql);
    const hasCluster = Boolean(config.clusterColumn) && columns.has(config.clusterColumn);

    // Vector passed as a parameter so the HNSW index is used for the kNN scan.
    const neighbors = await sql`
      SELECT ${sql(scalarCols)},
             (${sql(config.embeddingColumn)} <=> ${ref[0].emb}::vector) AS distance
      FROM ${sql(config.table)}
      WHERE source_id IS DISTINCT FROM ${id}
        AND ${sql(config.embeddingColumn)} IS NOT NULL
      ORDER BY ${sql(config.embeddingColumn)} <=> ${ref[0].emb}::vector
      LIMIT ${k}
    `;

    let outsideNeighbors: typeof neighbors = [];
    if (hasCluster) {
      const [self] = await sql<{ cluster: number | null }[]>`
        SELECT ${sql(config.clusterColumn)} AS cluster
        FROM ${sql(config.table)}
        WHERE source_id = ${id}
        LIMIT 1
      `;
      if (self && self.cluster !== null) {
        outsideNeighbors = await sql`
          SELECT ${sql(scalarCols)},
                 (${sql(config.embeddingColumn)} <=> ${ref[0].emb}::vector) AS distance
          FROM ${sql(config.table)}
          WHERE source_id IS DISTINCT FROM ${id}
            AND ${sql(config.embeddingColumn)} IS NOT NULL
            AND ${sql(config.clusterColumn)} IS DISTINCT FROM ${self.cluster}
          ORDER BY ${sql(config.embeddingColumn)} <=> ${ref[0].emb}::vector
          LIMIT ${k}
        `;
      }
    }

    return Response.json({
      neighbors: toJsonSafe([...neighbors]),
      outsideNeighbors: toJsonSafe([...outsideNeighbors]),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown database error";
    return Response.json({ error: message }, { status: 500 });
  }
}
