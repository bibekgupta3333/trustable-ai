import request from "supertest";
import type Database from "better-sqlite3";
import type { Factor, Post, PostBank, PracticePost, SetId } from "../../shared/types";
import type { Cursor, SessionView, TrialSubmission, BlockSurveySubmission } from "../../shared/api";
import { openDb } from "../db/db";
import { asAsyncDatabase } from "../db/async";
import { createApp } from "../app";
import { assignmentPreview } from "./participant";
import { assignFromBank, assignShortFromBank } from "../../shared/counterbalance";
import { createSession, hashParticipantCode, setStatus } from "../db/repo";

// ---------- synthetic post bank (24 posts, 6 per set, 2 wrong labels per set) ----------
const SETS: SetId[] = ["S1", "S2", "S3", "S4"];

function factors(truthTrue: boolean): [Factor, Factor, Factor] {
  return [
    { key: "source", label: "Source", displayValue: "Unverified account", passes: true, detail: "Source detail." },
    { key: "claimVsRecord", label: "Claim vs record", displayValue: "12 vs 12", passes: truthTrue, detail: "Claim detail." },
    { key: "wording", label: "Wording", displayValue: "Neutral", passes: true, detail: "Wording detail." },
  ];
}

function makePost(n: number): Post {
  const set = SETS[Math.floor((n - 1) / 6)];
  const i = (n - 1) % 6; // 0,1 wrong; 2-5 correct
  const groundTruth = i % 2 === 0 ? "TRUE" : "FALSE";
  const isAiCorrect = i >= 2;
  const truthIsAccurate = groundTruth === "TRUE";
  const aiLabel = (isAiCorrect ? truthIsAccurate : !truthIsAccurate) ? "accurate" : "misleading";
  return {
    id: `p${String(n).padStart(2, "0")}`,
    set,
    topic: (["env", "svc", "evt"] as const)[n % 3],
    author: { handle: `@user${n}`, displayName: `User ${n}`, verified: false },
    text: `Synthetic post ${n}`,
    postedAgo: "2h",
    likes: n * 10,
    reposts: n,
    context: { image: { src: "/post-images/environment.png", alt: "Trees beside a park path", width: 1536, height: 1024 }, likes: 128, reposts: 16 },
    keyFact: { claimValue: "12", recordValue: groundTruth === "TRUE" ? "12" : "21" },
    factSheet: { title: `Fact ${n}`, body: "Body.", source: "Town records (fictional)" },
    groundTruth,
    aiLabel,
    isAiCorrect,
    errorType: isAiCorrect ? null : aiLabel === "misleading" ? "false_alarm" : "miss",
    difficulty: isAiCorrect ? null : i === 0 ? "clear" : "subtle",
    staticExplanation: "one two three four five six seven eight nine ten",
    factors: factors(groundTruth === "TRUE"),
    counterfactualExplanation: "one two three four five six seven eight nine ten eleven twelve",
  };
}

const practiceBase = makePost(1);
const practice: PracticePost = { ...practiceBase, id: "practice-01", set: null };
const bank: PostBank = { schemaVersion: 1, practice, posts: Array.from({ length: 24 }, (_, k) => makePost(k + 1)) };
const byId = new Map(bank.posts.map((p) => [p.id, p]));

// ---------- helpers ----------
let db: Database.Database;
let app: Awaited<ReturnType<typeof createApp>>;

beforeEach(async () => {
  db = openDb(":memory:");
  app = await createApp({ db, bank, appVersion: "test", participantSalt: "test-salt" });
});
afterEach(() => db.close());

let codeCounter = 0;
async function newSession(code = `person-${++codeCounter}@uni.edu`): Promise<SessionView> {
  const res = await request(app).post("/api/sessions").send({ participantCode: code });
  expect(res.status).toBe(201);
  return res.body as SessionView;
}
const start = (participantCode: unknown, extra: object = {}) =>
  request(app).post("/api/sessions").send({ participantCode, ...extra });

async function legacySession(code = "legacy-session", short = false): Promise<SessionView> {
  return createSession(db, short ? assignShortFromBank(77, bank) : assignFromBank(77, bank), {
    consequenceBanner: false, anxiety: false, postBankHash: "legacy-bank", appVersion: "legacy",
    participantHash: hashParticipantCode("test-salt", code),
  });
}

function trialBody(s: SessionView, block: number, pos: number, over: Partial<TrialSubmission> = {}): TrialSubmission {
  const plan = s.blocks[block - 1];
  const isC = plan.condition === "C";
  return {
    blockIndex: block as TrialSubmission["blockIndex"],
    positionInBlock: pos as TrialSubmission["positionInBlock"],
    postId: plan.postOrder[pos - 1],
    agreed: true,
    confidence: 5,
    labelShownAt: "2026-10-17T10:00:00.000Z",
    respondedAt: "2026-10-17T10:00:05.000Z",
    decisionTimeRawMs: 5000,
    hiddenMs: 0,
    hiddenCount: 0,
    blurCount: 0,
    factSheetOpened: false,
    factSheetOpenMs: 0,
    explanationOpened: isC ? false : null,
    factorsExpanded: [],
    timeToFirstExpandMs: null,
    resumed: false,
    ...over,
  };
}

