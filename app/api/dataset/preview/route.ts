import { z } from "zod";

import { connectSourceReadOnly, redactUrl, validatePostgresUrl } from "@/lib/source";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  url: z.string().max(2000),
  search: z.string().max(200).optional(),
});

const TABLES_LIMIT = 100;

interface ColumnRow {
  schema: string;
  table: string;
  column: string;
  data_type: string;
  udt: string;
  vector_dim: number | null;
}

const CLUSTER_NAME_HINTS = new Set([
  "cluster",
  "label",
  "category",
  "topic",
  "class",
  "group",
  "segment",
]);
const ID_TYPES = new Set(["int2", "int4", "int8", "uuid", "text", "varchar"]);
const FLOAT_TYPES = new Set(["float4", "float8", "numeric"]);
const LABEL_NAME_HINTS = new Set(["name", "title", "label", "handle", "slug", "username", "email"]);

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const { url } = parsed.data;
  const search = parsed.data.search?.trim() ?? "";
  const urlError = validatePostgresUrl(url);
  if (urlError) {
    return Response.json({ error: urlError }, { status: 400 });
  }

  const source = connectSourceReadOnly(url, { connectTimeout: 45 });
  try {
    const pattern = `%${search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const tables = await source<{ schema: string; table: string; est_rows: string }[]>`
      SELECT schemaname AS schema, relname AS table, n_live_tup::text AS est_rows
      FROM pg_stat_user_tables
      WHERE ${search} = ''
         OR relname ILIKE ${pattern}
         OR schemaname ILIKE ${pattern}
      ORDER BY n_live_tup DESC
      LIMIT ${TABLES_LIMIT}
    `;

    const [countRow] = await source<{ total: string }[]>`
      SELECT count(*)::text AS total FROM pg_stat_user_tables
    `;
    const totalTables = Number(countRow?.total ?? 0);

    // Scope column/PK introspection to just the returned tables.
    const keys = tables.map((t) => `${t.schema}.${t.table}`);
    const columns: ColumnRow[] = [];
    const pks: { schema: string; table: string; column: string }[] = [];
    if (keys.length > 0) {
      columns.push(
        ...(await source<ColumnRow[]>`
          SELECT n.nspname AS schema, c.relname AS table, a.attname AS column,
                 t.typname AS udt,
                 CASE WHEN t.typname = 'vector' THEN a.atttypmod ELSE NULL END AS vector_dim,
                 format_type(a.atttypid, a.atttypmod) AS data_type
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_type t ON t.oid = a.atttypid
          WHERE c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
            AND (n.nspname || '.' || c.relname) = ANY(${keys})
          ORDER BY n.nspname, c.relname, a.attnum
        `),
      );
      pks.push(
        ...(await source<{ schema: string; table: string; column: string }[]>`
          SELECT n.nspname AS schema, c.relname AS table, a.attname AS column
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
          WHERE i.indisprimary
            AND (n.nspname || '.' || c.relname) = ANY(${keys})
        `),
      );
    }
    const pkSet = new Set(pks.map((r) => `${r.schema}.${r.table}.${r.column}`));

    const byTable = new Map<string, ColumnRow[]>();
    for (const col of columns) {
      const key = `${col.schema}.${col.table}`;
      const list = byTable.get(key) ?? [];
      list.push(col);
      byTable.set(key, list);
    }

    const result = tables
      .map((t) => {
        const key = `${t.schema}.${t.table}`;
        const cols = (byTable.get(key) ?? []).map((c) => ({
          name: c.column,
          dataType: c.data_type,
          udt: c.udt,
          vectorDim: c.vector_dim,
          isPrimaryKey: pkSet.has(`${key}.${c.column}`),
        }));

        const vectorCol = cols.find((c) => c.udt === "vector");
        const pkCol = cols.find((c) => c.isPrimaryKey);
        const idCol =
          pkCol ??
          cols.find((c) => c.name === "id" && ID_TYPES.has(c.udt)) ??
          cols.find((c) => ID_TYPES.has(c.udt));
        const clusterCol = cols.find(
          (c) => CLUSTER_NAME_HINTS.has(c.name.toLowerCase()) && c.udt !== "vector",
        );
        const labelCol = cols.find(
          (c) => LABEL_NAME_HINTS.has(c.name.toLowerCase()) && ["text", "varchar"].includes(c.udt),
        );
        const coordCol = (name: string) =>
          cols.find((c) => c.name.toLowerCase() === name && FLOAT_TYPES.has(c.udt));

        return {
          schema: t.schema,
          name: t.table,
          estimatedRows: Number(t.est_rows),
          hasEmbeddings: Boolean(vectorCol),
          columns: cols,
          suggestion: {
            idColumn: idCol?.name ?? null,
            embeddingColumn: vectorCol?.name ?? null,
            embeddingDim: vectorCol?.vectorDim ?? null,
            clusterColumn: clusterCol?.name ?? null,
            labelColumn: labelCol?.name ?? null,
            xColumn: coordCol("x")?.name ?? null,
            yColumn: coordCol("y")?.name ?? null,
            zColumn: coordCol("z")?.name ?? null,
          },
        };
      })
      .sort(
        (a, b) =>
          Number(b.hasEmbeddings) - Number(a.hasEmbeddings) || b.estimatedRows - a.estimatedRows,
      );

    return Response.json({
      source: redactUrl(url),
      tables: result,
      totalTables,
      truncated: totalTables > result.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection failed";
    return Response.json({ error: message }, { status: 502 });
  } finally {
    await source.end({ timeout: 2 }).catch(() => {});
  }
}
