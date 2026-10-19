// Counterbalancing (docs/system-design.md §4). Pure: safe to import from client or server.
import { mulberry32 } from "./rng";
import type { Condition, Post, SetId } from "./types";
import type { Assignment, BlockPlan } from "./api";

export const WILLIAMS = ["ABDC", "BCAD", "CDBA", "DACB"] as const;
const SETS: readonly SetId[] = ["S1", "S2", "S3", "S4"];
const COND_INDEX: Record<Condition, number> = { A: 0, B: 1, C: 2, D: 3 };
const K = 4;
const POSTS_PER_SET = 6;
const WRONG_PER_SET = 2;
const MAX_ATTEMPTS = 100;

function fisherYates<T>(xs: T[], rng: () => number): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

/** Shuffle so the two wrong ids are never both in positions 1-2. Consumes `rng`. */
function constrainedShuffle(ids: string[], wrongIds: Set<string>, rng: () => number): string[] {
  let a: string[] = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    a = fisherYates([...ids], rng);
    if (!(wrongIds.has(a[0]) && wrongIds.has(a[1]))) return a;
  }
  // Deterministic fallback (practically unreachable): swap position 2 with the first correct post in 3-6.
  const j = a.findIndex((id, i) => i >= 2 && !wrongIds.has(id));
  [a[1], a[j]] = [a[j], a[1]];
  return a;
}

export function assign(pid: number, setPosts: Record<SetId, string[]>, wrongIds: Set<string>): Assignment {
  if (!Number.isInteger(pid) || pid < 1) throw new Error(`pid must be an integer >= 1 (got ${pid})`);
  for (const s of SETS) {
    const ids = setPosts[s];
    if (!Array.isArray(ids) || ids.length !== POSTS_PER_SET || new Set(ids).size !== POSTS_PER_SET) {
      throw new Error(`set ${s} must have exactly ${POSTS_PER_SET} distinct posts (got ${ids?.length ?? 0})`);
    }
    const nWrong = ids.filter((id) => wrongIds.has(id)).length;
    if (nWrong !== WRONG_PER_SET) {
      throw new Error(`set ${s} must have exactly ${WRONG_PER_SET} wrong labels (got ${nWrong})`);
    }
  }

  const orderIndex = (pid - 1) % K;
  const rotation = (Math.floor((pid - 1) / K) % K) as 0 | 1 | 2 | 3;
  const order = WILLIAMS[orderIndex].split("") as Condition[];
  const rng = mulberry32(pid); // one stream per session, consumed in block order

  const blocks = order.map((condition, i): BlockPlan => {
    const set = SETS[(COND_INDEX[condition] + rotation) % K];
    return {
      blockIndex: (i + 1) as 1 | 2 | 3 | 4,
      condition,
      set,
      postOrder: constrainedShuffle(setPosts[set], wrongIds, rng),
    };
  });

  return {
    pid,
    conditionOrder: order as Assignment["conditionOrder"],
    setRotation: rotation,
    seed: pid,
    blocks: blocks as Assignment["blocks"],
  };
}

/** Convenience: build setPosts (id order within a set) and wrongIds from a post bank, then assign. */
export function assignFromBank(
  pid: number,
  bank: { posts: { id: string; set: SetId; isAiCorrect: boolean }[] },
): Assignment {
  const setPosts: Record<SetId, string[]> = { S1: [], S2: [], S3: [], S4: [] };
  const wrongIds = new Set<string>();
  for (const p of bank.posts) {
    if (!(p.set in setPosts)) throw new Error(`post ${p.id} has unknown set ${String(p.set)}`);
    setPosts[p.set].push(p.id);
    if (!p.isAiCorrect) wrongIds.add(p.id);
  }
  for (const s of SETS) setPosts[s].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return assign(pid, setPosts, wrongIds);
}

/** Two-post protocol for new sessions; the full bank and legacy assignment remain intact. */
export function assignShortFromBank(
  pid: number,
  bank: { posts: Pick<Post, "id" | "set" | "isAiCorrect" | "errorType">[] },
): Assignment {
  // Validate the six-post sets through the legacy path and retain its Williams/set plan.
  const assignment = assignFromBank(pid, bank);
  const cycle = Math.floor((pid - 1) / 16);
  const correctIndex = ((pid - 1) % K + cycle) % K;
  const rng = mulberry32(pid);
  const allIds = bank.posts.map((p) => p.id);
  if (new Set(allIds).size !== allIds.length) throw new Error("post ids must be globally distinct");
  assignment.blocks = assignment.blocks.map((block): BlockPlan => {
    const posts = bank.posts.filter((p) => p.set === block.set).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const correct = posts.filter((p) => p.isAiCorrect);
    const wrong = posts.filter((p) => !p.isAiCorrect);
    if (correct.length !== 4 || wrong.filter((p) => p.errorType === "false_alarm").length !== 1 ||
        wrong.filter((p) => p.errorType === "miss").length !== 1) {
      throw new Error(`set ${block.set} must have four correct labels, one false alarm and one miss`);
    }
    const errorType = (COND_INDEX[block.condition] + cycle) % 2 === 0 ? "false_alarm" : "miss";
    const selectedWrong = wrong.find((p) => p.errorType === errorType)!;
    return { ...block, postOrder: fisherYates([correct[correctIndex].id, selectedWrong.id], rng) };
  }) as Assignment["blocks"];
  return assignment;
}
