import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assignShortFromBank } from "./counterbalance";
import { buildPracticePresentation, buildPresentation, loadPostBank, postBankHash, validatePost } from "./labelEngine";
import type { Condition, Post, SetId, Topic } from "./types";

// Audit the executable stimuli and actual deterministic sampling, not synthetic fixtures.
const bank = loadPostBank(JSON.parse(readFileSync(new URL("./data/posts.json", import.meta.url), "utf8")));
const byId = new Map(bank.posts.map((post) => [post.id, post]));
const conditions: Condition[] = ["A", "B", "C", "D"];
const sets: SetId[] = ["S1", "S2", "S3", "S4"];
const profiles: Record<SetId, { likes: number; reposts: number }> = {
  S1: { likes: 128, reposts: 16 }, S2: { likes: 172, reposts: 24 },
  S3: { likes: 96, reposts: 12 }, S4: { likes: 148, reposts: 20 },
};
const assets: Record<Topic, string> = {
  env: "/post-images/environment.png",
  svc: "/post-images/public-services.png",
  evt: "/post-images/local-events.png",
};
const assignments = Array.from({ length: 32 }, (_, i) => assignShortFromBank(i + 1, bank));
const media = (post: Post, condition: Condition) => buildPresentation(post, condition, { contextMedia: true });

describe("media protocol: actual bank and 32-participant exposure audit", () => {
  it("preserves the original complete stimuli, truth validation and legacy counts", () => {
    // Recorded before the media revision: exclude only the newly authorized context field.
    // Includes original text, counts, author, truth, explanations, fact sheets and practice.
    const { context: _practiceContext, ...practice } = bank.practice;
    const original = { ...bank, practice, posts: bank.posts.map(({ context: _context, ...post }) => post) };
    expect(postBankHash(original)).toBe("78391c786b30b75616d9c5592004c2ef04f3fda36b1079982a90f03f2c578031");
    expect(bank.posts).toHaveLength(24);
    expect(bank.posts.filter((post) => post.isAiCorrect)).toHaveLength(16);
    expect(bank.posts.filter((post) => !post.isAiCorrect)).toHaveLength(8);
    for (const post of bank.posts) {
      expect(validatePost(post)).toEqual([]);
      for (const condition of conditions) {
        const legacy = buildPresentation(post, condition);
        expect(legacy).not.toHaveProperty("image");
        expect(legacy.likes).toBe(post.likes);
        expect(legacy.reposts).toBe(post.reposts);
        expect(buildPresentation(post, condition, { contextMedia: false })).toEqual(legacy);
      }
    }
    expect(buildPracticePresentation(bank.practice)).not.toHaveProperty("image");
    expect(buildPracticePresentation(bank.practice)).not.toHaveProperty("context");
  });

  it("provides every post with the same topic asset regardless of truth or condition", () => {
    const dimensions = new Set<string>();
    for (const post of bank.posts) {
      expect(post.context, post.id).toBeDefined();
      const context = post.context!;
      expect(context).toMatchObject(profiles[post.set]);
      expect(context.image.src).toBe(assets[post.topic]);
      expect(context.image.alt.trim().length).toBeGreaterThan(0);
      expect(context.image.alt).not.toMatch(/\b(true|false|accurate|misleading|verified|correct|incorrect|proof|evidence)\b/i);
      expect(Object.keys(context.image).sort()).toEqual(["alt", "height", "src", "width"]);
      expect(Number.isInteger(context.image.width) && context.image.width > 0).toBe(true);
      expect(Number.isInteger(context.image.height) && context.image.height > 0).toBe(true);
      dimensions.add(`${context.image.width}x${context.image.height}`);
      for (const condition of conditions) {
        const out = media(post, condition);
        expect(out.image).toEqual(context.image);
        expect({ likes: out.likes, reposts: out.reposts }).toEqual(profiles[post.set]);
        // Only the authorized image and engagement counts change in the view payload.
        const { image: _image, likes: _likes, reposts: _reposts, ...rest } = out;
        const { likes: _oldLikes, reposts: _oldReposts, ...legacy } = buildPresentation(post, condition);
        expect(rest).toEqual(legacy);
        for (const key of ["context", "groundTruth", "isAiCorrect", "errorType", "difficulty", "keyFact", "set", "topic"])
          expect(out).not.toHaveProperty(key);
      }
    }
    expect(dimensions.size).toBe(1);
    expect(new Set(bank.posts.map((post) => post.context!.image.src))).toEqual(new Set(Object.values(assets)));
    // The allow-listed asset names describe scenes, with no correctness or post-ID suffix.
    for (const src of Object.values(assets)) expect(src).toMatch(/^\/post-images\/(environment|public-services|local-events)\.png$/);
  });

  it("gives every participant two media posts per condition and matched correct/wrong engagement", () => {
    for (const assignment of assignments) {
      expect(assignment.blocks).toHaveLength(4);
      expect(new Set(assignment.blocks.map((block) => block.condition))).toEqual(new Set(conditions));
      expect(new Set(assignment.blocks.flatMap((block) => block.postOrder)).size).toBe(8);
      for (const block of assignment.blocks) {
        expect(block.postOrder).toHaveLength(2);
        const posts = block.postOrder.map((id) => byId.get(id)!);
        expect(posts.filter((post) => post.isAiCorrect)).toHaveLength(1);
        expect(posts.filter((post) => !post.isAiCorrect)).toHaveLength(1);
        const shown = posts.map((post) => media(post, block.condition));
        expect(shown.filter((post) => post.image)).toHaveLength(2);
        expect(shown.map(({ likes, reposts }) => ({ likes, reposts }))).toEqual([
          profiles[block.set], profiles[block.set],
        ]);
      }
    }
  });

  it("balances set engagement exposures and error types equally across conditions over pids 1–32", () => {
    for (const condition of conditions) {
      const blocks = assignments.flatMap((assignment) => assignment.blocks).filter((block) => block.condition === condition);
      const posts = blocks.flatMap((block) => block.postOrder.map((id) => byId.get(id)!));
      expect(posts).toHaveLength(64);
      expect(posts.filter((post) => post.isAiCorrect)).toHaveLength(32);
      expect(posts.filter((post) => post.errorType === "false_alarm")).toHaveLength(16);
      expect(posts.filter((post) => post.errorType === "miss")).toHaveLength(16);
      for (const set of sets) {
        const exposures = posts.filter((post) => post.set === set);
        expect(exposures).toHaveLength(16);
        expect(exposures.filter((post) => post.isAiCorrect)).toHaveLength(8);
        expect(exposures.filter((post) => !post.isAiCorrect)).toHaveLength(8);
        for (const post of exposures) {
          const shown = media(post, condition);
          expect({ likes: shown.likes, reposts: shown.reposts }).toEqual(profiles[set]);
        }
      }
    }
  });

  it("records equal condition exposure to topic images without claiming equal topic frequencies", () => {
    // Actual 32-slot sampling: equal BETWEEN conditions, but services has fewer exposures.
    // This does not assert balance for incomplete recruitment cycles or other pid ranges.
    for (const condition of conditions) {
      const posts = assignments.flatMap((assignment) => assignment.blocks)
        .filter((block) => block.condition === condition)
        .flatMap((block) => block.postOrder.map((id) => byId.get(id)!));
      const counts = Object.fromEntries(Object.entries(assets).map(([topic, src]) => [
        topic, posts.filter((post) => media(post, condition).image?.src === src).length,
      ]));
      expect(counts).toEqual({ env: 22, svc: 20, evt: 22 });
    }
  });
});
