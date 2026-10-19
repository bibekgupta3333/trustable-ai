// Participant-side helpers: a minimal hand-rolled validator, server-side derivations
// (trial fields, block-survey scoring, cursor advance) and the non-session participant routes.
import express from "express";
import type { DatabaseInput } from "../db/async";
import type {
  Condition, FactorKey, Likert7, Post, PostBank, Trial, TrustResponse, BlockSurvey, ExitSurvey,
} from "../../shared/types";
import type {
  Assignment, BlockPlan, BlockSurveySubmission, Cursor, EventSubmission, ExitSurveySubmission, TrialSubmission,
} from "../../shared/api";
import { assignFromBank } from "../../shared/counterbalance";
import { buildPracticePresentation } from "../../shared/labelEngine";

// ---------- errors ----------
export class ValidationError extends Error {
  constructor(public detail: string) {
    super(detail);
    this.name = "ValidationError";
  }
}
export class HttpError extends Error {
  constructor(public status: number, public error: string, public detail?: string) {
    super(detail ?? error);
    this.name = "HttpError";
  }
}
export const notFound = (detail: string) => new HttpError(404, "not_found", detail);

// ---------- minimal validator ----------
type Obj = Record<string, unknown>;

export function asObject(v: unknown, what = "body"): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ValidationError(`${what} must be an object`);
  return v as Obj;
}
export function int(o: Obj, k: string, min?: number, max?: number): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isInteger(v)) throw new ValidationError(`${k} must be an integer`);
  if ((min !== undefined && v < min) || (max !== undefined && v > max))
    throw new ValidationError(`${k} must be between ${min} and ${max}`);
  return v;
}
export function num(o: Obj, k: string, min = 0): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ValidationError(`${k} must be a finite number`);
  if (v < min) throw new ValidationError(`${k} must be >= ${min}`);
  return v;
}
export function bool(o: Obj, k: string): boolean {
  if (typeof o[k] !== "boolean") throw new ValidationError(`${k} must be a boolean`);
  return o[k] as boolean;
}
export function str(o: Obj, k: string, maxLen = 10_000): string {
  const v = o[k];
  if (typeof v !== "string") throw new ValidationError(`${k} must be a string`);
  if (v.length > maxLen) throw new ValidationError(`${k} is too long`);
  return v;
}
export function isoDate(o: Obj, k: string): string {
  const v = str(o, k, 64);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v) || Number.isNaN(Date.parse(v))) throw new ValidationError(`${k} must be an ISO 8601 timestamp`);
  return v;
}
export function oneOf<T extends string | null>(o: Obj, k: string, values: readonly T[]): T {
  const v = o[k] === undefined ? undefined : o[k];
  if (!values.includes(v as T)) throw new ValidationError(`${k} must be one of ${values.map(String).join(", ")}`);
  return v as T;
}
function likert(v: unknown, k: string): Likert7 {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 7) throw new ValidationError(`${k} must be an integer 1-7`);
  return v as Likert7;
}
export function parsePid(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new ValidationError("pid must be a positive integer");
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid) || pid < 1) throw new ValidationError("pid must be a positive integer");
  return pid;
}

/** trim + lowercase; 3-120 chars after normalising, else ValidationError. The raw code is never logged or stored. */
export function normaliseParticipantCode(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("participantCode must be a string");
  const code = raw.trim().toLowerCase();
  if (code.length < 3 || code.length > 120) throw new ValidationError("participantCode must be 3-120 characters");
  return code;
}

/** Assignment preview for any pid (including pilot pids >= 900). Mounted by the admin router at GET /assignments/:pid. */
export function assignmentPreview(bank: PostBank, rawPid: string): Assignment {
  return assignFromBank(parsePid(rawPid), bank);
}

const PHASES = ["consent", "instructions", "trial", "post_rating", "block_survey", "exit_survey", "done"] as const;
const FACTOR_KEYS: readonly FactorKey[] = ["source", "claimVsRecord", "wording"];
const CONDITIONS: readonly Condition[] = ["A", "B", "C", "D"];
const EVENT_TYPES = [
  "session_start", "session_resume", "consent_given", "practice_start", "practice_complete", "block_start",
  "trial_shown", "fact_sheet_open", "fact_sheet_close", "why_open", "why_close", "factor_expand", "factor_collapse",
  "decision_agree", "decision_disagree", "confidence_submit", "visibility_hidden", "visibility_visible",
  "block_survey_submit", "exit_survey_submit", "session_complete",
] as const;

