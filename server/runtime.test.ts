import request from "supertest";
import { createRuntime } from "./runtime";
import { openDb } from "./db/db";
import * as database from "./db/async";

const TURSO_URL = "turso://trustableai-bibekgupta3333.aws-us-east-1.turso.io";

beforeEach(() => {
  for (const name of ["VERCEL", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "ADMIN_TOKEN", "PARTICIPANT_SALT"]) {
    vi.stubEnv(name, "");
  }
  vi.stubEnv("DB_PATH", ":memory:");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "ADMIN_TOKEN", "PARTICIPANT_SALT"])("refuses serverless startup when %s is absent instead of creating local storage", async (missing) => {
  vi.stubEnv("TURSO_DATABASE_URL", TURSO_URL);
  vi.stubEnv("TURSO_AUTH_TOKEN", "demo-turso-token");
  vi.stubEnv("ADMIN_TOKEN", "demo-admin");
  vi.stubEnv("PARTICIPANT_SALT", "demo-salt");
  vi.stubEnv(missing, "");
  await expect(createRuntime({ serverless: true })).rejects.toThrow("Vercel requires");
});

it.each(["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"])("refuses partial local Turso configuration with only %s", async (present) => {
  vi.stubEnv(present, present === "TURSO_DATABASE_URL" ? TURSO_URL : "demo-turso-token");
  await expect(createRuntime()).rejects.toThrow("must be set together");
});

it("requires hosted credentials when VERCEL=1 even without the serverless option", async () => {
  vi.stubEnv("VERCEL", "1");
  await expect(createRuntime()).rejects.toThrow("Vercel requires");
});

it("retains local SQLite startup without hosted credentials", async () => {
  const runtime = await createRuntime();
  try {
    const response = await request(runtime.app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(runtime.storage).toBe(":memory:");
    const created = await request(runtime.app).post("/api/sessions").send({ participantCode: "local-demo" }).expect(201);
    expect(created.body.protocolVersion).toBe("calibrated-full-v1");
    expect(created.body.blocks.map((b: { postOrder: string[] }) => b.postOrder.length)).toEqual([2, 2, 2, 2]);
  } finally { await runtime.close(); }
});

it("uses the configured Turso database for hosted startup without leaking credentials in storage metadata", async () => {
  vi.stubEnv("TURSO_DATABASE_URL", TURSO_URL);
  vi.stubEnv("TURSO_AUTH_TOKEN", "demo-turso-token");
  vi.stubEnv("ADMIN_TOKEN", "demo-admin");
  vi.stubEnv("PARTICIPANT_SALT", "demo-salt");
  const db = database.asAsyncDatabase(openDb(":memory:"));
  const close = vi.spyOn(db, "close");
  const open = vi.spyOn(database, "openTursoDatabase").mockReturnValue(db);
  const runtime = await createRuntime({ serverless: true });
  try {
    expect(open).toHaveBeenCalledWith(TURSO_URL, "demo-turso-token");
    expect(runtime.storage).toBe("Turso SQLite");
    await request(runtime.app).get("/api/health").expect(200);
    await request(runtime.app).get("/api/admin/sessions").expect(401);
    await request(runtime.app).get("/api/admin/sessions").set("x-admin-token", "demo-admin").expect(200);
  } finally { await runtime.close(); }
  expect(close).toHaveBeenCalledOnce();
});

it("rejects an older remote schema and closes the database without migrating it", async () => {
  vi.stubEnv("TURSO_DATABASE_URL", TURSO_URL);
  vi.stubEnv("TURSO_AUTH_TOKEN", "demo-turso-token");
  const raw = openDb(":memory:");
  raw.prepare("UPDATE meta SET value='4' WHERE key='schema_version'").run();
  const db = database.asAsyncDatabase(raw);
  const actualClose = db.close.bind(db);
  const versionsAtClose: unknown[] = [];
  const close = vi.spyOn(db, "close").mockImplementation(async () => {
    versionsAtClose.push(raw.prepare("SELECT value FROM meta WHERE key='schema_version'").get());
    await actualClose();
  });
  vi.spyOn(database, "openTursoDatabase").mockReturnValue(db);
  try {
    await expect(createRuntime()).rejects.toThrow("Remote schema is not ready");
    expect(close).toHaveBeenCalledOnce();
    expect(versionsAtClose).toEqual([{ value: "4" }]);
    expect(raw.open).toBe(false);
  } finally { if (raw.open) raw.close(); }
});
