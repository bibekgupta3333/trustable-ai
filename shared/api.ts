// API contract between the React client and the Express + SQLite server.
// Every agent builds against these types. Do not change a shape without updating API.md.
import type {
  Condition, SetId, Presentation, FactorKey, Likert7, ExitSurvey, EventType, Phase, PracticePost, StudyProtocol, PostImage,
} from "./types";

// ---------- assignment ----------
export interface BlockPlan {
  blockIndex: 1 | 2 | 3 | 4;
  condition: Condition;
  set: SetId;
  postOrder: string[]; // 2 distinct ids for new short sessions; 6 for saved legacy sessions
}

export interface Assignment {
  pid: number;
  conditionOrder: [Condition, Condition, Condition, Condition];
  setRotation: 0 | 1 | 2 | 3;
  seed: number;
  blocks: [BlockPlan, BlockPlan, BlockPlan, BlockPlan];
}

export interface Cursor {
  blockIndex: 1 | 2 | 3 | 4;
  positionInBlock: 1 | 2 | 3 | 4 | 5 | 6;
  phase: Phase;
}

export type SessionStatus = "in_progress" | "completed" | "abandoned";

// What the client may know about a session (no correctness fields).
export interface SessionView {
  sessionId: string;
  pid: number;
  status: SessionStatus;
  protocolVersion?: StudyProtocol; // absent means legacy-full-v1; persisted for real sessions
  conditionOrder: [Condition, Condition, Condition, Condition];
  setRotation: 0 | 1 | 2 | 3;
  blocks: [BlockPlan, BlockPlan, BlockPlan, BlockPlan];
  cursor: Cursor;
  consequenceBanner: boolean;
  anxiety: boolean;
  resumeCount: number;
  nextEventSeq: number; // max stored event seq + 1; the client logger continues from here after a resume
  consentAt: string | null;
  startedAt: string;
  completedAt: string | null;
}

// ---------- requests ----------
// POST /api/sessions (self-start). The server normalises the code (trim + lowercase, 3-120 chars),
// stores only HMAC-SHA256(salt, code) and assigns the pid. 201 new, 200 resume, 409 already_participated.
export interface CreateSessionRequest { participantCode: string; consequenceBanner?: boolean }

// Client-measured fields only. The server derives condition, set, topic, aiLabel,
// groundTruth, isAiCorrect, errorType, difficulty, detectedError, trialIndex,
// decisionTimeMs (= raw - hidden) and timingFlag from the assignment and posts.json.
export interface TrialSubmission {
  blockIndex: 1 | 2 | 3 | 4;
  positionInBlock: 1 | 2 | 3 | 4 | 5 | 6;
  postId: string;
  agreed: boolean;
  confidence: Likert7;
  labelShownAt: string;
  respondedAt: string;
  decisionTimeRawMs: number;
  hiddenMs: number;
  hiddenCount: number;
  blurCount: number;
  factSheetOpened: boolean;
  factSheetOpenMs: number;
  explanationOpened: boolean | null; // null unless condition C
  factorsExpanded: FactorKey[];      // [] unless condition C
  timeToFirstExpandMs: number | null;
  resumed: boolean;
}

export interface EventSubmission {
  seq: number;                 // per-session, strictly increasing, assigned by the client logger
  trialId: string | null;
  blockIndex: number | null;
  condition: Condition | null;
  postId: string | null;
  type: EventType;
  factorKey: FactorKey | null;
  tMs: number | null;
  perfNow: number;
  wallClock: string;
}

export interface FullBlockSurveySubmission {
  questionnaireVersion?: "full-v1";
  blockIndex: 1 | 2 | 3 | 4;
  trustRaw: Likert7[];         // 12 raw answers in item order; server reverse-scores items 1-5
  fairness1: Likert7;
  fairness2: Likert7;
  tension: Likert7;
  frustrationTlx: number;      // 0-100, multiple of 5
  frustrationTlxTouched: boolean; // must be true
  anxiety?: number[] | null;
}

export interface BriefBlockSurveySubmission {
  blockIndex: 1 | 2 | 3 | 4;
  questionnaireVersion: "brief-v1";
  briefTrust: Likert7;
  tension: Likert7;
  frustrationTlx: number;
  frustrationTlxTouched: boolean;
}
export type BlockSurveySubmission = FullBlockSurveySubmission | BriefBlockSurveySubmission;

export type ExitSurveySubmission = Omit<ExitSurvey, "submittedAt">;

// ---------- responses ----------
export interface ApiError { error: string; detail?: string }

export interface TrialSaved { trialId: string; cursor: Cursor }

export interface AdminSessionRow {
  sessionId: string;
  pid: number;
  status: SessionStatus;
  conditionOrder: string; // e.g. "CDBA"
  setRotation: number;
  trialsSaved: number;    // response count, compare with plannedTrials
  protocolVersion?: StudyProtocol;
  plannedTrials?: number; // derived from saved blocks (8 short, 24 legacy)
  studyVariant?: string; // short-8, legacy-24, or custom-N
  surveysSaved: number;   // 0-4
  startedAt: string;
  completedAt: string | null;
  lastActivityAt: string | null;
}

// GET /api/admin/kpis. Pilot pids >= 900 are excluded everywhere; condition and error KPIs use completed sessions only.
export interface RelianceSummary {
  trials: number;
  correctTrials: number;
  wrongTrials: number;
  correctAcceptanceRate: number | null;
  wrongRejectionRate: number | null;
  appropriateRelianceRate: number | null;
  overrelianceRate: number | null;
  underrelianceRate: number | null;
}

export interface Kpis {
  cohort?: StudyProtocol | "all";
  primaryOutcome?: RelianceSummary;
  generatedAt: string;
  sessions: { started: number; inProgress: number; completed: number; abandoned: number; completionRate: number | null };
  target: { n: number; minimum: number; completed: number; cycle1Completed: number; cycle2Completed: number };
  durationMin: { median: number | null; p90: number | null };
  byCondition: Array<{ condition: Condition; trials: number; agreementRate: number | null; wrongTrials: number;
    detectionRate: number | null; falseAlarmDetection: number | null; missDetection: number | null;
    factSheetOpenRate: number | null; meanConfidence: number | null; medianDecisionMs: number | null;
    trustMean: number | null; fairnessMean: number | null; tensionMean: number | null; frustrationMean: number | null;
    correctAcceptanceRate?: number | null; wrongRejectionRate?: number | null; appropriateRelianceRate?: number | null;
    overrelianceRate?: number | null; underrelianceRate?: number | null; briefTrustMean?: number | null }>;
  byErrorType: Array<{ errorType: "false_alarm" | "miss"; n: number; detectionRate: number | null }>;
  balance: Array<{ conditionOrder: string; completed: number }>;
  dailyCompleted: Array<{ date: string; n: number }>;
}

export type PracticePresentation = Omit<PracticePost, "groundTruth" | "isAiCorrect" | "errorType" | "difficulty" | "keyFact" | "context"> & { image?: PostImage };

export type { Presentation };