const surveyBody = (block: number): BlockSurveySubmission => ({
  blockIndex: block as BlockSurveySubmission["blockIndex"],
  trustRaw: [1, 2, 3, 4, 5, 6, 7, 7, 7, 7, 7, 7],
  fairness1: 4,
  fairness2: 5,
  tension: 3,
  frustrationTlx: 35,
  frustrationTlxTouched: true,
});

const briefSurveyBody = (block: number): BlockSurveySubmission => ({
  blockIndex: block as BlockSurveySubmission["blockIndex"], questionnaireVersion: "brief-v1",
  briefTrust: 5, tension: 3, frustrationTlx: 35, frustrationTlxTouched: true,
});

async function completeBlock(s: SessionView, block: number, agreeFn: (postId: string) => boolean = () => true) {
  for (let pos = 1; pos <= s.blocks[block - 1].postOrder.length; pos++) {
    const body = trialBody(s, block, pos);
    body.agreed = agreeFn(body.postId);
    const r = await request(app).post(`/api/sessions/${s.sessionId}/trials`).send(body);
    expect(r.status).toBe(201);
  }
}

const trialRow = (sessionId: string, block: number, pos: number) =>
  db.prepare("SELECT * FROM trials WHERE session_id = ? AND block_index = ? AND position_in_block = ?")
    .get(sessionId, block, pos) as Record<string, unknown>;

