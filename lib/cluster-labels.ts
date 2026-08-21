import type postgres from "postgres";

const NAME_HINTS = new Set([
  "cluster",
  "label",
  "category",
  "topic",
  "class",
  "group",
  "segment",
  "type",
  "kind",
  "tag",
  "family",
]);

export type ClusterLabelMap = Record<string, string>;

export async function loadClusterLabels(sql: postgres.Sql): Promise<ClusterLabelMap> {
  const meta = await sql<{ cluster_labels: ClusterLabelMap | null }[]>`
    SELECT cluster_labels FROM dataset_meta WHERE id = 1
  `.catch(() => [] as { cluster_labels: ClusterLabelMap | null }[]);
  const stored = meta[0]?.cluster_labels;
  if (stored && Object.keys(stored).length > 0) return stored;
  return inferClusterLabels(sql);
}

export async function inferClusterLabels(sql: postgres.Sql): Promise<ClusterLabelMap> {
  const rows = await sql<{ cluster: number; payload: Record<string, unknown> | null }[]>`
    SELECT cluster, payload FROM (
      SELECT cluster, payload,
             row_number() OVER (PARTITION BY cluster ORDER BY id) AS rn
      FROM items
      WHERE cluster IS NOT NULL
    ) samples
    WHERE rn <= 25
  `.catch(() => [] as { cluster: number; payload: Record<string, unknown> | null }[]);

  const byCluster = new Map<number, Record<string, unknown>[]>();
  for (const row of rows) {
    if (typeof row.cluster !== "number") continue;
    const list = byCluster.get(row.cluster) ?? [];
    if (row.payload && typeof row.payload === "object") list.push(row.payload);
    byCluster.set(row.cluster, list);
  }

  const keys = new Set<string>();
  for (const payloads of byCluster.values()) {
    for (const payload of payloads) {
      for (const key of Object.keys(payload)) keys.add(key);
    }
  }

  let best: { score: number; labels: ClusterLabelMap } | null = null;
  for (const key of keys) {
    const labels: ClusterLabelMap = {};
    const seen = new Set<string>();
    let ok = true;
    for (const [id, payloads] of byCluster) {
      const values = new Set(
        payloads
          .map((p) => p[key])
          .filter((v) => v !== null && v !== undefined && v !== "")
          .map((v) => String(v)),
      );
      if (values.size !== 1) {
        ok = false;
        break;
      }
      const value = [...values][0];
      if (seen.has(value)) {
        ok = false;
        break;
      }
      seen.add(value);
      labels[String(id)] = value;
    }
    if (!ok || Object.keys(labels).length !== byCluster.size) continue;
    const score = (NAME_HINTS.has(key.toLowerCase()) ? 100 : 0) + Math.min(key.length, 20);
    if (!best || score > best.score) best = { score, labels };
  }
  if (best) return best.labels;

  const fallback: ClusterLabelMap = {};
  for (const id of byCluster.keys()) fallback[String(id)] = String(id);
  return fallback;
}

