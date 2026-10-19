// Data access for the study database. The snake_case <-> camelCase mapping lives here only.
import { asAsyncDatabase, type DatabaseInput, type StudyStatement } from "./async.js";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type {
  Assignment, BlockPlan, Cursor, SessionStatus, SessionView, AdminSessionRow, EventSubmission,
} from "../../shared/api.js";
import type {
  BlockSurvey, Condition, ExitSurvey, FactorKey, Phase, Trial, TrustResponse, StudyProtocol,
} from "../../shared/types.js";

type DB = DatabaseInput;
type Row = Record<string, any>;

export class ConflictError extends Error {
  constructor(message = "conflict") {
    super(message);
    this.name = "ConflictError";
  }
}

// ---------- helpers ----------
function stmt(db: DB, sql: string): StudyStatement {
  return asAsyncDatabase(db).prepare(sql);
}

const b = (v: boolean): number => (v ? 1 : 0);
const bn = (v: boolean | null | undefined): number | null => (v === null || v === undefined ? null : v ? 1 : 0);
const toBool = (v: unknown): boolean => v === 1 || v === true;
const toBoolN = (v: unknown): boolean | null => (v === null || v === undefined ? null : v === 1 || v === true);
const nowIso = (): string => new Date().toISOString();

function isPkConflict(e: unknown): boolean {
  const error = e as { code?: string; extendedCode?: string; rawCode?: number } | null;
  const codes = [error?.code, error?.extendedCode];
  return codes.some(code => code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE")
    || error?.rawCode === 1555 || error?.rawCode === 2067;
}
async function runOrConflict(fn: () => Promise<unknown>, msg: string): Promise<void> {
  try { (await fn()); } catch (e) {
    if (isPkConflict(e)) throw new ConflictError(msg);
    throw e;
  }
}

const splitOrder = (s: string): [Condition, Condition, Condition, Condition] =>
  s.split("") as [Condition, Condition, Condition, Condition];
const splitFactors = (s: string): FactorKey[] => (s ? (s.split("|") as FactorKey[]) : []);

// ---------- mapping ----------
function blockFromRow(r: Row): BlockPlan {
  return {
    blockIndex: r.block_index,
    condition: r.condition,
    set: r.set_id,
    postOrder: JSON.parse(r.post_order),
  };
}

async function sessionViewFromRow(db: DB, r: Row): Promise<SessionView> {
  const blocks = ((await stmt(db, "SELECT * FROM blocks WHERE session_id = ? ORDER BY block_index").all(r.session_id)) as Row[])
    .map(blockFromRow) as SessionView["blocks"];
  return {
    sessionId: r.session_id,
    pid: r.pid,
    status: r.status,
    protocolVersion: r.protocol_version ?? "legacy-full-v1",
    conditionOrder: splitOrder(r.condition_order),
    setRotation: r.set_rotation,
    blocks,
    cursor: { blockIndex: r.cursor_block, positionInBlock: r.cursor_position, phase: r.cursor_phase as Phase },
    consequenceBanner: toBool(r.consequence_banner),
    anxiety: toBool(r.anxiety),
    resumeCount: r.resume_count,
    nextEventSeq: (((await stmt(db, "SELECT MAX(seq) AS m FROM events WHERE session_id = ?").get(r.session_id)) as { m: number | null }).m ?? 0) + 1,
    consentAt: r.consent_at ?? null,
    startedAt: r.started_at,
    completedAt: r.completed_at ?? null,
  };
}

function trialFromRow(r: Row): Trial {
  return {
    trialId: r.trial_id,
    blockIndex: r.block_index,
    positionInBlock: r.position_in_block,
    trialIndex: r.trial_index,
    postId: r.post_id,
    condition: r.condition,
    set: r.set_id,
    topic: r.topic,
    aiLabel: r.ai_label,
    groundTruth: r.ground_truth,
    isAiCorrect: toBool(r.is_ai_correct),
    errorType: r.error_type ?? null,
    difficulty: r.difficulty ?? null,
    agreed: toBool(r.agreed),
    detectedError: toBoolN(r.detected_error),
    confidence: r.confidence,
    labelShownAt: r.label_shown_at,
    respondedAt: r.responded_at,
    decisionTimeMs: r.decision_time_ms,
    decisionTimeRawMs: r.decision_time_raw_ms,
    hiddenMs: r.hidden_ms,
    hiddenCount: r.hidden_count,
    blurCount: r.blur_count,
    timingFlag: toBool(r.timing_flag),
    factSheetOpened: toBool(r.fact_sheet_opened),
    factSheetOpenMs: r.fact_sheet_open_ms,
    explanationOpened: toBoolN(r.explanation_opened),
    factorsExpanded: splitFactors(r.factors_expanded),
    timeToFirstExpandMs: r.time_to_first_expand_ms ?? null,
    resumed: toBool(r.resumed),
  };
}

function surveyFromRow(r: Row, itemIds?: string[]): BlockSurvey {
  const raw: number[] = JSON.parse(r.trust_raw);
  const scored: number[] = JSON.parse(r.trust_scored);
  const trustResponses: TrustResponse[] = raw.map((v, i) => ({
    itemId: itemIds?.[i] ?? `jian-${String(i + 1).padStart(2, "0")}`,
    raw: v as TrustResponse["raw"],
    scored: scored[i] as TrustResponse["scored"],
  }));
  return {
    blockIndex: r.block_index,
    condition: r.condition,
    questionnaireVersion: r.questionnaire_version ?? "full-v1",
    briefTrust: r.brief_trust ?? null,
    trustResponses,
    trustMean: r.trust_mean,
    fairness1: r.fairness1,
    fairness2: r.fairness2,
    fairnessMean: r.fairness_mean,
    tension: r.tension,
    frustrationTlx: r.frustration_tlx,
    frustrationTlxTouched: toBool(r.frustration_tlx_touched),
    nWrongDetected: r.n_wrong_detected,
    anxiety: r.anxiety == null ? null : JSON.parse(r.anxiety),
    submittedAt: r.submitted_at,
  };
}

function exitFromRow(r: Row): ExitSurvey {
  return {
    ageRange: r.age_range,
    gender: r.gender ?? null,
    education: r.education,
    socialMediaUse: r.social_media_use,
    labelExposure: r.label_exposure,
    preferredCondition: r.preferred_condition,
    comment: r.comment ?? "",
    submittedAt: r.submitted_at,
  };
}

function eventFromRow(r: Row): EventSubmission {
  return {
    seq: r.seq,
    trialId: r.trial_id ?? null,
    blockIndex: r.block_index ?? null,
    condition: r.condition ?? null,
    postId: r.post_id ?? null,
    type: r.type,
    factorKey: r.factor_key ?? null,
    tMs: r.t_ms ?? null,
    perfNow: r.perf_now,
    wallClock: r.wall_clock,
  };
}

// ---------- sessions ----------
export interface CreateSessionOpts {
  consequenceBanner: boolean;
  anxiety: boolean;
  postBankHash: string;
  appVersion: string;
  protocolVersion?: StudyProtocol; // omitted by historical/manual callers: legacy-full-v1
  participantHash?: string | null; // HMAC of the participation code; never the raw code
}

export async function createSession(db: DB, a: Assignment, opts: CreateSessionOpts): Promise<SessionView> {
  const sessionId = randomUUID();
  const now = nowIso();
  const insertSession = stmt(db, `INSERT INTO sessions
    (session_id, pid, condition_order, set_rotation, seed, status, consequence_banner, anxiety,
     cursor_block, cursor_position, cursor_phase, resume_count, post_bank_hash, app_version, started_at,
     participant_hash, last_activity_at, protocol_version)
    VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?, 1, 1, 'consent', 0, ?, ?, ?, ?, ?, ?)`);
  const insertBlock = stmt(db, `INSERT INTO blocks (session_id, block_index, condition, set_id, post_order)
    VALUES (?, ?, ?, ?, ?)`);
  const tx = asAsyncDatabase(db).transaction(async () => {
    (await insertSession.run(
      sessionId, a.pid, a.conditionOrder.join(""), a.setRotation, a.seed,
      b(opts.consequenceBanner), b(opts.anxiety), opts.postBankHash, opts.appVersion, now,
      opts.participantHash ?? null, now, opts.protocolVersion ?? "legacy-full-v1",
    ));
    for (const blk of a.blocks) {
      (await insertBlock.run(sessionId, blk.blockIndex, blk.condition, blk.set, JSON.stringify(blk.postOrder)));
    }
  });
  (await runOrConflict(async () => (await tx()), `session ${sessionId} already exists`));
  return (await getSession(db, sessionId))!;
}

export async function getSession(db: DB, sessionId: string): Promise<SessionView | null> {
  const r = (await stmt(db, "SELECT * FROM sessions WHERE session_id = ?").get(sessionId)) as Row | undefined;
  return r ? (await sessionViewFromRow(db, r)) : null;
}

export async function listSessions(db: DB): Promise<AdminSessionRow[]> {
  const rows = (await stmt(db, `SELECT s.*,
      (SELECT COUNT(*) FROM trials t WHERE t.session_id = s.session_id) AS trials_saved,
      (SELECT COALESCE(SUM(json_array_length(b.post_order)), 0) FROM blocks b WHERE b.session_id = s.session_id) AS planned_trials,
      (SELECT COUNT(*) FROM block_surveys bs WHERE bs.session_id = s.session_id) AS surveys_saved
    FROM sessions s ORDER BY s.started_at DESC, s.pid DESC`).all()) as Row[];
  return rows.map((r) => ({
    sessionId: r.session_id,
    pid: r.pid,
    status: r.status,
    protocolVersion: r.protocol_version ?? "legacy-full-v1",
    conditionOrder: r.condition_order,
    setRotation: r.set_rotation,
    trialsSaved: r.trials_saved,
    plannedTrials: r.planned_trials,
    studyVariant: r.planned_trials === 8 ? "short-8" : r.planned_trials === 24 ? "legacy-24" : `custom-${r.planned_trials}`,
    surveysSaved: r.surveys_saved,
    startedAt: r.started_at,
    completedAt: r.completed_at ?? null,
    lastActivityAt: r.last_activity_at ?? null,
  }));
}

export async function findInProgressByPid(db: DB, pid: number): Promise<SessionView | null> {
  const r = (await stmt(db, `SELECT * FROM sessions WHERE pid = ? AND status = 'in_progress'
    ORDER BY started_at DESC LIMIT 1`).get(pid)) as Row | undefined;
  return r ? (await sessionViewFromRow(db, r)) : null;
}

export async function recordConsent(db: DB, sessionId: string, at: string): Promise<void> {
  (await stmt(db, "UPDATE sessions SET consent_at = ? WHERE session_id = ?").run(at, sessionId));
}

export async function updateCursor(db: DB, sessionId: string, c: Cursor): Promise<void> {
  (await stmt(db, "UPDATE sessions SET cursor_block = ?, cursor_position = ?, cursor_phase = ? WHERE session_id = ?")
    .run(c.blockIndex, c.positionInBlock, c.phase, sessionId));
}

export async function incrementResume(db: DB, sessionId: string): Promise<void> {
  (await stmt(db, "UPDATE sessions SET resume_count = resume_count + 1 WHERE session_id = ?").run(sessionId));
}

export async function setStatus(db: DB, sessionId: string, status: SessionStatus, at?: string): Promise<void> {
  if (status === "completed") {
    (await stmt(db, "UPDATE sessions SET status = ?, completed_at = ? WHERE session_id = ?").run(status, at ?? nowIso(), sessionId));
  } else {
    (await stmt(db, "UPDATE sessions SET status = ? WHERE session_id = ?").run(status, sessionId));
  }
}

/** Sets last_activity_at = now. Call on every participant write (consent, trial, events, cursor, surveys, exit, resume). */
export async function touchActivity(db: DB, sessionId: string, at: string = nowIso()): Promise<void> {
  (await stmt(db, "UPDATE sessions SET last_activity_at = ? WHERE session_id = ?").run(at, sessionId));
}

// ---------- participation code (once-only) ----------
/** Salt for participant hashes: env PARTICIPANT_SALT if given, else 32 random bytes generated once into meta.participant_salt. */
export async function participantSalt(db: DB, envSalt?: string): Promise<string> {
  if (envSalt) return envSalt;
  (await stmt(db, "INSERT OR IGNORE INTO meta (key, value) VALUES ('participant_salt', ?)").run(randomBytes(32).toString("hex")));
  return ((await stmt(db, "SELECT value FROM meta WHERE key = 'participant_salt'").get()) as { value: string }).value;
}

/** hex HMAC-SHA256(salt, normalisedCode). The caller normalises (trim + lowercase). */
export function hashParticipantCode(salt: string, normalisedCode: string): string {
  return createHmac("sha256", salt).update(normalisedCode, "utf8").digest("hex");
}

export const PILOT_PID_MIN = 900; // pids >= 900 are pilot/manual and never auto-assigned

/** Marks in_progress sessions whose last activity is older than staleMinutes as abandoned. Returns rows changed. */
export async function abandonStaleSessions(db: DB, staleMinutes: number, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - staleMinutes * 60_000).toISOString();
  return (await stmt(db, `UPDATE sessions SET status = 'abandoned'
    WHERE status = 'in_progress' AND COALESCE(last_activity_at, started_at) < ?`).run(cutoff)).changes;
}

