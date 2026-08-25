import postgres from "postgres";

export interface SourceConnectOptions {
  /** 0 disables the timeout (needed for long cursor copies). */
  statementTimeoutMs?: number;
  idleTimeout?: number;
  connectTimeout?: number;
  /** Default 1 — kube port-forward resets if we open extra sessions. */
  max?: number;
}

export function logImport(event: string, detail?: unknown) {
  const time = new Date().toISOString().slice(11, 23);
  if (detail === undefined) console.log(`[import ${time}] ${event}`);
  else console.log(`[import ${time}] ${event}`, detail);
}

/**
 * Connect to a user-provided source database in enforced read-only mode.
 * `options` is a startup parameter, so every pooled connection is read-only
 * regardless of which queries run later.
 */
export function connectSourceReadOnly(url: string, opts: SourceConnectOptions = {}): postgres.Sql {
  const statementTimeoutMs = opts.statementTimeoutMs ?? 60_000;
  const idleTimeout = opts.idleTimeout ?? 30;
  const connectTimeout = opts.connectTimeout ?? 30;
  const max = opts.max ?? 1;
  return postgres(url, {
    max,
    prepare: false,
    idle_timeout: idleTimeout,
    connect_timeout: connectTimeout,
    // Keep the kube/TCP tunnel from looking idle and getting reset.
    keep_alive: 10,
    connection: {
      options: `-c default_transaction_read_only=on -c statement_timeout=${statementTimeoutMs}`,
      application_name: "vectorview-import",
    },
  });
}

export function validatePostgresUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid URL";
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return "URL must use postgres:// or postgresql://";
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
    return "URL must include a host and a database name";
  }
  return null;
}

/** host/database — safe to display, never includes credentials. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return "unknown";
  }
}

export async function estimatedTableRows(
  source: postgres.Sql,
  schema: string,
  table: string,
): Promise<number> {
  const [row] = await source<{ estimate: string }[]>`
    SELECT GREATEST(c.reltuples, 0)::bigint::text AS estimate
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relname = ${table}
  `;
  return Number(row?.estimate ?? 0);
}
