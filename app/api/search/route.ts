import { createGateway, GatewayAuthenticationError } from "@ai-sdk/gateway";
import type { GatewayEmbeddingModelId } from "@ai-sdk/gateway";
import { embed } from "ai";
import { z } from "zod";

import { config } from "@/lib/config";
import { getDb, hasDatabase } from "@/lib/db";
import { getScalarColumns, toJsonSafe } from "@/lib/schema";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  query: z.string().trim().min(1).max(2000),
  k: z.number().int().min(1).max(100).default(20),
});

export async function POST(request: Request) {
  const token = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  if (!token) {
    return Response.json(
      { error: "Missing Vercel AI Gateway token. Add one to enable search." },
      { status: 401 },
    );
  }
  if (!hasDatabase()) {
    return Response.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const { query, k } = parsed.data;

  let vectorText: string;
  try {
    const gateway = createGateway({ apiKey: token });
    const { embedding } = await embed({
      model: gateway.embeddingModel(config.embeddingModel as GatewayEmbeddingModelId),
      value: query,
    });
    vectorText = `[${embedding.join(",")}]`;
  } catch (error) {
    if (error instanceof GatewayAuthenticationError) {
      return Response.json(
        { error: "Gateway token was rejected. Check it and try again." },
        { status: 401 },
      );
    }
    const message = error instanceof Error ? error.message : "Embedding request failed";
    return Response.json({ error: message }, { status: 502 });
  }

  try {
    const sql = getDb();
    const scalarCols = await getScalarColumns(sql);
    const results = await sql`
      SELECT ${sql(scalarCols)},
             (${sql(config.embeddingColumn)} <=> ${vectorText}::vector) AS distance
      FROM ${sql(config.table)}
      WHERE ${sql(config.embeddingColumn)} IS NOT NULL
      ORDER BY ${sql(config.embeddingColumn)} <=> ${vectorText}::vector
      LIMIT ${k}
    `;
    return Response.json({ query, results: toJsonSafe([...results]) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown database error";
    if (/expected \d+ dimensions|different dimensions/i.test(message)) {
      return Response.json(
        {
          error: `Embedding dimension mismatch: "${config.embeddingModel}" does not match the stored embeddings. Set EMBEDDING_MODEL/EMBEDDING_DIM correctly. (${message})`,
        },
        { status: 409 },
      );
    }
    return Response.json({ error: message }, { status: 500 });
  }
}
