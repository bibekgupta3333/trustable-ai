import Database from "better-sqlite3";
import { initializeTursoSchema } from "./setup";
import { openDb } from "./db";
import { asAsyncDatabase } from "./async";

it("creates the complete schema in an empty database and preserves current contents on a second run", async () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  try {
    expect(await initializeTursoSchema(db)).toBe("created");
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: "5" });
    db.prepare("INSERT INTO meta (key,value) VALUES ('participant_salt','preserve-salt')").run();
    expect(await initializeTursoSchema(db)).toBe("current");
    expect(db.prepare("SELECT value FROM meta WHERE key='participant_salt'").get()).toEqual({ value: "preserve-salt" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally { db.close(); }
});

it("refuses unrelated tables without altering their rows or adding study tables", async () => {
  const db = new Database(":memory:");db.exec("CREATE TABLE important (value TEXT); INSERT INTO important VALUES ('keep')");
  try {
    await expect(initializeTursoSchema(db)).rejects.toThrow("No changes made");
    expect(db.prepare("SELECT value FROM important").all()).toEqual([{ value: "keep" }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: "important" }]);
  } finally { db.close(); }
});

it("refuses older or incomplete schemas instead of performing an implicit destructive migration", async () => {
  const db = openDb(":memory:");
  try {
    db.prepare("UPDATE meta SET value='4' WHERE key='schema_version'").run();
    await expect(initializeTursoSchema(db)).rejects.toThrow("No changes made");
    db.prepare("UPDATE meta SET value='5' WHERE key='schema_version'").run();db.exec("DROP TABLE exit_surveys");
    await expect(initializeTursoSchema(db)).rejects.toThrow("incomplete");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='exit_surveys'").get()).toBeUndefined();
  } finally { db.close(); }
});


it("refuses a current schema missing the duplicate-code index without changing saved metadata", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO meta (key,value) VALUES ('participant_salt','preserve-salt')").run();
  db.exec("DROP INDEX idx_sessions_participant_hash");
  try {
    await expect(initializeTursoSchema(db)).rejects.toThrow("missing its duplicate-code index");
    expect(db.prepare("SELECT value FROM meta WHERE key='participant_salt'").get()).toEqual({ value: "preserve-salt" });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='idx_sessions_participant_hash'").get()).toBeUndefined();
  } finally { db.close(); }
});


it("rolls back an interrupted bootstrap and permits retry without a partial schema", async () => {
  const raw = new Database(":memory:");
  const db = asAsyncDatabase(raw);
  const exec = db.exec.bind(db);
  const interrupted = vi.spyOn(db, "exec").mockImplementationOnce(async (sql) => {
    await exec(sql);
    throw new Error("simulated setup interruption");
  });
  try {
    await expect(initializeTursoSchema(db)).rejects.toThrow("simulated setup interruption");
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()).toEqual([]);
    interrupted.mockRestore();
    expect(await initializeTursoSchema(db)).toBe("created");
    expect(raw.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: "5" });
  } finally {
    interrupted.mockRestore();
    await db.close();
  }
});

it("initializes a fresh Turso database while preserving its engine metadata", async () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE __turso_internal_mvcc_meta (value TEXT); INSERT INTO __turso_internal_mvcc_meta VALUES ('preserve-engine-state')");
  try {
    expect(await initializeTursoSchema(db)).toBe("created");
    expect(await initializeTursoSchema(db)).toBe("current");
    expect(db.prepare("SELECT * FROM __turso_internal_mvcc_meta").all()).toEqual([{ value: "preserve-engine-state" }]);
  } finally { db.close(); }
});
