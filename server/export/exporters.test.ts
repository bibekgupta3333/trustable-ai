import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { toCsv } from "./csv";
import {
  trialsCsv, surveysCsv, eventsCsv, exitCsv, sessionsJson, participantsCsv, kpisCsv, exportIndex,
  TRIAL_COLUMNS, SURVEY_COLUMNS, EVENT_COLUMNS, EXIT_COLUMNS, PARTICIPANT_COLUMNS, KPI_COLUMNS,
} from "./exporters";
import { computeKpis } from "../kpi";
import { openDb } from "../db/db";
import { createSession, setStatus, insertTrial, insertEvents, insertBlockSurvey, insertExitSurvey } from "../db/repo";
import type { Assignment, EventSubmission } from "../../shared/api";
import type { Trial, BlockSurvey, ExitSurvey, Likert7 } from "../../shared/types";

// ---------- toCsv ----------
describe("toCsv", () => {
  it("emits only the header (with CRLF) for empty rows", () => {
    expect(toCsv([], ["a", "b", "c"])).toBe("a,b,c\r\n");
  });

  it("uses CRLF line endings and column order, ignoring extra keys", () => {
    const out = toCsv([{ b: 2, a: 1, extra: "x" }, { a: 3, b: 4 }], ["a", "b"]);
    expect(out).toBe("a,b\r\n1,2\r\n3,4\r\n");
  });

  it("writes booleans as TRUE/FALSE", () => {
    expect(toCsv([{ x: true, y: false }], ["x", "y"])).toBe("x,y\r\nTRUE,FALSE\r\n");
  });

  it("writes null, undefined and missing as empty", () => {
    expect(toCsv([{ a: null, b: undefined }], ["a", "b", "c"])).toBe("a,b,c\r\n,,\r\n");
  });

  it("writes numbers as-is, including 0 and decimals", () => {
    expect(toCsv([{ a: 0, b: 9312.4, c: -1 }], ["a", "b", "c"])).toBe("a,b,c\r\n0,9312.4,-1\r\n");
  });

  it("pipe-joins arrays, empty array -> empty", () => {
    const out = toCsv([{ f: ["claimVsRecord", "source"], g: [] }], ["f", "g"]);
    expect(out).toBe("f,g\r\nclaimVsRecord|source,\r\n");
  });

  it("quotes fields containing commas", () => {
    expect(toCsv([{ c: "a,b" }], ["c"])).toBe('c\r\n"a,b"\r\n');
  });

  it("quotes and doubles embedded quotes", () => {
    expect(toCsv([{ c: 'say "hi"' }], ["c"])).toBe('c\r\n"say ""hi"""\r\n');
  });

  it("quotes fields containing LF or CR", () => {
    expect(toCsv([{ c: "line1\nline2", d: "x\ry" }], ["c", "d"])).toBe('c,d\r\n"line1\nline2","x\ry"\r\n');
  });

  it("does not quote plain strings or strings with spaces", () => {
    expect(toCsv([{ c: "hello world" }], ["c"])).toBe("c\r\nhello world\r\n");
  });

  it("quotes header cells that need it", () => {
    expect(toCsv([], ["a,b"])).toBe('"a,b"\r\n');
  });

  it("empty string stays empty", () => {
    expect(toCsv([{ c: "" }], ["c"])).toBe("c\r\n\r\n");
  });
});