// ---------- tests ----------
describe("basic routes", () => {
  it("accepts an already normalized database without deployment configuration", async () => {
    const normalizedApp = await createApp({ db: asAsyncDatabase(db), bank, appVersion: "normalized-test" });
    const created = await request(normalizedApp).post("/api/sessions").send({ participantCode: "normalized-local" }).expect(201);
    expect(created.body.protocolVersion).toBe("calibrated-full-v1");
    expect(created.body.blocks.map((b: { postOrder: string[] }) => b.postOrder.length)).toEqual([2, 2, 2, 2]);
    await request(normalizedApp).get(`/api/sessions/${created.body.sessionId}`).expect(200);
  });

  it("health returns hash and version", async () => {
    const r = await request(app).get("/api/health");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, appVersion: "test" });
    expect(r.body.postBankHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("assignment preview moved off the public API; helper previews any pid without creating anything", async () => {
    expect((await request(app).get("/api/assignments/3")).status).toBe(404);
    const a = assignmentPreview(bank, "3");
    expect(a.pid).toBe(3);
    expect(a.blocks).toHaveLength(4);
    expect(JSON.stringify(a)).not.toMatch(/groundTruth|isAiCorrect/);
    expect(assignmentPreview(bank, "901").pid).toBe(901);
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(0);
    expect(() => assignmentPreview(bank, "0")).toThrow();
    expect(() => assignmentPreview(bank, "abc")).toThrow();
  });

  it("practice has no correctness fields", async () => {
    const r = await request(app).get("/api/practice");
    expect(r.status).toBe(200);
    expect(r.body.id).toBe("practice-01");
    expect(r.body).not.toHaveProperty("groundTruth");
    expect(r.body).not.toHaveProperty("isAiCorrect");
    expect(r.body).not.toHaveProperty("keyFact");
  });

  it("unknown /api path is JSON 404", async () => {
    const r = await request(app).get("/api/nope");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("not_found");
  });

  it("malformed JSON is 400", async () => {
    const r = await request(app).post("/api/sessions").set("Content-Type", "application/json").send("{bad");
    expect(r.status).toBe(400);
  });
});

describe("sessions", () => {
  it("creates a session with a server-assigned pid and gets it", async () => {
    const s = await newSession();
    expect(s.pid).toBe(1);
    expect(s.cursor).toEqual({ blockIndex: 1, positionInBlock: 1, phase: "consent" });
    expect(s).not.toHaveProperty("participantHash");
    const g = await request(app).get(`/api/sessions/${s.sessionId}`);
    expect(g.status).toBe(200);
    expect(g.body.sessionId).toBe(s.sessionId);
    expect((await request(app).get("/api/sessions/missing")).status).toBe(404);
  });

  it("rejects invalid codes and the old {pid} body with 400", async () => {
    expect((await request(app).post("/api/sessions").send({ pid: 5 })).status).toBe(400);
    expect((await start("ab")).status).toBe(400);
    expect((await start("   ab   ")).status).toBe(400);
    expect((await start("x".repeat(121))).status).toBe(400);
    expect((await start(12345)).status).toBe(400);
    expect((await start("valid-code", { consequenceBanner: "yes" })).status).toBe(400);
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(0);
    expect((await start("x".repeat(120))).status).toBe(201);
    expect((await start("abc", { consequenceBanner: true })).body.consequenceBanner).toBe(true);
  });

  it("same code (normalised) resumes an in_progress session with 200", async () => {
    const s = await newSession("Student@UNI.edu");
    const r = await start("  student@uni.edu ");
    expect(r.status).toBe(200);
    expect(r.body.sessionId).toBe(s.sessionId);
    expect(r.body.pid).toBe(s.pid);
    expect(r.body.resumeCount).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(1);
  });

  it("409 already_participated for a completed or abandoned session", async () => {
    const done = await newSession("done@uni.edu");
    db.prepare("UPDATE sessions SET status = 'completed' WHERE session_id = ?").run(done.sessionId);
    const r = await start("DONE@uni.edu");
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "already_participated" });
    const gone = await newSession("gone@uni.edu");
    db.prepare("UPDATE sessions SET status = 'abandoned' WHERE session_id = ?").run(gone.sessionId);
    expect((await start("gone@uni.edu")).status).toBe(409);
  });

  it("stores only the HMAC of the code: deterministic, salted, raw code in no table", async () => {
    const code = "Raw.Secret-Code@Example.EDU";
    const s = await newSession(code);
    const { participant_hash: h } = db.prepare("SELECT participant_hash FROM sessions WHERE session_id = ?").get(s.sessionId) as { participant_hash: string };
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    const { createHmac } = await import("node:crypto");
    expect(h).toBe(createHmac("sha256", "test-salt").update(code.trim().toLowerCase()).digest("hex"));
    await request(app).post(`/api/sessions/${s.sessionId}/consent`);
    await request(app).post(`/api/sessions/${s.sessionId}/trials`).send(trialBody(s, 1, 1));
    const needles = [code, code.toLowerCase()];
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["meta", "sessions", "trials", "events"]));
    for (const t of tables) {
      const dump = JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all());
      for (const n of needles) expect(dump.includes(n), t).toBe(false);
    }
    // a different salt gives a different hash for the same code
    const db2 = openDb(":memory:");
    const app2 = await createApp({ db: db2, bank, appVersion: "test", participantSalt: "other-salt" });
    await request(app2).post("/api/sessions").send({ participantCode: code });
    const h2 = (db2.prepare("SELECT participant_hash FROM sessions").get() as { participant_hash: string }).participant_hash;
    expect(h2).not.toBe(h);
    db2.close();
  });

  it("generates a salt once into meta when PARTICIPANT_SALT is unset", async () => {
    const db2 = openDb(":memory:");
    const app2 = await createApp({ db: db2, bank, appVersion: "test" });
    const salt = (db2.prepare("SELECT value FROM meta WHERE key = 'participant_salt'").get() as { value: string }).value;
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    await createApp({ db: db2, bank, appVersion: "test" });
    expect((db2.prepare("SELECT value FROM meta WHERE key = 'participant_salt'").get() as { value: string }).value).toBe(salt);
    expect((await request(app2).post("/api/sessions").send({ participantCode: "abc" })).status).toBe(201);
    expect((await request(app2).post("/api/sessions").send({ participantCode: "ABC" })).status).toBe(200);
    db2.close();
  });

  it("allocates pids 1,2,3 and reuses an abandoned pid", async () => {
    const a = await newSession();
    const b = await newSession();
    const c = await newSession();
    expect([a.pid, b.pid, c.pid]).toEqual([1, 2, 3]);
    db.prepare("UPDATE sessions SET status = 'abandoned' WHERE session_id = ?").run(b.sessionId);
    db.prepare("UPDATE sessions SET status = 'completed' WHERE session_id = ?").run(a.sessionId);
    expect((await newSession()).pid).toBe(2);
    expect((await newSession()).pid).toBe(4);
  });

  it("marks stale in_progress sessions abandoned and frees their pid", async () => {
    const old = await newSession("old@uni.edu");
    const fresh = await newSession("fresh@uni.edu");
    const longAgo = new Date(Date.now() - 121 * 60_000).toISOString();
    const recent = new Date(Date.now() - 119 * 60_000).toISOString();
    db.prepare("UPDATE sessions SET last_activity_at = ? WHERE session_id = ?").run(longAgo, old.sessionId);
    db.prepare("UPDATE sessions SET last_activity_at = ? WHERE session_id = ?").run(recent, fresh.sessionId);
    const next = await newSession();
    expect(next.pid).toBe(old.pid);
    expect((await request(app).get(`/api/sessions/${old.sessionId}`)).body.status).toBe("abandoned");
    expect((await request(app).get(`/api/sessions/${fresh.sessionId}`)).body.status).toBe("in_progress");
    expect((await start("old@uni.edu")).status).toBe(409);
  });

  it("STALE_MINUTES is configurable", async () => {
    const db2 = openDb(":memory:");
    const app2 = await createApp({ db: db2, bank, appVersion: "test", participantSalt: "s", staleMinutes: 5 });
    const s = (await request(app2).post("/api/sessions").send({ participantCode: "aaa" })).body as SessionView;
    db2.prepare("UPDATE sessions SET last_activity_at = ?").run(new Date(Date.now() - 6 * 60_000).toISOString());
    expect((await request(app2).post("/api/sessions").send({ participantCode: "bbb" })).body.pid).toBe(s.pid);
    db2.close();
  });

  it("never auto-assigns pilot pids >= 900", async () => {
    const ins = db.prepare(`INSERT INTO sessions (session_id, pid, condition_order, set_rotation, seed, status,
      post_bank_hash, app_version, started_at) VALUES (?, ?, 'ABCD', 0, 1, 'completed', 'h', 'v', '2026-01-01T00:00:00.000Z')`);
    db.transaction(() => { for (let pid = 1; pid <= 898; pid++) ins.run(`s${pid}`, pid); })();
    expect((await newSession()).pid).toBe(899);
    const full = await start("one-too-many");
    expect(full.status).toBe(503);
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE pid >= 900").get() as { n: number }).n).toBe(0);
  });

  it("concurrent self-starts get distinct consecutive pids; duplicate codes resume", async () => {
    const codes = Array.from({ length: 20 }, (_, i) => `c-${i}@uni.edu`);
    const rs = await Promise.all([...codes, ...codes].map((c) => start(c)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(20);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(20);
    const pids = rs.filter((r) => r.status === 201).map((r) => r.body.pid as number).sort((x, y) => x - y);
    expect(pids).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("every participant write touches last_activity_at", async () => {
    const s = await newSession();
    const la = () => (db.prepare("SELECT last_activity_at AS t FROM sessions WHERE session_id = ?").get(s.sessionId) as { t: string }).t;
    expect(la()).toBe(s.startedAt);
    const ev = { seq: 1, trialId: null, blockIndex: null, condition: null, postId: null, type: "session_start",
      factorKey: null, tMs: null, perfNow: 1, wallClock: "2026-10-17T10:00:00.000Z" };
    const writes: Array<() => Promise<unknown>> = [
      () => request(app).post(`/api/sessions/${s.sessionId}/consent`),
      () => request(app).post(`/api/sessions/${s.sessionId}/resume`),
      () => request(app).put(`/api/sessions/${s.sessionId}/cursor`).send({ blockIndex: 1, positionInBlock: 1, phase: "trial" }),
      () => request(app).post(`/api/sessions/${s.sessionId}/trials`).send(trialBody(s, 1, 1)),
      () => request(app).post(`/api/sessions/${s.sessionId}/events`).send({ events: [ev] }),
    ];
    for (const w of writes) {
      db.prepare("UPDATE sessions SET last_activity_at = '2000-01-01T00:00:00.000Z' WHERE session_id = ?").run(s.sessionId);
      await w();
      expect(la() > "2026-01-01").toBe(true);
    }
  });

  it("resume increments resume count; consent moves to instructions", async () => {
    const s = await newSession();
    const r = await request(app).post(`/api/sessions/${s.sessionId}/resume`);
    expect(r.body.resumeCount).toBe(1);
    const c = await request(app).post(`/api/sessions/${s.sessionId}/consent`);
    expect(c.status).toBe(200);
    expect(c.body.consentAt).toBeTruthy();
    expect(c.body.cursor.phase).toBe("instructions");
  });

  it("presentation follows the plan, hides correctness, 404s out of range", async () => {
    const s = await newSession();
    const plan = s.blocks[0];
    const r = await request(app).get(`/api/sessions/${s.sessionId}/presentation/1/1`);
    expect(r.status).toBe(200);
    expect(r.body.postId).toBe(plan.postOrder[0]);
    expect(r.body.condition).toBe(plan.condition);
    expect(r.body).not.toHaveProperty("groundTruth");
    expect(r.body).not.toHaveProperty("isAiCorrect");
    expect((await request(app).get(`/api/sessions/${s.sessionId}/presentation/5/1`)).status).toBe(404);
    expect((await request(app).get(`/api/sessions/${s.sessionId}/presentation/1/7`)).status).toBe(404);
  });

  it("cursor PUT validates", async () => {
    const s = await newSession();
    const ok = await request(app).put(`/api/sessions/${s.sessionId}/cursor`).send({ blockIndex: 1, positionInBlock: 2, phase: "trial" });
    expect(ok.status).toBe(204);
    const bad = await request(app).put(`/api/sessions/${s.sessionId}/cursor`).send({ blockIndex: 9, positionInBlock: 2, phase: "trial" });
    expect(bad.status).toBe(400);
  });
});

describe("trials", () => {
  it("rolls back the trial and block timestamps if the cursor write fails, then allows retry", async () => {
    const s = await newSession("rollback-trial");
    db.exec(`CREATE TRIGGER fail_trial_cursor BEFORE UPDATE OF cursor_position ON sessions
      WHEN NEW.cursor_position = 2
      BEGIN SELECT RAISE(ABORT, 'injected cursor failure'); END`);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failed = await request(app).post(`/api/sessions/${s.sessionId}/trials`).send(trialBody(s, 1, 1)).expect(500);
      expect(failed.body).toEqual({ error: "internal" });
      expect(errorLog).toHaveBeenCalledWith("Unhandled API request error", {
        name: "SqliteError", code: "SQLITE_CONSTRAINT_TRIGGER", method: "POST", route: "/api/sessions/:id/trials",
      });
      expect(db.prepare("SELECT COUNT(*) AS n FROM trials WHERE session_id = ?").get(s.sessionId)).toEqual({ n: 0 });
      expect(db.prepare("SELECT started_at, ended_at FROM blocks WHERE session_id = ? AND block_index = 1")
        .get(s.sessionId)).toEqual({ started_at: null, ended_at: null });
      expect((await request(app).get(`/api/sessions/${s.sessionId}`).expect(200)).body.cursor).toEqual(s.cursor);
    } finally {
      errorLog.mockRestore();
      db.exec("DROP TRIGGER fail_trial_cursor");
    }
    await request(app).post(`/api/sessions/${s.sessionId}/trials`).send(trialBody(s, 1, 1)).expect(201);
  });

  it("serializes concurrent duplicate trial writes and saves one response", async () => {
    const s = await newSession("concurrent-trial");
    const responses = await Promise.all([1, 2].map(() =>
      request(app).post(`/api/sessions/${s.sessionId}/trials`).send(trialBody(s, 1, 1))));
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM trials WHERE session_id = ?").get(s.sessionId)).toEqual({ n: 1 });
    expect((await request(app).get(`/api/sessions/${s.sessionId}`).expect(200)).body.cursor)
      .toEqual({ blockIndex: 1, positionInBlock: 2, phase: "trial" });
  });

  it("derives fields server-side and advances the cursor", async () => {
    await newSession();
    const s = await newSession();
    expect(s.pid).toBe(2);
    const body = trialBody(s, 1, 1, { decisionTimeRawMs: 8000, hiddenMs: 3000, hiddenCount: 1, agreed: false });
    const r = await request(app).post(`/api/sessions/${s.sessionId}/trials`).send(body);
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ trialId: "2-1-1", cursor: { blockIndex: 1, positionInBlock: 2, phase: "trial" } as Cursor });
    const row = trialRow(s.sessionId, 1, 1);
    const post = byId.get(body.postId)!;
    expect(row.decision_time_ms).toBe(5000);
    expect(row.timing_flag).toBe(1);
    expect(row.trial_index).toBe(1);
    expect(row.condition).toBe(s.blocks[0].condition);
    expect(row.ground_truth).toBe(post.groundTruth);
    expect(row.detected_error).toBe(post.isAiCorrect ? null : 1);
    const blk = db.prepare("SELECT started_at FROM blocks WHERE session_id = ? AND block_index = 1").get(s.sessionId) as { started_at: string };
    expect(blk.started_at).toBe(body.labelShownAt);
  });

  it("timingFlag when decision time > 120 s; trialIndex for later blocks", async () => {
    const s = await legacySession();
    const r = await request(app).post(`/api/sessions/${s.sessionId}/trials`)
      .send(trialBody(s, 3, 4, { decisionTimeRawMs: 120_001 }));
    expect(r.status).toBe(201);
    const row = trialRow(s.sessionId, 3, 4);
    expect(row.timing_flag).toBe(1);
    expect(row.trial_index).toBe(16);
  });

  it("rejects postId mismatch, bad confidence, duplicates", async () => {
    const s = await newSession();
    const wrongPost = s.blocks[0].postOrder[1];
    expect((await request(app).post(`/api/sessions/${s.sessionId}/trials`).send(trialBody(s, 1, 1, { postId: wrongPost }))).status).toBe(400);
    expect((await request(app).post(`/api/sessions/${s.sessionId}/trials`).send({ ...trialBody(s, 1, 1), confidence: 8 })).status).toBe(400);
    expect((await request(app).post(`/api/sessions/${s.sessionId}/trials`).send({ ...trialBody(s, 1, 1), confidence: null })).status).toBe(400);
    expect((await request(app).post(`/api/sessions/${s.sessionId}/trials`).send(trialBody(s, 1, 1))).status).toBe(201);
    expect((await request(app).post(`/api/sessions/${s.sessionId}/trials`).send(trialBody(s, 1, 1))).status).toBe(409);
  });

  it("explanationOpened must be null unless condition C, boolean in C", async () => {
    const s = await newSession();
    const nonC = s.blocks.findIndex((b) => b.condition !== "C") + 1;
    const c = s.blocks.findIndex((b) => b.condition === "C") + 1;
    expect((await request(app).post(`/api/sessions/${s.sessionId}/trials`).send(trialBody(s, nonC, 1, { explanationOpened: true }))).status).toBe(400);
    expect((await request(app).post(`/api/sessions/${s.sessionId}/trials`).send(trialBody(s, nonC, 1, { factorsExpanded: ["source"] }))).status).toBe(400);
    expect((await request(app).post(`/api/sessions/${s.sessionId}/trials`).send(trialBody(s, c, 1, { explanationOpened: null }))).status).toBe(400);
    const ok = await request(app).post(`/api/sessions/${s.sessionId}/trials`)
      .send(trialBody(s, c, 1, { explanationOpened: true, factorsExpanded: ["claimVsRecord", "source"], timeToFirstExpandMs: 1200 }));
    expect(ok.status).toBe(201);
    expect(trialRow(s.sessionId, c, 1).factors_expanded).toBe("claimVsRecord|source");
  });

  it("position 6 moves cursor to block_survey and sets ended_at", async () => {
    const s = await legacySession();
    for (let pos = 1; pos <= 5; pos++) await request(app).post(`/api/sessions/${s.sessionId}/trials`).send(trialBody(s, 1, pos));
    const r = await request(app).post(`/api/sessions/${s.sessionId}/trials`).send(trialBody(s, 1, 6));
    expect(r.body.cursor).toEqual({ blockIndex: 1, positionInBlock: 6, phase: "block_survey" });
    const blk = db.prepare("SELECT ended_at FROM blocks WHERE session_id = ? AND block_index = 1").get(s.sessionId) as { ended_at: string };
    expect(blk.ended_at).toBe("2026-10-17T10:00:05.000Z");
  });
});

