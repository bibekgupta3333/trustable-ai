import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { createApp } from "../app.js";
import { openDb } from "../db/db.js";
import { createSession, getSession, getTrials, hashParticipantCode } from "../db/repo.js";
import { assignFromBank, assignShortFromBank } from "../../shared/counterbalance.js";
import { loadPostBank } from "../../shared/labelEngine.js";
import { CURRENT_PROTOCOL } from "../../shared/types.js";
import type { StudyProtocol } from "../../shared/types.js";
import type {
  Cursor, EventSubmission, ExitSurveySubmission, FullBlockSurveySubmission, SessionView, TrialSubmission,
} from "../../shared/api.js";

// Canonical stimuli, a separate memory database per test, and no remote configuration.
const bank = loadPostBank(JSON.parse(readFileSync(new URL("../../shared/data/posts.json", import.meta.url), "utf8")));
const posts = new Map(bank.posts.map((post) => [post.id, post]));
const salt = "route-audit-test-salt";
let db: Database.Database;
let app: Awaited<ReturnType<typeof createApp>>;
beforeEach(async () => {
  db = openDb(":memory:");
  app = await createApp({ db, bank, participantSalt: salt, appVersion: "route-audit" });
});
afterEach(() => db.close());

async function start(code = "fictional-route-audit"): Promise<SessionView> {
  const response = await request(app).post("/api/sessions").send({ participantCode: code }).expect(201);
  return response.body as SessionView;
}

function trialBody(session: SessionView, block: Cursor["blockIndex"] = 1, position: Cursor["positionInBlock"] = 1): TrialSubmission {
  const plan = session.blocks[block - 1];
  const postId = plan.postOrder[position - 1];
  return {
    blockIndex: block, positionInBlock: position, postId, agreed: posts.get(postId)!.isAiCorrect,
    confidence: 6, labelShownAt: "2026-10-19T12:00:00.000Z", respondedAt: "2026-10-19T12:00:05.000Z",
    decisionTimeRawMs: 5000, hiddenMs: 1000, hiddenCount: 1, blurCount: 1,
    factSheetOpened: true, factSheetOpenMs: 1000,
    explanationOpened: plan.condition === "C" ? true : null,
    factorsExpanded: plan.condition === "C" ? ["claimVsRecord"] : [],
    timeToFirstExpandMs: plan.condition === "C" ? 500 : null, resumed: false,
  };
}

const fullSurvey = (blockIndex: Cursor["blockIndex"]): FullBlockSurveySubmission => ({
  questionnaireVersion: "full-v1", blockIndex, trustRaw: [1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 5],
  fairness1: 4, fairness2: 6, tension: 3, frustrationTlx: 50, frustrationTlxTouched: true,
});
const exit: ExitSurveySubmission = {
  ageRange: "prefer_not", gender: null, education: "prefer_not", socialMediaUse: "daily",
  labelExposure: "sometimes", preferredCondition: "C", comment: "Fictional automated test only.",
};
const event = (seq: number, type: EventSubmission["type"] = "session_start"): EventSubmission => ({
  seq, trialId: null, blockIndex: null, condition: null, postId: null, type,
  factorKey: null, tMs: null, perfNow: seq * 100, wallClock: "2026-10-19T12:00:00.000Z",
});
function expectPublic(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    expect(["groundTruth", "isAiCorrect", "errorType", "difficulty", "keyFact", "participantHash", "participant_hash", "participant_salt"])
      .not.toContain(key);
    expectPublic(nested);
  }
}
const sessionRow = (id: string) => db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(id) as Record<string, any>;
const count = (table: string, id: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(id) as { n: number }).n;