// ---------- exporters (seeded through repo) ----------
function parseCsv(text: string): string[][] {
  // minimal RFC 4180 parser for assertions
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function records(csv: string): Record<string, string>[] {
  const [header, ...body] = parseCsv(csv);
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const assignment: Assignment = {
  pid: 7,
  conditionOrder: ["C", "D", "B", "A"],
  setRotation: 1,
  seed: 7,
  blocks: [
    { blockIndex: 1, condition: "C", set: "S2", postOrder: ["p07", "p08", "p09", "p10", "p11", "p12"] },
    { blockIndex: 2, condition: "D", set: "S3", postOrder: ["p13", "p14", "p15", "p16", "p17", "p18"] },
    { blockIndex: 3, condition: "B", set: "S4", postOrder: ["p19", "p20", "p21", "p22", "p23", "p24"] },
    { blockIndex: 4, condition: "A", set: "S1", postOrder: ["p01", "p02", "p03", "p04", "p05", "p06"] },
  ],
};

function trial(over: Partial<Trial> = {}): Trial {
  return {
    trialId: "7-1-1", blockIndex: 1, positionInBlock: 1, trialIndex: 1, postId: "p07",
    condition: "C", set: "S2", topic: "env", aiLabel: "accurate", groundTruth: "FALSE",
    isAiCorrect: false, errorType: "miss", difficulty: "subtle", agreed: false, detectedError: true,
    confidence: 6, labelShownAt: "2026-11-03T14:12:05.120Z", respondedAt: "2026-11-03T14:12:14.433Z",
    decisionTimeMs: 9312.4, decisionTimeRawMs: 9312.4, hiddenMs: 0, hiddenCount: 0, blurCount: 0,
    timingFlag: false, factSheetOpened: true, factSheetOpenMs: 1200, explanationOpened: true,
    factorsExpanded: ["claimVsRecord", "source"], timeToFirstExpandMs: 2100, resumed: false,
    ...over,
  };
}

const scored = (raw: number[]) => raw.map((r, i) => (i < 5 ? 8 - r : r));

function survey(blockIndex: 1 | 2 | 3 | 4, condition: "A" | "B" | "C" | "D"): BlockSurvey {
  const raw = [1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 5];
  const sc = scored(raw);
  return {
    blockIndex, condition,
    trustResponses: raw.map((r, i) => ({ itemId: `jian-${String(i + 1).padStart(2, "0")}`, raw: r as Likert7, scored: sc[i] as Likert7 })),
    trustMean: sc.reduce((a, b) => a + b, 0) / 12,
    fairness1: 5, fairness2: 6, fairnessMean: 5.5, tension: 3, frustrationTlx: 35, frustrationTlxTouched: true,
    nWrongDetected: 1, anxiety: null, submittedAt: "2026-11-03T14:20:00.000Z",
  };
}

const exit: ExitSurvey = {
  ageRange: "18-24", gender: null, education: "bachelors", socialMediaUse: "daily", labelExposure: "sometimes",
  preferredCondition: "C", comment: 'Liked the "Why?" button, mostly\nthanks', submittedAt: "2026-11-03T14:40:00.000Z",
};

function event(seq: number, over: Partial<EventSubmission> = {}): EventSubmission {
  return {
    seq, trialId: "7-1-1", blockIndex: 1, condition: "C", postId: "p07", type: "factor_expand",
    factorKey: "claimVsRecord", tMs: 2100.5, perfNow: 50000.25, wallClock: "2026-11-03T14:12:07.220Z", ...over,
  };
}

describe("exporters", () => {
  let db: Database.Database;
  let sessionId: string;

  beforeEach(async () => {
    db = openDb(":memory:");
    const s = await createSession(db, assignment, { consequenceBanner: false, anxiety: false, postBankHash: "abc", appVersion: "0.1.0" });
    sessionId = s.sessionId;
  });

  it("empty DB -> header-only CSVs and [] JSON", async () => {
    const fresh = openDb(":memory:");
    expect(await trialsCsv(fresh)).toBe(TRIAL_COLUMNS.join(",") + "\r\n");
    expect(await surveysCsv(fresh)).toBe(SURVEY_COLUMNS.join(",") + "\r\n");
    expect(await eventsCsv(fresh)).toBe(EVENT_COLUMNS.join(",") + "\r\n");
    expect(await exitCsv(fresh)).toBe(EXIT_COLUMNS.join(",") + "\r\n");
    expect(JSON.parse(await sessionsJson(fresh))).toEqual([]);
  });

  it("preserves existing columns and appends protocol metadata", () => {
    expect(TRIAL_COLUMNS).toHaveLength(38);
    expect(TRIAL_COLUMNS.slice(0, 3)).toEqual(["pid", "sessionId", "trialId"]);
    expect(TRIAL_COLUMNS.slice(-6)).toEqual(["conditionOrder", "setRotation", "status", "plannedTrials", "studyVariant", "protocolVersion"]);
    expect(SURVEY_COLUMNS).toHaveLength(4 + 24 + 9 + 2 + 3);
    expect(SURVEY_COLUMNS[4]).toBe("trust_01");
    expect(SURVEY_COLUMNS[27]).toBe("trust_12_s");
    expect(EVENT_COLUMNS).toHaveLength(13);
    expect(EXIT_COLUMNS).toHaveLength(11);
  });

  it("trials.csv: one row per trial with session fields and CSV encodings", async () => {
    await insertTrial(db, sessionId, trial());
    await insertTrial(db, sessionId, trial({
      trialId: "7-1-2", positionInBlock: 2, trialIndex: 2, postId: "p08", groundTruth: "TRUE", aiLabel: "accurate",
      isAiCorrect: true, errorType: null, difficulty: null, agreed: true, detectedError: null,
      explanationOpened: null, factorsExpanded: [], timeToFirstExpandMs: null,
    }));
    const csv = await trialsCsv(db);
    expect(csv.split("\r\n")[0]).toBe(TRIAL_COLUMNS.join(","));
    const [a, b] = records(csv);
    expect(a).toMatchObject({
      pid: "7", sessionId, trialId: "7-1-1", blockIndex: "1", positionInBlock: "1", trialIndex: "1",
      condition: "C", set: "S2", postId: "p07", topic: "env", aiLabel: "accurate", groundTruth: "FALSE",
      isAiCorrect: "FALSE", errorType: "miss", difficulty: "subtle", agreed: "FALSE", detectedError: "TRUE",
      confidence: "6", decisionTimeMs: "9312.4", timingFlag: "FALSE", factSheetOpened: "TRUE",
      factSheetOpenMs: "1200", explanationOpened: "TRUE", factorsExpanded: "claimVsRecord|source",
      timeToFirstExpandMs: "2100", resumed: "FALSE", labelShownAt: "2026-11-03T14:12:05.120Z",
      conditionOrder: "CDBA", setRotation: "1", status: "in_progress",
    });
    expect(b).toMatchObject({
      trialId: "7-1-2", isAiCorrect: "TRUE", errorType: "", difficulty: "", agreed: "TRUE", detectedError: "",
      explanationOpened: "", factorsExpanded: "", timeToFirstExpandMs: "",
    });
  });

  it("surveys.csv: raw and scored trust columns, means, booleans", async () => {
    await insertTrial(db, sessionId, trial());
    await insertBlockSurvey(db, sessionId, survey(1, "C"));
    const [r] = records(await surveysCsv(db));
    expect(r.pid).toBe("7");
    expect(r.sessionId).toBe(sessionId);
    expect(r.blockIndex).toBe("1");
    expect(r.condition).toBe("C");
    expect(r.trust_01).toBe("1");
    expect(r.trust_01_s).toBe("7");
    expect(r.trust_05_s).toBe("3");
    expect(r.trust_06).toBe("6");
    expect(r.trust_06_s).toBe("6");
    expect(r.trust_12).toBe("5");
    expect(Number(r.trustMean)).toBeCloseTo(survey(1, "C").trustMean!);
    expect(r).toMatchObject({
      fairness1: "5", fairness2: "6", fairnessMean: "5.5", tension: "3", frustrationTlx: "35",
      frustrationTlxTouched: "TRUE", nWrongDetected: "1", submittedAt: "2026-11-03T14:20:00.000Z",
    });
  });

  it("events.csv: ordered by seq, nulls empty, numbers as-is", async () => {
    await insertEvents(db, sessionId, [
      event(2),
      event(1, { type: "session_start", trialId: null, blockIndex: null, condition: null, postId: null, factorKey: null, tMs: null }),
    ]);
    const rows = records(await eventsCsv(db));
    expect(rows.map((r) => r.seq)).toEqual(["1", "2"]);
    expect(rows[0]).toMatchObject({ pid: "7", sessionId, type: "session_start", trialId: "", factorKey: "", tMs: "" });
    expect(rows[1]).toMatchObject({
      trialId: "7-1-1", blockIndex: "1", condition: "C", postId: "p07", type: "factor_expand",
      factorKey: "claimVsRecord", tMs: "2100.5", perfNow: "50000.25", wallClock: "2026-11-03T14:12:07.220Z",
    });
  });

  it("exit.csv: quoted comment round-trips, null gender empty", async () => {
    await insertExitSurvey(db, sessionId, exit);
    const csv = await exitCsv(db);
    expect(csv).toContain('"Liked the ""Why?"" button, mostly\nthanks"');
    const [r] = records(csv);
    expect(r).toMatchObject({
      pid: "7", sessionId, ageRange: "18-24", gender: "", education: "bachelors", socialMediaUse: "daily",
      labelExposure: "sometimes", preferredCondition: "C", comment: exit.comment, submittedAt: exit.submittedAt,
    });
  });

  it("sessions.json: array of full sessions", async () => {
    await insertTrial(db, sessionId, trial());
    await insertEvents(db, sessionId, [event(1)]);
    await insertExitSurvey(db, sessionId, exit);
    const parsed = JSON.parse(await sessionsJson(db));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    const text = JSON.stringify(parsed[0]);
    expect(text).toContain(sessionId);
    expect(text).toContain("7-1-1");
    expect(text).toContain("factor_expand");
  });
});

// ---------- participants.csv / kpis.csv / index ----------
describe("participants.csv", () => {
  const HASH = "deadbeefcafef00d0123456789abcdef0123456789abcdef0123456789abcdef";
  const opts = { consequenceBanner: false, anxiety: false, postBankHash: "abc", appVersion: "0.1.0" };

  async function seedCompleted(db: Database.Database) {
    const s = await createSession(db, assignment, { ...opts, participantHash: HASH });
    // block 1 (C): wrong miss detected, correct agreed, wrong false_alarm not detected
    await insertTrial(db, s.sessionId, trial({ decisionTimeMs: 1000, confidence: 6 }));
    await insertTrial(db, s.sessionId, trial({
      trialId: "7-1-2", positionInBlock: 2, trialIndex: 2, postId: "p08", groundTruth: "TRUE", isAiCorrect: true,
      errorType: null, difficulty: null, agreed: true, detectedError: null, decisionTimeMs: 2000, confidence: 5,
      factSheetOpened: false,
    }));
    await insertTrial(db, s.sessionId, trial({
      trialId: "7-1-3", positionInBlock: 3, trialIndex: 3, postId: "p09", aiLabel: "misleading", groundTruth: "TRUE",
      errorType: "false_alarm", difficulty: "clear", agreed: true, detectedError: false, decisionTimeMs: 4000, confidence: 4,
      factSheetOpened: false,
    }));
    await insertBlockSurvey(db, s.sessionId, survey(1, "C"));
    await insertExitSurvey(db, s.sessionId, exit);
    db.prepare("UPDATE sessions SET started_at = ? WHERE session_id = ?").run("2026-11-03T14:00:00.000Z", s.sessionId);
    await setStatus(db, s.sessionId, "completed", "2026-11-03T14:17:20.000Z");
    return s.sessionId;
  }

  it("empty DB -> header only, in the contract column order", async () => {
    const fresh = openDb(":memory:");
    expect(await participantsCsv(fresh)).toBe(PARTICIPANT_COLUMNS.join(",") + "\r\n");
    expect(PARTICIPANT_COLUMNS.slice(0, 19)).toEqual([
      "pid", "sessionId", "isPilot", "status", "conditionOrder", "setRotation", "startedAt", "completedAt",
      "durationMin", "trialsSaved", "surveysSaved", "agreementRate", "wrongDetected", "falseAlarmDetected",
      "missDetected", "detectionRate", "meanConfidence", "medianDecisionMs", "factSheetOpenRate",
    ]);
    expect(PARTICIPANT_COLUMNS.slice(19, 25)).toEqual(["agreement_A", "detected_A", "trust_A", "fairness_A", "tension_A", "frustration_A"]);
    expect(PARTICIPANT_COLUMNS.slice(37, 43)).toEqual(["agreement_D", "detected_D", "trust_D", "fairness_D", "tension_D", "frustration_D"]);
    expect(PARTICIPANT_COLUMNS.slice(43, 52)).toEqual([
      "ageRange", "gender", "education", "socialMediaUse", "labelExposure", "preferredCondition", "comment", "plannedTrials", "studyVariant",
    ]);
    expect(PARTICIPANT_COLUMNS).toHaveLength(19 + 24 + 7 + 2 + 32);
  });

  it("computes totals, rates (3 dp), duration (1 dp) and per-condition fields", async () => {
    const db = openDb(":memory:");
    const id = await seedCompleted(db);
    const csv = await participantsCsv(db);
    expect(csv.split("\r\n")[0]).toBe(PARTICIPANT_COLUMNS.join(","));
    const [r] = records(csv);
    expect(r).toMatchObject({
      pid: "7", sessionId: id, isPilot: "FALSE", status: "completed", conditionOrder: "CDBA", setRotation: "1",
      startedAt: "2026-11-03T14:00:00.000Z", completedAt: "2026-11-03T14:17:20.000Z", durationMin: "17.3",
      trialsSaved: "3", surveysSaved: "1", agreementRate: "0.667", wrongDetected: "1", falseAlarmDetected: "0",
      missDetected: "1", detectionRate: "0.5", meanConfidence: "5", medianDecisionMs: "2000", factSheetOpenRate: "0.333",
      agreement_C: "0.667", detected_C: "1", fairness_C: "5.5", tension_C: "3", frustration_C: "35",
      agreement_A: "", detected_A: "", trust_A: "", fairness_A: "", tension_A: "", frustration_A: "",
      ageRange: "18-24", gender: "", education: "bachelors", preferredCondition: "C", comment: exit.comment,
    });
    expect(r.trust_C).toBe(String(Math.round(survey(1, "C").trustMean! * 1000) / 1000));
  });

  it("includes in-progress and pilot sessions, flags pilots, leaves duration empty when not completed", async () => {
    const db = openDb(":memory:");
    await createSession(db, { ...assignment, pid: 905, seed: 905 }, opts);
    await createSession(db, assignment, opts);
    const rows = records(await participantsCsv(db));
    expect(rows.map((r) => [r.pid, r.isPilot, r.status])).toEqual([["7", "FALSE", "in_progress"], ["905", "TRUE", "in_progress"]]);
    expect(rows[0]).toMatchObject({ durationMin: "", completedAt: "", agreementRate: "", detectionRate: "", trialsSaved: "0", wrongDetected: "0" });
  });

  it("never contains the participant hash", async () => {
    const db = openDb(":memory:");
    await seedCompleted(db);
    expect(db.prepare("SELECT participant_hash AS h FROM sessions").get()).toEqual({ h: HASH });
    expect(await participantsCsv(db)).not.toContain(HASH);
    expect(await participantsCsv(db)).not.toMatch(/hash/i);
    expect(await kpisCsv(db)).not.toContain(HASH);
  });
});

describe("kpis.csv", () => {
  const now = new Date("2026-10-17T12:00:00.000Z");

  it("rows match computeKpis in long form", async () => {
    const db = openDb(":memory:");
    const s = await createSession(db, assignment, { consequenceBanner: false, anxiety: false, postBankHash: "abc", appVersion: "0.1.0" });
    await insertTrial(db, s.sessionId, trial());
    await setStatus(db, s.sessionId, "completed", "2026-10-17T10:00:00.000Z");
    const k = await computeKpis(db, now);
    const rows = records(await kpisCsv(db, now, "all"));
    expect(parseCsv(await kpisCsv(db, now))[0]).toEqual(KPI_COLUMNS);
    expect(rows[0]).toEqual({ section: "meta", key: "all", metric: "generatedAt", value: now.toISOString() });
    const get = (section: string, key: string, metric: string) =>
      rows.find((r) => r.section === section && r.key === key && r.metric === metric)?.value;
    expect(get("summary", "all", "completed")).toBe(String(k.sessions.completed));
    expect(get("summary", "all", "completed")).toBe("1");
    expect(get("summary", "all", "targetN")).toBe(String(k.target.n));
    for (const c of k.byCondition) {
      for (const [m, v] of Object.entries(c)) {
        if (m === "condition") continue;
        expect(get("condition", c.condition, m)).toBe(v === null ? "" : String(v));
      }
    }
    expect(get("condition", "C", "detectionRate")).toBe("1");
    for (const e of k.byErrorType) expect(get("errorType", e.errorType, "detectionRate")).toBe(e.detectionRate === null ? "" : String(e.detectionRate));
    expect(get("errorType", "miss", "detectionRate")).toBe("1");
    for (const b of k.balance) expect(get("balance", b.conditionOrder, "completed")).toBe(String(b.completed));
    expect(get("balance", "CDBA", "completed")).toBe("1");
    expect(get("daily", "2026-10-17", "completed")).toBe("1");
    const expected = 2 + Object.keys(k.primaryOutcome!).length + 11 + k.byCondition.reduce((n, c) => n + Object.keys(c).length - 1, 0) + 2 * 2 + k.balance.length + k.dailyCompleted.length;
    expect(rows).toHaveLength(expected);
  });

  it("empty DB still lists every metric, with empty rates", async () => {
    const rows = records(await kpisCsv(openDb(":memory:"), now));
    expect(rows.find((r) => r.metric === "completionRate")?.value).toBe("");
    expect(rows.filter((r) => r.section === "daily")).toHaveLength(0);
    expect(rows.filter((r) => r.section === "balance")).toHaveLength(4);
  });
});

describe("exportIndex", () => {
  it("lists all 7 exports with descriptions and data row counts", async () => {
    const db = openDb(":memory:");
    const s = await createSession(db, assignment, { consequenceBanner: false, anxiety: false, postBankHash: "abc", appVersion: "0.1.0" });
    await insertTrial(db, s.sessionId, trial());
    await insertEvents(db, s.sessionId, [event(1), event(2)]);
    const idx = await exportIndex(db);
    expect(idx.map((e) => e.name)).toEqual([
      "participants.csv", "trials.csv", "surveys.csv", "events.csv", "exit.csv", "kpis.csv", "sessions.json",
    ]);
    for (const e of idx) expect(e.description.length).toBeGreaterThan(10);
    const rows = Object.fromEntries(idx.map((e) => [e.name, e.rows]));
    expect(rows).toMatchObject({ "participants.csv": 1, "trials.csv": 1, "surveys.csv": 0, "events.csv": 2, "exit.csv": 0, "sessions.json": 1 });
    expect(rows["kpis.csv"]).toBe(records(await kpisCsv(db)).length);
    expect(rows["trials.csv"]).toBe(records(await trialsCsv(db)).length);
  });
});


describe("study-version metadata", () => {
  const opts = { consequenceBanner: false, anxiety: false, postBankHash: "test", appVersion: "test" };
  it("exports the planned length even for unfinished short and legacy sessions", async () => {
    const db = openDb(":memory:");
    await createSession(db, assignment, opts);
    const short: Assignment = { ...assignment, pid: 8, blocks: assignment.blocks.map(b => ({ ...b, postOrder: b.postOrder.slice(0, 2) })) as Assignment["blocks"] as Assignment["blocks"] };
    await createSession(db, short, opts);
    const rows = records(await participantsCsv(db));
    expect(rows.find(r => r.pid === "7")).toMatchObject({ plannedTrials: "24", studyVariant: "legacy-24", trialsSaved: "0" });
    expect(rows.find(r => r.pid === "8")).toMatchObject({ plannedTrials: "8", studyVariant: "short-8", trialsSaved: "0" });
    db.close();
  });
});

describe("brief and legacy export isolation", () => {
  it("exports both protocols, leaves full-scale scores blank for brief surveys, and defaults KPI CSV to current", async () => {
    const db = openDb(":memory:");
    const legacy = await createSession(db, assignment, { consequenceBanner: false, anxiety: false, postBankHash: "h", appVersion: "v" });
    const current = await createSession(db, { ...assignment, pid: 8, seed: 8, blocks: assignment.blocks.map((b) => ({ ...b, postOrder: b.postOrder.slice(0, 2) })) as Assignment["blocks"] }, {
      consequenceBanner: false, anxiety: false, postBankHash: "h", appVersion: "v", protocolVersion: "calibrated-brief-v1",
    });
    await insertBlockSurvey(db, legacy.sessionId, survey(1, "C"));
    await insertBlockSurvey(db, current.sessionId, { ...survey(1, "C"), questionnaireVersion: "brief-v1", briefTrust: 6,
      trustResponses: [], trustMean: null, fairness1: null, fairness2: null, fairnessMean: null });
    for (const s of [legacy, current]) {
      await insertTrial(db, s.sessionId, trial());
      await insertTrial(db, s.sessionId, trial({ trialId: "7-1-2", positionInBlock: 2, trialIndex: 2,
        isAiCorrect: true, agreed: true, detectedError: null, errorType: null, difficulty: null }));
      await setStatus(db, s.sessionId, "completed", "2026-10-17T12:00:00Z");
    }
    const sv = records(await surveysCsv(db));
    expect(sv.find((r) => r.sessionId === current.sessionId)).toMatchObject({
      protocolVersion: "calibrated-brief-v1", questionnaireVersion: "brief-v1", briefTrust: "6",
      trustMean: "", fairness1: "", fairness2: "", fairnessMean: "", trust_01: "", trust_01_s: "",
    });
    expect(sv.find((r) => r.sessionId === legacy.sessionId)).toMatchObject({
      protocolVersion: "legacy-full-v1", questionnaireVersion: "full-v1", briefTrust: "", trust_01: "1", trust_01_s: "7",
    });
    const participants = records(await participantsCsv(db));
    expect(participants).toHaveLength(2);
    const brief = participants.find((r) => r.sessionId === current.sessionId)!;
    expect(brief).toMatchObject({ protocolVersion: "calibrated-brief-v1", questionnaireVersion: "brief-v1", briefTrust: "6",
      trust_C: "", fairness_C: "", briefTrust_C: "6", correctAcceptanceRate: "1", wrongRejectionRate: "1",
      appropriateRelianceRate: "1", overrelianceRate: "0", underrelianceRate: "0", appropriateRelianceRate_C: "1",
      correctAcceptanceRate_A: "", wrongRejectionRate_A: "", plannedTrials: "8", studyVariant: "short-8" });
    const defaultRows = records(await kpisCsv(db));
    expect(defaultRows.find((r) => r.metric === "protocolVersion")?.value).toBe("calibrated-full-v1");
    expect(defaultRows.find((r) => r.section === "summary" && r.metric === "completed")?.value).toBe("0");
    const rows = records(await kpisCsv(db, new Date(), "calibrated-brief-v1"));
    expect(rows.find((r) => r.metric === "protocolVersion")?.value).toBe("calibrated-brief-v1");
    expect(rows.find((r) => r.section === "summary" && r.metric === "completed")?.value).toBe("1");
    expect(rows.find((r) => r.section === "primaryOutcome" && r.metric === "trials")?.value).toBe("2");
    const raw = records(await trialsCsv(db));
    expect(new Set(raw.map((r) => r.protocolVersion))).toEqual(new Set(["legacy-full-v1", "calibrated-brief-v1"]));
    expect(JSON.parse(await sessionsJson(db)).map((s: { protocolVersion: string }) => s.protocolVersion)).toContain("calibrated-brief-v1");
    db.close();
  });
});
