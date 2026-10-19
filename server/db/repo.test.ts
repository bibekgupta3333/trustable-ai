import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Connection as SDKConnection, DatabaseError } from "@tursodatabase/serverless";
import request from "supertest";
import { createApp } from "../app";
import { loadPostBank } from "../../shared/labelEngine";
import { asAsyncDatabase, openTursoDatabase, type StudyDatabase } from "./async";
import type Database from "better-sqlite3";
import { openDb } from "./db";
import {
  ConflictError, createSession, getSession, findInProgressByPid, updateCursor, recordConsent, incrementResume,
  insertTrial, getTrials, insertEvents, insertBlockSurvey, insertExitSurvey, setStatus, deleteSession,
  listSessions, allTrialRows, allSurveyRows, allEventRows, allExitRows, allSessionsFull,
  hashParticipantCode, participantSalt, startOrResumeSession, abandonStaleSessions, nextFreePid, touchActivity,
} from "./repo";
import BetterSqlite from "better-sqlite3";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Assignment, EventSubmission } from "../../shared/api";
import type { BlockSurvey, ExitSurvey, Trial } from "../../shared/types";

const assignment: Assignment = {
  pid: 7,
  conditionOrder: ["C", "D", "B", "A"],
  setRotation: 1,
  seed: 7,
  blocks: [
    { blockIndex: 1, condition: "C", set: "S2", postOrder: ["p07", "p08", "p09", "p10", "p11", "p12"] },
    { blockIndex: 2, condition: "D", set: "S3", postOrder: ["p13", "p14", "p15", "p16", "p17", "p18"] },
    { blockIndex: 3, condition: "B", set: "S4", postOrder: ["p19", "p20", "p21", "p22", "p23", "p24"] },
    { blockIndex: 4, condition: "A", set: "S1", postOrder: ["p01", "p02", "p03", "p04", "p05", "p06"] },
  ],
};
const opts = { consequenceBanner: false, anxiety: true, postBankHash: "abc123", appVersion: "0.1.0" };

function trial(pos: 1 | 2 | 3 | 4 | 5 | 6 = 1): Trial {
  return {
    trialId: `7-1-${pos}`, blockIndex: 1, positionInBlock: pos, trialIndex: pos, postId: "p07",
    condition: "C", set: "S2", topic: "env", aiLabel: "accurate", groundTruth: "FALSE", isAiCorrect: false,
    errorType: "miss", difficulty: "subtle", agreed: false, detectedError: true, confidence: 5,
    labelShownAt: "2026-01-01T00:00:00.000Z", respondedAt: "2026-01-01T00:00:05.000Z",
    decisionTimeMs: 4000, decisionTimeRawMs: 5000, hiddenMs: 1000, hiddenCount: 1, blurCount: 0,
    timingFlag: true, factSheetOpened: true, factSheetOpenMs: 1200, explanationOpened: true,
    factorsExpanded: ["claimVsRecord", "source"], timeToFirstExpandMs: 900, resumed: false,
  };
}

const ev = (seq: number): EventSubmission => ({
  seq, trialId: "7-1-1", blockIndex: 1, condition: "C", postId: "p07", type: "factor_expand",
  factorKey: "source", tMs: 10 * seq, perfNow: 1000 + seq, wallClock: "2026-01-01T00:00:01.000Z",
});

const survey: BlockSurvey = {
  blockIndex: 1, condition: "C",
  trustResponses: Array.from({ length: 12 }, (_, i) => ({
    itemId: `jian-${String(i + 1).padStart(2, "0")}`, raw: 2 as const, scored: (i < 5 ? 6 : 2) as 6 | 2,
  })),
  trustMean: 3.67, fairness1: 4, fairness2: 5, fairnessMean: 4.5, tension: 3,
  frustrationTlx: 35, frustrationTlxTouched: true, nWrongDetected: 1, anxiety: null,
  submittedAt: "2026-01-01T00:10:00.000Z",
};

const exitSurvey: ExitSurvey = {
  ageRange: "25-34", gender: null, education: "bachelors", socialMediaUse: "daily", labelExposure: "sometimes",
  preferredCondition: "C", comment: "fine, \"ok\"", submittedAt: "2026-01-01T00:30:00.000Z",
};

