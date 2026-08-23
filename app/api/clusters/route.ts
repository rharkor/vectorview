import { z } from "zod";

import {
  applyClusterColumn,
  listPayloadFields,
  loadClusterColumn,
  loadClusterLabels,
} from "@/lib/cluster-labels";
import { getDb, hasDatabase } from "@/lib/db";
import { invalidatePointsCache } from "@/lib/points-cache";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!hasDatabase()) {
    return Response.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
  }
  try {
    const sql = getDb();
    const [labels, column, listed] = await Promise.all([
      loadClusterLabels(sql),
      loadClusterColumn(sql),
      listPayloadFields(sql),
    ]);
    const fields = column && !listed.includes(column) ? [column, ...listed] : listed;
    return Response.json({ labels, column, fields });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load clusters";
    return Response.json({ error: message }, { status: 500 });
  }
}

const patchSchema = z.object({
  column: z.string().min(1).max(200),
});

export async function PATCH(request: Request) {
  if (!hasDatabase()) {
    return Response.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
  }
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Send { column: string }." }, { status: 400 });
  }
  try {
    const result = await applyClusterColumn(getDb(), parsed.data.column);
    invalidatePointsCache();
    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to change cluster field";
    return Response.json({ error: message }, { status: 400 });
  }
}
