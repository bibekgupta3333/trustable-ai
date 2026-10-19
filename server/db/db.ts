import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");
export const SCHEMA_VERSION = "5";

/** Opens (or creates) the study database, applies schema.sql idempotently and migrates older DBs. ':memory:' allowed. */
export function openDb(path: string): Database.Database {
  const inMemory = path === ":memory:" || path === "";
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  if (!inMemory) db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  migrate(db);
  return db;
}

/** Idempotent migrations preserve saved plans, responses and historical protocol versions. */
function migrate(db: Database.Database): void {
  // Rebuilding the parent table to extend its CHECK must not cascade-delete children.
  // This connection is not exposed to request handlers until migration succeeds.
  db.pragma("foreign_keys = OFF");
  try {
  db.transaction(() => {
    const cols = new Set((db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name));
    if (!cols.has("participant_hash")) db.exec("ALTER TABLE sessions ADD COLUMN participant_hash TEXT");
    if (!cols.has("last_activity_at")) {
      db.exec("ALTER TABLE sessions ADD COLUMN last_activity_at TEXT");
      // Best guess for pre-existing rows: last saved trial, else completion, consent or start time.
      db.exec(`UPDATE sessions SET last_activity_at = COALESCE(
        (SELECT MAX(t.saved_at) FROM trials t WHERE t.session_id = sessions.session_id),
        completed_at, consent_at, started_at)`);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_participant_hash
      ON sessions(participant_hash) WHERE participant_hash IS NOT NULL`);
    if (!cols.has("protocol_version"))
      db.exec("ALTER TABLE sessions ADD COLUMN protocol_version TEXT NOT NULL DEFAULT 'legacy-full-v1' CHECK (protocol_version IN ('legacy-full-v1','calibrated-brief-v1'))");

    const sessionSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'sessions'").get() as { sql: string }).sql;
    if (!sessionSql.includes("'calibrated-media-full-v1'")) {
      const schema = readFileSync(SCHEMA_PATH, "utf8");
      const definition = schema.match(/CREATE TABLE IF NOT EXISTS sessions \([\s\S]*?\n\);/)![0];
      db.exec(definition.replace("IF NOT EXISTS sessions", "sessions_v5"));
      const names = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name).join(", ");
      db.exec(`INSERT INTO sessions_v5 (${names}) SELECT ${names} FROM sessions`);
      db.exec("DROP TABLE sessions");
      db.exec("ALTER TABLE sessions_v5 RENAME TO sessions");
      db.exec("CREATE INDEX idx_sessions_pid ON sessions(pid)");
      db.exec("CREATE UNIQUE INDEX idx_sessions_participant_hash ON sessions(participant_hash) WHERE participant_hash IS NOT NULL");
    }

    const surveyCols = db.prepare("PRAGMA table_info(block_surveys)").all() as { name: string; notnull: number }[];
    if (surveyCols.some((c) => ["trust_mean", "fairness1", "fairness2", "fairness_mean"].includes(c.name) && c.notnull)) {
      // SQLite cannot drop NOT NULL constraints in place. No table references block_surveys.
      // Reuse the canonical definition so new and migrated databases have identical constraints.
      const schema = readFileSync(SCHEMA_PATH, "utf8");
      const definition = schema.match(/CREATE TABLE IF NOT EXISTS block_surveys \([\s\S]*?\n\);/)![0];
      db.exec(definition.replace("IF NOT EXISTS block_surveys", "block_surveys_v3"));
      const names = surveyCols.map((c) => c.name).join(", ");
      db.exec(`INSERT INTO block_surveys_v3 (${names}) SELECT ${names} FROM block_surveys`);
      db.exec("DROP TABLE block_surveys");
      db.exec("ALTER TABLE block_surveys_v3 RENAME TO block_surveys");
    } else {
      const names = new Set(surveyCols.map((c) => c.name));
      if (!names.has("questionnaire_version"))
        db.exec("ALTER TABLE block_surveys ADD COLUMN questionnaire_version TEXT NOT NULL DEFAULT 'full-v1' CHECK (questionnaire_version IN ('full-v1','brief-v1'))");
      if (!names.has("brief_trust"))
        db.exec("ALTER TABLE block_surveys ADD COLUMN brief_trust INTEGER CHECK (brief_trust BETWEEN 1 AND 7)");
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(SCHEMA_VERSION);
    if ((db.pragma("foreign_key_check") as unknown[]).length) throw new Error("Foreign key check failed during schema migration");
  })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
