import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildPracticePresentation, buildPresentation, getTruth, loadPostBank, postBankHash, validatePost, wordCount,
} from "./labelEngine";
import type { Condition, Label, Post, PostBank, PostContext, PracticePost, SetId, Truth } from "./types";

const FORBIDDEN = ["groundTruth", "isAiCorrect", "errorType", "difficulty", "keyFact", "claimValue", "recordValue"];

function makePost(id: string, set: SetId, truth: Truth, label: Label, difficulty: "clear" | "subtle" = "clear"): Post {
  const correct = (label === "accurate") === (truth === "TRUE");
  return {
    id, set, topic: "env",
    author: { handle: "@riverton_news", displayName: "Riverton News", verified: true },
    text: "The river cleanup is on Saturday at Mill Park.",
    postedAgo: "2h", likes: 10, reposts: 2,
    keyFact: { claimValue: "Saturday", recordValue: truth === "TRUE" ? "Saturday" : "Sunday" },
    factSheet: { title: "Cleanup", body: "The cleanup is on Saturday.", source: "Riverton Parks (fictional)" },
    groundTruth: truth,
    aiLabel: label,
    isAiCorrect: correct,
    errorType: correct ? null : label === "misleading" ? "false_alarm" : "miss",
    difficulty: correct ? null : difficulty,
    staticExplanation: label === "misleading"
      ? "Flagged: event dates shared by accounts are often outdated."
      : "Checked: the date in the post matches the parks record.",
    factors: [
      { key: "source", label: "Source", displayValue: "@riverton_news · verified", passes: true, detail: "Verified local account." },
      { key: "claimVsRecord", label: "Claim vs record", displayValue: "Post: Saturday · Record: Saturday", passes: truth === "TRUE", detail: "The record was compared." },
      { key: "wording", label: "Wording", displayValue: "Neutral", passes: true, detail: "Plain wording." },
    ],
    counterfactualExplanation: label === "misleading"
      ? "This would be labeled accurate if an official page had posted it."
      : "This would be labeled misleading if the date differed from the record.",
  };
}

function makePractice(): PracticePost {
  const p = makePost("x", "S1", "TRUE", "accurate");
  return { ...p, id: "practice-01", set: null };
}

function makeBank(): PostBank {
  const sets: SetId[] = ["S1", "S2", "S3", "S4"];
  const posts: Post[] = [];
  let n = 1;
  for (const set of sets) {
    posts.push(makePost(`p${String(n++).padStart(2, "0")}`, set, "TRUE", "misleading", "clear"));
    posts.push(makePost(`p${String(n++).padStart(2, "0")}`, set, "FALSE", "accurate", "subtle"));
    for (let i = 0; i < 4; i++) {
      posts.push(makePost(`p${String(n++).padStart(2, "0")}`, set, i % 2 ? "TRUE" : "FALSE", i % 2 ? "accurate" : "misleading"));
    }
  }
  return { schemaVersion: 1, practice: makePractice(), posts };
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function mediaContext(): PostContext {
  return {
    image: { src: "/post-images/environment.png", alt: "Trees along a river in a fictional town.", width: 1536, height: 1024 },
    likes: 128,
    reposts: 16,
  };
}

describe("wordCount", () => {
  it("counts whitespace-separated words", () => {
    expect(wordCount("  one two\tthree\nfour ")).toBe(4);
    expect(wordCount("")).toBe(0);
  });
});

describe("validatePost", () => {
  it("accepts valid correct and wrong posts", () => {
    for (const p of makeBank().posts) expect(validatePost(p)).toEqual([]);
    expect(validatePost(makePractice())).toEqual([]);
  });

  const cases: [string, (p: Post) => void, RegExp][] = [
    ["groundTruth vs keyFact", (p) => { p.keyFact.recordValue = "Sunday"; }, /groundTruth/],
    ["isAiCorrect", (p) => { p.isAiCorrect = !p.isAiCorrect; }, /isAiCorrect/],
    ["errorType", (p) => { p.errorType = "miss"; }, /errorType/],
    ["difficulty on correct", (p) => { p.difficulty = "clear"; }, /difficulty/],
    ["factor order", (p) => { p.factors = [p.factors[1], p.factors[0], p.factors[2]]; }, /factors must be exactly/],
    ["factor count", (p) => { (p.factors as unknown as unknown[]).pop(); }, /factors must be exactly/],
    ["claimVsRecord.passes", (p) => { p.factors[1].passes = false; }, /claimVsRecord\.passes/],
    ["source.passes", (p) => { p.factors[0].passes = false; }, /source\.passes/],
    ["wording.passes", (p) => { p.factors[2].passes = false; }, /wording\.passes/],
    ["factor label", (p) => { (p.factors[0] as { label: string }).label = "Src"; }, /label/],
    ["B too short", (p) => { p.staticExplanation = "Checked: too short."; }, /staticExplanation has 3 words/],
    ["B too long", (p) => { p.staticExplanation = "Checked: " + "word ".repeat(14); }, /staticExplanation has 15 words/],
    ["B prefix", (p) => { p.staticExplanation = "Flagged: the date in the post matches the parks record."; }, /must start with "Checked:"/],
    ["D too short", (p) => { p.counterfactualExplanation = "This would be labeled misleading if wrong."; }, /counterfactualExplanation has 7 words/],
    ["D too long", (p) => { p.counterfactualExplanation = "This would be labeled misleading if " + "x ".repeat(11); }, /counterfactualExplanation has 17 words/],
  ];
  it.each(cases)("catches %s", (_name, mutate, re) => {
    const p = makePost("p01", "S1", "TRUE", "accurate");
    mutate(p);
    const problems = validatePost(p);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((m) => re.test(m))).toBe(true);
  });

  it("requires difficulty on a wrong label", () => {
    const p = makePost("p01", "S1", "TRUE", "misleading");
    p.difficulty = null;
    expect(validatePost(p).some((m) => /difficulty/.test(m))).toBe(true);
  });
});

