// Export builders for /api/admin/export/:name. Column lists are binding (app/CONTRACT.md "CSV columns").
// Rows come from server/db/repo.ts (camelCase). Session-level fields (pid, conditionOrder, setRotation,
// status) are filled from the sessions table when a repo row does not carry them, and a few likely
// naming variants are accepted, so the exports do not depend on exactly how repo joins.
// Row order is repo's (pid, session start, block/position or seq).
import { asAsyncDatabase, type DatabaseInput } from "../db/async.js";
import { toCsv } from "./csv.js";
import { allEventRows, allExitRows, allSessionsFull, allSurveyRows, allTrialRows } from "../db/repo.js";
import { computeKpis, median, mean, relianceSummary, PILOT_PID_MIN } from "../kpi.js";
import type { Kpis } from "../kpi.js";

import { CURRENT_PROTOCOL, type StudyProtocol } from "../../shared/types.js";

type Row = Record<string, unknown>;

export const TRIAL_COLUMNS = [
  "pid", "sessionId", "trialId", "blockIndex", "positionInBlock", "trialIndex", "condition", "set", "postId",
  "topic", "aiLabel", "groundTruth", "isAiCorrect", "errorType", "difficulty", "agreed", "detectedError",
  "confidence", "decisionTimeMs", "decisionTimeRawMs", "hiddenMs", "hiddenCount", "blurCount", "timingFlag",
  "factSheetOpened", "factSheetOpenMs", "explanationOpened", "factorsExpanded", "timeToFirstExpandMs",
  "resumed", "labelShownAt", "respondedAt", "conditionOrder", "setRotation", "status", "plannedTrials", "studyVariant", "protocolVersion",
];

const pad2 = (n: number) => String(n).padStart(2, "0");
const TRUST_RAW = Array.from({ length: 12 }, (_, i) => `trust_${pad2(i + 1)}`);
const TRUST_SCORED = TRUST_RAW.map((c) => `${c}_s`);

export const SURVEY_COLUMNS = [
  "pid", "sessionId", "blockIndex", "condition", ...TRUST_RAW, ...TRUST_SCORED, "trustMean",
  "fairness1", "fairness2", "fairnessMean", "tension", "frustrationTlx", "frustrationTlxTouched",
  "nWrongDetected", "submittedAt", "plannedTrials", "studyVariant", "protocolVersion", "questionnaireVersion", "briefTrust",
];

export const EVENT_COLUMNS = [
  "pid", "sessionId", "seq", "trialId", "blockIndex", "condition", "postId", "type", "factorKey", "tMs",
  "perfNow", "wallClock", "protocolVersion",
];

export const EXIT_COLUMNS = [
  "pid", "sessionId", "ageRange", "gender", "education", "socialMediaUse", "labelExposure",
  "preferredCondition", "comment", "submittedAt", "protocolVersion",
];

const TRIAL_BOOLEANS = ["isAiCorrect", "agreed", "detectedError", "timingFlag", "factSheetOpened", "explanationOpened", "resumed"];

interface SessionMeta { pid: number; conditionOrder: string; setRotation: number; status: string; plannedTrials: number; studyVariant: string; protocolVersion: StudyProtocol }

async function sessionMeta(db: DatabaseInput): Promise<Map<string, SessionMeta>> {
  const rows = await asAsyncDatabase(db)
    .prepare(`SELECT s.session_id, s.pid, s.condition_order, s.set_rotation, s.status, s.protocol_version,
      (SELECT COALESCE(SUM(json_array_length(b.post_order)),0) FROM blocks b WHERE b.session_id=s.session_id) AS planned_trials FROM sessions s`)
    .all() as { session_id: string; pid: number; condition_order: string; set_rotation: number; status: string; protocol_version: StudyProtocol; planned_trials: number }[];
  return new Map(rows.map((r) => [r.session_id, {
    protocolVersion: r.protocol_version, pid: r.pid, conditionOrder: r.condition_order, setRotation: r.set_rotation, status: r.status,
    plannedTrials: r.planned_trials, studyVariant: r.planned_trials === 8 ? "short-8" : r.planned_trials === 24 ? "legacy-24" : `custom-${r.planned_trials}`,
  }]));
}

