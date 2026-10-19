import request from "supertest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import postBank from "../shared/data/posts.json" with { type: "json" };
import { loadPostBank } from "../shared/labelEngine.js";
import { createApp } from "./app.js";
import { openDb } from "./db/db.js";

const pages = ["/", "/start", "/admin", "/consent", "/instructions", "/trial/1/1", "/survey/1", "/exit", "/debrief"];
let directory: string;
let db: ReturnType<typeof openDb>;
let app: Awaited<ReturnType<typeof createApp>>;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "xai-routing-"));
  writeFileSync(join(directory, "index.html"), "<!doctype html><html><body><div id=\"root\">study-shell</div></body></html>");
  mkdirSync(join(directory, "assets"));
  writeFileSync(join(directory, "assets", "app.js"), "console.log('study-asset');");
  db = openDb(":memory:");
  app = await createApp({ db, bank: loadPostBank(postBank), appVersion: "route-audit", participantSalt: "audit-salt", adminToken: "audit-admin", staticDir: directory });
});
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });

it.each(pages)("serves the SPA document for direct navigation to %s", async (path) => {
  const result = await request(app).get(path).expect(200);
  expect(result.headers["content-type"]).toMatch(/text\/html/);
  expect(result.text).toContain("study-shell");
});

it("serves real assets and HEAD requests without converting them to API responses", async () => {
  const asset = await request(app).get("/assets/app.js").expect(200);
  expect(asset.headers["content-type"]).toMatch(/javascript/);
  expect(asset.text).toContain("study-asset");
  const head = await request(app).head("/trial/2/1").expect(200);
  expect(head.text).toBeUndefined();
});

it.each(["/api", "/api/missing", "/api/sessions/missing/consent", "/api/admin/missing"])("keeps missing API routes as JSON errors: %s", async (path) => {
  const result = await request(app).get(path).set("x-admin-token", "audit-admin").expect(404);
  expect(result.headers["content-type"]).toMatch(/application\/json/);
  expect(result.body.error).toBe("not_found");
  expect(result.text).not.toContain("study-shell");
});

it("rejects unsupported API methods and malformed JSON without serving the SPA", async () => {
  const method = await request(app).delete("/api/health").expect(404);
  expect(method.body.error).toBe("not_found");
  const malformed = await request(app).post("/api/sessions").set("Content-Type", "application/json").send("{bad").expect(400);
  expect(malformed.body.error).toBe("validation");
  expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  await request(app).post("/start").expect(404);
});
