import { describe, it, expect } from "vitest";
import type { SessionView } from "../../shared/api";
import { initialStudyState, studyReducer } from "./studyReducer";
import { routeForCursor } from "./StudyContext";

const session: SessionView = {
  sessionId: "s-1",
  pid: 1,
  status: "in_progress",
  conditionOrder: ["A", "B", "D", "C"],
  setRotation: 0,
  blocks: [
    { blockIndex: 1, condition: "A", set: "S1", postOrder: ["p01", "p02", "p03", "p04", "p05", "p06"] },
    { blockIndex: 2, condition: "B", set: "S2", postOrder: ["p07", "p08", "p09", "p10", "p11", "p12"] },
    { blockIndex: 3, condition: "D", set: "S3", postOrder: ["p13", "p14", "p15", "p16", "p17", "p18"] },
    { blockIndex: 4, condition: "C", set: "S4", postOrder: ["p19", "p20", "p21", "p22", "p23", "p24"] },
  ],
  cursor: { blockIndex: 1, positionInBlock: 1, phase: "consent" },
  consequenceBanner: false,
  anxiety: false,
  resumeCount: 0,
  nextEventSeq: 1,
  consentAt: null,
  startedAt: "2026-10-17T10:00:00.000Z",
  completedAt: null,
};

describe("studyReducer", () => {
  it("starts idle", () => {
    expect(initialStudyState).toEqual({ status: "idle", session: null, error: null, resumed: false });
  });

  it("LOADING sets status and clears error", () => {
    const s = studyReducer({ ...initialStudyState, status: "error", error: "x" }, { type: "LOADING" });
    expect(s).toEqual({ status: "loading", session: null, error: null, resumed: false });
  });

  it("SESSION_LOADED stores the session and becomes ready", () => {
    const s = studyReducer({ ...initialStudyState, error: "old" }, { type: "SESSION_LOADED", session });
    expect(s.status).toBe("ready");
    expect(s.session).toBe(session);
    expect(s.error).toBeNull();
  });

  it("CURSOR_CHANGED updates the cursor immutably", () => {
    const before = studyReducer(initialStudyState, { type: "SESSION_LOADED", session });
    const cursor = { blockIndex: 2, positionInBlock: 3, phase: "trial" } as const;
    const after = studyReducer(before, { type: "CURSOR_CHANGED", cursor });
    expect(after.session?.cursor).toEqual(cursor);
    expect(before.session?.cursor.phase).toBe("consent");
    expect(after.session).not.toBe(before.session);
    expect(after.session?.blocks).toBe(session.blocks);
  });

  it("CURSOR_CHANGED without a session is a no-op", () => {
    const s = studyReducer(initialStudyState, { type: "CURSOR_CHANGED", cursor: session.cursor });
    expect(s).toBe(initialStudyState);
  });

  it("ERROR keeps the session and records the message", () => {
    const loaded = studyReducer(initialStudyState, { type: "SESSION_LOADED", session });
    const s = studyReducer(loaded, { type: "ERROR", error: "network" });
    expect(s.status).toBe("error");
    expect(s.error).toBe("network");
    expect(s.session).toBe(session);
  });

  it("RESET returns to the initial state", () => {
    const loaded = studyReducer(initialStudyState, { type: "SESSION_LOADED", session });
    expect(studyReducer(loaded, { type: "RESET" })).toEqual(initialStudyState);
  });
});

describe("routeForCursor", () => {
  it.each([
    [{ blockIndex: 1, positionInBlock: 1, phase: "consent" }, "/consent"],
    [{ blockIndex: 1, positionInBlock: 1, phase: "instructions" }, "/instructions"],
    [{ blockIndex: 2, positionInBlock: 4, phase: "trial" }, "/trial/2/4"],
    [{ blockIndex: 3, positionInBlock: 6, phase: "post_rating" }, "/trial/3/6"],
    [{ blockIndex: 4, positionInBlock: 6, phase: "block_survey" }, "/survey/4"],
    [{ blockIndex: 4, positionInBlock: 6, phase: "exit_survey" }, "/exit"],
    [{ blockIndex: 4, positionInBlock: 6, phase: "done" }, "/debrief"],
  ] as const)("%o -> %s", (cursor, route) => {
    expect(routeForCursor(cursor)).toBe(route);
  });
});
