// Label engine: post bank validation, allow-listed payload builders, ground-truth lookup.
// Server-only module (imports node:crypto). The client must never import this file or posts.json.
// Sources: docs/ai-design.md §2–§4, docs/data-model.md §2, app/CONTRACT.md.
import { createHash } from "node:crypto";
import type {
  Condition, Difficulty, ErrorType, Factor, FactorKey, Label, Post, PostBank, PracticePost,
  Presentation, SetId, Topic, Truth,
} from "./types";
import type { PracticePresentation } from "./api";

const SETS: readonly SetId[] = ["S1", "S2", "S3", "S4"];
const TOPICS: readonly Topic[] = ["env", "svc", "evt"];
const FACTOR_KEYS: readonly FactorKey[] = ["source", "claimVsRecord", "wording"];
const FACTOR_LABELS: Record<FactorKey, Factor["label"]> = {
  source: "Source",
  claimVsRecord: "Claim vs record",
  wording: "Wording",
};
const CONDITIONS: readonly Condition[] = ["A", "B", "C", "D"];
const POSTS_PER_BANK = 24;
const POSTS_PER_SET = 6;
const POST_IMAGE_PATHS = [
  "/post-images/environment.png", "/post-images/public-services.png", "/post-images/local-events.png",
];

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** Structural checks on one raw post-like object (before the semantic checks of validatePost). */
function shapeProblems(raw: unknown, where: string, practice: boolean): string[] {
  const out: string[] = [];
  if (!isObj(raw)) return [`${where}: not an object`];
  const id = isStr(raw.id) ? raw.id : where;
  const bad = (msg: string) => out.push(`${id}: ${msg}`);

  if (practice) {
    if (raw.id !== "practice-01") bad(`practice id must be "practice-01"`);
    if (raw.set !== null) bad("practice set must be null");
  } else {
    if (!isStr(raw.id)) bad("id missing");
    if (!SETS.includes(raw.set as SetId)) bad(`set must be one of ${SETS.join("/")}`);
  }
  if (!TOPICS.includes(raw.topic as Topic)) bad(`topic must be one of ${TOPICS.join("/")}`);

  const a = raw.author;
  if (!isObj(a) || !isStr(a.handle) || !isStr(a.displayName) || typeof a.verified !== "boolean") {
    bad("author must have handle, displayName (strings) and verified (boolean)");
  }
  if (!isStr(raw.text)) bad("text missing");
  if (!isStr(raw.postedAgo)) bad("postedAgo missing");
  if (!isCount(raw.likes)) bad("likes must be a non-negative integer");
  if (!isCount(raw.reposts)) bad("reposts must be a non-negative integer");

  if (raw.context !== undefined) {
    const context = raw.context;
    if (!isObj(context)) {
      bad("context must be an object");
    } else {
      if (!isCount(context.likes)) bad("context.likes must be a non-negative integer");
      if (!isCount(context.reposts)) bad("context.reposts must be a non-negative integer");
      const image = context.image;
      if (!isObj(image)) {
        bad("context.image must be an object");
      } else {
        if (typeof image.src !== "string" || !POST_IMAGE_PATHS.includes(image.src)) {
          bad("context.image.src must be an allow-listed same-origin /post-images/ PNG path");
        }
        if (!isStr(image.alt)) bad("context.image.alt must be a non-empty neutral scene description");
        if (!isCount(image.width) || image.width === 0) bad("context.image.width must be a positive integer");
        if (!isCount(image.height) || image.height === 0) bad("context.image.height must be a positive integer");
      }
    }
  }

  const k = raw.keyFact;
  if (!isObj(k) || typeof k.claimValue !== "string" || typeof k.recordValue !== "string") {
    bad("keyFact must have claimValue and recordValue strings");
  }
  const fs = raw.factSheet;
  if (!isObj(fs) || !isStr(fs.title) || !isStr(fs.body) || !isStr(fs.source)) {
    bad("factSheet must have title, body and source strings");
  }
  if (raw.groundTruth !== "TRUE" && raw.groundTruth !== "FALSE") bad(`groundTruth must be "TRUE" or "FALSE"`);
  if (raw.aiLabel !== "accurate" && raw.aiLabel !== "misleading") bad(`aiLabel must be "accurate" or "misleading"`);
  if (typeof raw.isAiCorrect !== "boolean") bad("isAiCorrect must be boolean");
  if (![null, "false_alarm", "miss"].includes(raw.errorType as string | null)) bad("errorType must be null, false_alarm or miss");
  if (![null, "clear", "subtle"].includes(raw.difficulty as string | null)) bad("difficulty must be null, clear or subtle");
  if (!isStr(raw.staticExplanation)) bad("staticExplanation missing");
  if (!isStr(raw.counterfactualExplanation)) bad("counterfactualExplanation missing");

  if (!Array.isArray(raw.factors) || raw.factors.length !== 3) {
    bad("factors must be an array of 3");
  } else {
    raw.factors.forEach((f, i) => {
      if (!isObj(f) || typeof f.key !== "string" || typeof f.label !== "string" ||
          typeof f.displayValue !== "string" || typeof f.passes !== "boolean" || typeof f.detail !== "string") {
        bad(`factors[${i}] must have key, label, displayValue, detail (strings) and passes (boolean)`);
      }
    });
  }
  return out;
}