describe("repo", () => {
  let db: Database.Database;
  beforeEach(() => { db = openDb(":memory:"); });

  it("creates and reads a session round trip", async () => {
    const s = (await createSession(db, assignment, opts));
    expect(s.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s).toMatchObject({
      pid: 7, status: "in_progress", protocolVersion: "legacy-full-v1", conditionOrder: ["C", "D", "B", "A"], setRotation: 1,
      consequenceBanner: false, anxiety: true, resumeCount: 0, consentAt: null, completedAt: null,
      cursor: { blockIndex: 1, positionInBlock: 1, phase: "consent" },
    });
    expect(s.blocks).toEqual(assignment.blocks);
    expect((await getSession(db, s.sessionId))).toEqual(s);
    expect((await getSession(db, "nope"))).toBeNull();
  });

  it("finds the in-progress session by pid", async () => {
    const s = (await createSession(db, assignment, opts));
    expect((await findInProgressByPid(db, 7))?.sessionId).toBe(s.sessionId);
    expect((await findInProgressByPid(db, 8))).toBeNull();
    (await setStatus(db, s.sessionId, "abandoned"));
    expect((await findInProgressByPid(db, 7))).toBeNull();
  });

  it("updates cursor, consent, resume count and status", async () => {
    const { sessionId } = (await createSession(db, assignment, opts));
    (await updateCursor(db, sessionId, { blockIndex: 3, positionInBlock: 4, phase: "trial" }));
    (await recordConsent(db, sessionId, "2026-01-01T00:00:00.000Z"));
    (await incrementResume(db, sessionId));
    (await incrementResume(db, sessionId));
    (await setStatus(db, sessionId, "completed", "2026-01-02T00:00:00.000Z"));
    const s = (await getSession(db, sessionId))!;
    expect(s.cursor).toEqual({ blockIndex: 3, positionInBlock: 4, phase: "trial" });
    expect(s.consentAt).toBe("2026-01-01T00:00:00.000Z");
    expect(s.resumeCount).toBe(2);
    expect(s.status).toBe("completed");
    expect(s.completedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("inserts a trial and rejects a duplicate with ConflictError", async () => {
    const { sessionId } = (await createSession(db, assignment, opts));
    (await insertTrial(db, sessionId, trial(1)));
    expect((await getTrials(db, sessionId))).toEqual([trial(1)]);
    (await expect(insertTrial(db, sessionId, trial(1))).rejects.toThrow(ConflictError));
    const noC: Trial = { ...trial(2), explanationOpened: null, factorsExpanded: [], detectedError: null, timeToFirstExpandMs: null };
    (await insertTrial(db, sessionId, noC));
    expect((await getTrials(db, sessionId))[1]).toEqual(noC);
  });

  it("inserts events with INSERT OR IGNORE by seq", async () => {
    const { sessionId } = (await createSession(db, assignment, opts));
    expect((await insertEvents(db, sessionId, [ev(1), ev(2)]))).toBe(2);
    expect((await insertEvents(db, sessionId, [ev(2), ev(3)]))).toBe(1);
    expect((await insertEvents(db, sessionId, []))).toBe(0);
    const rows = (await allEventRows(db));
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows[0]).toMatchObject({ pid: 7, sessionId, type: "factor_expand", factorKey: "source", tMs: 10 });
  });

  it("inserts a block survey, rejects a duplicate, and expands trust columns", async () => {
    const { sessionId } = (await createSession(db, assignment, opts));
    (await insertBlockSurvey(db, sessionId, survey));
    (await expect(insertBlockSurvey(db, sessionId, survey)).rejects.toThrow(ConflictError));
    const [row] = (await allSurveyRows(db));
    expect(row).toMatchObject({
      pid: 7, sessionId, blockIndex: 1, condition: "C", trust_01: 2, trust_12: 2, trust_01_s: 6, trust_06_s: 2,
      trustMean: 3.67, fairnessMean: 4.5, frustrationTlx: 35, frustrationTlxTouched: true, nWrongDetected: 1,
    });
  });

  it("round trips brief scores and protocol metadata without inventing full questionnaire values", async () => {
    const s = (await createSession(db, assignment, { ...opts, protocolVersion: "calibrated-brief-v1" }));
    const brief: BlockSurvey = { ...survey, questionnaireVersion: "brief-v1", briefTrust: 6,
      trustResponses: [], trustMean: null, fairness1: null, fairness2: null, fairnessMean: null };
    (await insertBlockSurvey(db, s.sessionId, brief));
    expect((await listSessions(db))[0].protocolVersion).toBe("calibrated-brief-v1");
    expect((await allSurveyRows(db))[0]).toMatchObject({ questionnaireVersion: "brief-v1", briefTrust: 6,
      trust_01: null, trust_12: null, trust_01_s: null, trust_12_s: null,
      trustMean: null, fairness1: null, fairness2: null, fairnessMean: null });
    const full = (await allSessionsFull(db))[0] as any;
    expect(full.protocolVersion).toBe("calibrated-brief-v1");
    expect(full.blocks[0].survey).toEqual(brief);
  });

  it("inserts an exit survey once", async () => {
    const { sessionId } = (await createSession(db, assignment, opts));
    (await insertExitSurvey(db, sessionId, exitSurvey));
    (await expect(insertExitSurvey(db, sessionId, exitSurvey)).rejects.toThrow(ConflictError));
    expect((await allExitRows(db))).toEqual([{ ...exitSurvey, pid: 7, sessionId, conditionOrder: "CDBA", setRotation: 1, status: "in_progress", protocolVersion: "legacy-full-v1" }]);
  });

  it("export rows join session columns and full sessions nest everything", async () => {
    const { sessionId } = (await createSession(db, assignment, opts));
    (await insertTrial(db, sessionId, trial(1)));
    (await insertEvents(db, sessionId, [ev(1)]));
    (await insertBlockSurvey(db, sessionId, survey));
    (await insertExitSurvey(db, sessionId, exitSurvey));
    const [t] = (await allTrialRows(db));
    expect(t).toMatchObject({ pid: 7, sessionId, set: "S2", conditionOrder: "CDBA", setRotation: 1, status: "in_progress",
      isAiCorrect: false, factorsExpanded: ["claimVsRecord", "source"] });
    const [full] = (await allSessionsFull(db)) as any[];
    expect(full.blocks).toHaveLength(4);
    expect(full.blocks[0].trials).toEqual([trial(1)]);
    expect(full.blocks[0].survey.trustResponses[0]).toEqual({ itemId: "jian-01", raw: 2, scored: 6 });
    expect(full.blocks[1].survey).toBeNull();
    expect(full.events).toHaveLength(1);
    expect(full.exitSurvey).toEqual(exitSurvey);
  });

  it("deleteSession cascades to every child table", async () => {
    const { sessionId } = (await createSession(db, assignment, opts));
    (await insertTrial(db, sessionId, trial(1)));
    (await insertEvents(db, sessionId, [ev(1)]));
    (await insertBlockSurvey(db, sessionId, survey));
    (await insertExitSurvey(db, sessionId, exitSurvey));
    (await deleteSession(db, sessionId));
    expect((await getSession(db, sessionId))).toBeNull();
    for (const table of ["blocks", "trials", "events", "block_surveys", "exit_surveys"]) {
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(n, table).toBe(0);
    }
  });

  it("listSessions reports trial and survey counts", async () => {
    const a = (await createSession(db, assignment, opts));
    const b = (await createSession(db, { ...assignment, pid: 8 }, opts));
    (await insertTrial(db, a.sessionId, trial(1)));
    (await insertTrial(db, a.sessionId, trial(2)));
    (await insertBlockSurvey(db, a.sessionId, survey));
    const rows = (await listSessions(db));
    expect(rows).toHaveLength(2);
    const ra = rows.find((r) => r.sessionId === a.sessionId)!;
    const rb = rows.find((r) => r.sessionId === b.sessionId)!;
    expect(ra).toMatchObject({ pid: 7, conditionOrder: "CDBA", setRotation: 1, trialsSaved: 2, surveysSaved: 1, completedAt: null });
    expect(rb).toMatchObject({ pid: 8, trialsSaved: 0, surveysSaved: 0, status: "in_progress" });
    expect(ra.lastActivityAt).toBe(a.startedAt);
    (await touchActivity(db, a.sessionId, "2026-02-02T00:00:00.000Z"));
    expect((await listSessions(db)).find((r) => r.sessionId === a.sessionId)!.lastActivityAt).toBe("2026-02-02T00:00:00.000Z");
  });
});

describe("participation codes and pid allocation", () => {
  let db: Database.Database;
  beforeEach(() => { db = openDb(":memory:"); });
  const assign = (pid: number): Assignment => ({ ...assignment, pid });
  const startArgs = (code: string, now?: Date) => ({
    participantHash: hashParticipantCode("salt", code), staleMinutes: 120, assign, now,
    opts: { consequenceBanner: false, anxiety: false, postBankHash: "h", appVersion: "v" },
  });

  it("hash is deterministic hex HMAC-SHA256 and depends on salt and code", async () => {
    const h = hashParticipantCode("salt", "abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashParticipantCode("salt", "abc")).toBe(h);
    expect(hashParticipantCode("salt2", "abc")).not.toBe(h);
    expect(hashParticipantCode("salt", "abd")).not.toBe(h);
  });

  it("participantSalt prefers env, else generates once into meta", async () => {
    expect((await participantSalt(db, "from-env"))).toBe("from-env");
    const s1 = (await participantSalt(db));
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
    expect((await participantSalt(db))).toBe(s1);
  });

  it("new, resumed, already_participated", async () => {
    const r1 = (await startOrResumeSession(db, startArgs("a")));
    expect(r1.kind).toBe("new");
    const r2 = (await startOrResumeSession(db, startArgs("a")));
    expect(r2.kind).toBe("resumed");
    if (r1.kind !== "new" || r2.kind !== "resumed") throw new Error("unreachable");
    expect(r2.session.sessionId).toBe(r1.session.sessionId);
    expect(r2.session.resumeCount).toBe(1);
    (await setStatus(db, r1.session.sessionId, "completed"));
    expect((await startOrResumeSession(db, startArgs("a"))).kind).toBe("already_participated");
  });

  it("allocates lowest free pid, reuses abandoned, sweeps stale, skips >= 900", async () => {
    const pid = async (code: string, now?: Date) => {
      const r = (await startOrResumeSession(db, startArgs(code, now)));
      if (r.kind !== "new") throw new Error(r.kind);
      return r.session;
    };
    const [a, b, c] = [(await pid("a")), (await pid("b")), (await pid("c"))];
    expect([a.pid, b.pid, c.pid]).toEqual([1, 2, 3]);
    (await setStatus(db, a.sessionId, "abandoned"));
    const d = (await pid("d"));
    expect(d.pid).toBe(1);
    // 3 hours from now b is stale (idle > 120 min); c and d were active a minute before
    const later = new Date(Date.now() + 3 * 3600_000);
    for (const x of [c, d]) (await touchActivity(db, x.sessionId, new Date(later.getTime() - 60_000).toISOString()));
    const e = (await pid("e", later));
    expect(e.pid).toBe(2);
    expect((await getSession(db, b.sessionId))!.status).toBe("abandoned");
    expect((await getSession(db, c.sessionId))!.status).toBe("in_progress");
    (await touchActivity(db, e.sessionId, later.toISOString()));
    expect((await abandonStaleSessions(db, 120, later))).toBe(0);
    expect((await abandonStaleSessions(db, 120, new Date(later.getTime() + 3 * 3600_000)))).toBe(3); // c, d, e
    (await createSession(db, assign(900), opts));
    (await createSession(db, assign(905), opts));
    expect((await nextFreePid(db))).toBe(1);
  });

  it("is safe across two connections to the same file (BEGIN IMMEDIATE)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xai-repo-"));
    try {
      const path = join(dir, "study.db");
      const c1 = openDb(path);
      const c2 = openDb(path);
      const pids: number[] = [];
      for (let i = 0; i < 30; i++) {
        const r = (await startOrResumeSession(i % 2 ? c1 : c2, startArgs(`code-${i}`)));
        if (r.kind !== "new") throw new Error(r.kind);
        pids.push(r.session.pid);
        if (i % 7 === 3) (await setStatus(i % 2 ? c2 : c1, r.session.sessionId, "abandoned"));
      }
      const live = (c1.prepare("SELECT pid FROM sessions WHERE status = 'in_progress' ORDER BY pid").all() as { pid: number }[]).map((r) => r.pid);
      expect(new Set(live).size).toBe(live.length);
      expect(Math.max(...pids)).toBeLessThanOrEqual(30);
      c1.close();
      c2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("migration from the v1 schema", () => {
  it("adds participant_hash, last_activity_at and the unique index to an old DB, keeping rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xai-mig-"));
    try {
      const path = join(dir, "old.db");
      const old = new BetterSqlite(path);
      old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta VALUES ('schema_version', '1');
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY, pid INTEGER NOT NULL CHECK (pid >= 1), condition_order TEXT NOT NULL,
          set_rotation INTEGER NOT NULL CHECK (set_rotation BETWEEN 0 AND 3), seed INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','abandoned')),
          consequence_banner INTEGER NOT NULL DEFAULT 0, anxiety INTEGER NOT NULL DEFAULT 0,
          cursor_block INTEGER NOT NULL DEFAULT 1, cursor_position INTEGER NOT NULL DEFAULT 1,
          cursor_phase TEXT NOT NULL DEFAULT 'consent', resume_count INTEGER NOT NULL DEFAULT 0,
          post_bank_hash TEXT NOT NULL, app_version TEXT NOT NULL, started_at TEXT NOT NULL,
          consent_at TEXT, completed_at TEXT);
        CREATE INDEX idx_sessions_pid ON sessions(pid);
        INSERT INTO sessions (session_id, pid, condition_order, set_rotation, seed, post_bank_hash, app_version, started_at)
          VALUES ('old-1', 1, 'ABCD', 0, 1, 'h', 'v', '2026-01-01T00:00:00.000Z');`);
      old.close();

      const db = openDb(path);
      const cols = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
      expect(cols).toEqual(expect.arrayContaining(["participant_hash", "last_activity_at"]));
      const idx = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_sessions_participant_hash'").get() as { sql: string };
      expect(idx.sql).toMatch(/UNIQUE[\s\S]*WHERE participant_hash IS NOT NULL/);
      expect((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("5");
      const row = db.prepare("SELECT participant_hash, last_activity_at FROM sessions WHERE session_id = 'old-1'").get();
      expect(row).toEqual({ participant_hash: null, last_activity_at: "2026-01-01T00:00:00.000Z" });
      expect((await listSessions(db))[0]).toMatchObject({ sessionId: "old-1", lastActivityAt: "2026-01-01T00:00:00.000Z" });
      // the old pid-1 session went stale long ago: a self-start abandons it and reuses pid 1
      const r = (await startOrResumeSession(db, {
        participantHash: hashParticipantCode("s", "abc"), staleMinutes: 120, assign: (pid) => ({ ...assignment, pid }),
        opts: { consequenceBanner: false, anxiety: false, postBankHash: "h", appVersion: "v" },
      }));
      expect(r.kind === "new" && r.session.pid).toBe(1);
      // unique index enforced
      expect(() => db.prepare("UPDATE sessions SET participant_hash = ? WHERE session_id = 'old-1'")
        .run(hashParticipantCode("s", "abc"))).toThrow(/UNIQUE/);
      db.close();
      // idempotent: reopening is a no-op
      const again = openDb(path);
      expect((again.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(2);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe("schema 5 migration retention", () => {
  it.each([2, 3, 4])("preserves schema %i full/brief scores, plans, responses and identities across migration and reopen", async (version) => {
    const dir = mkdtempSync(join(tmpdir(), "xai-v3-retention-"));
    const path = join(dir, "old-v2.db");
    try {
      // Construct an actual schema-2 file, rather than using openDb before the migration.
      const currentSchema = readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");
      const schema = version >= 3 ? currentSchema.replace(",'calibrated-media-full-v1'", "").replace(version === 3 ? ",'calibrated-full-v1'" : "__absent__", "") : currentSchema
        .replace(/^  protocol_version.*\n/m, "")
        .replace(/^  questionnaire_version.*\n/m, "")
        .replace(/^  brief_trust.*\n/m, "")
        .replace("trust_mean               REAL,", "trust_mean               REAL NOT NULL,")
        .replace("fairness1                INTEGER,", "fairness1                INTEGER NOT NULL,")
        .replace("fairness2                INTEGER,", "fairness2                INTEGER NOT NULL,")
        .replace("fairness_mean            REAL,", "fairness_mean            REAL NOT NULL,");
      const old = new BetterSqlite(path);
      old.exec(schema);
      old.prepare("INSERT INTO meta VALUES ('schema_version', ?), ('participant_salt', 'keep-salt')").run(String(version));
      old.prepare(`INSERT INTO sessions (session_id, pid, condition_order, set_rotation, seed,
        post_bank_hash, app_version, started_at, participant_hash, last_activity_at, cursor_phase)
        VALUES ('saved', 7, 'CDBA', 1, 7, 'hash', 'old', ?, 'keep-hash', ?, 'block_survey')`)
        .run(survey.submittedAt, survey.submittedAt);
      for (const block of assignment.blocks) {
        old.prepare("INSERT INTO blocks (session_id, block_index, condition, set_id, post_order) VALUES ('saved', ?, ?, ?, ?)")
          .run(block.blockIndex, block.condition, block.set, JSON.stringify(block.postOrder));
      }
      (await insertTrial(old, "saved", trial()));
      (await insertEvents(old, "saved", [ev(4), ev(5)]));
      const raw = JSON.stringify(survey.trustResponses.map((r) => r.raw));
      const scored = JSON.stringify(survey.trustResponses.map((r) => r.scored));
      old.prepare(`INSERT INTO block_surveys (session_id, block_index, condition, trust_raw, trust_scored,
        trust_mean, fairness1, fairness2, fairness_mean, tension, frustration_tlx, frustration_tlx_touched,
        n_wrong_detected, anxiety, submitted_at) VALUES ('saved', 1, 'C', ?, ?, ?, 4, 5, 4.5, 3, 35, 1, 1, NULL, ?)`)
        .run(raw, scored, survey.trustMean, survey.submittedAt);
      if (version >= 3) {
        const briefSession = (await createSession(old, { ...assignment, pid: 8 }, { ...opts, protocolVersion: "calibrated-brief-v1" }));
        (await insertBlockSurvey(old, briefSession.sessionId, { ...survey, questionnaireVersion: "brief-v1", briefTrust: 6,
          trustResponses: [], trustMean: null, fairness1: null, fairness2: null, fairnessMean: null }));
      }
      if (version === 4) {
        const fullSession = (await createSession(old, { ...assignment, pid: 11 }, { ...opts, protocolVersion: "calibrated-full-v1" }));
        (await insertBlockSurvey(old, fullSession.sessionId, survey));
      }
      const saved = Object.fromEntries(["sessions", "blocks", "trials", "events", "block_surveys"].map((table) =>
        [table, old.prepare(`SELECT * FROM ${table}`).all()]));
      old.close();

      for (let pass = 0; pass < 2; pass++) {
        const migrated = openDb(path);
        for (const [table, rows] of Object.entries(saved)) {
          const actual = migrated.prepare(`SELECT * FROM ${table}`).all();
          expect(actual).toHaveLength(rows.length);
          rows.forEach((row, i) => expect(actual[i]).toMatchObject(row as object));
        }
        expect((await getSession(migrated, "saved"))).toMatchObject({
          protocolVersion: "legacy-full-v1", nextEventSeq: 6, blocks: assignment.blocks,
          cursor: { phase: "block_survey" },
        });
        const full = ((await allSessionsFull(migrated)) as any[]).find((s) => s.sessionId === "saved");
        expect(full.blocks[0].survey).toEqual({ ...survey, questionnaireVersion: "full-v1", briefTrust: null });
        expect(migrated.prepare("SELECT value FROM meta WHERE key='participant_salt'").get()).toEqual({ value: "keep-salt" });
        expect(migrated.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: "5" });
        expect(migrated.pragma("foreign_key_check")).toEqual([]);
        if (pass === 1) {
          expect(migrated.pragma("foreign_keys", { simple: true })).toBe(1);
          const restored = (await createSession(migrated, { ...assignment, pid: 9 }, { ...opts, protocolVersion: "calibrated-media-full-v1" }));
          (await insertBlockSurvey(migrated, restored.sessionId, survey));
          expect((await getSession(migrated, restored.sessionId))?.protocolVersion).toBe("calibrated-media-full-v1");
          const current = (await createSession(migrated, { ...assignment, pid: 10 }, { ...opts, protocolVersion: "calibrated-brief-v1" }));
          const brief: BlockSurvey = { ...survey, questionnaireVersion: "brief-v1", briefTrust: 7,
            trustResponses: [], trustMean: null, fairness1: null, fairness2: null, fairnessMean: null };
          (await insertBlockSurvey(migrated, current.sessionId, brief));
          expect(() => migrated.prepare("UPDATE block_surveys SET brief_trust=8 WHERE session_id=?").run(current.sessionId)).toThrow(/CHECK/);
          expect(() => migrated.prepare("UPDATE block_surveys SET brief_trust=0 WHERE session_id=?").run(current.sessionId)).toThrow(/CHECK/);
        }
        migrated.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("async local database adapter", () => {
  let raw: Database.Database;
  let db: StudyDatabase;
  beforeEach(() => {
    raw = openDb(":memory:");
    db = asAsyncDatabase(raw);
  });
  afterEach(async () => { await db.close(); });

  it("normalizes a handle once, preserves async handles, and supports statements and pragma", async () => {
    expect(asAsyncDatabase(raw)).toBe(db);
    expect(asAsyncDatabase(db)).toBe(db);
    await db.exec("CREATE TABLE adapter_test (n INTEGER); INSERT INTO adapter_test VALUES (1), (2);");
    expect(await db.prepare("SELECT n FROM adapter_test ORDER BY n").all()).toEqual([{ n: 1 }, { n: 2 }]);
    expect(await db.prepare("SELECT n FROM adapter_test WHERE n = ?").get(99)).toBeUndefined();
    expect(await db.prepare("UPDATE adapter_test SET n = n + 2").run()).toEqual({ changes: 2 });
    expect(await db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("queues outside queries and transactions until rollback, without leaking uncommitted data", async () => {
    await db.exec("CREATE TABLE adapter_test (n INTEGER)");
    const entered = deferred();
    const release = deferred();
    const first = db.transaction(async () => {
      await db.prepare("INSERT INTO adapter_test VALUES (?)").run(1);
      entered.resolve();
      await release.promise;
      throw new Error("abort first");
    }).immediate();
    const rejected = expect(first).rejects.toThrow("abort first");
    await entered.promise;
    let readFinished = false;
    const read = db.prepare("SELECT * FROM adapter_test").all().then((rows) => { readFinished = true; return rows; });
    const second = db.transaction(async (n: number) => {
      await db.prepare("INSERT INTO adapter_test VALUES (?)").run(n);
      return n;
    })(2);
    await Promise.resolve();
    expect(readFinished).toBe(false);
    release.resolve();
    await rejected;
    expect(await read).toEqual([]);
    expect(await second).toBe(2);
    expect(await db.prepare("SELECT * FROM adapter_test").all()).toEqual([{ n: 2 }]);
  });

  it("rolls back a failed nested savepoint while retaining the outer transaction", async () => {
    await db.exec("CREATE TABLE adapter_test (n INTEGER)");
    await db.transaction(async () => {
      await db.prepare("INSERT INTO adapter_test VALUES (1)").run();
      await expect(db.transaction(async () => {
        await db.prepare("INSERT INTO adapter_test VALUES (2)").run();
        throw new Error("nested failure");
      }).immediate()).rejects.toThrow("nested failure");
      await db.transaction(async () => {
        await db.prepare("INSERT INTO adapter_test VALUES (3)").run();
      })();
      await expect(db.close()).rejects.toThrow("inside a transaction");
    }).immediate();
    expect(await db.prepare("SELECT n FROM adapter_test ORDER BY n").all()).toEqual([{ n: 1 }, { n: 3 }]);
  });

  it("serializes sibling savepoints so one rollback cannot remove another sibling's write", async () => {
    await db.exec("CREATE TABLE adapter_test (n INTEGER)");
    await db.transaction(async () => {
      const result = await Promise.allSettled([
        db.transaction(async () => {
          await db.prepare("INSERT INTO adapter_test VALUES (1)").run();
          await Promise.resolve();
          throw new Error("first sibling fails");
        })(),
        db.transaction(async () => { await db.prepare("INSERT INTO adapter_test VALUES (2)").run(); })(),
      ]);
      expect(result.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
    })();
    expect(await db.prepare("SELECT * FROM adapter_test").all()).toEqual([{ n: 2 }]);
  });

  it("rolls back all writes when the outer callback fails after a successful nested transaction", async () => {
    await db.exec("CREATE TABLE adapter_test (n INTEGER)");
    await expect(db.transaction(async () => {
      await db.transaction(async () => { await db.prepare("INSERT INTO adapter_test VALUES (1)").run(); })();
      throw new Error("outer failure");
    })()).rejects.toThrow("outer failure");
    expect(await db.prepare("SELECT * FROM adapter_test").all()).toEqual([]);
  });

  it("concurrent starts on a raw handle allocate unique pids and resume one code exactly once", async () => {
    const args = (code: string) => ({
      participantHash: hashParticipantCode("test-salt", code), staleMinutes: 120,
      assign: (pid: number) => ({ ...assignment, pid }), opts,
    });
    const same = await Promise.all(Array.from({ length: 8 }, () => startOrResumeSession(raw, args("same"))));
    expect(same.filter((r) => r.kind === "new")).toHaveLength(1);
    expect(same.filter((r) => r.kind === "resumed")).toHaveLength(7);
    const different = await Promise.all(Array.from({ length: 12 }, (_, i) => startOrResumeSession(raw, args(`different-${i}`))));
    const pids = different.map((r) => r.kind === "new" ? r.session.pid : null);
    expect(pids).not.toContain(null);
    expect(new Set(pids).size).toBe(12);
    expect((await listSessions(raw))).toHaveLength(13);
  });

  it("rolls back session creation if any assigned block violates its constraints", async () => {
    const invalid = { ...assignment, blocks: [assignment.blocks[0], assignment.blocks[0]] } as unknown as Assignment;
    await expect(createSession(raw, invalid, opts)).rejects.toBeInstanceOf(ConflictError);
    expect(await listSessions(raw)).toEqual([]);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM blocks").get()).toEqual({ n: 0 });
  });
});


/** Exercise the installed SDK's HTTP/stream handling, not a replacement SDK. */
function mockTursoHttp() {
  const directory = mkdtempSync(join(tmpdir(), "xai-turso-"));
  const path = join(directory, "remote.db");
  const streams = new Map<string, { id: number; sqlite: Database.Database }>();
  const created: { id: number; initialForeignKeys: number }[] = [];
  const log: { stream: number; sql: string }[] = [];
  let serial = 0;
  let token = 0;
  const value = (v: any): any => v === null ? { type: "null" }
    : typeof v === "bigint" ? { type: "integer", value: String(v) }
    : typeof v === "number" ? { type: "float", value: v }
    : { type: "text", value: v };
  const decode = (v: any): any => v.type === "null" ? null
    : v.type === "integer" ? BigInt(v.value) : v.value;
  const error = (e: any) => ({ message: e.message, code: e.code });
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    let stream = streams.get(body.baton);
    if (body.baton && !stream) return new Response("Expired stream", { status: 404 });
    if (stream) streams.delete(body.baton); // A baton is consumed once, just as on the server.
    else {
      const sqlite = new BetterSqlite(path);
      sqlite.pragma("foreign_keys = OFF"); // Every fresh stream starts independently.
      stream = { id: ++serial, sqlite };
      created.push({ id: stream.id, initialForeignKeys: sqlite.pragma("foreign_keys", { simple: true }) as number });
    }
    const baton = `stream-${stream.id}-${++token}`;
    streams.set(baton, stream);
    const sqlite = stream.sqlite;
    if (body.requests) {
      let closing = false;
      const results = body.requests.map((request: any) => {
        try {
          if (request.type === "sequence") {
            log.push({ stream: stream!.id, sql: request.sql });
            sqlite.exec(request.sql);
          } else if (request.type === "close") {
            closing = true;
          } else if (request.type === "get_autocommit") {
            return { type: "ok", response: { type: "get_autocommit", is_autocommit: !sqlite.inTransaction } };
          } else throw new Error(`Unexpected request ${request.type}`);
          return { type: "ok", response: { type: request.type } };
        } catch (e) { return { type: "error", error: error(e) }; }
      });
      if (closing) { streams.delete(baton); sqlite.close(); }
      return Response.json({ baton: closing ? null : baton, base_url: null, results });
    }
    const entries: any[] = [{ baton, base_url: null }];
    for (const [step, item] of body.batch.steps.entries()) {
      if (item.condition?.type === "is_autocommit" && sqlite.inTransaction) continue;
      const sql = item.stmt.sql;
      if (!item.condition) log.push({ stream: stream.id, sql });
      try {
        const statement = sqlite.prepare(sql).safeIntegers(true);
        const params = (item.stmt.args ?? []).map(decode);
        const cols = statement.reader ? statement.columns().map((c) => ({ name: c.name, decltype: c.type ?? "" })) : [];
        entries.push({ type: "step_begin", step, cols });
        let changes = 0;
        if (statement.reader) {
          const rows = statement.raw().all(...params) as any[][];
          if (item.stmt.want_rows) for (const row of rows) entries.push({ type: "row", row: row.map(value) });
        } else changes = statement.run(...params).changes;
        entries.push({ type: "step_end", step, affected_row_count: changes });
      } catch (e) { entries.push({ type: "step_error", step, error: error(e) }); }
    }
    return new Response(entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  });
  vi.stubGlobal("fetch", fetch);
  return {
    fetch, log, created, streams,
    expireStreams: () => {
      for (const { sqlite } of streams.values()) sqlite.close();
      streams.clear();
    },
    cleanup: () => {
      for (const { sqlite } of streams.values()) sqlite.close();
      streams.clear();
      vi.unstubAllGlobals();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("Turso adapter with the real serverless SDK and SQLite-backed HTTP streams", () => {
  const url = "turso://study.example.invalid";
  let http: ReturnType<typeof mockTursoHttp>;
  let db: StudyDatabase;
  beforeEach(() => { http = mockTursoHttp(); db = openTursoDatabase(url, "test-token"); });
  afterEach(async () => { try { await db.close(); } finally { http.cleanup(); } });

  it("accepts consent and admin reads after idle streams expire between top-level requests", async () => {
    await db.exec(readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8"));
    const session = await createSession(db, assignment, opts);
    http.expireStreams(); // Simulate the participant spending time reading consent.
    const consentAt = "2026-10-19T21:00:00.000Z";
    const saved = await db.transaction(async () => {
      await recordConsent(db, session.sessionId, consentAt);
      await updateCursor(db, session.sessionId, { blockIndex: 1, positionInBlock: 1, phase: "instructions" });
      await touchActivity(db, session.sessionId, consentAt);
      return getSession(db, session.sessionId);
    }).immediate();
    expect(saved).toMatchObject({ consentAt, cursor: { phase: "instructions" } });
    http.expireStreams(); // Simulate another pause before the admin's next poll.
    expect(await listSessions(db)).toEqual([expect.objectContaining({ sessionId: session.sessionId, lastActivityAt: consentAt })]);
    expect(http.streams.size).toBe(0);
  });

  it("serves session creation, consent after idle expiry, concurrent admin requests and resumed state through actual routes", async () => {
    await db.exec(readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8"));
    const bank = loadPostBank(JSON.parse(readFileSync(fileURLToPath(new URL("../../shared/data/posts.json", import.meta.url)), "utf8")));
    const app = await createApp({ db, bank, appVersion: "lifecycle-test", participantSalt: "test-salt", adminToken: "test-admin" });
    const participantCode = "fictional-lifecycle-test-only";
    const started = await request(app).post("/api/sessions").send({ participantCode }).expect(201);
    const id = started.body.sessionId as string;
    expect(started.body).toMatchObject({ protocolVersion: "calibrated-full-v1", cursor: { phase: "consent" } });
    expect(started.body.blocks.flatMap((block: any) => block.postOrder)).toHaveLength(8);
    http.expireStreams();
    const consent = await request(app).post(`/api/sessions/${id}/consent`).send({}).expect(200);
    expect(consent.body).toMatchObject({ sessionId: id, cursor: { phase: "instructions" } });
    expect(consent.body.consentAt).toEqual(expect.any(String));
    http.expireStreams();
    const [sessions, kpis, index, csv] = await Promise.all([
      request(app).get("/api/admin/sessions").set("x-admin-token", "test-admin").expect(200),
      request(app).get("/api/admin/kpis").set("x-admin-token", "test-admin").expect(200),
      request(app).get("/api/admin/export").set("x-admin-token", "test-admin").expect(200),
      request(app).get("/api/admin/export/participants.csv").set("x-admin-token", "test-admin").expect(200),
    ]);
    expect(sessions.body).toEqual([expect.objectContaining({ sessionId: id, status: "in_progress", plannedTrials: 8 })]);
    expect(kpis.body).toEqual(expect.any(Object));
    expect(index.body).toBeTruthy();
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text).toContain(id);
    http.expireStreams();
    const resumed = await request(app).post("/api/sessions").send({ participantCode }).expect(200);
    expect(resumed.body).toMatchObject({ sessionId: id, consentAt: consent.body.consentAt, resumeCount: 1, cursor: { phase: "instructions" } });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
    expect(http.streams.size).toBe(0);
  });

  it("is lazy, uses HTTPS/authentication, and initializes foreign keys before BEGIN on the same stream", async () => {
    expect(http.fetch).not.toHaveBeenCalled();
    await db.transaction(async () => {
      expect(await db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(await db.prepare("SELECT ? AS n").get(12)).toEqual({ n: 12 });
    }).immediate();
    expect(http.created).toEqual([{ id: 1, initialForeignKeys: 0 }]);
    expect(http.log.slice(0, 2).map((l) => l.sql)).toEqual([
      "PRAGMA foreign_keys = ON", "BEGIN IMMEDIATE",
    ]);
    expect(new Set(http.log.map((l) => l.stream)).size).toBe(1);
    for (const [endpoint, options] of http.fetch.mock.calls) {
      expect(String(endpoint)).toMatch(/^https:\/\/study\.example\.invalid\/v3\//);
      expect((options!.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    }
  });

  it("executes canonical multi-statement SQL, triggers and quoted semicolons without splitting", async () => {
    const schema = readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");
    await db.exec(schema);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    await db.exec(`CREATE TABLE source (n INTEGER); CREATE TABLE audit (text TEXT);
      CREATE TRIGGER track AFTER INSERT ON source BEGIN
        INSERT INTO audit VALUES ('first;message');
        INSERT INTO audit VALUES ('second;message');
      END; INSERT INTO source VALUES (1);`);
    expect(await db.prepare("SELECT * FROM audit").all()).toEqual([{ text: "first;message" }, { text: "second;message" }]);
    expect(http.log.some((l) => l.sql === schema)).toBe(true);
  });

  it("normalizes numbers, absent rows, binds and affected-row counts", async () => {
    await db.exec("CREATE TABLE example (n INTEGER, text TEXT); INSERT INTO example VALUES (1, 'literal?');");
    expect(await db.prepare("SELECT n, text, '?' AS literal FROM example WHERE n = ?").get(1)).toEqual({ n: 1, text: "literal?", literal: "?" });
    expect(await db.prepare("SELECT * FROM example WHERE n = ?").get(9)).toBeUndefined();
    expect(await db.prepare("UPDATE example SET n = ? WHERE n = ?").run(2, 1)).toEqual({ changes: 1 });
    expect(await db.prepare("UPDATE example SET n = ? WHERE n = ?").run(3, 9)).toEqual({ changes: 0 });
    expect(await db.prepare("SELECT 1.5 AS real, NULL AS empty").get()).toEqual({ real: 1.5, empty: null });
    await expect(db.prepare("SELECT 9007199254740993 AS n").get()).rejects.toThrow("safe range");
  });

  it("pins nested savepoints and preserves outer writes after a caught inner rollback", async () => {
    await db.exec("CREATE TABLE example (n INTEGER)");
    await db.transaction(async () => {
      await db.prepare("INSERT INTO example VALUES (?)").run(1);
      await expect(db.transaction(async () => {
        await db.prepare("INSERT INTO example VALUES (?)").run(2);
        throw new Error("nested failure");
      }).immediate()).rejects.toThrow("nested failure");
      await db.transaction(async () => { await db.prepare("INSERT INTO example VALUES (?)").run(3); })();
      await expect(db.close()).rejects.toThrow("inside a transaction");
    }).immediate();
    expect(http.created).toHaveLength(2); // Setup and the complete nested transaction.
    expect(http.log.filter((l) => /SAVEPOINT|INSERT INTO example|COMMIT/.test(l.sql))
      .every((l) => l.stream === 2)).toBe(true);
    expect(await db.prepare("SELECT * FROM example ORDER BY n").all()).toEqual([{ n: 1 }, { n: 3 }]);
    expect(http.log.map((l) => l.sql)).toContain("ROLLBACK TO SAVEPOINT study_sp_1");
    expect(http.created).toHaveLength(3); // The subsequent read owns another stream.
  });

  it("queues other requests across a failing transaction and rolls back all nested writes", async () => {
    await db.exec("CREATE TABLE example (n INTEGER)");
    const entered = deferred();
    const release = deferred();
    const transaction = db.transaction(async () => {
      await db.transaction(async () => { await db.prepare("INSERT INTO example VALUES (1)").run(); })();
      entered.resolve();
      await release.promise;
      throw new Error("outer failure");
    }).immediate();
    const failure = expect(transaction).rejects.toThrow("outer failure");
    await entered.promise;
    let finished = false;
    const read = db.prepare("SELECT * FROM example").all().then((rows) => { finished = true; return rows; });
    await Promise.resolve();
    expect(finished).toBe(false);
    release.resolve();
    await failure;
    expect(await read).toEqual([]);
    // The failed stream is closed; a fresh stream gets FK setup before the next query.
    expect(http.created).toHaveLength(3);
    expect(http.log.filter((l) => l.stream === 3)[0].sql).toBe("PRAGMA foreign_keys = ON");
  });

  it("serializes sibling savepoints without mixing their rollbacks", async () => {
    await db.exec("CREATE TABLE example (n INTEGER)");
    await db.transaction(async () => {
      const result = await Promise.allSettled([
        db.transaction(async () => {
          await db.prepare("INSERT INTO example VALUES (1)").run();
          throw new Error("first fails");
        })(),
        db.transaction(async () => { await db.prepare("INSERT INTO example VALUES (2)").run(); })(),
      ]);
      expect(result.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
    })();
    expect(await db.prepare("SELECT * FROM example").all()).toEqual([{ n: 2 }]);
  });

  it("round trips repository data, deduplicates events, maps duplicates, and cascades deletion", async () => {
    await db.exec(readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8"));
    const s = await createSession(db, assignment, { ...opts, protocolVersion: "calibrated-full-v1" });
    await insertTrial(db, s.sessionId, trial());
    await insertBlockSurvey(db, s.sessionId, survey);
    await insertExitSurvey(db, s.sessionId, exitSurvey);
    expect(await insertEvents(db, s.sessionId, [ev(1), ev(2)])).toBe(2);
    expect(await insertEvents(db, s.sessionId, [ev(2), ev(3)])).toBe(1);
    expect(await getSession(db, s.sessionId)).toMatchObject({ protocolVersion: "calibrated-full-v1", nextEventSeq: 4, blocks: assignment.blocks });
    expect(await allSessionsFull(db)).toHaveLength(1);
    await expect(insertTrial(db, s.sessionId, trial())).rejects.toBeInstanceOf(ConflictError);
    await expect(insertBlockSurvey(db, s.sessionId, survey)).rejects.toBeInstanceOf(ConflictError);
    await expect(insertExitSurvey(db, s.sessionId, exitSurvey)).rejects.toBeInstanceOf(ConflictError);
    // Errors reset the stream; FK must be enabled on this fresh stream before DELETE.
    await db.transaction(async () => { await deleteSession(db, s.sessionId); }).immediate();
    for (const table of ["blocks", "trials", "events", "block_surveys", "exit_surveys"]) {
      expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    for (const created of http.created) {
      expect(created.initialForeignKeys).toBe(0);
      expect(http.log.find((l) => l.stream === created.id)?.sql).toBe("PRAGMA foreign_keys = ON");
    }
  });

  it("uploads 5000 events in 100 HTTP inserts, deduplicates retries, and counts only a new tail", async () => {
    await db.exec(readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8"));
    const { sessionId } = await createSession(db, assignment, opts);
    const events = Array.from({ length: 5000 }, (_, i) => ev(i + 1));
    const eventRequests = (since: number) => http.fetch.mock.calls.slice(since).flatMap(([, init]) => {
      const request = JSON.parse(init!.body as string);
      return (request.batch?.steps ?? []).filter((step: any) =>
        /^\s*INSERT OR IGNORE INTO events\b/i.test(step.stmt.sql));
    });

    let since = http.fetch.mock.calls.length;
    expect(await insertEvents(db, sessionId, events)).toBe(5000);
    expect(eventRequests(since)).toHaveLength(100);
    expect(eventRequests(since).every((step: any) => step.stmt.args.length === 550)).toBe(true);
    // One FK setup, BEGIN, 100 inserts, COMMIT and close; no per-row connections.
    expect(http.fetch.mock.calls.length - since).toBe(104);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?").get(sessionId)).toEqual({ n: 5000 });

    since = http.fetch.mock.calls.length;
    expect(await insertEvents(db, sessionId, events)).toBe(0);
    expect(eventRequests(since)).toHaveLength(100);
    expect(http.fetch.mock.calls.length - since).toBe(104);

    // First chunk is all duplicates; the second mixes 10 duplicates and 25 new rows.
    const tail = Array.from({ length: 85 }, (_, i) => ev(4941 + i));
    since = http.fetch.mock.calls.length;
    expect(await insertEvents(db, sessionId, tail)).toBe(25);
    expect(eventRequests(since).map((step: any) => step.stmt.args.length)).toEqual([550, 385]);
    expect(http.fetch.mock.calls.length - since).toBe(6);
    expect(await db.prepare("SELECT COUNT(*) AS n, MIN(seq) AS first, MAX(seq) AS last FROM events WHERE session_id = ?")
      .get(sessionId)).toEqual({ n: 5025, first: 1, last: 5025 });
    expect(await db.prepare("SELECT seq, type, factor_key FROM events WHERE session_id = ? AND seq = ?")
      .get(sessionId, 5025)).toEqual({ seq: 5025, type: "factor_expand", factor_key: "source" });
  });

  it("rolls back the first event chunk when the second chunk fails, preserves prior rows, and permits retry", async () => {
    await db.exec(readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8"));
    const { sessionId } = await createSession(db, assignment, opts);
    await insertEvents(db, sessionId, [ev(9000)]);
    await db.exec(`CREATE TRIGGER reject_second_event_chunk BEFORE INSERT ON events
      WHEN NEW.seq = 51 BEGIN SELECT RAISE(ABORT, 'second chunk failed'); END;`);
    const events = Array.from({ length: 125 }, (_, i) => ev(i + 1));
    const start = http.log.length;
    await expect(insertEvents(db, sessionId, events)).rejects.toMatchObject({
      name: "DatabaseError", message: "second chunk failed", code: "SQLITE_CONSTRAINT_TRIGGER",
    });
    const statements = http.log.slice(start).map((l) => l.sql);
    expect(statements.filter((sql) => /^\s*INSERT OR IGNORE INTO events\b/i.test(sql))).toHaveLength(2);
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(await db.prepare("SELECT seq FROM events WHERE session_id = ? ORDER BY seq").all(sessionId))
      .toEqual([{ seq: 9000 }]);
    await db.exec("DROP TRIGGER reject_second_event_chunk");
    expect(await insertEvents(db, sessionId, events)).toBe(125);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?").get(sessionId))
      .toEqual({ n: 126 });
  });

  it("retains SDK FK and CHECK violations instead of converting them to duplicate conflicts", async () => {
    await db.exec(readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8"));
    await expect(insertExitSurvey(db, "unknown-session", exitSurvey)).rejects.toMatchObject({ name: "DatabaseError", code: "SQLITE_CONSTRAINT_FOREIGNKEY" });
    await expect(insertExitSurvey(db, "unknown-session", exitSurvey)).rejects.not.toBeInstanceOf(ConflictError);
    const s = await createSession(db, assignment, opts);
    const bad = { ...survey, tension: 8 } as unknown as BlockSurvey;
    await expect(insertBlockSurvey(db, s.sessionId, bad)).rejects.toMatchObject({ name: "DatabaseError", code: "SQLITE_CONSTRAINT_CHECK" });
    await expect(insertBlockSurvey(db, s.sessionId, bad)).rejects.toBeInstanceOf(DatabaseError);
    await expect(insertBlockSurvey(db, s.sessionId, bad)).rejects.not.toBeInstanceOf(ConflictError);
  });

  it("concurrent starts retain atomic pid allocation and code resume behavior", async () => {
    await db.exec(readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8"));
    const args = (code: string) => ({
      participantHash: hashParticipantCode("test-salt", code), staleMinutes: 120,
      assign: (pid: number) => ({ ...assignment, pid }), opts,
    });
    const same = await Promise.all(Array.from({ length: 4 }, () => startOrResumeSession(db, args("same"))));
    expect(same.filter((r) => r.kind === "new")).toHaveLength(1);
    expect(same.filter((r) => r.kind === "resumed")).toHaveLength(3);
    const separate = await Promise.all(Array.from({ length: 4 }, (_, i) => startOrResumeSession(db, args(`code-${i}`))));
    expect(separate.map((r) => r.kind === "new" ? r.session.pid : null)).toEqual([2, 3, 4, 5]);
  });

  it("does not replay failed HTTP writes, and retries initialization on a fresh stream", async () => {
    http.fetch.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(db.prepare("SELECT 1 AS n").get()).rejects.toThrow("network unavailable");
    expect(http.fetch).toHaveBeenCalledTimes(1);
    expect(await db.prepare("SELECT 1 AS n").get()).toEqual({ n: 1 });
    expect(http.log[0].sql).toBe("PRAGMA foreign_keys = ON");
  });

  it("reports a lost write response without replaying a possibly committed write", async () => {
    await db.exec("CREATE TABLE example (n INTEGER)");
    const transport = http.fetch.getMockImplementation()!;
    let lost = false;
    http.fetch.mockImplementation(async (...args) => {
      const request = JSON.parse(args[1]!.body as string);
      const response = await transport(...args);
      if (!lost && request.batch?.steps.some((step: any) => step.stmt.sql === "INSERT INTO example VALUES (?)")) {
        lost = true;
        throw new Error("lost write response");
      }
      return response;
    });
    await expect(db.prepare("INSERT INTO example VALUES (?)").run(1)).rejects.toThrow("lost write response");
    expect(http.log.filter((l) => l.sql === "INSERT INTO example VALUES (?)")).toHaveLength(1);
    expect(await db.prepare("SELECT * FROM example").all()).toEqual([{ n: 1 }]);
  });

  it("cannot continue or commit on a new stream after a caught transaction transport failure", async () => {
    await db.exec("CREATE TABLE example (n INTEGER)");
    await expect(db.transaction(async () => {
      http.fetch.mockRejectedValueOnce(new Error("transaction transport lost"));
      await expect(db.prepare("INSERT INTO example VALUES (1)").run()).rejects.toThrow("transaction transport lost");
      await expect(db.prepare("INSERT INTO example VALUES (2)").run()).rejects.toThrow("transaction stream was lost");
    }).immediate()).rejects.toThrow("transaction stream was lost");
    expect(http.log.some((l) => l.sql === "INSERT INTO example VALUES (2)")).toBe(false);
    expect(http.log.some((l) => l.sql === "COMMIT")).toBe(false);
  });

  it("keeps confirmed commits successful and original failures intact when SDK cleanup rejects", async () => {
    const originalClose = SDKConnection.prototype.close;
    const close = vi.spyOn(SDKConnection.prototype, "close").mockImplementation(async function (this: SDKConnection) {
      await originalClose.call(this);
      throw new Error("cleanup failed");
    });
    try {
      await db.exec("CREATE TABLE example (n INTEGER)");
      const result = await db.transaction(async () => {
        await db.prepare("INSERT INTO example VALUES (1)").run();
        return "confirmed commit";
      }).immediate();
      expect(result).toBe("confirmed commit");
      expect(http.log.filter((l) => l.sql === "INSERT INTO example VALUES (1)")).toHaveLength(1);
      await expect(db.transaction(async () => {
        await db.prepare("INSERT INTO example VALUES (2)").run();
        throw new Error("original operation failed");
      })()).rejects.toThrow("original operation failed");
      expect(await db.prepare("SELECT * FROM example").all()).toEqual([{ n: 1 }]);
      expect(close).toHaveBeenCalledTimes(4);
      expect(http.streams.size).toBe(0);
    } finally { close.mockRestore(); }
  });

  it("closes the SDK stream, is idempotent and rejects subsequent operations", async () => {
    await db.prepare("SELECT 1 AS n").get();
    expect(http.streams.size).toBe(0); // Top-level reads clean up without db.close().
    await db.close();
    expect(http.streams.size).toBe(0);
    const calls = http.fetch.mock.calls.length;
    await db.close();
    await expect(db.prepare("SELECT 1").get()).rejects.toThrow("closed");
    expect(http.fetch).toHaveBeenCalledTimes(calls);
  });

  it("can close unused adapters without network requests", async () => {
    await db.close();
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it.each(["http://study.example.invalid", "file:study.db", "libsql://study.example.invalid", "https://name:password@study.example.invalid", "https://study.example.invalid?tls=false"])(
    "rejects invalid or insecure URL %s before HTTP", (invalid) => {
      expect(() => openTursoDatabase(invalid, "test-token")).toThrow("Turso requires");
      expect(http.fetch).not.toHaveBeenCalled();
    },
  );

  it("requires a token and accepts the supplied Turso URL without connecting", () => {
    expect(() => openTursoDatabase(url, " ")).toThrow("authentication token");
    expect(() => openTursoDatabase("turso://trustableai-bibekgupta3333.aws-us-east-1.turso.io", "test-token")).not.toThrow();
    expect(http.fetch).not.toHaveBeenCalled();
  });
});
