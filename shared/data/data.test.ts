import { describe, it, expect } from "vitest";
import postsRaw from "./posts.json";
import surveyRaw from "./surveyItems.json";
import type { Post, PostBank, PracticePost, SurveyItems } from "../types";

const bank = postsRaw as unknown as PostBank;
const survey = surveyRaw as unknown as SurveyItems;
const posts: Post[] = bank.posts;
const all: (Post | PracticePost)[] = [bank.practice, ...posts];

const words = (s: string) => s.trim().split(/\s+/).length;
const ids = (pred: (p: Post) => boolean) => posts.filter(pred).map((p) => p.id).sort();

describe("posts.json", () => {
  it("has the PostBank shape", () => {
    expect(bank.schemaVersion).toBe(1);
    expect(bank.practice.id).toBe("practice-01");
    expect(bank.practice.set).toBeNull();
    expect(bank.practice.groundTruth).toBe("TRUE");
    expect(bank.practice.aiLabel).toBe("accurate");
    expect(posts).toHaveLength(24);
  });

  it("has unique ids p01-p24 in order", () => {
    expect(posts.map((p) => p.id)).toEqual(
      Array.from({ length: 24 }, (_, i) => `p${String(i + 1).padStart(2, "0")}`),
    );
  });

  it("has 6 posts per set with the matched structure", () => {
    for (const set of ["S1", "S2", "S3", "S4"] as const) {
      const s = posts.filter((p) => p.set === set);
      expect(s).toHaveLength(6);
      expect(s.filter((p) => p.isAiCorrect && p.aiLabel === "accurate")).toHaveLength(2);
      expect(s.filter((p) => p.isAiCorrect && p.aiLabel === "misleading")).toHaveLength(2);
      expect(s.filter((p) => p.errorType === "false_alarm")).toHaveLength(1);
      expect(s.filter((p) => p.errorType === "miss")).toHaveLength(1);
      expect(s.filter((p) => p.difficulty === "clear")).toHaveLength(1);
      expect(s.filter((p) => p.difficulty === "subtle")).toHaveLength(1);
    }
  });

  it("gives every analysed post the same media presence with neutral topic-specific scenes", () => {
    const scenes = {
      env: { src: "/post-images/environment.png", alt: "Trees beside a quiet town park path" },
      svc: { src: "/post-images/public-services.png", alt: "Exterior of a town public-services building" },
      evt: { src: "/post-images/local-events.png", alt: "An empty community square with benches" },
    };
    expect(posts.filter((p) => p.context?.image)).toHaveLength(24);
    for (const p of posts) {
      expect(p.context?.image, p.id).toMatchObject(scenes[p.topic]);
      const image = p.context!.image;
      expect(Number.isInteger(image.width), p.id).toBe(true);
      expect(Number.isInteger(image.height), p.id).toBe(true);
      expect(image.width, p.id).toBeGreaterThan(0);
      expect(image.height, p.id).toBeGreaterThan(0);
    }
    // Each topic reuses a single complete image descriptor across correct and wrong labels.
    for (const topic of ["env", "svc", "evt"] as const) {
      const topicPosts = posts.filter((p) => p.topic === topic);
      expect(new Set(topicPosts.map((p) => JSON.stringify(p.context!.image))).size).toBe(1);
      expect(topicPosts.some((p) => p.isAiCorrect)).toBe(true);
      expect(topicPosts.some((p) => !p.isAiCorrect)).toBe(true);
    }
  });

  it.each([
    ["S1", 128, 16], ["S2", 172, 24], ["S3", 96, 12], ["S4", 148, 20],
  ] as const)("matches %s context counts across four correct and two wrong labels", (set, likes, reposts) => {
    const setPosts = posts.filter((p) => p.set === set);
    const correct = setPosts.filter((p) => p.isAiCorrect);
    const wrong = setPosts.filter((p) => !p.isAiCorrect);
    expect(correct).toHaveLength(4);
    expect(wrong).toHaveLength(2);
    for (const p of [...correct, ...wrong]) {
      expect(p.context, p.id).toMatchObject({ likes, reposts });
    }
    expect(wrong.map((p) => p.errorType).sort()).toEqual(["false_alarm", "miss"]);
  });

  it("uses the park scene for practice without changing its original counts", () => {
    expect(bank.practice.context).toEqual({
      image: {
        src: "/post-images/environment.png", alt: "Trees beside a quiet town park path",
        width: posts.find((p) => p.topic === "env")!.context!.image.width,
        height: posts.find((p) => p.topic === "env")!.context!.image.height,
      },
      likes: bank.practice.likes,
      reposts: bank.practice.reposts,
    });
  });

  it("has 12/12 label and truth tallies", () => {
    expect(posts.filter((p) => p.aiLabel === "accurate")).toHaveLength(12);
    expect(posts.filter((p) => p.aiLabel === "misleading")).toHaveLength(12);
    expect(posts.filter((p) => p.groundTruth === "TRUE")).toHaveLength(12);
    expect(posts.filter((p) => p.groundTruth === "FALSE")).toHaveLength(12);
    expect(posts.filter((p) => p.isAiCorrect)).toHaveLength(16);
  });

  it("places the wrong labels and crosses difficulty", () => {
    expect(ids((p) => p.errorType === "false_alarm")).toEqual(["p03", "p09", "p15", "p21"]);
    expect(ids((p) => p.errorType === "miss")).toEqual(["p04", "p10", "p16", "p22"]);
    expect(ids((p) => p.difficulty === "clear")).toEqual(["p03", "p10", "p16", "p21"]);
    expect(ids((p) => p.difficulty === "subtle")).toEqual(["p04", "p09", "p15", "p22"]);
  });

  it.each(all.map((p) => [p.id, p] as const))("%s is internally consistent", (_id, p) => {
    expect(p.groundTruth).toBe(p.keyFact.claimValue === p.keyFact.recordValue ? "TRUE" : "FALSE");
    expect(p.isAiCorrect).toBe((p.aiLabel === "accurate") === (p.groundTruth === "TRUE"));
    if (p.isAiCorrect) {
      expect(p.errorType).toBeNull();
      expect(p.difficulty).toBeNull();
    } else {
      expect(p.errorType).toBe(p.aiLabel === "misleading" ? "false_alarm" : "miss");
      expect(["clear", "subtle"]).toContain(p.difficulty);
    }
    expect(p.factors.map((f) => f.key)).toEqual(["source", "claimVsRecord", "wording"]);
    expect(p.factors.map((f) => f.label)).toEqual(["Source", "Claim vs record", "Wording"]);
    expect(p.factors[1].passes).toBe(p.groundTruth === "TRUE");
    expect(p.factors[0].passes).toBe(p.author.verified);
    expect(p.factors[0].displayValue).toBe(
      `${p.author.handle} · ${p.author.verified ? "verified" : "not verified"}`,
    );
    expect(p.factors[2].passes).toBe(p.factors[2].displayValue === "Neutral");
    const b = words(p.staticExplanation);
    expect(b).toBeGreaterThanOrEqual(8);
    expect(b).toBeLessThanOrEqual(14);
    expect(p.staticExplanation.startsWith(p.aiLabel === "accurate" ? "Checked:" : "Flagged:")).toBe(true);
    const d = words(p.counterfactualExplanation);
    expect(d).toBeGreaterThanOrEqual(10);
    expect(d).toBeLessThanOrEqual(16);
    expect(p.counterfactualExplanation.startsWith(
      `This would be labeled ${p.aiLabel === "accurate" ? "misleading" : "accurate"} if`,
    )).toBe(true);
    expect(p.factSheet.source.endsWith("(fictional)")).toBe(true);
    expect(p.text.length).toBeLessThanOrEqual(240);
    expect(p.author.handle.startsWith("@")).toBe(true);
  });
});