/** Semantic checks. Returns [] when the post is valid. Works for PracticePost too. */
export function validatePost(p: Post | PracticePost): string[] {
  const out: string[] = [];
  const bad = (msg: string) => out.push(`${p.id}: ${msg}`);

  const expectedTruth: Truth = p.keyFact.claimValue === p.keyFact.recordValue ? "TRUE" : "FALSE";
  if (p.groundTruth !== expectedTruth) {
    bad(`groundTruth is ${p.groundTruth} but keyFact says ${expectedTruth}`);
  }
  const correct = (p.aiLabel === "accurate") === (p.groundTruth === "TRUE");
  if (p.isAiCorrect !== correct) bad(`isAiCorrect is ${p.isAiCorrect} but should be ${correct}`);

  const expectedErr: ErrorType = correct ? null : p.aiLabel === "misleading" ? "false_alarm" : "miss";
  if (p.errorType !== expectedErr) bad(`errorType is ${String(p.errorType)} but should be ${String(expectedErr)}`);
  const d: Difficulty = p.difficulty;
  if (correct && d !== null) bad("difficulty must be null on a correct label");
  if (!correct && d !== "clear" && d !== "subtle") bad("difficulty must be clear or subtle on a wrong label");

  const factors = Array.isArray(p.factors) ? p.factors : [];
  const keys = factors.map((f) => f.key).join(",");
  if (factors.length !== 3 || keys !== FACTOR_KEYS.join(",")) {
    bad(`factors must be exactly ${FACTOR_KEYS.join(", ")} in that order (got ${keys || "none"})`);
  } else {
    factors.forEach((f) => {
      if (f.label !== FACTOR_LABELS[f.key]) bad(`factor ${f.key} label must be "${FACTOR_LABELS[f.key]}"`);
      if (!f.detail || f.detail.trim().length === 0) bad(`factor ${f.key} detail is empty`);
      if (!f.displayValue || f.displayValue.trim().length === 0) bad(`factor ${f.key} displayValue is empty`);
    });
    const [src, cvr, wording] = factors;
    if (cvr.passes !== (p.groundTruth === "TRUE")) {
      bad("claimVsRecord.passes must equal the true comparison (groundTruth === TRUE)");
    }
    if (src.passes !== p.author.verified) bad("source.passes must equal author.verified");
    if (wording.passes !== (wording.displayValue === "Neutral")) {
      bad(`wording.passes must be true exactly when displayValue is "Neutral"`);
    }
  }

  const bWords = wordCount(p.staticExplanation ?? "");
  if (bWords < 8 || bWords > 14) bad(`staticExplanation has ${bWords} words (must be 8-14)`);
  const bPrefix = p.aiLabel === "misleading" ? "Flagged:" : "Checked:";
  if (!(p.staticExplanation ?? "").startsWith(bPrefix)) bad(`staticExplanation must start with "${bPrefix}"`);

  const dWords = wordCount(p.counterfactualExplanation ?? "");
  if (dWords < 10 || dWords > 16) bad(`counterfactualExplanation has ${dWords} words (must be 10-16)`);
  const dPrefix = `This would be labeled ${p.aiLabel === "misleading" ? "accurate" : "misleading"} if`;
  if (!(p.counterfactualExplanation ?? "").startsWith(dPrefix)) {
    bad(`counterfactualExplanation must start with "${dPrefix}"`);
  }
  return out;
}

