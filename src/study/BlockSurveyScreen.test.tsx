// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const mocks = vi.hoisted(() => ({
  protocolVersion: undefined as "calibrated-full-v1" | "calibrated-brief-v1" | "legacy-full-v1" | undefined,
  submitBlockSurvey: vi.fn(),
  log: vi.fn(),
  flush: vi.fn(),
  navigate: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock("react-router-dom", async (orig) => {
  const actual = await orig<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mocks.navigate };
});
vi.mock("../api/client", () => ({ api: { submitBlockSurvey: mocks.submitBlockSurvey } }));
vi.mock("../state/StudyContext", () => ({
  useStudy: () => ({
    dispatch: mocks.dispatch,
    session: {
      protocolVersion: mocks.protocolVersion,
      sessionId: "sess-1",
      pid: 3,
      blocks: [
        { blockIndex: 1, condition: "B", set: "S3", postOrder: [] },
        { blockIndex: 2, condition: "C", set: "S4", postOrder: [] },
        { blockIndex: 3, condition: "A", set: "S2", postOrder: [] },
        { blockIndex: 4, condition: "D", set: "S1", postOrder: [] },
      ],
    },
  }),
  routeForCursor: (c: { blockIndex: number; positionInBlock: number; phase: string }) =>
    c.phase === "trial" ? `/trial/${c.blockIndex}/${c.positionInBlock}` : `/${c.phase}`,
}));
vi.mock("../logging/logger", () => ({ useLogger: () => ({ log: mocks.log, flush: mocks.flush, nextSeq: () => 1 }) }));
vi.mock("../../shared/data/surveyItems.json", async (orig) => {
  const actual = await orig<{ default: typeof import("../../shared/data/surveyItems.json") }>();
  const scale = { min: 1, max: 7, minLabel: "Not at all", maxLabel: "Extremely" };
  return {
    default: {
      schemaVersion: 1,
      briefTrust: actual.default.briefTrust,
      trustScale: scale,
      trustItems: Array.from({ length: 12 }, (_, i) => ({
        id: `jian-${String(i + 1).padStart(2, "0")}`,
        order: i + 1,
        text: `Trust item ${i + 1}`,
        reverse: i < 5,
        subscale: i < 5 ? "distrust" : "trust",
      })),
      fairnessScale: { min: 1, max: 7, minLabel: "Strongly disagree", maxLabel: "Strongly agree" },
      fairnessItems: [
        { id: "fair-01", order: 1, text: "Fair item 1" },
        { id: "fair-02", order: 2, text: "Fair item 2" },
      ],
      tension: { id: "tension", text: "How tense?", min: 1, max: 7, step: 1, minLabel: "Not at all tense", maxLabel: "Extremely tense", widget: "likert" },
      frustrationTlx: { id: "frustrationTlx", text: "How irritated?", min: 0, max: 100, step: 5, minLabel: "Very low", maxLabel: "Very high", widget: "slider", start: 50 },
      confidence: { id: "confidence", text: "How confident?", min: 1, max: 7, step: 1, minLabel: "a", maxLabel: "b", widget: "likert" },
    },
  };
});

import BlockSurveyScreen from "./BlockSurveyScreen";

