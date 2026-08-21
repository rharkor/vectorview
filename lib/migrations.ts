import { readdirSync } from "node:fs";
import path from "node:path";

import { getDb, hasDatabase } from "@/lib/db";

/** Names of migration files present on disk but not yet applied. */
export async function getPendingMigrations(): Promise<string[]> {
  const files = readdirSync(path.join(process.cwd(), "migrations"))
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  if (!hasDatabase()) return files;
  const sql = getDb();
  const appliedRows = await sql<{ name: string }[]>`
    SELECT name FROM schema_migrations
  `.catch((error: { code?: string }) => {
    if (error?.code === "42P01") return [] as { name: string }[];
    throw error;
  });
  const applied = new Set(appliedRows.map((r) => r.name));
  return files.filter((f) => !applied.has(f));
}
