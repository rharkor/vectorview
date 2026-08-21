import { loadClusterLabels } from "@/lib/cluster-labels";
import { getDb, hasDatabase } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!hasDatabase()) {
    return Response.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
  }
  try {
    const labels = await loadClusterLabels(getDb());
    return Response.json({ labels });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load clusters";
    return Response.json({ error: message }, { status: 500 });
  }
}
