import { readFileSync } from "node:fs";
import { asAsyncDatabase, type DatabaseInput } from "./async";
import { SCHEMA_VERSION } from "./db";

/** Explicit bootstrap only. Never changes a nonempty incompatible database. */
export async function initializeTursoSchema(input: DatabaseInput): Promise<"created" | "current"> {
  const db = asAsyncDatabase(input);
  return db.transaction(async () => {
    // Fresh Turso databases contain engine metadata; preserve it and inspect only application tables.
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__turso_internal_mvcc_meta'").all() as { name: string }[];
    if (tables.length) {
      const version = tables.some((t) => t.name === "meta")
        ? await db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined
        : undefined;
      if (version?.value !== SCHEMA_VERSION) {
        throw new Error("Database is not empty/current. No changes made; migrate an existing study locally or use an empty Turso database.");
      }
      const required = ["meta", "sessions", "blocks", "trials", "events", "block_surveys", "exit_surveys"];
      if (required.some((name) => !tables.some((table) => table.name === name))) {
        throw new Error("Existing schema is incomplete; no changes made. Restore a verified backup.");
      }
      const index = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_participant_hash'").get();
      if (!index) throw new Error("Existing schema is missing its duplicate-code index; no changes made. Restore a verified backup.");
      return "current";
    }
    const sql = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
    await db.exec(sql);
    await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_participant_hash ON sessions(participant_hash) WHERE participant_hash IS NOT NULL");
    await db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
    return "created";
  }).immediate();
}
