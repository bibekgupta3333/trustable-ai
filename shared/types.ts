// Shared domain types. Source: docs/data-model.md §3 (keep in sync).
// The SessionStoreRoot type is legacy (v3 docs used localStorage); the app now persists to SQLite on the server.

// ---------- shared enums ----------
export type StudyProtocol = "legacy-full-v1" | "calibrated-brief-v1" | "calibrated-full-v1" | "calibrated-media-full-v1";
export type QuestionnaireVersion = "full-v1" | "brief-v1";
export const CURRENT_PROTOCOL: StudyProtocol = "calibrated-full-v1";

export type Condition = "A" | "B" | "C" | "D";
export type Label = "accurate" | "misleading";       // shown as "Likely accurate" / "Likely misleading"
export type Truth = "TRUE" | "FALSE";
export type ErrorType = null | "false_alarm" | "miss";
export type Difficulty = null | "clear" | "subtle";
export type SetId = "S1" | "S2" | "S3" | "S4";
export type Topic = "env" | "svc" | "evt";
export type FactorKey = "source" | "claimVsRecord" | "wording";
export type Likert7 = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type Tlx100 = number;   // 0-100, multiple of 5

// ---------- static: posts.json ----------
export interface Author {
  handle: string;             // "@..." fictional
  displayName: string;
  verified: boolean;
}

export interface KeyFact {
  claimValue: string;         // what the post claims, canonical short form
  recordValue: string;        // what the fact sheet says, same form
}

export interface FactSheet {
  title: string;
  body: string;               // 1-3 sentences, contains the key fact
  source: string;             // ends with "(fictional)"
}

export interface Factor {
  key: FactorKey;
  label: "Source" | "Claim vs record" | "Wording";
  displayValue: string;       // true value as shown
  passes: boolean;            // true comparison; true = points to "accurate"
  detail: string;             // argues for the AI label (stimuli.md)
}

export interface PostImage {
  src: string;                // same-origin, immutable /post-images/ asset
  alt: string;                // neutral scene description; no claim verification
  width: number;
  height: number;
}

export interface PostContext {
  image: PostImage;
  likes: number;
  reposts: number;
}

export interface Post {
  id: string;                 // "p01".."p24"
  set: SetId;
  topic: Topic;
  author: Author;
  text: string;
  postedAgo: string;
  likes: number;
  reposts: number;
  context?: PostContext;       // versioned realism profile; historical presentation stays unchanged
  keyFact: KeyFact;
  factSheet: FactSheet;
  groundTruth: Truth;
  aiLabel: Label;
  isAiCorrect: boolean;
  errorType: ErrorType;
  difficulty: Difficulty;
  staticExplanation: string;          // B, 8-14 words
  factors: [Factor, Factor, Factor];  // source, claimVsRecord, wording
  counterfactualExplanation: string;  // D, 10-16 words
}

export interface PracticePost extends Omit<Post, "id" | "set"> {
  id: "practice-01";
  set: null;
}

export interface PostBank {
  schemaVersion: 1;
  practice: PracticePost;     // shown once in InstructionsScreen, never a Trial
  posts: Post[];              // length 24
}

// What a condition view receives from buildPresentation(post, condition).
// Allow-listed: no groundTruth, isAiCorrect, errorType, difficulty or keyFact.
export interface Presentation {
  postId: string;
  condition: Condition;
  author: Author;
  text: string;
  postedAgo: string;
  likes: number;
  reposts: number;
  image?: PostImage;
  factSheet: FactSheet;
  aiLabel: Label;
  staticExplanation?: string;          // B only
  factors?: [Factor, Factor, Factor];  // C only
  counterfactualExplanation?: string;  // D only
}

// ---------- static: surveyItems.json ----------
export interface TrustItem {
  id: string;                 // "jian-01".."jian-12"
  order: number;
  text: string;
  reverse: boolean;           // true for orders 1-5
  subscale: "distrust" | "trust";
}

export interface SimpleItem {
  id: string;
  order: number;
  text: string;
}

export interface ScaleItem {
  id: "tension" | "frustrationTlx" | "confidence" | "briefTrust";
  text: string;
  min: number;
  max: number;
  step: number;
  minLabel: string;
  maxLabel: string;
  widget: "likert" | "slider";
  start?: number;             // slider only: 50
}

export interface SurveyItems {
  schemaVersion: 1;
  trustScale: { min: 1; max: 7; minLabel: string; maxLabel: string };
  trustItems: TrustItem[];    // length 12
  fairnessScale: { min: 1; max: 7; minLabel: string; maxLabel: string };
  fairnessItems: SimpleItem[]; // length 2
  tension: ScaleItem;
  frustrationTlx: ScaleItem;
  confidence: ScaleItem;
  briefTrust?: ScaleItem; // custom single-item perceived trust; not a Jian short form
}