/** First defined (non-undefined) value among the given keys. */
function pick(row: Row, ...keys: string[]): unknown {
  for (const k of keys) if (row[k] !== undefined) return row[k];
  return undefined;
}

/** 0/1 (SQLite) -> boolean; null stays null. */
function toBool(v: unknown): unknown {
  if (v === 0 || v === "0") return false;
  if (v === 1 || v === "1") return true;
  return v;
}

/** JSON-string arrays (e.g. trust_raw) -> arrays. */
function toArray(v: unknown): unknown[] | undefined {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : undefined; } catch { return undefined; }
  }
  return undefined;
}

function orderString(v: unknown): unknown {
  return Array.isArray(v) ? v.join("") : v;
}

function withSession(row: Row, meta: Map<string, SessionMeta>): Row {
  const sessionId = pick(row, "sessionId", "session_id") as string | undefined;
  const m = sessionId ? meta.get(sessionId) : undefined;
  return {
    ...row,
    sessionId,
    pid: pick(row, "pid") ?? m?.pid,
    conditionOrder: orderString(pick(row, "conditionOrder") ?? m?.conditionOrder),
    setRotation: pick(row, "setRotation") ?? m?.setRotation,
    status: pick(row, "status", "sessionStatus") ?? m?.status,
    plannedTrials: m?.plannedTrials,
    studyVariant: m?.studyVariant,
    protocolVersion: m?.protocolVersion,
  };
}

export async function trialRows(db: DatabaseInput): Promise<Row[]> {
  const meta = await sessionMeta(db);
  return (await allTrialRows(db)).map((r) => {
    const row = withSession(r, meta);
    row.set = pick(r, "set", "setId");
    for (const k of TRIAL_BOOLEANS) row[k] = toBool(row[k]);
    const fe = row.factorsExpanded;
    row.factorsExpanded = toArray(fe) ?? (fe ?? "");
    return row;
  });
}

export async function surveyRows(db: DatabaseInput): Promise<Row[]> {
  const meta = await sessionMeta(db);
  return (await allSurveyRows(db)).map((r) => {
    const row = withSession(r, meta);
    const responses = toArray(r.trustResponses) as { raw?: unknown; scored?: unknown }[] | undefined;
    const raw = toArray(r.trustRaw) ?? responses?.map((x) => x?.raw);
    const scored = toArray(r.trustScored) ?? responses?.map((x) => x?.scored);
    TRUST_RAW.forEach((c, i) => { if (row[c] === undefined) row[c] = raw?.[i]; });
    TRUST_SCORED.forEach((c, i) => { if (row[c] === undefined) row[c] = scored?.[i]; });
    row.fairness1 = pick(r, "fairness1", "fairness_1");
    row.fairness2 = pick(r, "fairness2", "fairness_2");
    row.questionnaireVersion = r.questionnaireVersion ?? "full-v1";
    row.briefTrust = r.briefTrust ?? null;
    row.frustrationTlxTouched = toBool(row.frustrationTlxTouched);
    return row;
  });
}

export async function eventRows(db: DatabaseInput): Promise<Row[]> {
  const meta = await sessionMeta(db);
  return (await allEventRows(db)).map((r) => withSession(r, meta));
}

export async function exitRows(db: DatabaseInput): Promise<Row[]> {
  const meta = await sessionMeta(db);
  return (await allExitRows(db)).map((r) => withSession(r, meta));
}

export async function trialsCsv(db: DatabaseInput): Promise<string> { return toCsv(await trialRows(db), TRIAL_COLUMNS); }
export async function surveysCsv(db: DatabaseInput): Promise<string> { return toCsv(await surveyRows(db), SURVEY_COLUMNS); }
export async function eventsCsv(db: DatabaseInput): Promise<string> { return toCsv(await eventRows(db), EVENT_COLUMNS); }
export async function exitCsv(db: DatabaseInput): Promise<string> { return toCsv(await exitRows(db), EXIT_COLUMNS); }

