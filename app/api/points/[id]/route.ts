import { config } from "@/lib/config";
import { getDb, hasDatabase } from "@/lib/db";
import { getScalarColumns, toJsonSafe } from "@/lib/schema";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!hasDatabase()) {
    return Response.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
  }

  const { id } = await params;
  try {
    const sql = getDb();
    const scalarCols = await getScalarColumns(sql);
    const rows = await sql`
      SELECT ${sql(scalarCols)}
      FROM ${sql(config.table)}
      WHERE source_id = ${id}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return Response.json({ error: `Point ${id} not found` }, { status: 404 });
    }
    const row = toJsonSafe({ ...rows[0] }) as Record<string, unknown>;
    row.embedding_dim = config.embeddingDim;
    return Response.json({ point: row });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown database error";
    return Response.json({ error: message }, { status: 500 });
  }
}
