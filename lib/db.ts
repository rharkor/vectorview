import postgres from "postgres";

let client: postgres.Sql | null = null;

export function getDb(): postgres.Sql {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set. Copy .env.example to .env and configure it.",
      );
    }
    client = postgres(url, {
      max: 10,
      prepare: false,
      idle_timeout: 30,
      onnotice: () => {},
    });
  }
  return client;
}

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}