/** Validates shape and every post (and the practice post); throws one Error listing every problem. */
export function loadPostBank(raw: unknown): PostBank {
  const problems: string[] = [];
  if (!isObj(raw)) throw new Error("Post bank invalid:\n- root is not an object");
  if (raw.schemaVersion !== 1) problems.push("schemaVersion must be 1");

  if (raw.practice === undefined) {
    problems.push("practice post missing");
  } else {
    const s = shapeProblems(raw.practice, "practice", true);
    problems.push(...s);
    if (s.length === 0) problems.push(...validatePost(raw.practice as PracticePost));
  }

  if (!Array.isArray(raw.posts)) {
    problems.push("posts must be an array");
  } else {
    if (raw.posts.length !== POSTS_PER_BANK) {
      problems.push(`posts must have ${POSTS_PER_BANK} entries (got ${raw.posts.length})`);
    }
    const seen = new Set<string>();
    const perSet: Record<string, number> = {};
    raw.posts.forEach((p, i) => {
      const s = shapeProblems(p, `posts[${i}]`, false);
      problems.push(...s);
      if (s.length > 0) return;
      const post = p as Post;
      if (seen.has(post.id)) problems.push(`${post.id}: duplicate id`);
      seen.add(post.id);
      perSet[post.set] = (perSet[post.set] ?? 0) + 1;
      problems.push(...validatePost(post));
    });
    if (raw.posts.length === POSTS_PER_BANK) {
      for (const set of SETS) {
        if ((perSet[set] ?? 0) !== POSTS_PER_SET) {
          problems.push(`set ${set} must have ${POSTS_PER_SET} posts (got ${perSet[set] ?? 0})`);
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Post bank invalid (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n- ${problems.join("\n- ")}`);
  }
  return raw as unknown as PostBank;
}

function copyFactor(f: Factor): Factor {
  return { key: f.key, label: f.label, displayValue: f.displayValue, passes: f.passes, detail: f.detail };
}

function copyFactors(fs: [Factor, Factor, Factor]): [Factor, Factor, Factor] {
  return [copyFactor(fs[0]), copyFactor(fs[1]), copyFactor(fs[2])];
}

export interface PresentationOptions {
  contextMedia?: boolean;
}

/** Opt-in scene and count profile; explicitly copy image fields across the truth boundary. */
function presentationContext(p: Post | PracticePost, options: PresentationOptions): Pick<Presentation, "likes" | "reposts" | "image"> {
  if (!options.contextMedia || !p.context) return { likes: p.likes, reposts: p.reposts };
  const { image } = p.context;
  return {
    likes: p.context.likes,
    reposts: p.context.reposts,
    image: { src: image.src, alt: image.alt, width: image.width, height: image.height },
  };
}

/** Allow-listed view payload. Never spreads the post, so correctness fields cannot leak. */
export function buildPresentation(p: Post, condition: Condition, options: PresentationOptions = {}): Presentation {
  if (!CONDITIONS.includes(condition)) throw new Error(`Unknown condition: ${String(condition)}`);
  const base: Presentation = {
    postId: p.id,
    condition,
    author: { handle: p.author.handle, displayName: p.author.displayName, verified: p.author.verified },
    text: p.text,
    postedAgo: p.postedAgo,
    ...presentationContext(p, options),
    factSheet: { title: p.factSheet.title, body: p.factSheet.body, source: p.factSheet.source },
    aiLabel: p.aiLabel,
  };
  switch (condition) {
    case "A": return base;
    case "B": return { ...base, staticExplanation: p.staticExplanation };
    case "C": return { ...base, factors: copyFactors(p.factors) };
    case "D": return { ...base, counterfactualExplanation: p.counterfactualExplanation };
  }
}

/** Practice payload: allow-listed, keeps all explanation fields (instructions demo every condition). */
export function buildPracticePresentation(p: PracticePost, options: PresentationOptions = {}): PracticePresentation {
  return {
    id: p.id,
    set: null,
    topic: p.topic,
    author: { handle: p.author.handle, displayName: p.author.displayName, verified: p.author.verified },
    text: p.text,
    postedAgo: p.postedAgo,
    ...presentationContext(p, options),
    factSheet: { title: p.factSheet.title, body: p.factSheet.body, source: p.factSheet.source },
    aiLabel: p.aiLabel,
    staticExplanation: p.staticExplanation,
    factors: copyFactors(p.factors),
    counterfactualExplanation: p.counterfactualExplanation,
  };
}

export interface PostTruth {
  groundTruth: Truth;
  isAiCorrect: boolean;
  errorType: ErrorType;
  difficulty: Difficulty;
  aiLabel: Label;
  topic: Topic;
  set: SetId;
}

/** Server-only correctness lookup used when deriving trial rows. Throws on an unknown id. */
export function getTruth(bank: PostBank, postId: string): PostTruth {
  const p = bank.posts.find((x) => x.id === postId);
  if (!p) throw new Error(`Unknown post id: ${postId}`);
  return {
    groundTruth: p.groundTruth,
    isAiCorrect: p.isAiCorrect,
    errorType: p.errorType,
    difficulty: p.difficulty,
    aiLabel: p.aiLabel,
    topic: p.topic,
    set: p.set,
  };
}

/** sha-256 hex of JSON.stringify(bank); stored per session to tie data to the exact stimuli. */
export function postBankHash(bank: PostBank): string {
  return createHash("sha256").update(JSON.stringify(bank)).digest("hex");
}