export function validateCursor(raw: unknown): Cursor {
  const o = asObject(raw);
  return {
    blockIndex: int(o, "blockIndex", 1, 4) as Cursor["blockIndex"],
    positionInBlock: int(o, "positionInBlock", 1, 6) as Cursor["positionInBlock"],
    phase: oneOf(o, "phase", PHASES),
  };
}

export function validateTrialSubmission(raw: unknown): TrialSubmission {
  const o = asObject(raw);
  const fe = o.factorsExpanded;
  if (!Array.isArray(fe) || fe.some((k) => !FACTOR_KEYS.includes(k as FactorKey)) || new Set(fe).size !== fe.length)
    throw new ValidationError("factorsExpanded must be an array of distinct factor keys");
  const eo = o.explanationOpened;
  if (eo !== null && typeof eo !== "boolean") throw new ValidationError("explanationOpened must be a boolean or null");
  const tfe = o.timeToFirstExpandMs;
  if (tfe !== null && (typeof tfe !== "number" || !Number.isFinite(tfe) || tfe < 0))
    throw new ValidationError("timeToFirstExpandMs must be a non-negative number or null");
  const t: TrialSubmission = {
    blockIndex: int(o, "blockIndex", 1, 4) as TrialSubmission["blockIndex"],
    positionInBlock: int(o, "positionInBlock", 1, 6) as TrialSubmission["positionInBlock"],
    postId: str(o, "postId", 64),
    agreed: bool(o, "agreed"),
    confidence: likert(o.confidence, "confidence"),
    labelShownAt: isoDate(o, "labelShownAt"),
    respondedAt: isoDate(o, "respondedAt"),
    decisionTimeRawMs: num(o, "decisionTimeRawMs"),
    hiddenMs: num(o, "hiddenMs"),
    hiddenCount: int(o, "hiddenCount", 0),
    blurCount: int(o, "blurCount", 0),
    factSheetOpened: bool(o, "factSheetOpened"),
    factSheetOpenMs: num(o, "factSheetOpenMs"),
    explanationOpened: eo as boolean | null,
    factorsExpanded: fe as FactorKey[],
    timeToFirstExpandMs: tfe as number | null,
    resumed: bool(o, "resumed"),
  };
  if (t.hiddenMs > t.decisionTimeRawMs) throw new ValidationError("hiddenMs cannot exceed decisionTimeRawMs");
  return t;
}

export function validateEvents(raw: unknown): EventSubmission[] {
  const o = asObject(raw);
  if (!Array.isArray(o.events)) throw new ValidationError("events must be an array");
  if (o.events.length > 5000) throw new ValidationError("too many events in one request");
  return o.events.map((e, i) => {
    const ev = asObject(e, `events[${i}]`);
    const nullableStr = (k: string) => {
      if (ev[k] === null) return null;
      return str(ev, k, 128);
    };
    const nullableNum = (k: string) => {
      if (ev[k] === null) return null;
      return num(ev, k, -Infinity);
    };
    return {
      seq: int(ev, "seq", 0),
      trialId: nullableStr("trialId"),
      blockIndex: ev.blockIndex === null ? null : int(ev, "blockIndex", 1, 4),
      condition: oneOf(ev, "condition", [...CONDITIONS, null]),
      postId: nullableStr("postId"),
      type: oneOf(ev, "type", EVENT_TYPES),
      factorKey: oneOf(ev, "factorKey", [...FACTOR_KEYS, null]),
      tMs: nullableNum("tMs"),
      perfNow: num(ev, "perfNow", -Infinity),
      wallClock: isoDate(ev, "wallClock"),
    };
  });
}

