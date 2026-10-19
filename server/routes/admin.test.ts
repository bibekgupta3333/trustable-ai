import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import type Database from "better-sqlite3";
import { openDb } from "../db/db";
import { createSession, getSession, setStatus, insertTrial, insertEvents, insertBlockSurvey, insertExitSurvey } from "../db/repo.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adminRouter, adminAccess, exportFilename, isLoopback } from "./admin";
import { loadPostBank } from "../../shared/labelEngine";
import { assignShortFromBank } from "../../shared/counterbalance";
import type { Assignment, BlockPlan } from "../../shared/api";
import type { Condition, PostBank, SetId } from "../../shared/types";

function block(blockIndex: 1 | 2 | 3 | 4, condition: Condition, set: SetId): BlockPlan {
  const postOrder = [1, 2, 3, 4, 5, 6].map((i) => `${set.toLowerCase()}-p${i}`);
  return { blockIndex, condition, set, postOrder };
}

function assignment(pid: number): Assignment {
  return {
    pid,
    conditionOrder: ["A", "B", "D", "C"],
    setRotation: 0,
    seed: pid,
    blocks: [block(1, "A", "S1"), block(2, "B", "S2"), block(3, "D", "S4"), block(4, "C", "S3")],
  };
}

const OPTS = { consequenceBanner: false, anxiety: false, postBankHash: "test-hash", appVersion: "0.0.0-test" };

function makeApp(db: Database.Database, adminToken?: string, opts: { remoteAddress?: string; bank?: PostBank } = {}) {
  const app = express();
  app.use(express.json());
  if (opts.remoteAddress) {
    // Simulate a request arriving from another machine.
    const fake = opts.remoteAddress;
    app.use((req, _res, next) => {
      Object.defineProperty(req, "socket", { value: { ...req.socket, remoteAddress: fake }, configurable: true });
      next();
    });
  }
  app.use("/api/admin", adminRouter({ db, adminToken, bank: opts.bank }));
  return app;
}

const BANK = loadPostBank(JSON.parse(readFileSync(join(__dirname, "../../shared/data/posts.json"), "utf8")));

let db: Database.Database;
beforeEach(() => {
  db = openDb(":memory:");
});
afterEach(() => db.close());

describe("admin token", () => {
  it("allows all requests when no token is configured", async () => {
    await request(makeApp(db)).get("/api/admin/sessions").expect(200);
  });

  it("rejects a missing or wrong token with 401 JSON", async () => {
    const app = makeApp(db, "secret");
    const r1 = await request(app).get("/api/admin/sessions").expect(401);
    expect(r1.body.error).toBeTruthy();
    await request(app).get("/api/admin/sessions").set("x-admin-token", "nope").expect(401);
    await request(app).get("/api/admin/export/trials.csv?token=nope").expect(401);
  });

  it("accepts the token via header or ?token= query", async () => {
    const app = makeApp(db, "secret");
    await request(app).get("/api/admin/sessions").set("x-admin-token", "secret").expect(200);
    await request(app).get("/api/admin/export/trials.csv?token=secret").expect(200);
  });
});

describe("admin access without ADMIN_TOKEN (loopback only)", () => {
  it("isLoopback recognises IPv4, IPv6 and mapped loopback only", () => {
    for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(isLoopback(a)).toBe(true);
    for (const a of ["10.0.0.5", "192.168.1.2", "::ffff:10.0.0.5", "", undefined, null]) expect(isLoopback(a)).toBe(false);
  });

  it("adminAccess: token required when set, loopback otherwise", () => {
    expect(adminAccess(undefined, { remoteAddress: "127.0.0.1" })).toBe("ok");
    expect(adminAccess(undefined, { remoteAddress: "10.0.0.5" })).toBe("forbidden");
    expect(adminAccess("s", { remoteAddress: "127.0.0.1" })).toBe("unauthorized");
    expect(adminAccess("s", { header: "s", remoteAddress: "10.0.0.5" })).toBe("ok");
    expect(adminAccess("s", { queryToken: "s" })).toBe("ok");
  });

  it("allows loopback requests (supertest connects via loopback)", async () => {
    await request(makeApp(db)).get("/api/admin/sessions").expect(200);
    await request(makeApp(db)).get("/api/admin/kpis").expect(200);
  });

  it("returns 403 JSON for non-loopback requests", async () => {
    const app = makeApp(db, undefined, { remoteAddress: "192.168.1.20" });
    for (const path of ["/api/admin/sessions", "/api/admin/kpis", "/api/admin/export/trials.csv"]) {
      const res = await request(app).get(path).expect(403);
      expect(res.body.error).toBe("forbidden");
    }
  });

  it("allows non-loopback requests that carry the configured token", async () => {
    const app = makeApp(db, "secret", { remoteAddress: "192.168.1.20" });
    await request(app).get("/api/admin/kpis").expect(401);
    await request(app).get("/api/admin/kpis").set("x-admin-token", "secret").expect(200);
  });
});

