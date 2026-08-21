import { z } from "zod";

import { connectSourceReadOnly, validatePostgresUrl } from "@/lib/source";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  url: z.string().max(2000),
  schema: z.string().min(1).max(200),
  table: z.string().min(1).max(200),
  embeddingColumn: z.string().max(200).nullish(),
});

/** Exact row counts for a selected table (pg_stat estimates can be stale). */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const { url, schema, table, embeddingColumn } = parsed.data;
  const urlError = validatePostgresUrl(url);
  if (urlError) {
    return Response.json({ error: urlError }, { status: 400 });
  }

  const source = connectSourceReadOnly(url);
  try {
    const [row] = await source<{ count: string; emb_count: string | null }[]>`
      SELECT count(*)::text AS count,
             ${embeddingColumn
               ? source`count(${source(embeddingColumn)})::text`
               : source`NULL`} AS emb_count
      FROM ${source(schema)}.${source(table)}
    `;
    return Response.json({
      count: Number(row?.count ?? 0),
      embeddingCount: row?.emb_count === null ? null : Number(row?.emb_count),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Count failed";
    return Response.json({ error: message }, { status: 502 });
  } finally {
    await source.end({ timeout: 2 }).catch(() => {});
  }
}
