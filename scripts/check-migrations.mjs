#!/usr/bin/env node
/**
 * Verify all migrations are applied. Runs before `next dev` (see package.json).
 * Exits 1 with actionable output when anything is missing.
 * Set SKIP_DB_CHECK=1 to bypass.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import postgres from "postgres";

if (process.env.SKIP_DB_CHECK === "1") {
  process.exit(0);
}

const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");
const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort();

const fail = (lines) => {
  console.error("\n[vectorview] Database check failed:");
  for (const line of lines) console.error(`  ${line}`);
  console.error("");
  process.exit(1);
};

const url = process.env.DATABASE_URL;
if (!url) {
  fail([
    "DATABASE_URL is not set.",
    "Copy .env.example to .env, configure it, then run: pnpm db:migrate",
    "(SKIP_DB_CHECK=1 pnpm dev to bypass)",
  ]);
}

const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 5 });
try {
  const appliedRows = await sql`SELECT name FROM schema_migrations`.catch((e) => {
    if (e?.code === "42P01") return []; // schema_migrations does not exist yet
    throw e;
  });
  const applied = new Set(appliedRows.map((r) => r.name));
  const pending = files.filter((f) => !applied.has(f));
  if (pending.length > 0) {
    fail([
      `Pending migrations: ${pending.join(", ")}`,
      "Run: pnpm db:migrate",
      "(SKIP_DB_CHECK=1 pnpm dev to bypass)",
    ]);
  }
  console.log("[vectorview] Database migrations up to date.");
} catch (error) {
  fail([
    `Cannot reach Postgres: ${error instanceof Error ? error.message : error}`,
    "Check DATABASE_URL in .env (SKIP_DB_CHECK=1 pnpm dev to bypass)",
  ]);
} finally {
  await sql.end({ timeout: 2 }).catch(() => {});
}