describe("GET /kpis", () => {
  it("defaults to the current cohort and validates explicit cohort queries", async () => {
    const legacy = await createSession(db, assignment(1), OPTS);
    const current = await createSession(db, assignment(2), { ...OPTS, protocolVersion: "calibrated-full-v1" });
    const media = await createSession(db, assignment(3), { ...OPTS, protocolVersion: "calibrated-media-full-v1" });
    for (const s of [legacy, current, media]) await setStatus(db, s.sessionId, "completed", new Date().toISOString());
    const app = makeApp(db);
    const res = await request(app).get("/api/admin/kpis").expect(200);
    expect(res.body.cohort).toBe("calibrated-full-v1");
    expect(res.body.sessions.completed).toBe(1);
    expect((await request(app).get("/api/admin/kpis?protocolVersion=all").expect(200)).body.sessions.completed).toBe(3);
    expect((await request(app).get("/api/admin/kpis?protocolVersion=legacy-full-v1").expect(200)).body.sessions.completed).toBe(1);
    const mediaRes = await request(app).get("/api/admin/kpis?protocolVersion=calibrated-media-full-v1").expect(200);
    expect(mediaRes.body.cohort).toBe("calibrated-media-full-v1");
    expect(mediaRes.body.sessions.completed).toBe(1);
    for (const query of ["invalid", "all&protocolVersion=legacy-full-v1", "", "all%27"]) {
      await request(app).get(`/api/admin/kpis?protocolVersion=${query}`).expect(400);
    }
    const csv = await request(app).get("/api/admin/export/kpis.csv").expect(200);
    expect(csv.text).toContain("meta,all,protocolVersion,calibrated-full-v1");
    expect(csv.text).toContain("summary,all,completed,1");
  });

  it("returns the Kpis shape", async () => {
    const s = await createSession(db, assignment(1), OPTS);
    await setStatus(db, s.sessionId, "completed", new Date().toISOString());
    await createSession(db, assignment(901), OPTS);
    const res = await request(makeApp(db)).get("/api/admin/kpis?protocolVersion=all").expect(200);
    expect(res.body.sessions).toMatchObject({ started: 1, completed: 1, inProgress: 0, completionRate: 1 });
    expect(res.body.byCondition).toHaveLength(4);
    expect(res.body.byErrorType).toHaveLength(2);
    expect(typeof res.body.generatedAt).toBe("string");
  });
});