/** Array of full sessions (session + blocks + trials + surveys + exit + events), pretty-printed. */
export async function sessionsJson(db: DatabaseInput): Promise<string> {
  return JSON.stringify(await allSessionsFull(db), null, 2);
}

// ---------- participants.csv: one analysis-ready row per session (all statuses, pilots flagged) ----------
// Built straight from SQL so participant_hash can never leak in (it is never selected).

const CONDS = ["A", "B", "C", "D"] as const;

export const PARTICIPANT_COLUMNS = [
  "pid", "sessionId", "isPilot", "status", "conditionOrder", "setRotation", "startedAt", "completedAt",
  "durationMin", "trialsSaved", "surveysSaved", "agreementRate", "wrongDetected", "falseAlarmDetected",
  "missDetected", "detectionRate", "meanConfidence", "medianDecisionMs", "factSheetOpenRate",
  ...CONDS.flatMap((c) => [`agreement_${c}`, `detected_${c}`, `trust_${c}`, `fairness_${c}`, `tension_${c}`, `frustration_${c}`]),
  "ageRange", "gender", "education", "socialMediaUse", "labelExposure", "preferredCondition", "comment", "plannedTrials", "studyVariant",
  "protocolVersion", "questionnaireVersion", "briefTrust",
  "correctAcceptanceRate", "wrongRejectionRate", "appropriateRelianceRate", "overrelianceRate", "underrelianceRate",
  ...CONDS.flatMap((c) => ["correctAcceptanceRate", "wrongRejectionRate", "appropriateRelianceRate", "overrelianceRate", "underrelianceRate", "briefTrust"].map((m) => `${m}_${c}`)),
];

/** Round to `dp` decimals; null for null/non-finite. */
export function round(v: number | null | undefined, dp: number): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
const ratio = (num: number, den: number) => (den === 0 ? null : round(num / den, 3));
const avg = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

interface PSession {
  session_id: string; pid: number; status: string; condition_order: string; set_rotation: number;
  started_at: string; completed_at: string | null;
}
interface PTrial {
  session_id: string; condition: string; is_ai_correct: number; error_type: string | null; agreed: number;
  detected_error: number | null; confidence: number; decision_time_ms: number; fact_sheet_opened: number;
}
interface PSurvey {
  session_id: string; condition: string; trust_mean: number | null; fairness_mean: number | null; brief_trust: number | null; questionnaire_version: string; tension: number; frustration_tlx: number;
}
interface PExit {
  session_id: string; age_range: string; gender: string | null; education: string; social_media_use: string;
  label_exposure: string; preferred_condition: string; comment: string;
}

function groupBy<T extends { session_id: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const list = m.get(r.session_id);
    if (list) list.push(r); else m.set(r.session_id, [r]);
  }
  return m;
}

