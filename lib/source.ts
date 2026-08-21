import postgres from "postgres";

/**
 * Connect to a user-provided source database in enforced read-only mode.
 * `options` is a startup parameter, so every pooled connection is read-only
 * and time-boxed regardless of which queries run later.
 */
export function connectSourceReadOnly(url: string): postgres.Sql {
  return postgres(url, {
    max: 3,
    prepare: false,
    idle_timeout: 10,
    connection: {
      options: "-c default_transaction_read_only=on -c statement_timeout=60000",
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