/** Lowest pid >= 1 with no in_progress or completed session (abandoned pids are reused); null if 1-899 are all taken. */
export async function nextFreePid(db: DB): Promise<number | null> {
  const used = new Set(((await stmt(db, `SELECT DISTINCT pid FROM sessions
    WHERE status IN ('in_progress','completed') AND pid < ?`).all(PILOT_PID_MIN)) as { pid: number }[]).map((r) => r.pid));
  for (let pid = 1; pid < PILOT_PID_MIN; pid++) if (!used.has(pid)) return pid;
  return null;
}

export type StartResult =
  | { kind: "new"; session: SessionView }
  | { kind: "resumed"; session: SessionView }
  | { kind: "already_participated" }
  | { kind: "full" };

/**
 * Self-start in one BEGIN IMMEDIATE transaction: sweep stale sessions, then resume / refuse by participant hash,
 * else allocate the lowest free pid and create the session from assign(pid).
 */
export async function startOrResumeSession(
  db: DB,
  args: {
    participantHash: string;
    staleMinutes: number;
    assign: (pid: number) => Assignment;
    opts: Omit<CreateSessionOpts, "participantHash">;
    now?: Date;
  },
): Promise<StartResult> {
  const tx = asAsyncDatabase(db).transaction(async (): Promise<StartResult> => {
    const now = args.now ?? new Date();
    (await abandonStaleSessions(db, args.staleMinutes, now));
    const prior = (await stmt(db, "SELECT session_id, status FROM sessions WHERE participant_hash = ?")
      .get(args.participantHash)) as Row | undefined;
    if (prior) {
      if (prior.status !== "in_progress") return { kind: "already_participated" };
      (await stmt(db, "UPDATE sessions SET resume_count = resume_count + 1, last_activity_at = ? WHERE session_id = ?")
        .run(now.toISOString(), prior.session_id));
      return { kind: "resumed", session: (await getSession(db, prior.session_id))! };
    }
    const pid = (await nextFreePid(db));
    if (pid === null) return { kind: "full" };
    const session = (await createSession(db, args.assign(pid), { ...args.opts, participantHash: args.participantHash }));
    return { kind: "new", session };
  });
  return (await tx.immediate());
}