export async function participantRows(db: DatabaseInput): Promise<Row[]> {
  const meta = await sessionMeta(db);
  const sessions = await asAsyncDatabase(db).prepare(
    `SELECT session_id, pid, status, condition_order, set_rotation, started_at, completed_at
       FROM sessions ORDER BY pid, started_at, session_id`,
  ).all() as PSession[];
  const trials = groupBy(await asAsyncDatabase(db).prepare(
    `SELECT session_id, condition, is_ai_correct, error_type, agreed, detected_error, confidence, decision_time_ms, fact_sheet_opened
       FROM trials`,
  ).all() as PTrial[]);
  const surveys = groupBy(await asAsyncDatabase(db).prepare(
    `SELECT session_id, condition, trust_mean, fairness_mean, brief_trust, questionnaire_version, tension, frustration_tlx FROM block_surveys`,
  ).all() as PSurvey[]);
  const exits = new Map((await asAsyncDatabase(db).prepare(
    `SELECT session_id, age_range, gender, education, social_media_use, label_exposure, preferred_condition, comment
       FROM exit_surveys`,
  ).all() as PExit[]).map((x) => [x.session_id, x]));

  return sessions.map((s) => {
    const ts = trials.get(s.session_id) ?? [];
    const ss = surveys.get(s.session_id) ?? [];
    const x = exits.get(s.session_id);
    const wrong = ts.filter((t) => t.is_ai_correct === 0);
    const detected = (rows: PTrial[]) => rows.filter((t) => t.is_ai_correct === 0 && t.detected_error === 1).length;
    const dur = s.status === "completed" && s.completed_at
      ? (Date.parse(s.completed_at) - Date.parse(s.started_at)) / 60000 : NaN;
    const row: Row = {
      ...relianceSummary(ts),
      protocolVersion: meta.get(s.session_id)?.protocolVersion,
      questionnaireVersion: ss[0]?.questionnaire_version ?? (meta.get(s.session_id)?.protocolVersion === "calibrated-brief-v1" ? "brief-v1" : "full-v1"),
      briefTrust: round(mean(ss.map((v) => v.brief_trust)), 3),
      pid: s.pid,
      sessionId: s.session_id,
      isPilot: s.pid >= PILOT_PID_MIN,
      status: s.status,
      conditionOrder: s.condition_order,
      setRotation: s.set_rotation,
      startedAt: s.started_at,
      completedAt: s.completed_at,
      durationMin: dur >= 0 ? round(dur, 1) : null,
      trialsSaved: ts.length,
      surveysSaved: ss.length,
      plannedTrials: meta.get(s.session_id)?.plannedTrials,
      studyVariant: meta.get(s.session_id)?.studyVariant,
      agreementRate: ratio(ts.filter((t) => t.agreed === 1).length, ts.length),
      wrongDetected: detected(wrong),
      falseAlarmDetected: detected(wrong.filter((t) => t.error_type === "false_alarm")),
      missDetected: detected(wrong.filter((t) => t.error_type === "miss")),
      detectionRate: ratio(detected(wrong), wrong.length),
      meanConfidence: round(avg(ts.map((t) => t.confidence)), 3),
      medianDecisionMs: round(median(ts.map((t) => t.decision_time_ms)), 1),
      factSheetOpenRate: ratio(ts.filter((t) => t.fact_sheet_opened === 1).length, ts.length),
      ageRange: x?.age_range,
      gender: x?.gender,
      education: x?.education,
      socialMediaUse: x?.social_media_use,
      labelExposure: x?.label_exposure,
      preferredCondition: x?.preferred_condition,
      comment: x?.comment,
    };
    for (const c of CONDS) {
      const ct = ts.filter((t) => t.condition === c);
      const sv = ss.find((v) => v.condition === c);
      const reliance = relianceSummary(ct);
      for (const metric of ["correctAcceptanceRate", "wrongRejectionRate", "appropriateRelianceRate", "overrelianceRate", "underrelianceRate"] as const) row[`${metric}_${c}`] = reliance[metric];
      row[`briefTrust_${c}`] = sv?.brief_trust ?? null;
      row[`agreement_${c}`] = ratio(ct.filter((t) => t.agreed === 1).length, ct.length);
      row[`detected_${c}`] = ct.length === 0 ? null : detected(ct);
      row[`trust_${c}`] = round(sv?.trust_mean, 3);
      row[`fairness_${c}`] = round(sv?.fairness_mean, 3);
      row[`tension_${c}`] = sv?.tension;
      row[`frustration_${c}`] = sv?.frustration_tlx;
    }
    return row;
  });
}

export async function participantsCsv(db: DatabaseInput): Promise<string> { return toCsv(await participantRows(db), PARTICIPANT_COLUMNS); }

// ---------- kpis.csv: computeKpis(db) in long/tidy form ----------
export const KPI_COLUMNS = ["section", "key", "metric", "value"];