describe("events", () => {
  const ev = (seq: number) => ({
    seq, trialId: null, blockIndex: null, condition: null, postId: null, type: "session_start",
    factorKey: null, tMs: null, perfNow: 12.5, wallClock: "2026-10-17T10:00:00.000Z",
  });

  it("accepts JSON and text/plain, ignores duplicate seq", async () => {
    const s = await newSession();
    const a = await request(app).post(`/api/sessions/${s.sessionId}/events`).send({ events: [ev(1), ev(2)] });
    expect(a.status).toBe(200);
    expect(a.body.inserted).toBe(2);
    const b = await request(app).post(`/api/sessions/${s.sessionId}/events`)
      .set("Content-Type", "text/plain").send(JSON.stringify({ events: [ev(2), ev(3)] }));
    expect(b.status).toBe(200);
    expect(b.body.inserted).toBe(1);
    const bad = await request(app).post(`/api/sessions/${s.sessionId}/events`).send({ events: [{ ...ev(4), type: "bogus" }] });
    expect(bad.status).toBe(400);
  });
});

describe("block surveys and exit", () => {
  it("defaults to text-only original counts and preserves saved media presentations on resume", async () => {
    const current = await newSession("text-presentation");
    expect(current.protocolVersion).toBe("calibrated-full-v1");
    const media = await createSession(db, assignShortFromBank(77, bank), {
      consequenceBanner: false, anxiety: false, postBankHash: "media-hash", appVersion: "0.4.0", protocolVersion: "calibrated-media-full-v1",
      participantHash: hashParticipantCode("test-salt", "saved-media"),
    });
    const resumed = await start("saved-media").expect(200);
    expect(resumed.body.protocolVersion).toBe("calibrated-media-full-v1");
    expect(resumed.body.blocks).toEqual(media.blocks);
    for (const s of [current, media]) {
      const p = byId.get(s.blocks[0].postOrder[0])!;
      const r = await request(app).get(`/api/sessions/${s.sessionId}/presentation/1/1`).expect(200);
      expect(r.body).not.toHaveProperty("context");
      expect(r.body).not.toHaveProperty("groundTruth");
      if (s === media) expect(r.body).toMatchObject({ image: p.context!.image, likes: 128, reposts: 16 });
      else {
        expect(r.body).not.toHaveProperty("image");
        expect(r.body).toMatchObject({ likes: p.likes, reposts: p.reposts });
      }
    }
    const practice = await request(app).get("/api/practice?contextMedia=1").expect(200);
    expect(practice.body.image).toEqual(bank.practice.context!.image);
    expect(practice.body).not.toHaveProperty("context");
    expect((await request(app).get("/api/practice")).body).not.toHaveProperty("image");
  });


  it.each([
    { postsPerBlock: 2, protocol: "calibrated-media-full-v1" },
    { postsPerBlock: 2, protocol: "calibrated-full-v1" },
    { postsPerBlock: 2, protocol: "calibrated-brief-v1" },
    { postsPerBlock: 2, protocol: "legacy-full-v1" },
    { postsPerBlock: 6, protocol: "legacy-full-v1" },
  ])("completes and resumes $protocol with $postsPerBlock posts per block through HTTP", async ({ postsPerBlock, protocol }) => {
    const code = `protocol-${protocol}-${postsPerBlock}`;
    const s = protocol === "legacy-full-v1" ? await legacySession(code, postsPerBlock === 2)
      : protocol === "calibrated-brief-v1" ? await createSession(db, assignShortFromBank(77, bank), {
        consequenceBanner: false, anxiety: false, postBankHash: "brief-bank", appVersion: "brief",
        protocolVersion: "calibrated-brief-v1", participantHash: hashParticipantCode("test-salt", code),
      }) : protocol === "calibrated-media-full-v1" ? await createSession(db, assignShortFromBank(77, bank), {
        consequenceBanner: false, anxiety: false, postBankHash: "media-bank", appVersion: "0.4.0",
        protocolVersion: "calibrated-media-full-v1", participantHash: hashParticipantCode("test-salt", code),
      }) : await newSession(code);
    const body = protocol === "calibrated-brief-v1" ? briefSurveyBody : surveyBody;
    expect(s.protocolVersion).toBe(protocol);
    const plans = s.blocks;
    expect(plans.map((b) => b.postOrder.length)).toEqual(Array(4).fill(postsPerBlock));
    expect((await request(app).post(`/api/sessions/${s.sessionId}/consent`)).status).toBe(200);
    expect((await request(app).put(`/api/sessions/${s.sessionId}/cursor`)
      .send({ blockIndex: 1, positionInBlock: 1, phase: "trial" })).status).toBe(204);
    const exit = { ageRange: "25-34", gender: null, education: "bachelors", socialMediaUse: "daily",
      labelExposure: "sometimes", preferredCondition: "C", comment: "" };
    for (const plan of plans) {
      const block = plan.blockIndex;
      for (let pos = 1; pos <= postsPerBlock; pos++) {
        const presentation = await request(app).get(`/api/sessions/${s.sessionId}/presentation/${block}/${pos}`);
        expect(presentation.status).toBe(200);
        expect(presentation.body.postId).toBe(plan.postOrder[pos - 1]);
        expect(presentation.body).not.toHaveProperty("groundTruth");
        const r = await request(app).post(`/api/sessions/${s.sessionId}/trials`)
          .send(trialBody(s, block, pos, { agreed: byId.get(plan.postOrder[pos - 1])!.isAiCorrect }));
        expect(r.status).toBe(201);
        expect(trialRow(s.sessionId, block, pos).trial_index).toBe((block - 1) * postsPerBlock + pos);
        expect(r.body.cursor).toEqual({ blockIndex: block,
          positionInBlock: pos === postsPerBlock ? pos : pos + 1,
          phase: pos === postsPerBlock ? "block_survey" : "trial" });
        if (pos < postsPerBlock) {
          expect((await request(app).post(`/api/sessions/${s.sessionId}/block-surveys`).send(body(block))).status).toBe(400);
        }
        if (block === 1 && pos === 1) {
          const resumed = await start(code);
          expect(resumed.status).toBe(200);
          expect(resumed.body.sessionId).toBe(s.sessionId);
          expect(resumed.body.protocolVersion).toBe(protocol);
          expect(resumed.body.blocks).toEqual(plans);
          expect(resumed.body.cursor).toEqual(r.body.cursor);
        }
      }
      const survey = await request(app).post(`/api/sessions/${s.sessionId}/block-surveys`).send(body(block));
      expect(survey.status).toBe(201);
      expect(survey.body.nWrongDetected).toBe(postsPerBlock === 2 ? 1 : 2);
      expect(survey.body.cursor).toEqual(block < 4
        ? { blockIndex: block + 1, positionInBlock: 1, phase: "trial" }
        : { blockIndex: 4, positionInBlock: postsPerBlock, phase: "exit_survey" });
      if (block < 4) expect((await request(app).post(`/api/sessions/${s.sessionId}/exit-survey`).send(exit)).status).toBe(400);
    }
    const done = await request(app).post(`/api/sessions/${s.sessionId}/exit-survey`).send(exit);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("completed");
    expect(done.body.cursor).toEqual({ blockIndex: 4, positionInBlock: postsPerBlock, phase: "done" });
    expect(done.body.blocks).toEqual(plans);
    expect(done.body.protocolVersion).toBe(protocol);
    const rows = db.prepare("SELECT * FROM block_surveys WHERE session_id = ?").all(s.sessionId) as Record<string, unknown>[];
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.questionnaire_version).toBe(protocol === "calibrated-brief-v1" ? "brief-v1" : "full-v1");
      if (protocol === "calibrated-brief-v1") {
        expect(row).toMatchObject({ brief_trust: 5, trust_raw: "[]", trust_scored: "[]",
          trust_mean: null, fairness1: null, fairness2: null, fairness_mean: null });
      } else {
        expect(JSON.parse(row.trust_scored as string)).toEqual([7, 6, 5, 4, 3, 6, 7, 7, 7, 7, 7, 7]);
        expect(row.brief_trust).toBeNull();
      }
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM trials WHERE session_id = ?").get(s.sessionId) as { n: number }).n).toBe(postsPerBlock * 4);
    expect((await start(code)).status).toBe(409);
  });

  it("enforces the saved questionnaire protocol and validates brief ratings without saving rejected submissions", async () => {
    const current = await createSession(db, assignShortFromBank(78, bank), {
      consequenceBanner: false, anxiety: false, postBankHash: "brief-bank", appVersion: "brief",
      protocolVersion: "calibrated-brief-v1", participantHash: hashParticipantCode("test-salt", "brief-validation"),
    });
    const legacy = await legacySession("legacy-validation", true);
    for (const s of [current, legacy]) await completeBlock(s, 1);
    const submit = (s: SessionView, body: object) =>
      request(app).post(`/api/sessions/${s.sessionId}/block-surveys`).send(body);
    await submit(current, surveyBody(1)).expect(400);
    await submit(legacy, briefSurveyBody(1)).expect(400);
    for (const invalid of [
      { briefTrust: 0 }, { briefTrust: 8 }, { briefTrust: 3.5 }, { briefTrust: null },
      { tension: 0 }, { frustrationTlx: 33 }, { frustrationTlxTouched: false },
      { questionnaireVersion: "unknown" }, { questionnaireVersion: null }, { trustRaw: Array(12).fill(4) }, { fairness1: 3 },
    ]) await submit(current, { ...briefSurveyBody(1), ...invalid }).expect(400);
    expect(db.prepare("SELECT COUNT(*) AS n FROM block_surveys").get()).toEqual({ n: 0 });
    await submit(current, briefSurveyBody(1)).expect(201);
    await submit(legacy, surveyBody(1)).expect(201); // absent version remains full-v1
    await submit(current, briefSurveyBody(1)).expect(409);
    const resumed = await start("legacy-validation");
    expect(resumed.body.protocolVersion).toBe("legacy-full-v1");
    expect(resumed.body.blocks).toEqual(legacy.blocks);
  });

  it("rejects positions outside a short stored plan without saving a trial or cursor", async () => {
    const s = await newSession();
    expect((await request(app).get(`/api/sessions/${s.sessionId}/presentation/1/3`)).status).toBe(404);
    expect((await request(app).post(`/api/sessions/${s.sessionId}/trials`)
      .send(trialBody(s, 1, 3, { postId: bank.posts[0].id }))).status).toBe(400);
    expect((await request(app).put(`/api/sessions/${s.sessionId}/cursor`)
      .send({ blockIndex: 1, positionInBlock: 3, phase: "trial" })).status).toBe(400);
    expect((db.prepare("SELECT COUNT(*) AS n FROM trials").get() as { n: number }).n).toBe(0);
    expect((await request(app).get(`/api/sessions/${s.sessionId}`)).body.cursor).toEqual(s.cursor);
  });

  it("derives trial indices from preceding stored block lengths", async () => {
    const assignment = assignFromBank(78, bank);
    assignment.blocks[1].postOrder = assignment.blocks[1].postOrder.slice(0, 2);
    const s = await createSession(db, assignment, {
      consequenceBanner: false, anxiety: false, postBankHash: "test", appVersion: "test",
    });
    const r = await request(app).post(`/api/sessions/${s.sessionId}/trials`).send(trialBody(s, 3, 1));
    expect(r.status).toBe(201);
    expect(trialRow(s.sessionId, 3, 1).trial_index).toBe(9);
  });

  it("requires 6 trials, scores, counts detections, advances", async () => {
    const s = await legacySession();
    expect((await request(app).post(`/api/sessions/${s.sessionId}/block-surveys`).send(surveyBody(1))).status).toBe(400);
    // disagree with every wrong label -> both detected
    await completeBlock(s, 1, (id) => byId.get(id)!.isAiCorrect);
    const r = await request(app).post(`/api/sessions/${s.sessionId}/block-surveys`).send(surveyBody(1));
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ nWrongDetected: 2, cursor: { blockIndex: 2, positionInBlock: 1, phase: "trial" } });
    const row = db.prepare("SELECT * FROM block_surveys WHERE session_id = ?").get(s.sessionId) as Record<string, unknown>;
    expect(JSON.parse(row.trust_scored as string)).toEqual([7, 6, 5, 4, 3, 6, 7, 7, 7, 7, 7, 7]);
    expect(row.trust_mean).toBeCloseTo(73 / 12);
    expect(row.fairness_mean).toBe(4.5);
    expect(row.condition).toBe(s.blocks[0].condition);
    expect((await request(app).post(`/api/sessions/${s.sessionId}/block-surveys`).send(surveyBody(1))).status).toBe(409);
  });

  it("validates survey fields", async () => {
    const s = await legacySession("full-validation", true);
    await completeBlock(s, 1);
    const post = (b: object) => request(app).post(`/api/sessions/${s.sessionId}/block-surveys`).send({ ...surveyBody(1), ...b });
    expect((await post({ frustrationTlx: 33 })).status).toBe(400);
    expect((await post({ frustrationTlxTouched: false })).status).toBe(400);
    expect((await post({ trustRaw: [1, 2, 3] })).status).toBe(400);
    expect((await post({ tension: 0 })).status).toBe(400);
    const ok = await post({});
    expect(ok.body.nWrongDetected).toBe(0); // agreed with everything
  });

  it("exit survey requires 4 block surveys and completes the session", async () => {
    const s = await newSession();
    const exit = { ageRange: "25-34", gender: null, education: "bachelors", socialMediaUse: "daily", labelExposure: "sometimes", preferredCondition: "C", comment: "" };
    for (let b = 1; b <= 3; b++) {
      await completeBlock(s, b);
      await request(app).post(`/api/sessions/${s.sessionId}/block-surveys`).send(surveyBody(b));
    }
    expect((await request(app).post(`/api/sessions/${s.sessionId}/exit-survey`).send(exit)).status).toBe(400);
    await completeBlock(s, 4);
    const last = await request(app).post(`/api/sessions/${s.sessionId}/block-surveys`).send(surveyBody(4));
    expect(last.body.cursor).toEqual({ blockIndex: 4, positionInBlock: 2, phase: "exit_survey" });
    expect((await request(app).post(`/api/sessions/${s.sessionId}/exit-survey`).send({ ...exit, ageRange: "99" })).status).toBe(400);
    const done = await request(app).post(`/api/sessions/${s.sessionId}/exit-survey`).send(exit);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("completed");
    expect(done.body.completedAt).toBeTruthy();
    expect(done.body.cursor.phase).toBe("done");
    // completed session rejects further writes; the pid stays taken; the same code is refused
    expect((await request(app).post(`/api/sessions/${s.sessionId}/trials`).send(trialBody(s, 1, 1))).status).toBe(409);
    expect((await newSession()).pid).not.toBe(s.pid);
  });
});