export function validateBlockSurvey(raw: unknown): BlockSurveySubmission {
  const o = asObject(raw);
  const version = o.questionnaireVersion === undefined ? "full-v1" : o.questionnaireVersion;
  if (version !== "brief-v1" && version !== "full-v1")
    throw new ValidationError("questionnaireVersion must be brief-v1 or full-v1");
  const tlx = int(o, "frustrationTlx", 0, 100);
  if (tlx % 5 !== 0) throw new ValidationError("frustrationTlx must be a multiple of 5");
  if (o.frustrationTlxTouched !== true) throw new ValidationError("frustrationTlxTouched must be true");
  if (version === "brief-v1") {
    if (["trustRaw", "fairness1", "fairness2", "anxiety"].some((key) => o[key] !== undefined))
      throw new ValidationError("brief-v1 does not accept full questionnaire fields");
    return {
      questionnaireVersion: "brief-v1",
      blockIndex: int(o, "blockIndex", 1, 4) as BlockSurveySubmission["blockIndex"],
      briefTrust: likert(o.briefTrust, "briefTrust"),
      tension: likert(o.tension, "tension"), frustrationTlx: tlx, frustrationTlxTouched: true,
    };
  }
  if (o.briefTrust !== undefined) throw new ValidationError("full-v1 does not accept briefTrust");
  if (!Array.isArray(o.trustRaw) || o.trustRaw.length !== 12) throw new ValidationError("trustRaw must be 12 answers");
  const trustRaw = o.trustRaw.map((v, i) => likert(v, `trustRaw[${i}]`));
  let anxiety: number[] | null = null;
  if (o.anxiety !== undefined && o.anxiety !== null) {
    if (!Array.isArray(o.anxiety) || o.anxiety.some((v) => typeof v !== "number" || !Number.isFinite(v)))
      throw new ValidationError("anxiety must be an array of numbers or null");
    anxiety = o.anxiety as number[];
  }
  return {
    blockIndex: int(o, "blockIndex", 1, 4) as BlockSurveySubmission["blockIndex"],
    questionnaireVersion: "full-v1",
    trustRaw,
    fairness1: likert(o.fairness1, "fairness1"),
    fairness2: likert(o.fairness2, "fairness2"),
    tension: likert(o.tension, "tension"),
    frustrationTlx: tlx,
    frustrationTlxTouched: true,
    anxiety,
  };
}

export function validateExitSurvey(raw: unknown): ExitSurveySubmission {
  const o = asObject(raw);
  return {
    ageRange: oneOf(o, "ageRange", ["18-24", "25-34", "35-44", "45-54", "55+", "prefer_not"] as const),
    gender: oneOf(o, "gender", ["woman", "man", "nonbinary", "self_describe", "prefer_not", null] as const),
    education: oneOf(o, "education", ["high_school", "some_college", "bachelors", "graduate", "prefer_not"] as const),
    socialMediaUse: oneOf(o, "socialMediaUse", ["never", "less_than_weekly", "weekly", "daily", "several_daily"] as const),
    labelExposure: oneOf(o, "labelExposure", ["never", "rarely", "sometimes", "often"] as const),
    preferredCondition: oneOf(o, "preferredCondition", [...CONDITIONS, "none"] as const),
    comment: o.comment === undefined ? "" : str(o, "comment", 5000),
  };
}

// ---------- derivations ----------
/** Builds the full Trial from the client submission, the stored block plan and the post's ground truth. */
export function deriveTrial(pid: number, plan: BlockPlan, post: Post, s: TrialSubmission, trialOffset = (s.blockIndex - 1) * 6): Trial {
  if (s.blockIndex !== plan.blockIndex) throw new ValidationError("blockIndex does not match the block plan");
  const planned = plan.postOrder[s.positionInBlock - 1];
  if (s.postId !== planned || post.id !== planned)
    throw new ValidationError(`postId ${s.postId} does not match the plan (expected ${planned})`);
  const isC = plan.condition === "C";
  if (!isC) {
    if (s.explanationOpened !== null) throw new ValidationError("explanationOpened must be null unless condition C");
    if (s.factorsExpanded.length > 0) throw new ValidationError("factorsExpanded must be empty unless condition C");
    if (s.timeToFirstExpandMs !== null) throw new ValidationError("timeToFirstExpandMs must be null unless condition C");
  } else if (s.explanationOpened === null) {
    throw new ValidationError("explanationOpened must be a boolean in condition C");
  }
  const decisionTimeMs = s.decisionTimeRawMs - s.hiddenMs;
  return {
    trialId: `${pid}-${s.blockIndex}-${s.positionInBlock}`,
    blockIndex: s.blockIndex,
    positionInBlock: s.positionInBlock,
    trialIndex: trialOffset + s.positionInBlock,
    postId: post.id,
    condition: plan.condition,
    set: plan.set,
    topic: post.topic,
    aiLabel: post.aiLabel,
    groundTruth: post.groundTruth,
    isAiCorrect: post.isAiCorrect,
    errorType: post.errorType,
    difficulty: post.difficulty,
    agreed: s.agreed,
    detectedError: post.isAiCorrect ? null : !s.agreed,
    confidence: s.confidence,
    labelShownAt: s.labelShownAt,
    respondedAt: s.respondedAt,
    decisionTimeMs,
    decisionTimeRawMs: s.decisionTimeRawMs,
    hiddenMs: s.hiddenMs,
    hiddenCount: s.hiddenCount,
    blurCount: s.blurCount,
    timingFlag: s.hiddenCount > 0 || decisionTimeMs > 120_000,
    factSheetOpened: s.factSheetOpened,
    factSheetOpenMs: s.factSheetOpenMs,
    explanationOpened: s.explanationOpened,
    factorsExpanded: s.factorsExpanded,
    timeToFirstExpandMs: s.timeToFirstExpandMs,
    resumed: s.resumed,
  };
}

