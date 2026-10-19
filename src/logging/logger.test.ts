// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("../api/client", () => ({
  api: { submitEvents: vi.fn() },
}));

import { api } from "../api/client";
import { createLogger, AUTO_FLUSH_MS } from "./logger";
import { useTrialTimer } from "./useTrialTimer";

const submitEvents = api.submitEvents as unknown as ReturnType<typeof vi.fn>;
let now = 0;
const ev = { trialId: "1-1-1", blockIndex: 1, condition: "A" as const, postId: "p1", type: "trial_shown" as const, factorKey: null, tMs: 0 };

function setVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  submitEvents.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setVisibility("visible");
});

describe("createLogger", () => {
  it("assigns increasing seq starting at startSeq, with perfNow and wallClock", async () => {
    submitEvents.mockResolvedValue({ inserted: 3 });
    const logger = createLogger("s1", 5);
    logger.log(ev);
    now = 1010;
    logger.log(ev);
    logger.log(ev);
    expect(logger.nextSeq()).toBe(8);
    await logger.flush();
    const sent = submitEvents.mock.calls[0][1];
    expect(submitEvents.mock.calls[0][0]).toBe("s1");
    expect(sent.map((e: { seq: number }) => e.seq)).toEqual([5, 6, 7]);
    expect(sent[1].perfNow).toBe(1010);
    expect(typeof sent[0].wallClock).toBe("string");
    logger.dispose();
  });

  it("keeps events when a flush fails and resends them without new seqs", async () => {
    submitEvents.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ inserted: 2 });
    const logger = createLogger("s1");
    logger.log(ev);
    await logger.flush();
    logger.log(ev);
    await logger.flush();
    expect(submitEvents).toHaveBeenCalledTimes(2);
    expect(submitEvents.mock.calls[1][1].map((e: { seq: number }) => e.seq)).toEqual([1, 2]);
    await logger.flush();
    expect(submitEvents).toHaveBeenCalledTimes(2); // nothing left
    logger.dispose();
  });

  it("auto-flushes every 5 s and stops after dispose", async () => {
    submitEvents.mockResolvedValue({ inserted: 1 });
    const logger = createLogger("s1");
    logger.log(ev);
    await vi.advanceTimersByTimeAsync(AUTO_FLUSH_MS);
    expect(submitEvents).toHaveBeenCalledTimes(1);
    logger.dispose();
    logger.log(ev);
    await vi.advanceTimersByTimeAsync(AUTO_FLUSH_MS * 2);
    expect(submitEvents).toHaveBeenCalledTimes(1);
  });

  it("sends remaining events with sendBeacon on pagehide", async () => {
    class FakeBlob {
      constructor(public parts: string[], public opts: { type: string }) {}
      get type() { return this.opts.type; }
    }
    vi.stubGlobal("Blob", FakeBlob);
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beacon });
    const logger = createLogger("abc");
    logger.log(ev);
    logger.log(ev);
    window.dispatchEvent(new Event("pagehide"));
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, blob] = beacon.mock.calls[0] as unknown as [string, FakeBlob];
    expect(url).toBe("/api/sessions/abc/events");
    expect(blob.type).toBe("text/plain");
    const body = JSON.parse(blob.parts.join(""));
    expect(body.events.map((e: { seq: number }) => e.seq)).toEqual([1, 2]);
    await logger.flush();
    expect(submitEvents).not.toHaveBeenCalled();
    logger.dispose();
  });
});

describe("useTrialTimer", () => {
  it("measures raw decision time and reports hidden time separately", () => {
    const { result } = renderHook(() => useTrialTimer());
    act(() => result.current.markShown());
    expect(result.current.shownAtIso).not.toBeNull();
    now = 2000;
    setVisibility("hidden");
    now = 5000;
    setVisibility("visible");
    now = 6000;
    act(() => result.current.markShown()); // idempotent
    const snap = result.current.snapshot();
    expect(snap.decisionTimeRawMs).toBe(5000);
    expect(snap.hiddenMs).toBe(3000);
    expect(snap.hiddenCount).toBe(1);
  });

  it("counts window blur", () => {
    const { result } = renderHook(() => useTrialTimer());
    act(() => result.current.markShown());
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("blur"));
    expect(result.current.snapshot().blurCount).toBe(2);
  });

  it("accumulates fact-sheet open time, excluding hidden time and closing on snapshot", () => {
    const { result } = renderHook(() => useTrialTimer());
    act(() => result.current.markShown());
    now = 1100;
    result.current.onFactSheet(true);
    now = 1600;
    result.current.onFactSheet(false); // 500
    now = 2000;
    result.current.onFactSheet(true);
    now = 2200;
    setVisibility("hidden"); // +200
    now = 4000;
    setVisibility("visible");
    now = 4300; // still open: +300 at snapshot
    const snap = result.current.snapshot();
    expect(snap.factSheetOpened).toBe(true);
    expect(snap.factSheetOpenMs).toBe(1000);
  });

  it("records time to first Why? only once", () => {
    const { result } = renderHook(() => useTrialTimer());
    act(() => result.current.markShown());
    now = 3500;
    result.current.onWhy(true);
    now = 4000;
    result.current.onWhy(false);
    result.current.onWhy(true);
    const snap = result.current.snapshot();
    expect(snap.explanationOpened).toBe(true);
    expect(snap.timeToFirstExpandMs).toBe(2500);
  });

  it("keeps unique factor keys in first-expand order and reset clears state", () => {
    const { result } = renderHook(() => useTrialTimer());
    act(() => result.current.markShown());
    result.current.onFactorExpand("wording");
    result.current.onFactorExpand("source");
    result.current.onFactorExpand("wording");
    result.current.onFactorExpand("claimVsRecord");
    expect(result.current.snapshot().factorsExpanded).toEqual(["wording", "source", "claimVsRecord"]);
    act(() => result.current.reset());
    expect(result.current.shownAtIso).toBeNull();
    const snap = result.current.snapshot();
    expect(snap.factorsExpanded).toEqual([]);
    expect(snap.explanationOpened).toBe(false);
    expect(snap.timeToFirstExpandMs).toBeNull();
  });
});
