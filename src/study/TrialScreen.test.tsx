// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Presentation, Condition } from "../../shared/types";
import type { SessionView, TrialSubmission } from "../../shared/api";

const mocks = vi.hoisted(() => ({
  api: {
    getPresentation: vi.fn(),
    submitTrial: vi.fn(),
    getSession: vi.fn(),
  },
  study: {
    state: { status: "ready", session: null, error: null, resumed: false } as Record<string, unknown>,
    session: null as unknown,
    dispatch: vi.fn(),
  },
  logger: { log: vi.fn(), flush: vi.fn(), nextSeq: vi.fn(() => 1) },
  timer: {
    markShown: vi.fn(),
    shownAtIso: null,
    onFactSheet: vi.fn(),
    onWhy: vi.fn(),
    onFactorExpand: vi.fn(),
    reset: vi.fn(),
    snapshot: vi.fn(),
  },
}));

vi.mock("../api/client", () => ({ api: mocks.api }));
vi.mock("../state/StudyContext", () => ({
  useStudy: () => ({
    state: mocks.study.state,
    session: mocks.study.session,
    dispatch: mocks.study.dispatch,
    startSession: vi.fn(),
    resume: vi.fn(),
    advance: vi.fn(),
  }),
  routeForCursor: (c: { blockIndex: number; positionInBlock: number; phase: string }) =>
    c.phase === "block_survey" ? `/survey/${c.blockIndex}` : `/trial/${c.blockIndex}/${c.positionInBlock}`,
}));
vi.mock("../logging/logger", () => ({ useLogger: () => mocks.logger }));
vi.mock("../logging/useTrialTimer", () => ({ useTrialTimer: () => mocks.timer }));
vi.mock("../conditions/conditionRegistry", () => {
  const Plain = () => <div data-testid="explanation" />;
  const Interactive = (props: {
    onWhy?(open: boolean): void;
    onFactorToggle?(key: string, expanded: boolean): void;
  }) => (
    <div data-testid="explanation">
      <button type="button" className="why-button" onClick={() => props.onWhy?.(true)}>Why?</button>
      <button type="button" onClick={() => props.onFactorToggle?.("source", true)}>Expand source</button>
    </div>
  );
  return { conditionRegistry: { A: Plain, B: Plain, C: Interactive, D: Plain } };
});

import TrialScreen, { clearPresentationCache } from "./TrialScreen";

const SNAP = {
  labelShownAt: "2026-10-17T10:00:00.000Z",
  respondedAt: "2026-10-17T10:00:04.000Z",
  decisionTimeRawMs: 4000,
  hiddenMs: 0,
  hiddenCount: 0,
  blurCount: 1,
  factSheetOpened: true,
  factSheetOpenMs: 1200,
  explanationOpened: true,
  factorsExpanded: ["source", "claimVsRecord"],
  timeToFirstExpandMs: 900,
};

function presentation(condition: Condition): Presentation {
  return {
    postId: "p07",
    condition,
    author: { handle: "@RivertonNeighbors", displayName: "Riverton Neighbors", verified: true },
    text: "Good news: Riverton tap water met all 12 safety limits in March.",
    postedAgo: "6h",
    likes: 187,
    reposts: 52,
    factSheet: { title: "March Water Quality Report", body: "All 12 results were within limits.", source: "Riverton Water Department (fictional)" },
    aiLabel: "misleading",
  };
}

function session(over: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: "s-1",
    pid: 5,
    status: "in_progress",
    conditionOrder: ["A", "B", "D", "C"],
    setRotation: 1,
    blocks: ([1, 2, 3, 4] as const).map((blockIndex) => ({
      blockIndex,
      condition: (["A", "B", "D", "C"] as const)[blockIndex - 1],
      set: "S1" as const,
      postOrder: Array.from({ length: 6 }, (_, i) => `p${String(i + 1).padStart(2, "0")}`),
    })) as SessionView["blocks"],
    cursor: { blockIndex: 2, positionInBlock: 3, phase: "trial" },
    consequenceBanner: false,
    anxiety: false,
    resumeCount: 0,
    nextEventSeq: 1,
    consentAt: "2026-10-17T09:55:00.000Z",
    startedAt: "2026-10-17T09:50:00.000Z",
    completedAt: null,
    ...over,
  };
}

