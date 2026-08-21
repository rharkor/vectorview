export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { getPendingMigrations } = await import("@/lib/migrations");
    const pending = await getPendingMigrations();
    if (pending.length > 0) {
      console.warn(
        [
          "",
          "┌──────────────────────────────────────────────────────────┐",
          "│  VectorView: pending database migrations!                │",
          `│  ${pending.join(", ").padEnd(57).slice(0, 57)}│`,
          "│  Run: pnpm db:migrate                                    │",
          "└──────────────────────────────────────────────────────────┘",
          "",
        ].join("\n"),
      );
    }
  } catch (error) {
    console.warn(
      `[vectorview] Could not verify database migrations: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
}