describe("loadPostBank", () => {
  it("returns a valid bank", () => {
    const bank = makeBank();
    expect(loadPostBank(clone(bank))).toEqual(bank);
  });

  it("throws on non-objects and wrong schema", () => {
    expect(() => loadPostBank(null)).toThrow(/root is not an object/);
    expect(() => loadPostBank({ ...makeBank(), schemaVersion: 2 })).toThrow(/schemaVersion/);
    expect(() => loadPostBank({ schemaVersion: 1, practice: makePractice(), posts: "x" })).toThrow(/posts must be an array/);
  });

  it("lists every problem in one error", () => {
    const bank = clone(makeBank());
    bank.posts[0].isAiCorrect = !bank.posts[0].isAiCorrect;
    bank.posts[5].staticExplanation = "Checked: short.";
    (bank.posts[7] as unknown as Record<string, unknown>).likes = -1;
    bank.practice.factors[1].passes = false;
    let msg = "";
    try { loadPostBank(bank); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/p01: isAiCorrect/);
    expect(msg).toMatch(/p06: staticExplanation has 2 words/);
    expect(msg).toMatch(/p08: likes/);
    expect(msg).toMatch(/practice-01: claimVsRecord\.passes/);
  });

  it("checks count, duplicate ids, sets and practice shape", () => {
    const short = clone(makeBank());
    short.posts.pop();
    expect(() => loadPostBank(short)).toThrow(/24 entries/);
    const dup = clone(makeBank());
    dup.posts[1].id = "p01";
    expect(() => loadPostBank(dup)).toThrow(/duplicate id/);
    const sets = clone(makeBank());
    sets.posts[0].set = "S2";
    expect(() => loadPostBank(sets)).toThrow(/set S1 must have 6/);
    const pr = clone(makeBank()) as unknown as { practice: Record<string, unknown> };
    pr.practice.set = "S1";
    expect(() => loadPostBank(pr)).toThrow(/practice set must be null/);
    const noAuthor = clone(makeBank()) as unknown as { posts: Record<string, unknown>[] };
    delete noAuthor.posts[3].author;
    expect(() => loadPostBank(noAuthor)).toThrow(/p04: author/);
  });
});

describe("buildPresentation", () => {
  const bank = makeBank();
  const conditions: Condition[] = ["A", "B", "C", "D"];

  it("never includes correctness fields, for any post and condition", () => {
    for (const p of bank.posts) {
      for (const c of conditions) {
        const json = JSON.stringify(buildPresentation(p, c));
        for (const f of FORBIDDEN) expect(json).not.toContain(`"${f}"`);
        expect(json).not.toContain('"set"');
        expect(json).not.toContain('"topic"');
      }
    }
  });

  it("includes only the condition-specific explanation field", () => {
    const p = bank.posts[0];
    const a = buildPresentation(p, "A");
    const b = buildPresentation(p, "B");
    const c = buildPresentation(p, "C");
    const d = buildPresentation(p, "D");
    const expl = ["staticExplanation", "factors", "counterfactualExplanation"];
    expect(Object.keys(a).filter((k) => expl.includes(k))).toEqual([]);
    expect(Object.keys(b).filter((k) => expl.includes(k))).toEqual(["staticExplanation"]);
    expect(Object.keys(c).filter((k) => expl.includes(k))).toEqual(["factors"]);
    expect(Object.keys(d).filter((k) => expl.includes(k))).toEqual(["counterfactualExplanation"]);
    expect(b.staticExplanation).toBe(p.staticExplanation);
    expect(d.counterfactualExplanation).toBe(p.counterfactualExplanation);
    expect(a).toMatchObject({ postId: p.id, condition: "A", aiLabel: p.aiLabel, text: p.text, factSheet: p.factSheet });
  });

  it("copies factors as fresh objects with only the allowed keys", () => {
    const p = clone(bank.posts[0]);
    (p.factors[0] as unknown as Record<string, unknown>).secret = "leak";
    const c = buildPresentation(p, "C");
    expect(c.factors).toHaveLength(3);
    c.factors!.forEach((f, i) => {
      expect(f).not.toBe(p.factors[i]);
      expect(Object.keys(f).sort()).toEqual(["detail", "displayValue", "key", "label", "passes"]);
    });
    expect(JSON.stringify(c)).not.toContain("leak");
    expect(c.author).not.toBe(p.author);
  });

  it("does not leak extra post fields", () => {
    const p = clone(bank.posts[0]) as Post & { internalNote?: string };
    p.internalNote = "secret";
    for (const c of conditions) expect(JSON.stringify(buildPresentation(p, c))).not.toContain("secret");
  });
});