export function cursorAfterTrial(blockIndex: Cursor["blockIndex"], position: Cursor["positionInBlock"], postsPerBlock = 6): Cursor {
  if (position < postsPerBlock) return { blockIndex, positionInBlock: (position + 1) as Cursor["positionInBlock"], phase: "trial" };
  return { blockIndex, positionInBlock: postsPerBlock as Cursor["positionInBlock"], phase: "block_survey" };
}

export function cursorAfterSurvey(blockIndex: Cursor["blockIndex"], postsPerBlock = 6): Cursor {
  if (blockIndex < 4) return { blockIndex: (blockIndex + 1) as Cursor["blockIndex"], positionInBlock: 1, phase: "trial" };
  return { blockIndex: 4, positionInBlock: postsPerBlock as Cursor["positionInBlock"], phase: "exit_survey" };
}

/** Reverse items 1-5 (8 - raw), means, nWrongDetected from saved trials of this block. */
export function scoreBlockSurvey(
  s: BlockSurveySubmission, condition: Condition, blockTrials: Trial[], trustItemIds: string[], submittedAt: string,
): BlockSurvey {
  const nWrongDetected = blockTrials.filter((t) => t.detectedError === true).length;
  if (nWrongDetected > 2) throw new HttpError(500, "invariant", "more than 2 detected errors in one block");
  if (s.questionnaireVersion === "brief-v1") {
    return {
      blockIndex: s.blockIndex, condition, questionnaireVersion: "brief-v1", briefTrust: s.briefTrust,
      trustResponses: [], trustMean: null, fairness1: null, fairness2: null, fairnessMean: null,
      tension: s.tension, frustrationTlx: s.frustrationTlx, frustrationTlxTouched: true,
      nWrongDetected: nWrongDetected as 0 | 1 | 2, anxiety: null, submittedAt,
    };
  }
  const trustResponses: TrustResponse[] = s.trustRaw.map((raw, i) => ({
    itemId: trustItemIds[i],
    raw,
    scored: (i < 5 ? 8 - raw : raw) as Likert7,
  }));
  const trustMean = trustResponses.reduce((a, r) => a + r.scored, 0) / 12;

  return {
    blockIndex: s.blockIndex,
    condition,
    questionnaireVersion: "full-v1", briefTrust: null,
    trustResponses,
    trustMean,
    fairness1: s.fairness1,
    fairness2: s.fairness2,
    fairnessMean: (s.fairness1 + s.fairness2) / 2,
    tension: s.tension,
    frustrationTlx: s.frustrationTlx,
    frustrationTlxTouched: true,
    nWrongDetected: nWrongDetected as 0 | 1 | 2,
    anxiety: s.anxiety ?? null,
    submittedAt,
  };
}

export const TRUST_ITEM_IDS = Array.from({ length: 12 }, (_, i) => `jian-${String(i + 1).padStart(2, "0")}`);

export function exitWithTimestamp(s: ExitSurveySubmission, submittedAt: string): ExitSurvey {
  return { ...s, submittedAt };
}

// ---------- non-session participant routes ----------
export function participantRouter(deps: {
  db: DatabaseInput; bank: PostBank; appVersion: string; postBankHash: string;
}): express.Router {
  const { bank, appVersion, postBankHash } = deps;
  const router = express.Router();

  router.get("/health", (_req, res) => {
    res.json({ ok: true, postBankHash, appVersion });
  });

  // GET /assignments/:pid moved to the admin router (/api/admin/assignments/:pid) — see assignmentPreview().

  router.get("/practice", (req, res) => {
    res.json(buildPracticePresentation(bank.practice, { contextMedia: req.query.contextMedia === "1" }));
  });

  return router;
}
