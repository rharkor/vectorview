import { z } from "zod";

import {
  connectSourceReadOnly,
  estimatedTableRows,
  validatePostgresUrl,
} from "@/lib/source";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  url: z.string().max(2000),
  schema: z.string().min(1).max(200),
  table: z.string().min(1).max(200),
  embeddingColumn: z.string().max(200).nullish(),
});

/** Exact counts when cheap; planner estimate for large / distant tables. */
const EXACT_COUNT_LIMIT = 80_000;

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

  const source = connectSourceReadOnly(url, {
    statementTimeoutMs: 20_000,
    connectTimeout: 30,
  });
  try {
    const estimated = await estimatedTableRows(source, schema, table);
    if (estimated > EXACT_COUNT_LIMIT) {
      return Response.json({
        count: estimated,
        embeddingCount: null,
        approximate: true,
      });
    }

    const [row] = await source<{ count: string; emb_count: string | null }[]>`
      SELECT count(*)::text AS count,
             ${embeddingColumn
               ? source`count(${source(embeddingColumn)})::text`
               : source`NULL`} AS emb_count
      FROM ${source(schema)}.${source(table)}
    `;
    return Response.json({
      count: Number(row?.count ?? estimated),
      embeddingCount: row?.emb_count === null ? null : Number(row.emb_count),
      approximate: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Count failed";
    const timeout = /statement timeout|canceling statement/i.test(message);
    if (timeout) {
      try {
        const estimated = await estimatedTableRows(source, schema, table);
        return Response.json({
          count: estimated,
          embeddingCount: null,
          approximate: true,
        });
      } catch {
        /* fall through */
      }
    }
    return Response.json({ error: message }, { status: 502 });
  } finally {
    await source.end({ timeout: 2 }).catch(() => {});
  }
}
