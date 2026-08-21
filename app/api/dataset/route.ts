import { getDb, hasDatabase } from "@/lib/db";
import { invalidatePointsCache } from "@/lib/points-cache";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!hasDatabase()) {
    return Response.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
  }
  try {
    const sql = getDb();
    const [counts] = await sql<{ total: string; projected: string }[]>`
      SELECT count(*)::text AS total, count(x)::text AS projected FROM items
    `;
    const metaRows = await sql`
      SELECT source_label, source_table, embedding_dim, imported_at
      FROM dataset_meta WHERE id = 1
    `.catch(() => [] as never[]);
    const meta = (metaRows as Record<string, unknown>[])[0] ?? null;
    return Response.json({
      rowCount: Number(counts.total),
      projectedCount: Number(counts.projected),
      source: meta
        ? {
            label: meta.source_label,
            table: meta.source_table,
            embeddingDim: meta.embedding_dim,
            importedAt: meta.imported_at,
          }
        : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown database error";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE() {
  if (!hasDatabase()) {
    return Response.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
  }
  try {
    const sql = getDb();
    await sql`TRUNCATE items RESTART IDENTITY`;
    await sql`DELETE FROM dataset_meta WHERE id = 1`.catch(() => {});
    invalidatePointsCache();
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown database error";
    return Response.json({ error: message }, { status: 500 });
  }
}