export async function deleteSession(db: DB, sessionId: string): Promise<void> {
  // Child rows go via ON DELETE CASCADE (foreign_keys = ON in openDb).
  (await stmt(db, "DELETE FROM sessions WHERE session_id = ?").run(sessionId));
}

// ---------- trials ----------
export async function insertTrial(db: DB, sessionId: string, t: Trial): Promise<void> {
  const s = (await stmt(db, "SELECT pid FROM sessions WHERE session_id = ?").get(sessionId)) as Row | undefined;
  if (!s) throw new Error(`unknown session ${sessionId}`);
  const ins = stmt(db, `INSERT INTO trials (
      trial_id, session_id, pid, block_index, position_in_block, trial_index, post_id, condition, set_id, topic,
      ai_label, ground_truth, is_ai_correct, error_type, difficulty, agreed, detected_error, confidence,
      label_shown_at, responded_at, decision_time_raw_ms, hidden_ms, hidden_count, blur_count, decision_time_ms,
      timing_flag, fact_sheet_opened, fact_sheet_open_ms, explanation_opened, factors_expanded,
      time_to_first_expand_ms, resumed, saved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  (await runOrConflict(async () => {
    (await ins.run(
      t.trialId, sessionId, s.pid, t.blockIndex, t.positionInBlock, t.trialIndex, t.postId, t.condition, t.set, t.topic,
      t.aiLabel, t.groundTruth, b(t.isAiCorrect), t.errorType, t.difficulty, b(t.agreed), bn(t.detectedError), t.confidence,
      t.labelShownAt, t.respondedAt, t.decisionTimeRawMs, t.hiddenMs, t.hiddenCount, t.blurCount, t.decisionTimeMs,
      b(t.timingFlag), b(t.factSheetOpened), t.factSheetOpenMs, bn(t.explanationOpened), t.factorsExpanded.join("|"),
      t.timeToFirstExpandMs, b(t.resumed), nowIso(),
    ));
  }, `trial ${t.blockIndex}-${t.positionInBlock} already saved`));
}

export async function getTrials(db: DB, sessionId: string): Promise<Trial[]> {
  return ((await stmt(db, "SELECT * FROM trials WHERE session_id = ? ORDER BY block_index, position_in_block")
    .all(sessionId)) as Row[]).map(trialFromRow);
}

// ---------- events ----------
export async function insertEvents(db: DB, sessionId: string, evs: EventSubmission[]): Promise<number> {
  if (!evs.length) return 0;
  // Bound network round trips while staying below SQLite's legacy 999-bind limit.
  // All chunks share the transaction: a later failure rolls back earlier chunks.
  const tx = asAsyncDatabase(db).transaction(async () => {
    let inserted = 0;
    for (let offset = 0; offset < evs.length; offset += 50) {
      const chunk = evs.slice(offset, offset + 50);
      const values = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const params = chunk.flatMap(e => [
        sessionId, e.seq, e.trialId ?? null, e.blockIndex ?? null, e.condition ?? null, e.postId ?? null,
        e.type, e.factorKey ?? null, e.tMs ?? null, e.perfNow, e.wallClock,
      ]);
      inserted += (await stmt(db, `INSERT OR IGNORE INTO events
        (session_id, seq, trial_id, block_index, condition, post_id, type, factor_key, t_ms, perf_now, wall_clock)
        VALUES ${values}`).run(...params)).changes;
    }
    return inserted;
  });
  return tx();
}

// ---------- surveys ----------
export async function insertBlockSurvey(db: DB, sessionId: string, s: BlockSurvey): Promise<void> {
  const ins = stmt(db, `INSERT INTO block_surveys
    (session_id, block_index, condition, trust_raw, trust_scored, trust_mean, fairness1, fairness2, fairness_mean,
     tension, frustration_tlx, frustration_tlx_touched, n_wrong_detected, anxiety, submitted_at, questionnaire_version, brief_trust)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  (await runOrConflict(async () => {
    (await ins.run(
      sessionId, s.blockIndex, s.condition,
      JSON.stringify(s.trustResponses.map((r) => r.raw)),
      JSON.stringify(s.trustResponses.map((r) => r.scored)),
      s.trustMean, s.fairness1, s.fairness2, s.fairnessMean, s.tension, s.frustrationTlx,
      b(s.frustrationTlxTouched), s.nWrongDetected, s.anxiety == null ? null : JSON.stringify(s.anxiety), s.submittedAt,
      s.questionnaireVersion ?? "full-v1", s.briefTrust ?? null,
    ));
  }, `block survey ${s.blockIndex} already saved`));
}

export async function insertExitSurvey(db: DB, sessionId: string, s: ExitSurvey): Promise<void> {
  const ins = stmt(db, `INSERT INTO exit_surveys
    (session_id, age_range, gender, education, social_media_use, label_exposure, preferred_condition, comment, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  (await runOrConflict(async () => {
    (await ins.run(sessionId, s.ageRange, s.gender, s.education, s.socialMediaUse, s.labelExposure,
      s.preferredCondition, s.comment ?? "", s.submittedAt));
  }, "exit survey already saved"));
}

// ---------- export rows ----------
function sessionCols(r: Row) {
  return {
    pid: r.pid,
    sessionId: r.session_id,
    conditionOrder: r.condition_order,
    setRotation: r.set_rotation,
    status: r.status,
    protocolVersion: r.protocol_version ?? "legacy-full-v1",
  };
}

export async function allTrialRows(db: DB): Promise<Record<string, unknown>[]> {
  const rows = (await stmt(db, `SELECT t.*, s.condition_order, s.set_rotation, s.status, s.protocol_version
    FROM trials t JOIN sessions s ON s.session_id = t.session_id
    ORDER BY t.pid, s.started_at, t.session_id, t.block_index, t.position_in_block`).all()) as Row[];
  return rows.map((r) => ({ ...sessionCols(r), ...trialFromRow(r) }));
}

export async function allSurveyRows(db: DB): Promise<Record<string, unknown>[]> {
  const rows = (await stmt(db, `SELECT bs.*, s.pid, s.condition_order, s.set_rotation, s.status, s.protocol_version
    FROM block_surveys bs JOIN sessions s ON s.session_id = bs.session_id
    ORDER BY s.pid, s.started_at, bs.session_id, bs.block_index`).all()) as Row[];
  return rows.map((r) => {
    const raw: number[] = JSON.parse(r.trust_raw);
    const scored: number[] = JSON.parse(r.trust_scored);
    const out: Record<string, unknown> = {
      ...sessionCols(r),
      blockIndex: r.block_index,
      condition: r.condition,
    };
    for (let i = 0; i < 12; i++) out[`trust_${String(i + 1).padStart(2, "0")}`] = raw[i] ?? null;
    for (let i = 0; i < 12; i++) out[`trust_${String(i + 1).padStart(2, "0")}_s`] = scored[i] ?? null;
    Object.assign(out, {
      questionnaireVersion: r.questionnaire_version ?? "full-v1",
      briefTrust: r.brief_trust ?? null,
      trustMean: r.trust_mean,
      fairness1: r.fairness1,
      fairness2: r.fairness2,
      fairnessMean: r.fairness_mean,
      tension: r.tension,
      frustrationTlx: r.frustration_tlx,
      frustrationTlxTouched: toBool(r.frustration_tlx_touched),
      nWrongDetected: r.n_wrong_detected,
      anxiety: r.anxiety == null ? null : JSON.parse(r.anxiety),
      submittedAt: r.submitted_at,
    });
    return out;
  });
}

export async function allEventRows(db: DB): Promise<Record<string, unknown>[]> {
  const rows = (await stmt(db, `SELECT e.*, s.pid, s.condition_order, s.set_rotation, s.status, s.protocol_version
    FROM events e JOIN sessions s ON s.session_id = e.session_id
    ORDER BY s.pid, s.started_at, e.session_id, e.seq`).all()) as Row[];
  return rows.map((r) => ({ ...sessionCols(r), ...eventFromRow(r) }));
}

export async function allExitRows(db: DB): Promise<Record<string, unknown>[]> {
  const rows = (await stmt(db, `SELECT x.*, s.pid, s.condition_order, s.set_rotation, s.status, s.protocol_version
    FROM exit_surveys x JOIN sessions s ON s.session_id = x.session_id
    ORDER BY s.pid, s.started_at, x.session_id`).all()) as Row[];
  return rows.map((r) => ({ ...sessionCols(r), ...exitFromRow(r) }));
}

export async function allSessionsFull(db: DB): Promise<unknown[]> {
  const sessions = (await stmt(db, "SELECT * FROM sessions ORDER BY pid, started_at, session_id").all()) as Row[];
  return (await Promise.all(sessions.map(async (s) => {
    const id = s.session_id;
    const trials = (await getTrials(db, id));
    const surveys = ((await stmt(db, "SELECT * FROM block_surveys WHERE session_id = ? ORDER BY block_index").all(id)) as Row[])
      .map((r) => surveyFromRow(r));
    const blocks = ((await stmt(db, "SELECT * FROM blocks WHERE session_id = ? ORDER BY block_index").all(id)) as Row[])
      .map((r) => ({
        ...blockFromRow(r),
        startedAt: r.started_at ?? null,
        endedAt: r.ended_at ?? null,
        trials: trials.filter((t) => t.blockIndex === r.block_index),
        survey: surveys.find((sv) => sv.blockIndex === r.block_index) ?? null,
      }));
    const exit = (await stmt(db, "SELECT * FROM exit_surveys WHERE session_id = ?").get(id)) as Row | undefined;
    const events = ((await stmt(db, "SELECT * FROM events WHERE session_id = ? ORDER BY seq").all(id)) as Row[]).map(eventFromRow);
    return {
      schemaVersion: 1,
      sessionId: id,
      pid: s.pid,
      conditionOrder: splitOrder(s.condition_order),
      setRotation: s.set_rotation,
      seed: s.seed,
      consequenceBanner: toBool(s.consequence_banner),
      anxiety: toBool(s.anxiety),
      status: s.status,
      protocolVersion: s.protocol_version ?? "legacy-full-v1",
      consentAt: s.consent_at ?? null,
      startedAt: s.started_at,
      completedAt: s.completed_at ?? null,
      cursor: { blockIndex: s.cursor_block, positionInBlock: s.cursor_position, phase: s.cursor_phase },
      resumeCount: s.resume_count,
      appVersion: s.app_version,
      postBankHash: s.post_bank_hash,
      blocks,
      events,
      exitSurvey: exit ? exitFromRow(exit) : null,
    };
  })));
}
