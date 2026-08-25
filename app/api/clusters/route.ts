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
export const runtime = "nodejs";

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

let remapInProgress = false;

export async function PATCH(request: Request) {
  if (!hasDatabase()) {
    return Response.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
  }
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Send { column: string }." }, { status: 400 });
  }
  if (remapInProgress) {
    return Response.json(
      { error: "A cluster update is already running. Wait for it to finish." },
      { status: 409 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  let streamClosed = false;
  const send = async (data: Record<string, unknown>) => {
    if (streamClosed) return;
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    } catch {
      streamClosed = true;
    }
  };

  remapInProgress = true;
  (async () => {
    try {
      const result = await applyClusterColumn(getDb(), parsed.data.column, send);
      invalidatePointsCache();
      await send({
        phase: "done",
        done: 1,
        total: 1,
        column: result.column,
        labels: result.labels,
        count: result.count,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to change cluster field";
      await send({ phase: "error", error: message }).catch(() => {});
    } finally {
      remapInProgress = false;
      streamClosed = true;
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