function renderAt(block: number) {
  return render(
    <MemoryRouter initialEntries={[`/survey/${block}`]}>
      <Routes>
        <Route path="/survey/:block" element={<BlockSurveyScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

const row = (name: string) => screen.getByRole("radiogroup", { name: new RegExp(name) });
const chip = (name: string, v: number) =>
  within(row(name)).getByRole("radio", { name: new RegExp(`^${v}(,|$)`) });

function answerAllLikert() {
  for (let i = 1; i <= 12; i++) fireEvent.click(chip(`Trust item ${i}$`, ((i - 1) % 7) + 1));
  fireEvent.click(chip("Fair item 1", 4));
  fireEvent.click(chip("Fair item 2", 6));
  fireEvent.click(within(screen.getByRole("group", { name: /How tense/ })).getByRole("radio", { name: "2" }));
}

const continueBtn = () => screen.getByRole("button", { name: /Continue|Saving/ });
const slider = () => screen.getByRole("slider", { name: /irritated/ });

describe("BlockSurveyScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.protocolVersion = undefined;
    mocks.submitBlockSurvey.mockResolvedValue({ nWrongDetected: 1, cursor: { blockIndex: 3, positionInBlock: 1, phase: "trial" } });
    mocks.flush.mockResolvedValue(undefined);
  });

  it("shows the part heading without naming the condition", () => {
    renderAt(2);
    const h = screen.getByRole("heading", { level: 1 });
    expect(h).toHaveTextContent("Part 2 of 4: Your ratings");
    expect(h.textContent).not.toMatch(/condition|\bC\b/);
  });

  it.each(["calibrated-full-v1", "calibrated-brief-v1"] as const)("gives neutral part-specific instructions for %s", (protocol) => {
    mocks.protocolVersion = protocol;
    renderAt(3);
    const form = screen.getByRole("form", { name: "Part 3 of 4: Your ratings" });
    expect(form).toHaveAccessibleDescription("Rate the AI labeling system you just used in this part, not the post authors or the website design. There are no right or wrong answers.");
    expect(screen.getByRole("heading", { name: "Trust", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "How you felt", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(protocol === "calibrated-brief-v1" ? "0 of 3 answered" : "0 of 16 answered");
  });

  it("describes trust and fairness sections with their distinct canonical endpoints", () => {
    mocks.protocolVersion = "calibrated-full-v1";
    renderAt(2);
    expect(screen.getByRole("region", { name: "Trust" })).toHaveAccessibleDescription("Rate each statement: 1 = Not at all; 7 = Extremely.");
    expect(screen.getByRole("region", { name: "Fairness" })).toHaveAccessibleDescription("Rate each statement: 1 = Strongly disagree; 7 = Strongly agree.");
  });

  it("renders trust and fairness matrices with their own anchors and 7 chips per row", () => {
    mocks.protocolVersion = "calibrated-full-v1";
    renderAt(1);
    const trust = screen.getByRole("group", { name: "Trust in the AI labels" });
    const fair = screen.getByRole("group", { name: "Fairness of the AI labels" });
    expect(within(trust).getAllByRole("radiogroup")).toHaveLength(12);
    expect(within(fair).getAllByRole("radiogroup")).toHaveLength(2);
    expect(within(row("Trust item 1$")).getAllByRole("radio")).toHaveLength(7);
    expect(within(trust).getByText("1 = Not at all")).toBeInTheDocument();
    expect(within(fair).getByText("7 = Strongly agree")).toBeInTheDocument();
    expect(within(row("Fair item 2")).getByRole("radio", { name: "1, Strongly disagree" })).toBeInTheDocument();
  });

  it("answers the focused row with number keys and moves focus to the next unanswered row", async () => {
    const user = userEvent.setup();
    renderAt(1);
    // pre-answer row 2 so the advance must skip it
    fireEvent.click(chip("Trust item 2$", 5));
    chip("Trust item 1$", 1).focus();
    await user.keyboard("3");
    expect(chip("Trust item 1$", 3)).toHaveAttribute("aria-checked", "true");
    expect(row("Trust item 3$")).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("7");
    expect(chip("Trust item 3$", 7)).toHaveAttribute("aria-checked", "true");
    expect(row("Trust item 4$")).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("8"); // out of range: ignored
    expect(within(row("Trust item 4$")).getAllByRole("radio").every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
    expect(screen.getByText("3 of 16 answered")).toBeInTheDocument();
  });

  it("arrow keys move focus within a row; roving tabindex keeps one tab stop", async () => {
    const user = userEvent.setup();
    renderAt(1);
    const chips = within(row("Trust item 1$")).getAllByRole("radio");
    expect(chips.filter((c) => c.tabIndex === 0)).toHaveLength(1);
    chips[0].focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(document.activeElement).toBe(chips[2]);
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(chips[1]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(chips[6]);
    await user.keyboard(" ");
    expect(chips[6]).toHaveAttribute("aria-checked", "true");
    expect(chips[6].tabIndex).toBe(0);
    expect(chips[0].tabIndex).toBe(-1);
  });

  it("counts answers and enables Continue only when all 16 are answered", () => {
    renderAt(2);
    expect(screen.getByText("0 of 16 answered")).toBeInTheDocument();
    expect(continueBtn()).toBeDisabled();
    answerAllLikert();
    expect(screen.getByText("15 of 16 answered")).toBeInTheDocument();
    expect(screen.getAllByText(/Move the slider/)).toHaveLength(1);
    expect(slider()).toHaveAccessibleDescription("Move the slider to select your answer");
    expect(continueBtn()).toBeDisabled();
    fireEvent.click(continueBtn());
    expect(mocks.submitBlockSurvey).not.toHaveBeenCalled();
    fireEvent.change(slider(), { target: { value: "55" } });
    expect(screen.getByText("16 of 16 answered")).toBeInTheDocument();
    expect(screen.queryByText(/Move the slider/)).not.toBeInTheDocument();
    expect(continueBtn()).toBeEnabled();
  });

  it("the slider counts only once touched, also by an arrow key", () => {
    renderAt(1);
    answerAllLikert();
    expect(slider()).toHaveValue("50");
    expect(continueBtn()).toBeDisabled();
    fireEvent.keyDown(slider(), { key: "ArrowLeft" });
    expect(continueBtn()).toBeEnabled();
  });

  it.each([undefined, "legacy-full-v1", "calibrated-full-v1"] as const)("submits the full payload in item order with logging and navigation for %s", async (protocol) => {
    mocks.protocolVersion = protocol;
    renderAt(2);
    answerAllLikert();
    fireEvent.change(slider(), { target: { value: "35" } });
    fireEvent.click(continueBtn());

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/trial/3/1"));
    expect(mocks.submitBlockSurvey).toHaveBeenCalledTimes(1);
    const [id, payload] = mocks.submitBlockSurvey.mock.calls[0];
    expect(id).toBe("sess-1");
    expect(payload).toEqual({
      blockIndex: 2,
      trustRaw: [1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 5],
      fairness1: 4,
      fairness2: 6,
      tension: 2,
      frustrationTlx: 35,
      frustrationTlxTouched: true,
      anxiety: null,
    });
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ type: "block_survey_submit", blockIndex: 2, condition: "C" }));
    expect(mocks.flush).toHaveBeenCalled();
    expect(mocks.log.mock.invocationCallOrder[0]).toBeLessThan(mocks.flush.mock.invocationCallOrder[0]);
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: "CURSOR_CHANGED", cursor: { blockIndex: 3, positionInBlock: 1, phase: "trial" } });
    expect(mocks.dispatch.mock.invocationCallOrder[0]).toBeLessThan(mocks.navigate.mock.invocationCallOrder[0]);
  });

  it("disables the button while sending", async () => {
    let resolve!: (v: unknown) => void;
    mocks.submitBlockSurvey.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderAt(1);
    answerAllLikert();
    fireEvent.change(slider(), { target: { value: "45" } });
    fireEvent.change(slider(), { target: { value: "50" } });
    fireEvent.click(continueBtn());
    await waitFor(() => expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled());
    fireEvent.click(continueBtn());
    expect(mocks.submitBlockSurvey).toHaveBeenCalledTimes(1);
    resolve({ nWrongDetected: 0, cursor: { blockIndex: 1, positionInBlock: 6, phase: "exit_survey" } });
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/exit_survey"));
    expect(mocks.submitBlockSurvey.mock.calls[0][1].frustrationTlx).toBe(50);
  });

  it.each([undefined, "legacy-full-v1", "calibrated-full-v1"] as const)("keeps the full 16-rating form for protocol %s", (protocol) => {
    mocks.protocolVersion = protocol;
    renderAt(1);
    expect(screen.getByText("0 of 16 answered")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /How much did you trust/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Fairness" })).toBeInTheDocument();
  });

  describe("brief questionnaire", () => {
    beforeEach(() => { mocks.protocolVersion = "calibrated-brief-v1"; });

    const trustGroup = () => screen.getByRole("group", { name: /How much did you trust the AI labels in this part/ });
    function answerBriefLikert() {
      fireEvent.click(within(trustGroup()).getByRole("radio", { name: "7, Completely" }));
      fireEvent.click(within(screen.getByRole("group", { name: /How tense/ })).getByRole("radio", { name: "2" }));
    }

    it("renders only three ratings with no selected trust default and requires all three", () => {
      renderAt(2);
      expect(screen.getByText("0 of 3 answered")).toBeInTheDocument();
      expect(screen.queryByText("Fairness")).not.toBeInTheDocument();
      expect(screen.queryByText(/Trust item/)).not.toBeInTheDocument();
      expect(screen.getAllByRole("radio")).toHaveLength(14);
      expect(within(trustGroup()).getAllByRole("radio").every((r) => !(r as HTMLInputElement).checked)).toBe(true);
      fireEvent.submit(continueBtn().closest("form")!);
      expect(mocks.submitBlockSurvey).not.toHaveBeenCalled();
      answerBriefLikert();
      expect(screen.getByText("2 of 3 answered")).toBeInTheDocument();
      expect(continueBtn()).toBeDisabled();
      fireEvent.keyDown(slider(), { key: "ArrowLeft" });
      expect(screen.getByText("3 of 3 answered")).toBeInTheDocument();
      expect(continueBtn()).toBeEnabled();
    });

    it("requires an explicit trust answer even when both affect ratings are complete", () => {
      renderAt(1);
      fireEvent.click(within(screen.getByRole("group", { name: /How tense/ })).getByRole("radio", { name: "2" }));
      fireEvent.change(slider(), { target: { value: "0" } });
      expect(continueBtn()).toBeDisabled();
      fireEvent.submit(continueBtn().closest("form")!);
      expect(mocks.submitBlockSurvey).not.toHaveBeenCalled();
    });

    it("submits exactly the brief payload and preserves logging/cursor navigation", async () => {
      renderAt(2);
      answerBriefLikert();
      fireEvent.change(slider(), { target: { value: "100" } });
      fireEvent.click(continueBtn());
      await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/trial/3/1"));
      expect(mocks.submitBlockSurvey).toHaveBeenCalledWith("sess-1", {
        blockIndex: 2, questionnaireVersion: "brief-v1", briefTrust: 7,
        tension: 2, frustrationTlx: 100, frustrationTlxTouched: true,
      });
      expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ type: "block_survey_submit", condition: "C" }));
      expect(mocks.flush).toHaveBeenCalled();
      expect(mocks.dispatch).toHaveBeenCalledWith({ type: "CURSOR_CHANGED", cursor: { blockIndex: 3, positionInBlock: 1, phase: "trial" } });
    });
  });

  it.each(["calibrated-brief-v1", "legacy-full-v1", "calibrated-full-v1"] as const)("rejects a non-step slider value for %s", (protocol) => {
    mocks.protocolVersion = protocol;
    renderAt(1);
    if (protocol === "calibrated-brief-v1") {
      fireEvent.click(within(screen.getByRole("group", { name: /How much did you trust/ })).getByRole("radio", { name: "1, Not at all" }));
      fireEvent.click(within(screen.getByRole("group", { name: /How tense/ })).getByRole("radio", { name: "2" }));
    } else answerAllLikert();
    fireEvent.change(slider(), { target: { value: "32" } });
    fireEvent.click(continueBtn());
    expect(screen.getByRole("alert")).toHaveTextContent("slider value is invalid");
    expect(mocks.submitBlockSurvey).not.toHaveBeenCalled();
  });

  it.each(["calibrated-brief-v1", "legacy-full-v1", "calibrated-full-v1"] as const)("retains answers and retries after a save failure for %s", async (protocol) => {
    mocks.protocolVersion = protocol;
    mocks.submitBlockSurvey.mockRejectedValueOnce(new Error("offline"));
    renderAt(1);
    if (protocol === "calibrated-brief-v1") {
      fireEvent.click(within(screen.getByRole("group", { name: /How much did you trust/ })).getByRole("radio", { name: "1, Not at all" }));
      fireEvent.click(within(screen.getByRole("group", { name: /How tense/ })).getByRole("radio", { name: "2" }));
    } else answerAllLikert();
    fireEvent.change(slider(), { target: { value: "0" } });
    fireEvent.click(continueBtn());
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("could not be saved"));
    expect(continueBtn()).toBeEnabled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    fireEvent.click(continueBtn());
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
    expect(mocks.submitBlockSurvey.mock.calls[1]).toEqual(mocks.submitBlockSurvey.mock.calls[0]);
  });

});