describe("buildPracticePresentation", () => {
  it("keeps explanation fields, drops correctness fields", () => {
    const pr = makePractice();
    const out = buildPracticePresentation(pr);
    const json = JSON.stringify(out);
    for (const f of FORBIDDEN) expect(json).not.toContain(`"${f}"`);
    expect(out.staticExplanation).toBe(pr.staticExplanation);
    expect(out.counterfactualExplanation).toBe(pr.counterfactualExplanation);
    expect(out.factors).toEqual(pr.factors);
    expect(out.factors[0]).not.toBe(pr.factors[0]);
    expect(out.id).toBe("practice-01");
  });
});

describe("optional context media", () => {
  it("validates all allowed scene paths and accepts historical banks without context", () => {
    expect(() => loadPostBank(makeBank())).not.toThrow();
    for (const filename of ["environment", "public-services", "local-events"]) {
      const bank = makeBank();
      bank.posts[0].context = mediaContext();
      bank.posts[0].context.image.src = `/post-images/${filename}.png`;
      bank.practice.context = mediaContext();
      bank.practice.context.likes = 0;
      bank.practice.context.reposts = 0;
      expect(() => loadPostBank(bank)).not.toThrow();
    }
  });

  it.each([
    "https://example.com/post-images/environment.png", "//example.com/post-images/environment.png",
    "data:image/png;base64,x", "javascript:alert(1)", "/post-images/../environment.png",
    "/post-images/%2e%2e/environment.png", "/post-images/environment.png?truth=TRUE",
    "/post-images/environment.png#truth", "/post-images/other.png", "post-images/environment.png",
    "/post-images/environment.png\n",
  ])("rejects non-allow-listed path %s", (src) => {
    const bank = makeBank();
    bank.posts[0].context = mediaContext();
    bank.posts[0].context.image.src = src;
    expect(() => loadPostBank(bank)).toThrow(/context.image.src/);
  });

  it.each([
    [null, /context must be an object/],
    [[], /context must be an object/],
    [{ ...mediaContext(), image: null }, /context.image must be an object/],
    [{ ...mediaContext(), image: { ...mediaContext().image, alt: "  " } }, /context.image.alt/],
    [{ ...mediaContext(), image: { ...mediaContext().image, alt: false } }, /context.image.alt/],
    [{ ...mediaContext(), image: { ...mediaContext().image, width: 0 } }, /context.image.width/],
    [{ ...mediaContext(), image: { ...mediaContext().image, height: -1 } }, /context.image.height/],
    [{ ...mediaContext(), image: { ...mediaContext().image, width: 1.5 } }, /context.image.width/],
    [{ ...mediaContext(), image: { ...mediaContext().image, height: "1024" } }, /context.image.height/],
    [{ ...mediaContext(), likes: -1 }, /context.likes/],
    [{ ...mediaContext(), reposts: 1.2 }, /context.reposts/],
    [{ ...mediaContext(), likes: "128" }, /context.likes/],
  ])("rejects malformed context %#", (context, problem) => {
    const bank = makeBank();
    (bank.posts[0] as unknown as Record<string, unknown>).context = context;
    expect(() => loadPostBank(bank)).toThrow(problem as RegExp);
    const practiceBank = makeBank();
    (practiceBank.practice as unknown as Record<string, unknown>).context = context;
    expect(() => loadPostBank(practiceBank)).toThrow(problem as RegExp);
  });

  it("defaults to original counts and no image, including practice and missing-context fixtures", () => {
    const post = makeBank().posts[0];
    const original = buildPresentation(post, "C");
    post.context = mediaContext();
    expect(buildPresentation(post, "C")).toEqual(original);
    expect(buildPresentation(post, "C", { contextMedia: false })).toEqual(original);
    const practice = makePractice();
    const originalPractice = buildPracticePresentation(practice);
    practice.context = mediaContext();
    expect(buildPracticePresentation(practice)).toEqual(originalPractice);
    expect(buildPracticePresentation(practice, { contextMedia: false })).toEqual(originalPractice);
    delete post.context;
    delete practice.context;
    expect(buildPresentation(post, "C", { contextMedia: true })).toEqual(original);
    expect(buildPracticePresentation(practice, { contextMedia: true })).toEqual(originalPractice);
  });

  it("copies only allowed media fields without altering explanations, truth or the source object", () => {
    const post = makeBank().posts[0];
    post.context = mediaContext();
    Object.assign(post.context, { groundTruth: "context-secret", internalNote: "context-secret" });
    Object.assign(post.context.image, { keyFact: "image-secret", onerror: "image-secret" });
    const snapshot = clone(post);
    for (const condition of ["A", "B", "C", "D"] as const) {
      const legacy = buildPresentation(post, condition);
      const output = buildPresentation(post, condition, { contextMedia: true });
      const { image, likes, reposts, ...withoutMedia } = output;
      const { likes: _oldLikes, reposts: _oldReposts, ...legacyWithoutCounts } = legacy;
      expect(withoutMedia).toEqual(legacyWithoutCounts);
      expect(likes).toBe(128);
      expect(reposts).toBe(16);
      expect(image).toEqual(mediaContext().image);
      expect(image).not.toBe(post.context.image);
      expect(Object.keys(image!).sort()).toEqual(["alt", "height", "src", "width"]);
      const json = JSON.stringify(output);
      expect(json).not.toContain("secret");
      expect(json).not.toContain('"context"');
      for (const forbidden of FORBIDDEN) expect(json).not.toContain(`"${forbidden}"`);
    }
    expect(post).toEqual(snapshot);

    const practice = { ...makePractice(), context: post.context };
    const result = buildPracticePresentation(practice, { contextMedia: true });
    expect(result).toMatchObject({ image: mediaContext().image, likes: 128, reposts: 16 });
    expect(result.image).not.toBe(practice.context.image);
    expect(result.factors).toEqual(practice.factors);
    expect(result.staticExplanation).toBe(practice.staticExplanation);
    expect(result.counterfactualExplanation).toBe(practice.counterfactualExplanation);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain('"context"');
    for (const forbidden of FORBIDDEN) expect(JSON.stringify(result)).not.toContain(`"${forbidden}"`);
  });

  it("keeps the same image and set count profile across A–D for all posts", () => {
    const profiles = { S1: [128, 16], S2: [172, 24], S3: [96, 12], S4: [148, 20] };
    const bank = loadPostBank(JSON.parse(readFileSync(postsPath, "utf8")));
    const images = { env: "environment", svc: "public-services", evt: "local-events" };
    for (const post of bank.posts) {
      // Use real context when populated; this fallback also exercises older bank fixtures.
      post.context ??= { ...mediaContext(), likes: profiles[post.set][0], reposts: profiles[post.set][1],
        image: { ...mediaContext().image, src: `/post-images/${images[post.topic]}.png` } };
      for (const condition of ["A", "B", "C", "D"] as const) {
        const output = buildPresentation(post, condition, { contextMedia: true });
        expect(output.image).toEqual(post.context.image);
        expect(output.image?.src).toBe(`/post-images/${images[post.topic]}.png`);
        expect([output.likes, output.reposts]).toEqual(profiles[post.set]);
        expect(buildPresentation(post, condition)).toMatchObject({ likes: post.likes, reposts: post.reposts });
        expect(buildPresentation(post, condition)).not.toHaveProperty("image");
      }
    }
  });
});

describe("getTruth", () => {
  it("returns correctness fields for a post and throws on unknown id", () => {
    const bank = makeBank();
    expect(getTruth(bank, "p01")).toEqual({
      groundTruth: "TRUE", isAiCorrect: false, errorType: "false_alarm", difficulty: "clear",
      aiLabel: "misleading", topic: "env", set: "S1",
    });
    expect(() => getTruth(bank, "nope")).toThrow(/Unknown post id/);
  });
});

describe("postBankHash", () => {
  it("is a stable sha-256 hex and changes with content", () => {
    const bank = makeBank();
    const h = postBankHash(bank);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(postBankHash(clone(bank))).toBe(h);
    const changed = clone(bank);
    changed.posts[0].likes += 1;
    expect(postBankHash(changed)).not.toBe(h);
  });
});

const postsPath = fileURLToPath(new URL("./data/posts.json", import.meta.url));
describe.skipIf(!existsSync(postsPath))("shared/data/posts.json", () => {
  it("loads and validates", () => {
    const bank = loadPostBank(JSON.parse(readFileSync(postsPath, "utf8")));
    expect(bank.posts).toHaveLength(24);
  });
});