describe("surveyItems.json", () => {
  it("has 12 Jian trust items with items 1-5 reversed", () => {
    expect(survey.schemaVersion).toBe(1);
    expect(survey.trustItems).toHaveLength(12);
    survey.trustItems.forEach((item, i) => {
      expect(item.order).toBe(i + 1);
      expect(item.id).toBe(`jian-${String(i + 1).padStart(2, "0")}`);
      expect(item.reverse).toBe(i < 5);
      expect(item.subscale).toBe(i < 5 ? "distrust" : "trust");
      expect(item.text).toMatch(/AI labels/);
    });
    expect(survey.trustItems.filter((t) => t.reverse)).toHaveLength(5);
    expect(survey.trustScale).toMatchObject({ min: 1, max: 7 });
  });

  it("has 2 fairness items and the scale items", () => {
    expect(survey.fairnessItems).toHaveLength(2);
    expect(survey.fairnessScale).toMatchObject({ min: 1, max: 7 });
    expect(survey.tension).toMatchObject({ id: "tension", min: 1, max: 7, step: 1, widget: "likert" });
    expect(survey.frustrationTlx).toMatchObject({
      id: "frustrationTlx", min: 0, max: 100, step: 5, widget: "slider", start: 50,
    });
    expect(survey.confidence).toMatchObject({ id: "confidence", min: 1, max: 7, step: 1, widget: "likert" });
  });
});
