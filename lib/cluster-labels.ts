import type postgres from "postgres";

const MAX_CLUSTER_VALUES = 2_500;
const SKIP_FIELD_HINTS = new Set([
  "embedding",
  "emb",
  "vector",
  "embedding_vector",
]);

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

export interface ClusterField {
  key: string;
}

export async function loadClusterColumn(
  sql: postgres.Sql,
): Promise<string | null> {
  const rows = await sql<{ cluster_column: string | null }[]>`
    SELECT cluster_column FROM dataset_meta WHERE id = 1
  `.catch(() => [] as { cluster_column: string | null }[]);
  return rows[0]?.cluster_column ?? null;
}

export async function listPayloadFields(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ payload: Record<string, unknown> | null }[]>`
    SELECT payload FROM items
    WHERE payload IS NOT NULL
    ORDER BY id
    LIMIT 150
  `.catch(() => [] as { payload: Record<string, unknown> | null }[]);
  const keys = new Set<string>();
  for (const row of rows) {
    if (!row.payload || typeof row.payload !== "object") continue;
    for (const [key, value] of Object.entries(row.payload)) {
      if (SKIP_FIELD_HINTS.has(key.toLowerCase())) continue;
      if (value !== null && typeof value === "object") continue;
      keys.add(key);
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

export async function applyClusterColumn(
  sql: postgres.Sql,
  column: string,
): Promise<{ column: string; labels: ClusterLabelMap; count: number }> {
  const key = column.trim();
  if (!key) throw new Error("Choose a payload field to color by.");

  const [{ n }] = await sql<{ n: string }[]>`
    SELECT count(DISTINCT payload->>${key})::text AS n
    FROM items
    WHERE payload ? ${key}
      AND payload->>${key} IS NOT NULL
      AND payload->>${key} <> ''
  `;
  const distinct = Number(n);
  if (!Number.isFinite(distinct) || distinct === 0) {
    throw new Error(`No values found in payload field "${key}".`);
  }
  if (distinct > MAX_CLUSTER_VALUES) {
    throw new Error(
      `"${key}" has ${distinct.toLocaleString()} distinct values — pick a categorical field (max ${MAX_CLUSTER_VALUES.toLocaleString()}).`,
    );
  }

  await sql.begin(async (tx) => {
    await tx`UPDATE items SET cluster = NULL`;
    await tx`
      UPDATE items AS t
      SET cluster = m.cid
      FROM (
        SELECT
          id,
          (dense_rank() OVER (ORDER BY payload->>${key})) - 1 AS cid
        FROM items
        WHERE payload ? ${key}
          AND payload->>${key} IS NOT NULL
          AND payload->>${key} <> ''
      ) m
      WHERE t.id = m.id
    `;
    const labeled = await tx<{ cluster: number; label: string }[]>`
      SELECT DISTINCT cluster, payload->>${key} AS label
      FROM items
      WHERE cluster IS NOT NULL
    `;
    const labels: ClusterLabelMap = {};
    for (const row of labeled) labels[String(row.cluster)] = row.label;
    await tx`
      UPDATE dataset_meta
      SET cluster_column = ${key}, cluster_labels = ${tx.json(labels)}
      WHERE id = 1
    `;
  });

  const labels = await loadClusterLabels(sql);
  return { column: key, labels, count: distinct };
}