// ---------- session log (localStorage) ----------
export type EventType =
  | "session_start" | "session_resume" | "consent_given"
  | "practice_start" | "practice_complete" | "block_start"
  | "trial_shown" | "fact_sheet_open" | "fact_sheet_close"
  | "why_open" | "why_close" | "factor_expand" | "factor_collapse"
  | "decision_agree" | "decision_disagree" | "confidence_submit"
  | "visibility_hidden" | "visibility_visible"
  | "block_survey_submit" | "exit_survey_submit" | "session_complete";

export interface InteractionEvent {
  eventId: string;            // `${sessionId}-${seq}`
  seq: number;
  trialId: string | null;
  type: EventType;
  factorKey: FactorKey | null;
  tMs: number | null;         // since trial_shown
  perfNow: number;            // performance.now()
  wallClock: string;          // ISO 8601
}

export interface Trial {
  trialId: string;            // `${pid}-${blockIndex}-${positionInBlock}`
  blockIndex: 1 | 2 | 3 | 4;
  positionInBlock: 1 | 2 | 3 | 4 | 5 | 6;
  trialIndex: number;         // 1-8 short / 1-24 saved legacy
  postId: string;
  condition: Condition;
  set: SetId;
  topic: Topic;
  aiLabel: Label;
  groundTruth: Truth;
  isAiCorrect: boolean;
  errorType: ErrorType;
  difficulty: Difficulty;
  agreed: boolean;                   // true = "Agree with label"
  detectedError: boolean | null;     // wrong labels only
  confidence: Likert7;               // required, never null
  labelShownAt: string;
  respondedAt: string;
  decisionTimeMs: number;            // decisionTimeRawMs - hiddenMs
  decisionTimeRawMs: number;
  hiddenMs: number;
  hiddenCount: number;
  blurCount: number;
  timingFlag: boolean;               // hiddenCount > 0 or decisionTimeMs > 120000
  factSheetOpened: boolean;
  factSheetOpenMs: number;
  explanationOpened: boolean | null; // C only
  factorsExpanded: FactorKey[];      // C only; [] otherwise
  timeToFirstExpandMs: number | null;
  resumed: boolean;
}

export interface TrustResponse {
  itemId: string;
  raw: Likert7;
  scored: Likert7;
}

export interface BlockSurvey {
  blockIndex: 1 | 2 | 3 | 4;
  condition: Condition;
  questionnaireVersion?: QuestionnaireVersion; // absent means historical full-v1
  briefTrust?: Likert7 | null;       // brief-v1 only, custom item
  trustResponses: TrustResponse[];  // 12 full-v1 / empty brief-v1
  trustMean: number | null;          // Jian score only; null for brief-v1
  fairness1: Likert7 | null;
  fairness2: Likert7 | null;
  fairnessMean: number | null;       // not collected in brief-v1
  tension: Likert7;                 // H3
  frustrationTlx: Tlx100;           // H3; 0-100 in steps of 5
  frustrationTlxTouched: boolean;   // slider moved at least once
  nWrongDetected: 0 | 1 | 2;        // H3 predictor
  anxiety: number[] | null;         // optional, off by default
  submittedAt: string;
}

export interface Block {
  blockIndex: 1 | 2 | 3 | 4;
  condition: Condition;
  set: SetId;
  postOrder: string[];        // 2 short / 6 saved legacy post ids
  startedAt: string | null;
  endedAt: string | null;
  trials: Trial[];
  survey: BlockSurvey | null;
}

export interface ExitSurvey {
  ageRange: "18-24" | "25-34" | "35-44" | "45-54" | "55+" | "prefer_not";
  gender: "woman" | "man" | "nonbinary" | "self_describe" | "prefer_not" | null;
  education: "high_school" | "some_college" | "bachelors" | "graduate" | "prefer_not";
  socialMediaUse: "never" | "less_than_weekly" | "weekly" | "daily" | "several_daily";
  labelExposure: "never" | "rarely" | "sometimes" | "often";
  preferredCondition: Condition | "none";
  comment: string;
  submittedAt: string;
}

export type Phase =
  | "consent" | "instructions" | "trial" | "post_rating"
  | "block_survey" | "exit_survey" | "done";

export interface Session {
  protocolVersion?: StudyProtocol;
  schemaVersion: 1;
  sessionId: string;
  pid: number;
  conditionOrder: [Condition, Condition, Condition, Condition];
  setRotation: 0 | 1 | 2 | 3;
  seed: number;
  consequenceBanner: boolean; // optional feature, default false
  anxiety: boolean;           // optional feature, default false
  status: "in_progress" | "completed" | "abandoned";
  consentAt: string | null;
  startedAt: string;
  completedAt: string | null;
  cursor: { blockIndex: 1 | 2 | 3 | 4; positionInBlock: 1 | 2 | 3 | 4 | 5 | 6; phase: Phase };
  resumeCount: number;
  appVersion: string;
  postBankHash: string;
  submittedAt: string | null; // optional VITE_SUBMIT_URL add-on only; null otherwise
  blocks: [Block, Block, Block, Block];
  events: InteractionEvent[];
  exitSurvey: ExitSurvey | null;
}

export interface SessionStoreRoot {
  schemaVersion: 1;
  activeSessionId: string | null;
  sessions: Record<string, Session>; // keyed by sessionId
}
