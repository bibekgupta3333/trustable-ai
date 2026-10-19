import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "./db/db";
import { computeKpis, median, percentile, rate, mean } from "./kpi";

let db: Database.Database;
beforeEach(() => {
  db = openDb(":memory:");
});

function session(
  id: string,
  pid: number,
  status: "in_progress" | "completed" | "abandoned",
  opts: { order?: string; startedAt?: string; completedAt?: string | null } = {},
) {
  db.prepare(
    `INSERT INTO sessions (session_id, pid, condition_order, set_rotation, seed, status, post_bank_hash, app_version, started_at, completed_at)
     VALUES (?, ?, ?, 0, ?, ?, 'h', 'v', ?, ?)`,
  ).run(id, pid, opts.order ?? "ABDC", pid, status, opts.startedAt ?? "2026-10-17T10:00:00.000Z", opts.completedAt ?? null);
}

let pos = 0;
function trial(
  sessionId: string,
  t: {
    condition: "A" | "B" | "C" | "D";
    correct: boolean;
    errorType?: "false_alarm" | "miss" | null;
    agreed: boolean;
    confidence?: number;
    ms?: number;
    factSheet?: boolean;
  },
) {
  pos += 1;
  const detected = t.correct ? null : t.agreed ? 0 : 1;
  db.prepare(
    `INSERT INTO trials (trial_id, session_id, pid, block_index, position_in_block, trial_index, post_id, condition, set_id, topic,
       ai_label, ground_truth, is_ai_correct, error_type, difficulty, agreed, detected_error, confidence, label_shown_at, responded_at,
       decision_time_raw_ms, hidden_ms, hidden_count, blur_count, decision_time_ms, timing_flag, fact_sheet_opened, fact_sheet_open_ms,
       explanation_opened, factors_expanded, time_to_first_expand_ms, resumed, saved_at)
     VALUES (?, ?, 1, 1, ?, ?, 'p', ?, 'S1', 'x', 'accurate', 'TRUE', ?, ?, NULL, ?, ?, ?, 't', 't', ?, 0, 0, 0, ?, 0, ?, 0, NULL, '', NULL, 0, 't')`,
  ).run(
    `t${pos}`,
    sessionId,
    pos,
    pos,
    t.condition,
    t.correct ? 1 : 0,
    t.correct ? null : (t.errorType ?? "miss"),
    t.agreed ? 1 : 0,
    detected,
    t.confidence ?? 4,
    t.ms ?? 1000,
    t.ms ?? 1000,
    t.factSheet ? 1 : 0,
  );
}

let blk = 0;
function survey(sessionId: string, condition: "A" | "B" | "C" | "D", trust: number, fairness: number, tension: number, tlx: number) {
  blk = (blk % 4) + 1;
  db.prepare(
    `INSERT INTO block_surveys (session_id, block_index, condition, trust_raw, trust_scored, trust_mean, fairness1, fairness2,
       fairness_mean, tension, frustration_tlx, frustration_tlx_touched, n_wrong_detected, submitted_at)
     VALUES (?, ?, ?, '[]', '[]', ?, 4, 4, ?, ?, ?, 1, 0, 't')`,
  ).run(sessionId, blk, condition, trust, fairness, tension, tlx);
}

describe("helpers", () => {
  it("median / percentile / mean / rate", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(percentile([], 90)).toBeNull();
    expect(percentile([10], 90)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 90)).toBe(10);
    expect(percentile([0, 10], 90)).toBe(9);
    expect(mean([])).toBeNull();
    expect(mean([1, 2, 3])).toBe(2);
    expect(rate(1, 0)).toBeNull();
    expect(rate(1, 4)).toBe(0.25);
  });
});

