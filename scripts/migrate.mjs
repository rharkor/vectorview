#!/usr/bin/env node
/**
 * Apply pending SQL migrations from migrations/ in order.
 * Usage: pnpm db:migrate   (loads .env via --env-file-if-exists)
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import postgres from "postgres";

const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

export function listMigrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    const appliedRows = await sql`SELECT name FROM schema_migrations`;
    const applied = new Set(appliedRows.map((r) => r.name));

    const pending = listMigrationFiles().filter((f) => !applied.has(f));
    if (pending.length === 0) {
      console.log("All migrations already applied.");
      return;
    }

    for (const file of pending) {
      const body = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      console.log(`Applying ${file} ...`);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      });
      console.log(`Applied ${file}`);
    }
    console.log(`Done. ${pending.length} migration(s) applied.`);
  } catch (error) {
    console.error(`Migration failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

main();