function renderAt(path = "/trial/2/3") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/trial/:block/:pos" element={<TrialScreen />} />
        <Route path="/survey/:block" element={<p>Survey page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const agreeBtn = () => screen.getByRole("button", { name: "Agree with label" });
const disagreeBtn = () => screen.getByRole("button", { name: "Disagree with label" });
const loggedTypes = () => mocks.logger.log.mock.calls.map((c) => (c[0] as { type: string }).type);

async function showLabel(condition: Condition = "A", path = "/trial/2/3") {
  mocks.api.getPresentation.mockResolvedValue(presentation(condition));
  renderAt(path);
  await flush();
  await advance(800); // checking delay
  await advance(20); // animation frame after the label paints
}

const chip = (value: string) => screen.getByRole("radio", { name: new RegExp(`^${value}`) });
const choiceText = () => document.querySelector(".trial__choice")?.textContent ?? "";
const key = (k: string, target: Element | Window = window) => fireEvent.keyDown(target, { key: k });

async function rateAndSubmit(value = "5") {
  fireEvent.click(chip(value));
  await advance(1000); // undo window
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "Date"],
  });
  vi.clearAllMocks();
  clearPresentationCache();
  mocks.study.session = session();
  mocks.study.state = { status: "ready", session: mocks.study.session, error: null, resumed: false };
  mocks.timer.snapshot.mockReturnValue({ ...SNAP });
  mocks.logger.flush.mockResolvedValue(undefined);
  mocks.api.submitTrial.mockResolvedValue({ trialId: "5-2-3", cursor: { blockIndex: 2, positionInBlock: 4, phase: "trial" } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("TrialScreen", () => {
  it.each([
    ["A", "Label only", "without an explanation"],
    ["B", "Fixed reason", "short, fixed reason"],
    ["C", "Explore with Why?", "expand Source, Claim vs record or Wording independently"],
    ["D", "What-if explanation", "change that would lead to a different label"],
  ] as const)("offers neutral %s guidance on both opening posts of every part", async (condition, label, hint) => {
    for (const block of [1, 2, 3, 4]) {
      for (const pos of [1, 2]) {
        await showLabel(condition, `/trial/${block}/${pos}`);
        expect(screen.getByRole("complementary", { name: "Help for this part" })).toHaveTextContent(label);
        expect(screen.getByText(hint, { exact: false })).toBeVisible();
        expect(screen.getByText(/The fact sheet is optional/)).toBeVisible();
        expect(screen.getByRole("button", { name: "Hide help" })).toHaveAttribute("aria-expanded", "true");
        expect(screen.queryByRole("button", { name: "Why?" }) !== null).toBe(condition === "C");
        expect(mocks.timer.onWhy).not.toHaveBeenCalled();
        expect(mocks.timer.onFactSheet).not.toHaveBeenCalled();
        cleanup();
        clearPresentationCache();
      }
    }
  });

  it("lets keyboard users hide and reopen help without changing timing or responses", async () => {
    await showLabel("C", "/trial/1/1");
    vi.useRealTimers();
    const user = userEvent.setup();
    const resets = mocks.timer.reset.mock.calls.length;
    const events = [...loggedTypes()];
    screen.getByRole("button", { name: "Hide help" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Show help" })).toHaveFocus();
    expect(screen.getByText(/The fact sheet is optional/)).not.toBeVisible();
    await user.keyboard(" ");
    expect(screen.getByRole("button", { name: "Hide help" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/The fact sheet is optional/)).toBeVisible();
    expect(mocks.timer.reset).toHaveBeenCalledTimes(resets);
    expect(mocks.timer.markShown).toHaveBeenCalledTimes(1);
    expect(mocks.timer.snapshot).not.toHaveBeenCalled();
    expect(mocks.api.submitTrial).not.toHaveBeenCalled();
    expect(loggedTypes()).toEqual(events);
  });

  it("keeps help dismissed on the second post and offers it again in the next part", async () => {
    mocks.api.submitTrial.mockResolvedValueOnce({ cursor: { blockIndex: 1, positionInBlock: 2, phase: "trial" } });
    await showLabel("A", "/trial/1/1");
    fireEvent.click(screen.getByRole("button", { name: "Hide help" }));
    fireEvent.click(agreeBtn());
    await rateAndSubmit();
    expect(screen.getByRole("button", { name: "Show help" })).toHaveAttribute("aria-expanded", "false");
    await advance(800);
    await advance(20);
    mocks.api.submitTrial.mockResolvedValueOnce({ cursor: { blockIndex: 2, positionInBlock: 1, phase: "trial" } });
    fireEvent.click(agreeBtn());
    await rateAndSubmit();
    expect(screen.getByRole("button", { name: "Hide help" })).toHaveAttribute("aria-expanded", "true");
  });

  it("does not show opening guidance after the second post of a legacy part", async () => {
    await showLabel("B");
    expect(screen.queryByRole("complementary", { name: "Help for this part" })).not.toBeInTheDocument();
  });

  it("uses a two-post plan for progress, prefetching and the survey transition", async () => {
    const shortSession = session();
    shortSession.blocks.forEach((block) => { block.postOrder = block.postOrder.slice(0, 2); });
    mocks.study.session = shortSession;
    await showLabel("C", "/trial/3/1");
    expect(screen.getByRole("heading", { name: "Part 3 of 4 · Post 1 of 2" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Post 5 of 8" })).toHaveAttribute("aria-valuemax", "8");
    expect(mocks.api.getPresentation).toHaveBeenLastCalledWith("s-1", 3, 2);
    mocks.api.submitTrial.mockResolvedValueOnce({ cursor: { blockIndex: 3, positionInBlock: 2, phase: "trial" } });
    fireEvent.click(agreeBtn());
    await rateAndSubmit();
    await advance(800);
    await advance(20);
    expect(screen.getByRole("progressbar", { name: "Post 6 of 8" })).toHaveAttribute("aria-valuenow", "6");
    expect(mocks.api.getPresentation).toHaveBeenCalledTimes(2);
    mocks.api.submitTrial.mockResolvedValueOnce({ cursor: { blockIndex: 3, positionInBlock: 2, phase: "block_survey" } });
    fireEvent.click(disagreeBtn());
    await rateAndSubmit();
    expect(screen.getByText("Survey page")).toBeInTheDocument();
  });

  it("rejects a position outside the stored plan before fetching", async () => {
    const shortSession = session();
    shortSession.blocks.forEach((block) => { block.postOrder = block.postOrder.slice(0, 2); });
    mocks.study.session = shortSession;
    renderAt("/trial/2/3");
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("This page does not exist.");
    expect(mocks.api.getPresentation).not.toHaveBeenCalled();
  });

  it("calculates overall progress by summing saved block lengths", async () => {
    const mixedSession = session();
    mixedSession.blocks[0].postOrder = mixedSession.blocks[0].postOrder.slice(0, 2);
    mocks.study.session = mixedSession;
    await showLabel("B");
    expect(screen.getByRole("progressbar", { name: "Post 5 of 20" })).toHaveAttribute("aria-valuenow", "5");
  });

  it("shows the header and an 800 ms checking state with disabled buttons", async () => {
    mocks.api.getPresentation.mockResolvedValue(presentation("A"));
    renderAt();
    expect(screen.getByRole("heading", { name: "Part 2 of 4 · Post 3 of 6" })).toBeInTheDocument();
    await flush();
    expect(mocks.api.getPresentation).toHaveBeenCalledWith("s-1", 2, 3);
    expect(screen.getByText(/AI is checking/)).toBeInTheDocument();
    expect(agreeBtn()).toBeDisabled();
    expect(disagreeBtn()).toBeDisabled();
    expect(screen.queryByTestId("explanation")).not.toBeInTheDocument();

    await advance(790);
    expect(screen.getByText(/AI is checking/)).toBeInTheDocument();
    expect(agreeBtn()).toBeDisabled();
    expect(mocks.timer.markShown).not.toHaveBeenCalled();

    await advance(20); // checking delay ends; the label paints
    await advance(20); // next animation frame: trial_shown
    expect(screen.queryByText(/AI is checking/)).not.toBeInTheDocument();
    expect(screen.getByText("Likely misleading")).toBeInTheDocument();
    expect(screen.getByTestId("explanation")).toBeInTheDocument();
    expect(agreeBtn()).toBeEnabled();
    expect(mocks.timer.markShown).toHaveBeenCalledTimes(1);
    expect(loggedTypes()).toEqual(["trial_shown"]);
    expect(mocks.timer.reset).toHaveBeenCalled();
  });

  it("ignores clicks before the label is shown", async () => {
    mocks.api.getPresentation.mockResolvedValue(presentation("A"));
    renderAt();
    await flush();
    fireEvent.click(agreeBtn());
    expect(loggedTypes()).not.toContain("decision_agree");
    expect(mocks.timer.snapshot).not.toHaveBeenCalled();
  });

  it("registers a double click as one decision", async () => {
    await showLabel("A");
    const btn = disagreeBtn();
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(loggedTypes().filter((t) => t.startsWith("decision_"))).toEqual(["decision_disagree"]);
    expect(mocks.timer.snapshot).toHaveBeenCalledTimes(1);
    expect(choiceText()).toMatch(/^You chose: Disagree ✓/);
    expect(screen.queryByRole("button", { name: "Agree with label" })).not.toBeInTheDocument();
  });

  it("shows a 1–7 chip row after the decision and saves only after the undo window", async () => {
    await showLabel("A");
    fireEvent.click(agreeBtn());
    expect(screen.getByRole("radiogroup", { name: "How sure are you?" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(7);
    expect(chip("1")).toHaveAccessibleName("1, Not at all sure");
    expect(chip("7")).toHaveAccessibleName("7, Completely sure");
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    expect(mocks.api.submitTrial).not.toHaveBeenCalled();

    fireEvent.click(chip("6"));
    expect(loggedTypes()).toContain("confidence_submit");
    expect(document.querySelector(".confidence-chips__status")).toHaveTextContent(/Saving/);
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change" })).not.toBeInTheDocument();
    await advance(990);
    expect(mocks.api.submitTrial).not.toHaveBeenCalled();
    await advance(20);
    await flush();
    expect(mocks.api.submitTrial).toHaveBeenCalledTimes(1);
    expect((mocks.api.submitTrial.mock.calls[0][1] as TrialSubmission).confidence).toBe(6);
  });

  it("Undo cancels the save and lets the participant pick again", async () => {
    await showLabel("A");
    fireEvent.click(agreeBtn());
    fireEvent.click(chip("2"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await advance(2000);
    expect(mocks.api.submitTrial).not.toHaveBeenCalled();
    expect(chip("2")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: "Change" })).toBeInTheDocument();
    await rateAndSubmit("7");
    expect(mocks.api.submitTrial).toHaveBeenCalledTimes(1);
    expect((mocks.api.submitTrial.mock.calls[0][1] as TrialSubmission).confidence).toBe(7);
    expect(loggedTypes().filter((t) => t === "confidence_submit")).toHaveLength(2);
  });

  it("Change re-opens the decision and the final decision is the one saved", async () => {
    await showLabel("A");
    fireEvent.click(agreeBtn());
    expect(choiceText()).toMatch(/^You chose: Agree ✓ · Change/);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    mocks.timer.snapshot.mockReturnValueOnce({ ...SNAP, decisionTimeRawMs: 6500, respondedAt: "2026-10-17T10:00:06.500Z" });
    fireEvent.click(disagreeBtn());
    await rateAndSubmit("4");
    expect(loggedTypes().filter((t) => t.startsWith("decision_"))).toEqual(["decision_agree", "decision_disagree"]);
    const payload = mocks.api.submitTrial.mock.calls[0][1] as TrialSubmission;
    expect(payload.agreed).toBe(false);
    expect(payload.decisionTimeRawMs).toBe(6500);
    expect(payload.respondedAt).toBe("2026-10-17T10:00:06.500Z");
  });

  it("supports keyboard shortcuts A, D, 1–7, F and Esc", async () => {
    await showLabel("A");
    key("f");
    expect(mocks.timer.onFactSheet).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("button", { name: /Fact sheet ◂/ })).toBeInTheDocument();
    key("Escape");
    expect(mocks.timer.onFactSheet).toHaveBeenLastCalledWith(false);
    expect(loggedTypes().filter((t) => t === "fact_sheet_close")).toHaveLength(1);
    key("F");
    expect(loggedTypes().filter((t) => t === "fact_sheet_open")).toHaveLength(2);
    key("d");
    expect(loggedTypes()).toContain("decision_disagree");
    expect(mocks.timer.onFactSheet).toHaveBeenLastCalledWith(false); // closed by the decision
    key("a"); // already decided: ignored
    expect(loggedTypes().filter((t) => t.startsWith("decision_"))).toEqual(["decision_disagree"]);
    key("9"); // out of range: ignored
    key("3");
    expect(chip("3")).toHaveAttribute("aria-checked", "true");
    await advance(1000);
    await flush();
    const payload = mocks.api.submitTrial.mock.calls[0][1] as TrialSubmission;
    expect(payload.agreed).toBe(false);
    expect(payload.confidence).toBe(3);
  });

  it("A agrees from the keyboard and W toggles Why? only in condition C", async () => {
    await showLabel("C");
    key("w");
    expect(loggedTypes()).toContain("why_open");
    key("a");
    expect(loggedTypes()).toContain("decision_agree");
    cleanup();
    vi.clearAllMocks();
    clearPresentationCache();
    mocks.timer.snapshot.mockReturnValue({ ...SNAP });
    await showLabel("B");
    key("w");
    expect(loggedTypes()).not.toContain("why_open");
  });

  it("ignores keys during the checking state and while typing in an input", async () => {
    mocks.api.getPresentation.mockResolvedValue(presentation("A"));
    renderAt();
    await flush();
    key("a");
    key("f");
    key("5");
    expect(mocks.logger.log).not.toHaveBeenCalled();
    expect(mocks.timer.snapshot).not.toHaveBeenCalled();
    await advance(800);
    await advance(20);
    const input = document.createElement("input");
    document.body.appendChild(input);
    key("a", input);
    expect(loggedTypes()).toEqual(["trial_shown"]);
    input.remove();
    key("a");
    expect(loggedTypes()).toContain("decision_agree");
  });

  it.each(["dialog", "alertdialog", "native dialog"])("ignores trial shortcuts inside a %s", async (role) => {
    await showLabel("C");
    const dialog = document.createElement(role === "native dialog" ? "dialog" : "div");
    if (role === "native dialog") dialog.setAttribute("open", "");
    else dialog.setAttribute("role", role);
    const button = document.createElement("button");
    button.textContent = "Keep participating";
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    try {
      button.focus();
      for (const shortcut of ["f", "w", "a", "d", "5"]) key(shortcut, button);
      expect(loggedTypes()).toEqual(["trial_shown"]);
      expect(mocks.timer.snapshot).not.toHaveBeenCalled();
      expect(mocks.timer.onFactSheet).not.toHaveBeenCalled();
      expect(mocks.timer.onWhy).not.toHaveBeenCalled();
      expect(mocks.api.submitTrial).not.toHaveBeenCalled();
    } finally {
      dialog.remove();
    }
    key("a");
    expect(loggedTypes()).toContain("decision_agree");
  });

  it("shows part/post text, the overall progress bar and a key hint", async () => {
    await showLabel("A");
    expect(screen.getByRole("heading", { name: "Part 2 of 4 · Post 3 of 6" })).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Post 9 of 24" });
    expect(bar).toHaveAttribute("aria-valuenow", "9");
    expect(bar).toHaveAttribute("aria-valuemax", "24");
    expect(screen.getByText("Keys: A agree · D disagree · 1–7 confidence · F fact sheet")).toBeInTheDocument();
  });

  it("prefetches the next post and renders it from the cache", async () => {
    await showLabel("A");
    expect(mocks.api.getPresentation).toHaveBeenCalledTimes(2);
    expect(mocks.api.getPresentation).toHaveBeenNthCalledWith(2, "s-1", 2, 4);
    fireEvent.click(agreeBtn());
    await rateAndSubmit("5");
    expect(screen.getByRole("heading", { name: "Part 2 of 4 · Post 4 of 6" })).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.getByText(/AI is checking/)).toBeInTheDocument();
    expect(mocks.api.getPresentation).toHaveBeenCalledTimes(2); // no new fetch for post 4
    await advance(800);
    await advance(20);
    expect(agreeBtn()).toBeEnabled();
    expect(mocks.api.getPresentation).toHaveBeenLastCalledWith("s-1", 2, 5); // next prefetch
  });

  it("does not prefetch past the last post of a block", async () => {
    await showLabel("A", "/trial/2/6");
    expect(mocks.api.getPresentation).toHaveBeenCalledTimes(1);
    expect(mocks.api.getPresentation).toHaveBeenCalledWith("s-1", 2, 6);
  });

  it("submits nulls for C-only fields outside condition C, flushes and navigates", async () => {
    await showLabel("B");
    fireEvent.click(agreeBtn());
    await rateAndSubmit("5");
    expect(mocks.api.submitTrial).toHaveBeenCalledTimes(1);
    const [id, payload] = mocks.api.submitTrial.mock.calls[0] as [string, TrialSubmission];
    expect(id).toBe("s-1");
    expect(payload).toEqual({
      blockIndex: 2,
      positionInBlock: 3,
      postId: "p07",
      agreed: true,
      confidence: 5,
      labelShownAt: SNAP.labelShownAt,
      respondedAt: SNAP.respondedAt,
      decisionTimeRawMs: 4000,
      hiddenMs: 0,
      hiddenCount: 0,
      blurCount: 1,
      factSheetOpened: true,
      factSheetOpenMs: 1200,
      explanationOpened: null,
      factorsExpanded: [],
      timeToFirstExpandMs: null,
      resumed: false,
    });
    expect(mocks.logger.flush).toHaveBeenCalled();
    expect(mocks.study.dispatch).toHaveBeenCalledWith({
      type: "CURSOR_CHANGED",
      cursor: { blockIndex: 2, positionInBlock: 4, phase: "trial" },
    });
    expect(mocks.api.getPresentation).toHaveBeenLastCalledWith("s-1", 2, 4);
    expect(screen.getByRole("heading", { name: "Part 2 of 4 · Post 4 of 6" })).toBeInTheDocument();
  });

  it("keeps C fields, logs Why/factor events and marks resumed trials", async () => {
    mocks.study.state = { ...mocks.study.state, resumed: true };
    await showLabel("C");
    fireEvent.click(screen.getByRole("button", { name: "Why?" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand source" }));
    expect(mocks.timer.onWhy).toHaveBeenCalledWith(true);
    expect(mocks.timer.onFactorExpand).toHaveBeenCalledWith("source");
    const factorEvent = mocks.logger.log.mock.calls.map((c) => c[0]).find((e) => e.type === "factor_expand");
    expect(factorEvent).toMatchObject({ factorKey: "source", trialId: "5-2-3", condition: "C", postId: "p07" });
    expect(loggedTypes()).toEqual(["trial_shown", "why_open", "factor_expand"]);

    fireEvent.click(disagreeBtn());
    await rateAndSubmit("2");
    const payload = mocks.api.submitTrial.mock.calls[0][1] as TrialSubmission;
    expect(payload.agreed).toBe(false);
    expect(payload.confidence).toBe(2);
    expect(payload.explanationOpened).toBe(true);
    expect(payload.factorsExpanded).toEqual(["source", "claimVsRecord"]);
    expect(payload.timeToFirstExpandMs).toBe(900);
    expect(payload.resumed).toBe(true);
  });

  it("navigates to the cursor the server returns", async () => {
    mocks.api.submitTrial.mockResolvedValue({ trialId: "5-2-3", cursor: { blockIndex: 2, positionInBlock: 6, phase: "block_survey" } });
    await showLabel("A");
    fireEvent.click(agreeBtn());
    await rateAndSubmit("4");
    expect(screen.getByText("Survey page")).toBeInTheDocument();
  });

  it("logs fact sheet open and close", async () => {
    await showLabel("D");
    fireEvent.click(screen.getByRole("button", { name: /Fact sheet/ }));
    expect(mocks.timer.onFactSheet).toHaveBeenCalledWith(true);
    expect(loggedTypes()).toContain("fact_sheet_open");
    fireEvent.click(screen.getByRole("button", { name: /Fact sheet/ }));
    expect(mocks.timer.onFactSheet).toHaveBeenCalledWith(false);
    expect(loggedTypes()).toContain("fact_sheet_close");
  });

  it("keeps the decision on a failed save and resubmits it on Retry", async () => {
    mocks.api.submitTrial.mockRejectedValueOnce(new Error("network"));
    await showLabel("A");
    fireEvent.click(agreeBtn());
    await rateAndSubmit("3");
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be saved/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(mocks.api.submitTrial).toHaveBeenCalledTimes(2);
    expect(mocks.api.submitTrial.mock.calls[1][1]).toEqual(mocks.api.submitTrial.mock.calls[0][1]);
    expect(mocks.api.getPresentation).toHaveBeenLastCalledWith("s-1", 2, 4);
  });

  it("shows the consequence banner only when the session has it on", async () => {
    await showLabel("A");
    expect(screen.queryByText(/stay visible to other users/)).not.toBeInTheDocument();
    cleanup();
    mocks.study.session = session({ consequenceBanner: true });
    await showLabel("A");
    expect(screen.getByText(/Posts you agree are accurate stay visible to other users/)).toBeInTheDocument();
  });
});