describe("computeKpis", () => {
  it("returns zero counts and null rates on an empty DB", async () => {
    const now = new Date("2026-10-17T12:00:00Z");
    const k = await computeKpis(db, now);
    expect(k.generatedAt).toBe(now.toISOString());
    expect(k.sessions).toEqual({ started: 0, inProgress: 0, completed: 0, abandoned: 0, completionRate: null });
    expect(k.target).toEqual({ n: 32, minimum: 16, completed: 0, cycle1Completed: 0, cycle2Completed: 0 });
    expect(k.durationMin).toEqual({ median: null, p90: null });
    expect(k.byCondition.map((c) => c.condition)).toEqual(["A", "B", "C", "D"]);
    for (const c of k.byCondition) {
      expect(c.trials).toBe(0);
      expect(c.wrongTrials).toBe(0);
      for (const key of ["agreementRate", "detectionRate", "falseAlarmDetection", "missDetection", "factSheetOpenRate",
        "meanConfidence", "medianDecisionMs", "trustMean", "fairnessMean", "tensionMean", "frustrationMean"] as const)
        expect(c[key]).toBeNull();
    }
    expect(k.byErrorType).toEqual([
      { errorType: "false_alarm", n: 0, detectionRate: null },
      { errorType: "miss", n: 0, detectionRate: null },
    ]);
    expect(k.balance).toEqual([
      { conditionOrder: "ABDC", completed: 0 },
      { conditionOrder: "BCAD", completed: 0 },
      { conditionOrder: "CDBA", completed: 0 },
      { conditionOrder: "DACB", completed: 0 },
    ]);
    expect(k.dailyCompleted).toEqual([]);
  });

  it("computes session, target, duration, condition, error-type, balance and daily KPIs", async () => {
    session("c1", 1, "completed", { order: "ABDC", startedAt: "2026-10-16T10:00:00.000Z", completedAt: "2026-10-16T10:10:00.000Z" });
    session("c2", 2, "completed", { order: "BCAD", startedAt: "2026-10-17T09:00:00.000Z", completedAt: "2026-10-17T09:20:00.000Z" });
    session("c3", 17, "completed", { order: "ABDC", startedAt: "2026-10-17T11:00:00.000Z", completedAt: "2026-10-17T11:30:00.000Z" });
    session("ip", 3, "in_progress");
    session("ab", 4, "abandoned");

    // Condition A in c1: 4 trials; 2 wrong (1 false_alarm detected, 1 miss not detected)
    trial("c1", { condition: "A", correct: true, agreed: true, confidence: 7, ms: 1000, factSheet: true });
    trial("c1", { condition: "A", correct: true, agreed: false, confidence: 5, ms: 3000 });
    trial("c1", { condition: "A", correct: false, errorType: "false_alarm", agreed: false, confidence: 3, ms: 5000, factSheet: true });
    trial("c1", { condition: "A", correct: false, errorType: "miss", agreed: true, confidence: 1, ms: 2000 });
    // Condition C in c2: one miss detected
    trial("c2", { condition: "C", correct: false, errorType: "miss", agreed: false, confidence: 6, ms: 4000 });
    // In-progress session trial must be ignored
    trial("ip", { condition: "A", correct: false, errorType: "miss", agreed: false });

    survey("c1", "A", 5, 4, 3, 20);
    survey("c2", "A", 3, 6, 5, 40);
    survey("ip", "A", 1, 1, 1, 100);

    const k = await computeKpis(db);
    expect(k.sessions).toEqual({ started: 5, inProgress: 1, completed: 3, abandoned: 1, completionRate: 0.75 });
    expect(k.target).toMatchObject({ completed: 3, cycle1Completed: 2, cycle2Completed: 1 });
    expect(k.durationMin.median).toBe(20);
    expect(k.durationMin.p90).toBeCloseTo(28); // 10,20,30 -> rank 1.8 -> 20 + 0.8*10

    const a = k.byCondition.find((c) => c.condition === "A")!;
    expect(a).toMatchObject({
      trials: 4,
      agreementRate: 0.5,
      wrongTrials: 2,
      detectionRate: 0.5,
      falseAlarmDetection: 1,
      missDetection: 0,
      factSheetOpenRate: 0.5,
      meanConfidence: 4,
      medianDecisionMs: 2500,
      trustMean: 4,
      fairnessMean: 5,
      tensionMean: 4,
      frustrationMean: 30,
    });
    const c = k.byCondition.find((x) => x.condition === "C")!;
    expect(c.correctAcceptanceRate).toBeNull();
    expect(c.underrelianceRate).toBeNull();
    expect(c.wrongRejectionRate).toBe(1);
    expect(c).toMatchObject({ trials: 1, wrongTrials: 1, detectionRate: 1, missDetection: 1, falseAlarmDetection: null, trustMean: null });
    const b = k.byCondition.find((x) => x.condition === "B")!;
    expect(b.trials).toBe(0);
    expect(b.agreementRate).toBeNull();

    expect(k.byErrorType).toEqual([
      { errorType: "false_alarm", n: 1, detectionRate: 1 },
      { errorType: "miss", n: 2, detectionRate: 0.5 },
    ]);
    expect(k.balance).toEqual([
      { conditionOrder: "ABDC", completed: 2 },
      { conditionOrder: "BCAD", completed: 1 },
      { conditionOrder: "CDBA", completed: 0 },
      { conditionOrder: "DACB", completed: 0 },
    ]);
    expect(k.dailyCompleted).toEqual([
      { date: "2026-10-16", n: 1 },
      { date: "2026-10-17", n: 2 },
    ]);
  });

  it("excludes pilot pids >= 900 from every KPI", async () => {
    session("pilot1", 900, "completed", { order: "CDBA", completedAt: "2026-10-17T10:15:00.000Z" });
    session("pilot2", 901, "in_progress");
    session("pilot3", 905, "abandoned");
    trial("pilot1", { condition: "B", correct: false, errorType: "false_alarm", agreed: false });
    survey("pilot1", "B", 7, 7, 7, 100);

    const k = await computeKpis(db);
    expect(k.sessions).toEqual({ started: 0, inProgress: 0, completed: 0, abandoned: 0, completionRate: null });
    expect(k.target.completed).toBe(0);
    expect(k.durationMin.median).toBeNull();
    expect(k.byCondition.every((c) => c.trials === 0 && c.trustMean === null)).toBe(true);
    expect(k.byErrorType.every((e) => e.n === 0)).toBe(true);
    expect(k.balance.every((b) => b.completed === 0)).toBe(true);
    expect(k.dailyCompleted).toEqual([]);
  });
});