describe("participant cancellation", () => {
  it("preserves saved trials, ends without admin permission and blocks repeat participation", async () => {
    const s = await newSession("cancel-person");
    await request(app).post(`/api/sessions/${s.sessionId}/trials`).send(trialBody(s, 1, 1)).expect(201);
    const ended = await request(app).post(`/api/sessions/${s.sessionId}/cancel`).expect(200);
    expect(ended.body).toMatchObject({ status: "abandoned", cursor: { phase: "done" } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM trials WHERE session_id=?").get(s.sessionId)).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM exit_surveys WHERE session_id=?").get(s.sessionId)).toEqual({ n: 0 });
    await request(app).post(`/api/sessions/${s.sessionId}/cancel`).expect(200);
    await request(app).post(`/api/sessions/${s.sessionId}/trials`).send(trialBody(s, 1, 2)).expect(409);
    await start("cancel-person").expect(409);
  });

  it("does not change completed sessions and returns 404 for an unknown session", async () => {
    const s = await newSession();
    await setStatus(db, s.sessionId, "completed", new Date().toISOString());
    await request(app).post(`/api/sessions/${s.sessionId}/cancel`).expect(409);
    expect(db.prepare("SELECT status FROM sessions WHERE session_id=?").get(s.sessionId)).toEqual({ status: "completed" });
    await request(app).post("/api/sessions/not-a-session/cancel").expect(404);
  });
});
