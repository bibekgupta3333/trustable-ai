import { describe, it, expect, beforeEach } from "vitest";
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

  it("creates and reads a session round trip", () => {
    const s = createSession(db, assignment, opts);
    expect(s.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s).toMatchObject({
      pid: 7, status: "in_progress", protocolVersion: "legacy-full-v1", conditionOrder: ["C", "D", "B", "A"], setRotation: 1,
      consequenceBanner: false, anxiety: true, resumeCount: 0, consentAt: null, completedAt: null,
      cursor: { blockIndex: 1, positionInBlock: 1, phase: "consent" },
    });
    expect(s.blocks).toEqual(assignment.blocks);
    expect(getSession(db, s.sessionId)).toEqual(s);
    expect(getSession(db, "nope")).toBeNull();
  });

  it("finds the in-progress session by pid", () => {
    const s = createSession(db, assignment, opts);
    expect(findInProgressByPid(db, 7)?.sessionId).toBe(s.sessionId);
    expect(findInProgressByPid(db, 8)).toBeNull();
    setStatus(db, s.sessionId, "abandoned");
    expect(findInProgressByPid(db, 7)).toBeNull();
  });

  it("updates cursor, consent, resume count and status", () => {
    const { sessionId } = createSession(db, assignment, opts);
    updateCursor(db, sessionId, { blockIndex: 3, positionInBlock: 4, phase: "trial" });
    recordConsent(db, sessionId, "2026-01-01T00:00:00.000Z");
    incrementResume(db, sessionId);
    incrementResume(db, sessionId);
    setStatus(db, sessionId, "completed", "2026-01-02T00:00:00.000Z");
    const s = getSession(db, sessionId)!;
    expect(s.cursor).toEqual({ blockIndex: 3, positionInBlock: 4, phase: "trial" });
    expect(s.consentAt).toBe("2026-01-01T00:00:00.000Z");
    expect(s.resumeCount).toBe(2);
    expect(s.status).toBe("completed");
    expect(s.completedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("inserts a trial and rejects a duplicate with ConflictError", () => {
    const { sessionId } = createSession(db, assignment, opts);
    insertTrial(db, sessionId, trial(1));
    expect(getTrials(db, sessionId)).toEqual([trial(1)]);
    expect(() => insertTrial(db, sessionId, trial(1))).toThrow(ConflictError);
    const noC: Trial = { ...trial(2), explanationOpened: null, factorsExpanded: [], detectedError: null, timeToFirstExpandMs: null };
    insertTrial(db, sessionId, noC);
    expect(getTrials(db, sessionId)[1]).toEqual(noC);
  });

  it("inserts events with INSERT OR IGNORE by seq", () => {
    const { sessionId } = createSession(db, assignment, opts);
    expect(insertEvents(db, sessionId, [ev(1), ev(2)])).toBe(2);
    expect(insertEvents(db, sessionId, [ev(2), ev(3)])).toBe(1);
    expect(insertEvents(db, sessionId, [])).toBe(0);
    const rows = allEventRows(db);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows[0]).toMatchObject({ pid: 7, sessionId, type: "factor_expand", factorKey: "source", tMs: 10 });
  });

  it("inserts a block survey, rejects a duplicate, and expands trust columns", () => {
    const { sessionId } = createSession(db, assignment, opts);
    insertBlockSurvey(db, sessionId, survey);
    expect(() => insertBlockSurvey(db, sessionId, survey)).toThrow(ConflictError);
    const [row] = allSurveyRows(db);
    expect(row).toMatchObject({
      pid: 7, sessionId, blockIndex: 1, condition: "C", trust_01: 2, trust_12: 2, trust_01_s: 6, trust_06_s: 2,
      trustMean: 3.67, fairnessMean: 4.5, frustrationTlx: 35, frustrationTlxTouched: true, nWrongDetected: 1,
    });
  });

  it("round trips brief scores and protocol metadata without inventing full questionnaire values", () => {
    const s = createSession(db, assignment, { ...opts, protocolVersion: "calibrated-brief-v1" });
    const brief: BlockSurvey = { ...survey, questionnaireVersion: "brief-v1", briefTrust: 6,
      trustResponses: [], trustMean: null, fairness1: null, fairness2: null, fairnessMean: null };
    insertBlockSurvey(db, s.sessionId, brief);
    expect(listSessions(db)[0].protocolVersion).toBe("calibrated-brief-v1");
    expect(allSurveyRows(db)[0]).toMatchObject({ questionnaireVersion: "brief-v1", briefTrust: 6,
      trust_01: null, trust_12: null, trust_01_s: null, trust_12_s: null,
      trustMean: null, fairness1: null, fairness2: null, fairnessMean: null });
    const full = allSessionsFull(db)[0] as any;
    expect(full.protocolVersion).toBe("calibrated-brief-v1");
    expect(full.blocks[0].survey).toEqual(brief);
  });

  it("inserts an exit survey once", () => {
    const { sessionId } = createSession(db, assignment, opts);
    insertExitSurvey(db, sessionId, exitSurvey);
    expect(() => insertExitSurvey(db, sessionId, exitSurvey)).toThrow(ConflictError);
    expect(allExitRows(db)).toEqual([{ ...exitSurvey, pid: 7, sessionId, conditionOrder: "CDBA", setRotation: 1, status: "in_progress", protocolVersion: "legacy-full-v1" }]);
  });

  it("export rows join session columns and full sessions nest everything", () => {
    const { sessionId } = createSession(db, assignment, opts);
    insertTrial(db, sessionId, trial(1));
    insertEvents(db, sessionId, [ev(1)]);
    insertBlockSurvey(db, sessionId, survey);
    insertExitSurvey(db, sessionId, exitSurvey);
    const [t] = allTrialRows(db);
    expect(t).toMatchObject({ pid: 7, sessionId, set: "S2", conditionOrder: "CDBA", setRotation: 1, status: "in_progress",
      isAiCorrect: false, factorsExpanded: ["claimVsRecord", "source"] });
    const [full] = allSessionsFull(db) as any[];
    expect(full.blocks).toHaveLength(4);
    expect(full.blocks[0].trials).toEqual([trial(1)]);
    expect(full.blocks[0].survey.trustResponses[0]).toEqual({ itemId: "jian-01", raw: 2, scored: 6 });
    expect(full.blocks[1].survey).toBeNull();
    expect(full.events).toHaveLength(1);
    expect(full.exitSurvey).toEqual(exitSurvey);
  });

  it("deleteSession cascades to every child table", () => {
    const { sessionId } = createSession(db, assignment, opts);
    insertTrial(db, sessionId, trial(1));
    insertEvents(db, sessionId, [ev(1)]);
    insertBlockSurvey(db, sessionId, survey);
    insertExitSurvey(db, sessionId, exitSurvey);
    deleteSession(db, sessionId);
    expect(getSession(db, sessionId)).toBeNull();
    for (const table of ["blocks", "trials", "events", "block_surveys", "exit_surveys"]) {
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(n, table).toBe(0);
    }
  });

  it("listSessions reports trial and survey counts", () => {
    const a = createSession(db, assignment, opts);
    const b = createSession(db, { ...assignment, pid: 8 }, opts);
    insertTrial(db, a.sessionId, trial(1));
    insertTrial(db, a.sessionId, trial(2));
    insertBlockSurvey(db, a.sessionId, survey);
    const rows = listSessions(db);
    expect(rows).toHaveLength(2);
    const ra = rows.find((r) => r.sessionId === a.sessionId)!;
    const rb = rows.find((r) => r.sessionId === b.sessionId)!;
    expect(ra).toMatchObject({ pid: 7, conditionOrder: "CDBA", setRotation: 1, trialsSaved: 2, surveysSaved: 1, completedAt: null });
    expect(rb).toMatchObject({ pid: 8, trialsSaved: 0, surveysSaved: 0, status: "in_progress" });
    expect(ra.lastActivityAt).toBe(a.startedAt);
    touchActivity(db, a.sessionId, "2026-02-02T00:00:00.000Z");
    expect(listSessions(db).find((r) => r.sessionId === a.sessionId)!.lastActivityAt).toBe("2026-02-02T00:00:00.000Z");
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

  it("hash is deterministic hex HMAC-SHA256 and depends on salt and code", () => {
    const h = hashParticipantCode("salt", "abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashParticipantCode("salt", "abc")).toBe(h);
    expect(hashParticipantCode("salt2", "abc")).not.toBe(h);
    expect(hashParticipantCode("salt", "abd")).not.toBe(h);
  });

  it("participantSalt prefers env, else generates once into meta", () => {
    expect(participantSalt(db, "from-env")).toBe("from-env");
    const s1 = participantSalt(db);
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
    expect(participantSalt(db)).toBe(s1);
  });

  it("new, resumed, already_participated", () => {
    const r1 = startOrResumeSession(db, startArgs("a"));
    expect(r1.kind).toBe("new");
    const r2 = startOrResumeSession(db, startArgs("a"));
    expect(r2.kind).toBe("resumed");
    if (r1.kind !== "new" || r2.kind !== "resumed") throw new Error("unreachable");
    expect(r2.session.sessionId).toBe(r1.session.sessionId);
    expect(r2.session.resumeCount).toBe(1);
    setStatus(db, r1.session.sessionId, "completed");
    expect(startOrResumeSession(db, startArgs("a")).kind).toBe("already_participated");
  });

  it("allocates lowest free pid, reuses abandoned, sweeps stale, skips >= 900", () => {
    const pid = (code: string, now?: Date) => {
      const r = startOrResumeSession(db, startArgs(code, now));
      if (r.kind !== "new") throw new Error(r.kind);
      return r.session;
    };
    const [a, b, c] = [pid("a"), pid("b"), pid("c")];
    expect([a.pid, b.pid, c.pid]).toEqual([1, 2, 3]);
    setStatus(db, a.sessionId, "abandoned");
    const d = pid("d");
    expect(d.pid).toBe(1);
    // 3 hours from now b is stale (idle > 120 min); c and d were active a minute before
    const later = new Date(Date.now() + 3 * 3600_000);
    for (const x of [c, d]) touchActivity(db, x.sessionId, new Date(later.getTime() - 60_000).toISOString());
    const e = pid("e", later);
    expect(e.pid).toBe(2);
    expect(getSession(db, b.sessionId)!.status).toBe("abandoned");
    expect(getSession(db, c.sessionId)!.status).toBe("in_progress");
    touchActivity(db, e.sessionId, later.toISOString());
    expect(abandonStaleSessions(db, 120, later)).toBe(0);
    expect(abandonStaleSessions(db, 120, new Date(later.getTime() + 3 * 3600_000))).toBe(3); // c, d, e
    createSession(db, assign(900), opts);
    createSession(db, assign(905), opts);
    expect(nextFreePid(db)).toBe(1);
  });

  it("is safe across two connections to the same file (BEGIN IMMEDIATE)", () => {
    const dir = mkdtempSync(join(tmpdir(), "xai-repo-"));
    try {
      const path = join(dir, "study.db");
      const c1 = openDb(path);
      const c2 = openDb(path);
      const pids: number[] = [];
      for (let i = 0; i < 30; i++) {
        const r = startOrResumeSession(i % 2 ? c1 : c2, startArgs(`code-${i}`));
        if (r.kind !== "new") throw new Error(r.kind);
        pids.push(r.session.pid);
        if (i % 7 === 3) setStatus(i % 2 ? c2 : c1, r.session.sessionId, "abandoned");
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
  it("adds participant_hash, last_activity_at and the unique index to an old DB, keeping rows", () => {
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
      expect(listSessions(db)[0]).toMatchObject({ sessionId: "old-1", lastActivityAt: "2026-01-01T00:00:00.000Z" });
      // the old pid-1 session went stale long ago: a self-start abandons it and reuses pid 1
      const r = startOrResumeSession(db, {
        participantHash: hashParticipantCode("s", "abc"), staleMinutes: 120, assign: (pid) => ({ ...assignment, pid }),
        opts: { consequenceBanner: false, anxiety: false, postBankHash: "h", appVersion: "v" },
      });
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
  it.each([2, 3, 4])("preserves schema %i full/brief scores, plans, responses and identities across migration and reopen", (version) => {
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
      insertTrial(old, "saved", trial());
      insertEvents(old, "saved", [ev(4), ev(5)]);
      const raw = JSON.stringify(survey.trustResponses.map((r) => r.raw));
      const scored = JSON.stringify(survey.trustResponses.map((r) => r.scored));
      old.prepare(`INSERT INTO block_surveys (session_id, block_index, condition, trust_raw, trust_scored,
        trust_mean, fairness1, fairness2, fairness_mean, tension, frustration_tlx, frustration_tlx_touched,
        n_wrong_detected, anxiety, submitted_at) VALUES ('saved', 1, 'C', ?, ?, ?, 4, 5, 4.5, 3, 35, 1, 1, NULL, ?)`)
        .run(raw, scored, survey.trustMean, survey.submittedAt);
      if (version >= 3) {
        const briefSession = createSession(old, { ...assignment, pid: 8 }, { ...opts, protocolVersion: "calibrated-brief-v1" });
        insertBlockSurvey(old, briefSession.sessionId, { ...survey, questionnaireVersion: "brief-v1", briefTrust: 6,
          trustResponses: [], trustMean: null, fairness1: null, fairness2: null, fairnessMean: null });
      }
      if (version === 4) {
        const fullSession = createSession(old, { ...assignment, pid: 11 }, { ...opts, protocolVersion: "calibrated-full-v1" });
        insertBlockSurvey(old, fullSession.sessionId, survey);
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
        expect(getSession(migrated, "saved")).toMatchObject({
          protocolVersion: "legacy-full-v1", nextEventSeq: 6, blocks: assignment.blocks,
          cursor: { phase: "block_survey" },
        });
        const full = (allSessionsFull(migrated) as any[]).find((s) => s.sessionId === "saved");
        expect(full.blocks[0].survey).toEqual({ ...survey, questionnaireVersion: "full-v1", briefTrust: null });
        expect(migrated.prepare("SELECT value FROM meta WHERE key='participant_salt'").get()).toEqual({ value: "keep-salt" });
        expect(migrated.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: "5" });
        expect(migrated.pragma("foreign_key_check")).toEqual([]);
        if (pass === 1) {
          expect(migrated.pragma("foreign_keys", { simple: true })).toBe(1);
          const restored = createSession(migrated, { ...assignment, pid: 9 }, { ...opts, protocolVersion: "calibrated-media-full-v1" });
          insertBlockSurvey(migrated, restored.sessionId, survey);
          expect(getSession(migrated, restored.sessionId)?.protocolVersion).toBe("calibrated-media-full-v1");
          const current = createSession(migrated, { ...assignment, pid: 10 }, { ...opts, protocolVersion: "calibrated-brief-v1" });
          const brief: BlockSurvey = { ...survey, questionnaireVersion: "brief-v1", briefTrust: 7,
            trustResponses: [], trustMean: null, fairness1: null, fairness2: null, fairnessMean: null };
          insertBlockSurvey(migrated, current.sessionId, brief);
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