describe("calibrated reliance and protocol cohorts", () => {
  it("uses separate correct/wrong denominators and excludes incomplete/pilot sessions", async () => {
    session("current", 1, "completed");
    db.prepare("UPDATE sessions SET protocol_version = 'calibrated-brief-v1' WHERE session_id = ?").run("current");
    session("legacy", 2, "completed");
    session("unfinished", 3, "in_progress");
    session("pilot", 900, "completed");
    for (const id of ["current", "legacy", "unfinished", "pilot"]) {
      trial(id, { condition: "A", correct: true, agreed: true });
      trial(id, { condition: "A", correct: true, agreed: false });
      trial(id, { condition: "A", correct: false, agreed: false });
    }
    const current = await computeKpis(db, undefined, "calibrated-brief-v1");
    expect(current.cohort).toBe("calibrated-brief-v1");
    expect(current.sessions.started).toBe(1);
    expect(current.primaryOutcome).toEqual({ trials: 3, correctTrials: 2, wrongTrials: 1,
      correctAcceptanceRate: 0.5, wrongRejectionRate: 1, appropriateRelianceRate: 2 / 3,
      overrelianceRate: 0, underrelianceRate: 0.5 });
    expect(current.byCondition[0]).toMatchObject(current.primaryOutcome!);
    expect((await computeKpis(db, undefined, "legacy-full-v1")).primaryOutcome?.trials).toBe(3);
    expect((await computeKpis(db)).primaryOutcome?.trials).toBe(6);
    expect(current.byCondition[1].appropriateRelianceRate).toBeNull();
    expect(current.byCondition[1].correctAcceptanceRate).toBeNull();
    expect(current.byCondition[1].wrongRejectionRate).toBeNull();
  });

  it.each([true, false])("does not treat always-agree=%s as calibrated behavior", async (agreed) => {
    session("s", 1, "completed");
    trial("s", { condition: "A", correct: true, agreed });
    trial("s", { condition: "A", correct: true, agreed });
    trial("s", { condition: "A", correct: false, agreed });
    expect((await computeKpis(db)).primaryOutcome).toMatchObject({
      appropriateRelianceRate: agreed ? 2 / 3 : 1 / 3,
      correctAcceptanceRate: agreed ? 1 : 0, wrongRejectionRate: agreed ? 0 : 1,
      overrelianceRate: agreed ? 1 : 0, underrelianceRate: agreed ? 0 : 1,
    });
  });

  it("keeps custom brief trust separate and excludes null scores from means", async () => {
    session("full", 1, "completed");
    session("brief", 2, "completed");
    db.prepare("UPDATE sessions SET protocol_version = 'calibrated-brief-v1' WHERE session_id = 'brief'").run();
    survey("full", "A", 6, 5, 2, 25);
    db.prepare(`INSERT INTO block_surveys (session_id, block_index, condition, trust_raw, trust_scored,
      trust_mean, fairness1, fairness2, fairness_mean, tension, frustration_tlx, frustration_tlx_touched,
      n_wrong_detected, submitted_at, questionnaire_version, brief_trust)
      VALUES ('brief', 1, 'A', '[]', '[]', NULL, NULL, NULL, NULL, 4, 50, 1, 0, 't', 'brief-v1', 3)`).run();
    expect((await computeKpis(db)).byCondition[0]).toMatchObject({ trustMean: 6, fairnessMean: 5, briefTrustMean: 3 });
    expect((await computeKpis(db, undefined, "calibrated-brief-v1")).byCondition[0]).toMatchObject({
      trustMean: null, fairnessMean: null, briefTrustMean: 3, tensionMean: 4, frustrationMean: 50,
    });
    expect(mean([null, 6, undefined])).toBe(6);
    expect(mean([null])).toBeNull();
  });
});
