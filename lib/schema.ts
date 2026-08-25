import type postgres from "postgres";

import { config } from "@/lib/config";

interface TableMeta {
  columns: Set<string>;
  types: Map<string, string>;
}

let metaCache: TableMeta | null = null;

/** Column names + data types of the configured table, introspected once per process. */
export async function getTableMeta(sql: postgres.Sql): Promise<TableMeta> {
  if (metaCache) return metaCache;
  const rows = await sql<{ column_name: string; data_type: string }[]>`
    SELECT column_name::text, data_type::text
    FROM information_schema.columns
    WHERE table_name = ${config.table}
  `;
  if (rows.length === 0) {
    throw new Error(
      `Table "${config.table}" not found. Run pnpm db:migrate (and scripts/seed.sql for demo data).`,
    );
  }
  metaCache = {
    columns: new Set(rows.map((r) => r.column_name)),
    types: new Map(rows.map((r) => [r.column_name, r.data_type])),
  };
  return metaCache;
}

/** All columns except the (potentially huge) embedding vector. */
export async function getScalarColumns(sql: postgres.Sql): Promise<string[]> {
  const { columns } = await getTableMeta(sql);
  return [...columns].filter((c) => c !== config.embeddingColumn);
}

/** Recursively convert BigInt values so JSON.stringify works. */
export function toJsonSafe<T>(value: T): T {
  if (typeof value === "bigint") {
    const n = Number(value);
    return (Number.isSafeInteger(n) ? n : value.toString()) as T;
  }
  if (Array.isArray(value)) return value.map(toJsonSafe) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)])) as T;
  }
  return value;
}