describe("GET /assignments/:pid", () => {
  it("previews the counterbalanced assignment without creating a session", async () => {
    const app = makeApp(db, undefined, { bank: BANK });
    const res = await request(app).get("/api/admin/assignments/905").expect(200);
    expect(res.body).toEqual(assignShortFromBank(905, BANK));
    const n = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("400s on an invalid pid and 503s without a bank", async () => {
    await request(makeApp(db, undefined, { bank: BANK })).get("/api/admin/assignments/0").expect(400);
    await request(makeApp(db, undefined, { bank: BANK })).get("/api/admin/assignments/abc").expect(400);
    await request(makeApp(db)).get("/api/admin/assignments/1").expect(503);
  });
});

describe("GET /sessions", () => {
  it("lists created sessions", async () => {
    const s1 = await createSession(db, assignment(1), OPTS);
    const s2 = await createSession(db, assignment(2), OPTS);
    const res = await request(makeApp(db)).get("/api/admin/sessions").expect(200);
    expect(res.body).toHaveLength(2);
    const ids = res.body.map((r: { sessionId: string }) => r.sessionId).sort();
    expect(ids).toEqual([s1.sessionId, s2.sessionId].sort());
    const row = res.body.find((r: { sessionId: string }) => r.sessionId === s1.sessionId);
    expect(row).toMatchObject({ pid: 1, status: "in_progress", conditionOrder: "ABDC", trialsSaved: 0, surveysSaved: 0 });
    expect(row).toHaveProperty("lastActivityAt");
  });
});

describe("POST /sessions/:id/abandon", () => {
  it("marks an in_progress session abandoned (204)", async () => {
    const s = await createSession(db, assignment(3), OPTS);
    await request(makeApp(db)).post(`/api/admin/sessions/${s.sessionId}/abandon`).expect(204);
    expect((await getSession(db, s.sessionId))?.status).toBe("abandoned");
  });

  it("returns 404 for an unknown session", async () => {
    await request(makeApp(db)).post("/api/admin/sessions/nope/abandon").expect(404);
  });

  it("returns 409 when the session is not in_progress", async () => {
    const s = await createSession(db, assignment(4), OPTS);
    await setStatus(db, s.sessionId, "completed", new Date().toISOString());
    const res = await request(makeApp(db)).post(`/api/admin/sessions/${s.sessionId}/abandon`).expect(409);
    expect(res.body.error).toBeTruthy();
    expect((await getSession(db, s.sessionId))?.status).toBe("completed");
    await request(makeApp(db)).post(`/api/admin/sessions/${s.sessionId}/abandon`).expect(409);
  });
});

describe("DELETE /sessions/:id", () => {
  it("deletes the session (204) and then 404s", async () => {
    const s = await createSession(db, assignment(5), OPTS);
    const app = makeApp(db);
    await request(app).delete(`/api/admin/sessions/${s.sessionId}`).expect(204);
    expect(await getSession(db, s.sessionId)).toBeNull();
    await request(app).delete(`/api/admin/sessions/${s.sessionId}`).expect(404);
    const count = db.prepare("SELECT COUNT(*) AS n FROM blocks WHERE session_id = ?").get(s.sessionId) as { n: number };
    expect(count.n).toBe(0);
  });
});

describe("GET /export/:name", () => {
  const datePrefix = /^attachment; filename="\d{4}-\d{2}-\d{2}-xai-study-/;

  for (const name of ["trials.csv", "surveys.csv", "events.csv", "exit.csv", "participants.csv", "kpis.csv"]) {
    it(`serves ${name} as CSV with a BOM and attachment header`, async () => {
      await createSession(db, assignment(6), OPTS);
      const res = await request(makeApp(db))
        .get(`/api/admin/export/${name}`)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
      expect(res.headers["content-disposition"]).toMatch(datePrefix);
      expect(res.headers["content-disposition"]).toContain(`xai-study-${name}"`);
      const buf = res.body as Buffer;
      expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    });
  }

  it("serves sessions.json as JSON", async () => {
    const s = await createSession(db, assignment(7), OPTS);
    const res = await request(makeApp(db)).get("/api/admin/export/sessions.json").expect(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers["content-disposition"]).toMatch(datePrefix);
    expect(res.headers["content-disposition"]).toContain('xai-study-sessions.json"');
    expect(Array.isArray(res.body)).toBe(true);
    expect(JSON.stringify(res.body)).toContain(s.sessionId);
  });

  it("returns 404 for unknown export names", async () => {
    await request(makeApp(db)).get("/api/admin/export/secrets.txt").expect(404);
    await request(makeApp(db)).get("/api/admin/export/constructor").expect(404);
  });
});

describe("GET /export (index)", () => {
  it("returns name, description and row count for all 7 exports", async () => {
    await createSession(db, assignment(8), OPTS);
    const res = await request(makeApp(db)).get("/api/admin/export").expect(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.body.map((e: { name: string }) => e.name).sort()).toEqual(
      ["events.csv", "exit.csv", "kpis.csv", "participants.csv", "sessions.json", "surveys.csv", "trials.csv"],
    );
    for (const e of res.body) {
      expect(typeof e.description).toBe("string");
      expect(Number.isInteger(e.rows)).toBe(true);
    }
    const byName = Object.fromEntries(res.body.map((e: { name: string; rows: number }) => [e.name, e.rows]));
    expect(byName["participants.csv"]).toBe(1);
    expect(byName["sessions.json"]).toBe(1);
    expect(byName["trials.csv"]).toBe(0);
  });

  it("every indexed name is downloadable", async () => {
    const app = makeApp(db);
    const res = await request(app).get("/api/admin/export").expect(200);
    for (const e of res.body) await request(app).get(`/api/admin/export/${e.name}`).expect(200);
  });

  it("applies the token and loopback rules", async () => {
    await request(makeApp(db, "secret")).get("/api/admin/export").expect(401);
    await request(makeApp(db, "secret")).get("/api/admin/export/participants.csv").expect(401);
    await request(makeApp(db, "secret")).get("/api/admin/export").set("x-admin-token", "secret").expect(200);
    await request(makeApp(db, "secret")).get("/api/admin/export/kpis.csv?token=secret").expect(200);
    const remote = makeApp(db, undefined, { remoteAddress: "10.0.0.9" });
    for (const p of ["/api/admin/export", "/api/admin/export/participants.csv", "/api/admin/export/kpis.csv"]) {
      expect((await request(remote).get(p).expect(403)).body.error).toBe("forbidden");
    }
  });

  it("participants.csv download never contains the stored hash", async () => {
    const hash = "f".repeat(64);
    await createSession(db, assignment(9), { ...OPTS, participantHash: hash });
    const res = await request(makeApp(db)).get("/api/admin/export/participants.csv").expect(200);
    expect(res.text).toContain("isPilot");
    expect(res.text).not.toContain(hash);
  });
});

describe("exportFilename", () => {
  it("prefixes the ISO date", () => {
    expect(exportFilename("trials.csv", new Date("2026-10-17T12:00:00Z"))).toBe("2026-10-17-xai-study-trials.csv");
  });
});

// All fixtures below are synthetic and use the suite's fresh :memory: database.
const DOWNLOADS = ["participants.csv", "trials.csv", "surveys.csv", "events.csv", "exit.csv", "kpis.csv", "sessions.json"] as const;
const ADMIN_OPERATIONS = [
  ["get", "/sessions", 200],
  ["get", "/kpis", 200],
  ["get", "/assignments/1", 200],
  ["get", "/export", 200],
  ...DOWNLOADS.map((name) => ["get", `/export/${name}`, 200] as const),
  ["post", "/sessions/:id/abandon", 204],
  ["delete", "/sessions/:id", 204],
] as const;
const CHILD_TABLES = ["blocks", "trials", "events", "block_surveys", "exit_surveys"] as const;

function responseRows(id: string) {
  return Object.fromEntries(CHILD_TABLES.map((table) => [table,
    db.prepare(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY rowid`).all(id),
  ]));
}

async function seedResponses(pid: number, participantHash?: string) {
  const s = await createSession(db, assignment(pid), { ...OPTS, participantHash, protocolVersion: "calibrated-full-v1" });
  const now = "2026-10-19T12:00:00.000Z";
  await insertTrial(db, s.sessionId, {
    trialId: `${pid}-1-1`, blockIndex: 1, positionInBlock: 1, trialIndex: 1, postId: "s1-p1",
    condition: "A", set: "S1", topic: "env", aiLabel: "accurate", groundTruth: "TRUE",
    isAiCorrect: true, errorType: null, difficulty: null, agreed: true, detectedError: null,
    confidence: 5, labelShownAt: now, respondedAt: now, decisionTimeRawMs: 1000,
    hiddenMs: 0, hiddenCount: 0, blurCount: 0, decisionTimeMs: 1000, timingFlag: false,
    factSheetOpened: false, factSheetOpenMs: 0, explanationOpened: null, factorsExpanded: [],
    timeToFirstExpandMs: null, resumed: false,
  });
  await insertEvents(db, s.sessionId, [{
    seq: 1, type: "session_start", trialId: null, blockIndex: null, condition: null,
    postId: null, factorKey: null, tMs: null, perfNow: 0, wallClock: now,
  }]);
  await insertBlockSurvey(db, s.sessionId, {
    blockIndex: 1, condition: "A", questionnaireVersion: "full-v1",
    trustResponses: Array.from({ length: 12 }, (_, i) => ({ itemId: `jian-${i + 1}`, raw: 4, scored: 4 })),
    trustMean: 4, fairness1: 4, fairness2: 4, fairnessMean: 4, tension: 3,
    frustrationTlx: 25, frustrationTlxTouched: true, nWrongDetected: 0, anxiety: null, submittedAt: now,
  });
  await insertExitSurvey(db, s.sessionId, {
    ageRange: "18-24", gender: null, education: "bachelors", socialMediaUse: "daily",
    labelExposure: "sometimes", preferredCondition: "A", comment: "Synthetic route audit", submittedAt: now,
  });
  return s;
}

describe("admin route-wide authentication", () => {
  it.each(ADMIN_OPERATIONS)("requires a valid header for %s %s", async (method, path, success) => {
    const s = await seedResponses(1);
    const saved = responseRows(s.sessionId);
    const app = makeApp(db, "audit-admin-secret", { bank: BANK });
    const url = `/api/admin${path.replace(":id", s.sessionId)}`;
    for (const token of [undefined, "wrong"]) {
      const req = request(app)[method](url);
      if (token) req.set("x-admin-token", token);
      const res = await req.expect(401);
      expect(res.body.error).toBe("unauthorized");
    }
    await request(app)[method](`${url}?token=audit-admin-secret&token=wrong`).expect(401);
    expect((await getSession(db, s.sessionId))?.status).toBe("in_progress");
    expect(responseRows(s.sessionId)).toEqual(saved);
    await request(app)[method](url).set("x-admin-token", "audit-admin-secret").expect(success);
  });

  it.each(ADMIN_OPERATIONS)("denies tokenless non-loopback %s %s", async (method, path) => {
    const s = await seedResponses(1);
    const saved = responseRows(s.sessionId);
    const app = makeApp(db, undefined, { remoteAddress: "192.0.2.10", bank: BANK });
    const res = await request(app)[method](`/api/admin${path.replace(":id", s.sessionId)}`).expect(403);
    expect(res.body.error).toBe("forbidden");
    expect((await getSession(db, s.sessionId))?.status).toBe("in_progress");
    expect(responseRows(s.sessionId)).toEqual(saved);
  });

  it.each(DOWNLOADS)("accepts download-query authentication for %s without exporting secrets", async (name) => {
    const hash = "d".repeat(64);
    const salt = "synthetic-private-participant-salt";
    const token = "synthetic-private-admin-token";
    await seedResponses(1, hash);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('participant_salt', ?)").run(salt);
    const app = makeApp(db, token);
    const res = await request(app).get(`/api/admin/export/${name}`).query({ token }).expect(200);
    const text = res.text ?? JSON.stringify(res.body);
    expect(text.length).toBeGreaterThan(0);
    for (const secret of [hash, salt, token]) {
      expect(text).not.toContain(secret);
      expect(JSON.stringify(res.headers)).not.toContain(secret);
    }
    expect(text).not.toMatch(/participant_hash|participantHash|participant_salt|participantSalt|adminToken|authToken/);
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("admin validation and read safety", () => {
  it.each(["-1", "1.5", "1e2", "9007199254740992", "NaN", "1 OR 1=1"])("rejects invalid assignment pid %s", async (pid) => {
    const app = makeApp(db, "secret", { bank: BANK });
    const res = await request(app).get(`/api/admin/assignments/${encodeURIComponent(pid)}`).set("x-admin-token", "secret").expect(400);
    expect(res.body.error).toBe("validation");
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });

  it("accepts every supported cohort and rejects malformed scalar or repeated cohort input", async () => {
    const app = makeApp(db, "secret");
    for (const protocolVersion of ["all", "legacy-full-v1", "calibrated-brief-v1", "calibrated-full-v1", "calibrated-media-full-v1"]) {
      const res = await request(app).get("/api/admin/kpis").query({ protocolVersion }).set("x-admin-token", "secret").expect(200);
      expect(res.body.cohort).toBe(protocolVersion);
    }
    for (const query of ["protocolVersion=%5Bobject%20Object%5D", "protocolVersion=null", "protocolVersion=ALL", "protocolVersion=all&protocolVersion=all"]) {
      await request(app).get(`/api/admin/kpis?${query}`).set("x-admin-token", "secret").expect(400);
    }
  });

  it.each(["__proto__", "toString", ".env", "../.env", "trials.csv.bak", "participants.csv/extra"])("rejects unlisted export %s", async (name) => {
    await request(makeApp(db, "secret")).get(`/api/admin/export/${encodeURIComponent(name)}`).set("x-admin-token", "secret").expect(404);
  });

  it("disables caching for every admin read, including sessions and assignment previews", async () => {
    const s = await seedResponses(1, "e".repeat(64));
    const before = db.serialize();
    const app = makeApp(db, "secret", { bank: BANK });
    for (const [method, path] of ADMIN_OPERATIONS) {
      if (method !== "get") continue;
      const res = await request(app).get(`/api/admin${path}`).set("x-admin-token", "secret").expect(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(JSON.stringify(res.body)).not.toContain("e".repeat(64));
    }
    expect(db.serialize()).toEqual(before);
    expect((await getSession(db, s.sessionId))?.status).toBe("in_progress");
    const denied = await request(app).get("/api/admin/sessions").expect(401);
    expect(denied.headers["cache-control"]).toBe("no-store");
  });

  it.each(["not-a-uuid", "' OR 1=1 --", "missing-session"])("unknown session id %s cannot mutate other sessions", async (id) => {
    const s = await seedResponses(1);
    const before = db.serialize();
    const app = makeApp(db, "secret");
    const encoded = encodeURIComponent(id);
    for (const [method, suffix] of [["post", "/abandon"], ["delete", ""]] as const) {
      const res = await request(app)[method](`/api/admin/sessions/${encoded}${suffix}`).set("x-admin-token", "secret").expect(404);
      expect(res.body.error).toBe("not_found");
    }
    expect(db.serialize()).toEqual(before);
    expect((await getSession(db, s.sessionId))?.status).toBe("in_progress");
  });

  it("wrong HTTP methods cannot invoke admin mutations", async () => {
    const s = await seedResponses(1);
    const before = db.serialize();
    const app = makeApp(db, "secret");
    await request(app).get(`/api/admin/sessions/${s.sessionId}/abandon`).set("x-admin-token", "secret").expect(404);
    await request(app).get(`/api/admin/sessions/${s.sessionId}`).set("x-admin-token", "secret").expect(404);
    await request(app).post("/api/admin/sessions").set("x-admin-token", "secret").expect(404);
    expect(db.serialize()).toEqual(before);
  });
});

describe("admin mutation data retention", () => {
  it("abandon preserves every saved response, blocks retries, and keeps the participation hash", async () => {
    const hash = "a".repeat(64);
    const s = await seedResponses(1, hash);
    const other = await seedResponses(2);
    const saved = responseRows(s.sessionId);
    const otherRows = responseRows(other.sessionId);
    const app = makeApp(db, "secret");
    await request(app).post(`/api/admin/sessions/${s.sessionId}/abandon`).set("x-admin-token", "secret").expect(204);
    expect((await getSession(db, s.sessionId))?.status).toBe("abandoned");
    expect(responseRows(s.sessionId)).toEqual(saved);
    expect(db.prepare("SELECT participant_hash FROM sessions WHERE session_id = ?").get(s.sessionId)).toEqual({ participant_hash: hash });
    await request(app).post(`/api/admin/sessions/${s.sessionId}/abandon`).set("x-admin-token", "secret").expect(409);
    expect(responseRows(s.sessionId)).toEqual(saved);
    expect(responseRows(other.sessionId)).toEqual(otherRows);
    expect((await getSession(db, other.sessionId))?.status).toBe("in_progress");
  });

  it.each(["in_progress", "completed", "abandoned"] as const)("withdrawal deletes all child rows for %s only", async (status) => {
    const s = await seedResponses(1, "b".repeat(64));
    const other = await seedResponses(2);
    if (status !== "in_progress") await setStatus(db, s.sessionId, status, new Date().toISOString());
    const otherRows = responseRows(other.sessionId);
    for (const rows of Object.values(responseRows(s.sessionId))) expect(rows.length).toBeGreaterThan(0);
    const app = makeApp(db, "secret");
    await request(app).delete(`/api/admin/sessions/${s.sessionId}`).set("x-admin-token", "secret").expect(204);
    expect(await getSession(db, s.sessionId)).toBeNull();
    for (const rows of Object.values(responseRows(s.sessionId))) expect(rows).toEqual([]);
    expect(responseRows(other.sessionId)).toEqual(otherRows);
    expect((await getSession(db, other.sessionId))?.status).toBe("in_progress");
    await request(app).delete(`/api/admin/sessions/${s.sessionId}`).set("x-admin-token", "secret").expect(404);
  });
});