export function kpiRowsFrom(k: Kpis): Row[] {
  const rows: Row[] = [{ section: "meta", key: "all", metric: "generatedAt", value: k.generatedAt }];
  const add = (section: string, key: string, metric: string, value: unknown) => rows.push({ section, key, metric, value });
  add("meta", "all", "protocolVersion", k.cohort);
  for (const [metric, value] of Object.entries(k.primaryOutcome ?? {})) add("primaryOutcome", "all", metric, value);
  const summary: [string, number | null][] = [
    ["started", k.sessions.started], ["inProgress", k.sessions.inProgress], ["completed", k.sessions.completed],
    ["abandoned", k.sessions.abandoned], ["completionRate", k.sessions.completionRate],
    ["targetN", k.target.n], ["targetMinimum", k.target.minimum],
    ["cycle1Completed", k.target.cycle1Completed], ["cycle2Completed", k.target.cycle2Completed],
    ["durationMedianMin", k.durationMin.median], ["durationP90Min", k.durationMin.p90],
  ];
  for (const [m, v] of summary) add("summary", "all", m, v);
  for (const c of k.byCondition) {
    for (const [m, v] of Object.entries(c)) if (m !== "condition") add("condition", c.condition, m, v);
  }
  for (const e of k.byErrorType) {
    add("errorType", e.errorType, "n", e.n);
    add("errorType", e.errorType, "detectionRate", e.detectionRate);
  }
  for (const b of k.balance) add("balance", b.conditionOrder, "completed", b.completed);
  for (const d of k.dailyCompleted) add("daily", d.date, "completed", d.n);
  return rows;
}

export async function kpiRows(db: DatabaseInput, now: Date = new Date(), protocolVersion: StudyProtocol | "all" = CURRENT_PROTOCOL): Promise<Row[]> { return kpiRowsFrom(await computeKpis(db, now, protocolVersion)); }
export async function kpisCsv(db: DatabaseInput, now: Date = new Date(), protocolVersion: StudyProtocol | "all" = CURRENT_PROTOCOL): Promise<string> { return toCsv(await kpiRows(db, now, protocolVersion), KPI_COLUMNS); }

// ---------- export index (GET /api/admin/export) ----------
export interface ExportIndexEntry { name: string; description: string; rows: number }

const count = async (db: DatabaseInput, table: string): Promise<number> =>
  (await asAsyncDatabase(db).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

export const EXPORT_INDEX: { name: string; description: string; rows: (db: DatabaseInput) => Promise<number> }[] = [
  { name: "participants.csv", description: "One analysis-ready row per session (all statuses, pilots flagged): totals, detection, per-condition scores and exit answers.", rows: (db) => count(db, "sessions") },
  { name: "trials.csv", description: "One row per trial: post, AI label, truth, agreement, detection, confidence, timing and explanation use.", rows: (db) => count(db, "trials") },
  { name: "surveys.csv", description: "One row per block survey: versioned brief trust or legacy Jian items and fairness; tension and frustration.", rows: (db) => count(db, "block_surveys") },
  { name: "events.csv", description: "Interaction log: one row per client event (fact sheet, Why?, factor expands, visibility).", rows: (db) => count(db, "events") },
  { name: "exit.csv", description: "One row per exit survey: demographics, social media use, label exposure, preferred condition, comment.", rows: (db) => count(db, "exit_surveys") },
  { name: "kpis.csv", description: "Dashboard KPIs in long form (section, key, metric, value); current calibrated-full-v1 cohort; outcomes use completed non-pilot sessions.", rows: async (db) => (await kpiRows(db)).length },
  { name: "sessions.json", description: "Full nested record of every session (blocks, trials, surveys, exit, events) for archiving.", rows: (db) => count(db, "sessions") },
];

export async function exportIndex(db: DatabaseInput): Promise<ExportIndexEntry[]> {
  return Promise.all(EXPORT_INDEX.map(async (e) => ({ name: e.name, description: e.description, rows: await e.rows(db) })));
}