describe("public/session route audit: all 13 method/path patterns", () => {
  it("checks health, text-only practice, historical practice compatibility and unknown/unsupported routes", async () => {
    const health = await request(app).get("/api/health").expect(200);
    expect(health.body).toMatchObject({ ok: true, appVersion: "route-audit" });
    expect(health.body.postBankHash).toMatch(/^[0-9a-f]{64}$/);
    for (const path of ["/api/practice", "/api/practice?contextMedia=1"]) {
      const practice = await request(app).get(path).expect(200);
      expectPublic(practice.body);
      expect(practice.body.id).toBe(bank.practice.id);
      if (path === "/api/practice") {
        expect(practice.body).not.toHaveProperty("image");
        expect(practice.body.likes).toBe(bank.practice.likes);
      }
    }
    for (const path of ["/api/health", "/api/practice"]) {
      expect((await request(app).post(path).send({}).expect(404)).body.error).toBe("not_found");
    }
    await request(app).get("/api/missing-route").expect(404);
    await request(app).get("/api/assignments/1").expect(404); // Preview remains admin-only.
  });

  it("completes the current eight-trial/full-64-rating journey with persisted responses and server-derived truth", async () => {
    const code = "fictional-complete-route-audit";
    const session = await start(code);
    const id = session.sessionId;
    const base = `/api/sessions/${id}`;
    expect(session.protocolVersion).toBe(CURRENT_PROTOCOL);
    expect(session.blocks.map((block) => block.postOrder.length)).toEqual([2, 2, 2, 2]);
    expectPublic(session);
    const resumed = await request(app).post(`${base}/resume`).expect(200);
    expect(resumed.body.resumeCount).toBe(1);
    const consent = await request(app).post(`${base}/consent`).send({}).expect(200);
    expect(consent.body.cursor.phase).toBe("instructions");
    expect(sessionRow(id).consent_at).toBe(consent.body.consentAt);
    await request(app).get("/api/practice").expect(200);
    await request(app).post(`${base}/events`).send({ events: [event(1)] }).expect(200, { inserted: 1 });
    await request(app).post(`${base}/events`).set("Content-Type", "text/plain")
      .send(JSON.stringify({ events: [event(1), event(2, "practice_complete")] })).expect(200, { inserted: 1 });
    await request(app).put(`${base}/cursor`).send({ blockIndex: 1, positionInBlock: 1, phase: "trial" }).expect(204);
    expect((await request(app).get(base).expect(200)).body.nextEventSeq).toBe(3);

    const seen: string[] = [];
    for (const plan of session.blocks) {
      for (const position of [1, 2] as const) {
        const presentation = await request(app).get(`${base}/presentation/${plan.blockIndex}/${position}`).expect(200);
        expectPublic(presentation.body);
        const body = trialBody(session, plan.blockIndex, position);
        const post = posts.get(body.postId)!;
        seen.push(body.postId);
        expect(presentation.body).toMatchObject({ postId: body.postId, condition: plan.condition, likes: post.likes, reposts: post.reposts });
        expect(presentation.body).not.toHaveProperty("image");
        const explanation: string[] = { A: [], B: ["staticExplanation"], C: ["factors"], D: ["counterfactualExplanation"] }[plan.condition];
        for (const field of ["staticExplanation", "factors", "counterfactualExplanation"]) {
          expect(Object.hasOwn(presentation.body, field)).toBe(explanation.includes(field));
        }
        // Malicious/accidental truth fields are ignored; only the assigned bank determines truth.
        const saved = await request(app).post(`${base}/trials`).send({ ...body,
          groundTruth: "invented", isAiCorrect: !post.isAiCorrect, detectedError: false, trialIndex: 999,
        }).expect(201);
        const expectedCursor: Cursor = { blockIndex: plan.blockIndex, positionInBlock: 2,
          phase: position === 1 ? "trial" : "block_survey" };
        expect(saved.body.cursor).toEqual(expectedCursor);
        expect((await request(app).get(base).expect(200)).body.cursor).toEqual(expectedCursor);
        const row = db.prepare("SELECT * FROM trials WHERE session_id = ? AND block_index = ? AND position_in_block = ?")
          .get(id, plan.blockIndex, position) as Record<string, any>;
        expect(row).toMatchObject({ post_id: post.id, ground_truth: post.groundTruth, is_ai_correct: Number(post.isAiCorrect),
          detected_error: post.isAiCorrect ? null : 1, trial_index: seen.length, decision_time_ms: 4000, timing_flag: 1 });
        if (position === 1) {
          await request(app).post(`${base}/block-surveys`).send(fullSurvey(plan.blockIndex)).expect(400);
          await request(app).post(`${base}/trials`).send(body).expect(409);
        }
      }
      const ratings = fullSurvey(plan.blockIndex);
      expect(ratings.trustRaw.length + 4).toBe(16);
      const saved = await request(app).post(`${base}/block-surveys`).send(ratings).expect(201);
      expect(saved.body.nWrongDetected).toBe(1);
      expect(saved.body.cursor).toEqual(plan.blockIndex < 4
        ? { blockIndex: plan.blockIndex + 1, positionInBlock: 1, phase: "trial" }
        : { blockIndex: 4, positionInBlock: 2, phase: "exit_survey" });
      await request(app).post(`${base}/block-surveys`).send(ratings).expect(409);
      const row = db.prepare("SELECT * FROM block_surveys WHERE session_id = ? AND block_index = ?")
        .get(id, plan.blockIndex) as Record<string, any>;
      expect(JSON.parse(row.trust_raw)).toEqual(ratings.trustRaw);
      expect(JSON.parse(row.trust_scored)).toEqual([7, 6, 5, 4, 3, 6, 7, 1, 2, 3, 4, 5]);
      expect(row.trust_mean).toBeCloseTo(53 / 12);
      expect(row).toMatchObject({ questionnaire_version: "full-v1", brief_trust: null, fairness_mean: 5,
        tension: 3, frustration_tlx: 50, frustration_tlx_touched: 1 });
    }
    expect(new Set(seen).size).toBe(8);
    const completed = await request(app).post(`${base}/exit-survey`).send(exit).expect(200);
    expectPublic(completed.body);
    expect(completed.body).toMatchObject({ status: "completed", cursor: { blockIndex: 4, positionInBlock: 2, phase: "done" } });
    expect(completed.body.completedAt).toEqual(expect.any(String));
    expect([count("trials", id), count("block_surveys", id), count("exit_surveys", id)]).toEqual([8, 4, 1]);
    expect(count("block_surveys", id) * 16).toBe(64);
    expect(sessionRow(id).status).toBe("completed");
    await request(app).post("/api/sessions").send({ participantCode: code.toUpperCase() }).expect(409, { error: "already_participated" });
    for (const suffix of ["resume", "consent", "cancel", "trials", "block-surveys", "exit-survey"]) {
      await request(app).post(`${base}/${suffix}`).send({}).expect(409);
    }
    await request(app).put(`${base}/cursor`).send({ blockIndex: 1, positionInBlock: 1, phase: "trial" }).expect(409);
    // Late logger flushes intentionally remain accepted after completion.
    await request(app).post(`${base}/events`).send({ events: [event(3, "session_complete")] }).expect(200, { inserted: 1 });
    expect((await request(app).get(base).expect(200)).body.nextEventSeq).toBe(4);
  });

  it("cancels a separate unfinished session idempotently while preserving saved answers", async () => {
    const session = await start("fictional-cancel-audit");
    const base = `/api/sessions/${session.sessionId}`;
    await request(app).post(`${base}/consent`).expect(200);
    await request(app).post(`${base}/trials`).send(trialBody(session)).expect(201);
    await request(app).post(`${base}/events`).send({ events: [event(1)] }).expect(200);
    for (let retry = 0; retry < 2; retry++) {
      const cancelled = await request(app).post(`${base}/cancel`).send({}).expect(200);
      expect(cancelled.body).toMatchObject({ status: "abandoned", cursor: { phase: "done" } });
      expectPublic(cancelled.body);
    }
    expect(count("trials", session.sessionId)).toBe(1);
    expect(count("events", session.sessionId)).toBe(1);
    expect(count("block_surveys", session.sessionId)).toBe(0);
    expect(count("exit_surveys", session.sessionId)).toBe(0);
    await request(app).post(`${base}/resume`).expect(409);
    await request(app).post(`${base}/trials`).send(trialBody(session, 1, 2)).expect(409);
    await request(app).post("/api/sessions").send({ participantCode: "fictional-cancel-audit" }).expect(409);
  });

  it.each([
    ["get", ""], ["post", "/resume"], ["post", "/consent"], ["post", "/cancel"],
    ["get", "/presentation/1/1"], ["post", "/trials"], ["post", "/events"],
    ["put", "/cursor"], ["post", "/block-surveys"], ["post", "/exit-survey"],
  ] as const)("returns JSON 404 for missing session: %s %s", async (method, suffix) => {
    const response = await request(app)[method](`/api/sessions/missing-session${suffix}`).send({}).expect(404);
    expect(response.body.error).toBe("not_found");
    expect(response.headers["content-type"]).toContain("application/json");
  });

  it("rejects malformed starts, out-of-plan presentations, invalid bodies and premature surveys without saving rows", async () => {
    for (const body of [{}, { pid: 1 }, { participantCode: " x " }, { participantCode: "a".repeat(121) }, { participantCode: "valid", consequenceBanner: "yes" }]) {
      await request(app).post("/api/sessions").send(body).expect(400);
    }
    await request(app).post("/api/sessions").set("Content-Type", "application/json").send("{broken").expect(400);
    const session = await start();
    const base = `/api/sessions/${session.sessionId}`;
    for (const pair of ["0/1", "5/1", "1/0", "1/3", "abc/1", "1/1.5"]) {
      await request(app).get(`${base}/presentation/${pair}`).expect(404);
    }
    for (const body of [{ ...trialBody(session), confidence: 8 }, { ...trialBody(session), hiddenMs: 6000 },
      { ...trialBody(session), postId: session.blocks[0].postOrder[1] }, { ...trialBody(session), positionInBlock: 3 }]) {
      await request(app).post(`${base}/trials`).send(body).expect(400);
    }
    for (const body of [{ blockIndex: 5, positionInBlock: 1, phase: "trial" },
      { blockIndex: 1, positionInBlock: 3, phase: "trial" }, { blockIndex: 1, positionInBlock: 1, phase: "bogus" }]) {
      await request(app).put(`${base}/cursor`).send(body).expect(400);
    }
    await request(app).post(`${base}/events`).set("Content-Type", "text/plain").send("not JSON").expect(400);
    for (const body of [{}, { events: [{ ...event(1), type: "invented" }] }, { events: Array.from({ length: 5001 }, () => event(1)) }]) {
      await request(app).post(`${base}/events`).send(body).expect(400);
    }
    for (const body of [fullSurvey(1), { ...fullSurvey(1), trustRaw: [1] }, { ...fullSurvey(1), frustrationTlxTouched: false },
      { blockIndex: 1, questionnaireVersion: "brief-v1", briefTrust: 5, tension: 3, frustrationTlx: 50, frustrationTlxTouched: true }]) {
      await request(app).post(`${base}/block-surveys`).send(body).expect(400);
    }
    await request(app).post(`${base}/exit-survey`).send({ ...exit, ageRange: "invalid" }).expect(400);
    await request(app).post(`${base}/exit-survey`).send(exit).expect(400);
    for (const table of ["trials", "events", "block_surveys", "exit_surveys"]) expect(count(table, session.sessionId)).toBe(0);
    expect((await getSession(db, session.sessionId))!.cursor).toEqual(session.cursor);
  });

  it("documents the existing permissive phase/cursor behavior separately from the normal journey", async () => {
    const session = await start("fictional-permissive-api-audit");
    const base = `/api/sessions/${session.sessionId}`;
    // Existing contract/manual legacy callers permit assigned positions without a consent/cursor guard.
    // This records the limitation; it does not introduce strict sequencing or endorse bypassing the UI.
    await request(app).post(`${base}/trials`).send(trialBody(session, 4, 2)).expect(201);
    expect(sessionRow(session.sessionId).consent_at).toBeNull();
    expect((await getTrials(db, session.sessionId))).toHaveLength(1);
    await request(app).put(`${base}/cursor`).send({ blockIndex: 1, positionInBlock: 1, phase: "exit_survey" }).expect(204);
    expect((await request(app).get(base).expect(200)).body.cursor.phase).toBe("exit_survey");
    await request(app).post(`${base}/block-surveys`).send(fullSurvey(4)).expect(400);
    await request(app).post(`${base}/exit-survey`).send(exit).expect(400);
    expect(sessionRow(session.sessionId).status).toBe("in_progress");
  });

  it.each([
    ["legacy-full-v1", 6], ["calibrated-brief-v1", 2], ["calibrated-media-full-v1", 2],
  ] as const)("retains saved %s plans and survey version on resume", async (protocol: StudyProtocol, length) => {
    const code = `fictional-saved-${protocol}`;
    const assignment = length === 6 ? assignFromBank(77, bank) : assignShortFromBank(77, bank);
    const saved = await createSession(db, assignment, { consequenceBanner: false, anxiety: false,
      postBankHash: "historical-test", appVersion: "historical-test", protocolVersion: protocol,
      participantHash: hashParticipantCode(salt, code) });
    const resumed = await request(app).post("/api/sessions").send({ participantCode: code }).expect(200);
    expect(resumed.body).toMatchObject({ sessionId: saved.sessionId, protocolVersion: protocol });
    expect(resumed.body.blocks).toEqual(saved.blocks);
    expect(resumed.body.blocks.map((block: any) => block.postOrder.length)).toEqual([length, length, length, length]);
    expectPublic(resumed.body);
    const body = protocol === "calibrated-brief-v1" ? { blockIndex: 1, questionnaireVersion: "brief-v1", briefTrust: 5,
      tension: 3, frustrationTlx: 50, frustrationTlxTouched: true } : fullSurvey(1);
    for (let position = 1; position <= length; position++) {
      await request(app).post(`/api/sessions/${saved.sessionId}/trials`)
        .send(trialBody(saved, 1, position as Cursor["positionInBlock"])).expect(201);
      if (position < length) await request(app).post(`/api/sessions/${saved.sessionId}/block-surveys`).send(body).expect(400);
    }
    await request(app).post(`/api/sessions/${saved.sessionId}/block-surveys`).send(body).expect(201);
    const row = db.prepare("SELECT * FROM block_surveys WHERE session_id = ?").get(saved.sessionId) as Record<string, any>;
    expect(row.questionnaire_version).toBe(protocol === "calibrated-brief-v1" ? "brief-v1" : "full-v1");
    if (protocol === "calibrated-brief-v1") {
      expect(row).toMatchObject({ brief_trust: 5, trust_mean: null, fairness1: null, fairness2: null });
      expect(JSON.parse(row.trust_raw)).toEqual([]);
    }
    expect(sessionRow(saved.sessionId).protocol_version).toBe(protocol);
  });
});
