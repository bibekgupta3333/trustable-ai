// @vitest-environment jsdom
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { SessionView } from "../../shared/api";

const mocks = vi.hoisted(() => ({
  api: {
    consent: vi.fn(),
    getPractice: vi.fn(),
    submitExitSurvey: vi.fn(),
  },
  advance: vi.fn(),
  dispatch: vi.fn(),
  clearParticipantStorage: vi.fn(),
  log: vi.fn(),
  flush: vi.fn(),
  navigate: vi.fn(),
  session: null as unknown,
}));

vi.mock("../api/client", () => ({ api: mocks.api }));
vi.mock("../state/StudyContext", async (orig) => {
  const actual = await orig<typeof import("../state/StudyContext")>();
  // Spy on the real implementation so storage effects can be asserted.
  mocks.clearParticipantStorage.mockImplementation(actual.clearParticipantStorage);
  return {
    useStudy: () => ({ session: mocks.session, advance: mocks.advance, state: {}, dispatch: mocks.dispatch }),
    clearParticipantStorage: mocks.clearParticipantStorage,
    routeForCursor: () => "/",
  };
});
vi.mock("../logging/logger", () => ({
  useLogger: () => ({ log: mocks.log, flush: mocks.flush, nextSeq: () => 1 }),
}));
vi.mock("../components/PostCard", () => ({
  default: (p: { text: string }) => <article data-testid="post-card">{p.text}</article>,
}));
vi.mock("../components/LabelPanel", () => ({
  default: (p: { label: string }) => <div data-testid="label-panel">{p.label}</div>,
}));
vi.mock("../components/FactSheetPanel", () => ({
  default: (p: { factSheet: { title: string } }) => (
    <div data-testid="fact-sheet">Fact sheet ▸ {p.factSheet.title}</div>
  ),
}));
vi.mock("../conditions/conditionRegistry", () => {
  const View = () => <section className="explanation" />;
  return { conditionRegistry: { A: View, B: View, C: View, D: View } };
});
vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useNavigate: () => mocks.navigate,
}));

import ConsentScreen from "./ConsentScreen";
import InstructionsScreen from "./InstructionsScreen";
import ExitSurveyScreen from "./ExitSurveyScreen";
import DebriefScreen, { DEBRIEF_FACTS } from "./DebriefScreen";

const session: SessionView = {
  sessionId: "s-1",
  pid: 7,
  status: "in_progress",
  conditionOrder: ["C", "D", "B", "A"],
  setRotation: 1,
  blocks: [
    { blockIndex: 1, condition: "C", set: "S1", postOrder: ["p01", "p02", "p03", "p04", "p05", "p06"] },
    { blockIndex: 2, condition: "D", set: "S2", postOrder: ["p07", "p08", "p09", "p10", "p11", "p12"] },
    { blockIndex: 3, condition: "B", set: "S3", postOrder: ["p13", "p14", "p15", "p16", "p17", "p18"] },
    { blockIndex: 4, condition: "A", set: "S4", postOrder: ["p19", "p20", "p21", "p22", "p23", "p24"] },
  ],
  cursor: { blockIndex: 1, positionInBlock: 1, phase: "consent" },
  consequenceBanner: false,
  anxiety: false,
  resumeCount: 0,
  nextEventSeq: 1,
  consentAt: null,
  startedAt: "2026-10-17T00:00:00.000Z",
  completedAt: null,
};


function useShortSession() {
  mocks.session = {
    ...session,
    blocks: session.blocks.map((block) => ({
      ...block,
      postOrder: [block.postOrder[0], block.postOrder[2]],
    })),
  };
}

const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);
const loggedTypes = () => mocks.log.mock.calls.map((c) => c[0].type);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  mocks.session = session;
  mocks.api.consent.mockResolvedValue({ ...session, consentAt: "x" });
  mocks.api.submitExitSurvey.mockResolvedValue({ ...session, status: "completed" });
  mocks.api.getPractice.mockResolvedValue({
    id: "practice-01", set: null, topic: "svc",
    author: { handle: "@RivertonParks", displayName: "Riverton Parks", verified: true },
    text: "The Birch Road dog park reopens Saturday, April 4.",
    postedAgo: "2h", likes: 74, reposts: 9,
    factSheet: { title: "Birch Road Dog Park Reopening", body: "b", source: "s (fictional)" },
    aiLabel: "accurate", staticExplanation: "x", factors: [], counterfactualExplanation: "y",
  });
  mocks.advance.mockResolvedValue(undefined);
  mocks.flush.mockResolvedValue(undefined);
});
afterEach(cleanup);

// Participant screens use complete self-guided copy without unsupported institutional claims.
function expectNoResearcher(text: string) {
  expect(text).not.toMatch(/researcher|PLACEHOLDER|\bIRB\b|professor|supervisor|contact/i);
}

describe("ConsentScreen", () => {
  it("describes eight posts for a new session without promising a measured duration", () => {
    useShortSession();
    const { container } = wrap(<ConsentScreen />);
    expect(container.textContent).toContain("read 8 short posts");
    expect(container.textContent).not.toMatch(/24|minutes|delete your answers|anonymous/i);
    expectNoResearcher(container.textContent ?? "");
  });

  it("shows the short summary, full details disclosure and 18+ checkbox; gates Continue", async () => {
    const user = userEvent.setup();
    const { container } = wrap(<ConsentScreen />);
    expect(container.querySelectorAll(".consent-summary > li")).toHaveLength(5);
    expect(container.textContent).toContain("read 24 short posts");
    expect(container.textContent).toContain("Answers already saved remain on the study server if you stop.");
    expect(container.textContent).toMatch(/scrambled/);
    const details = container.querySelector("details.consent-details");
    expect(details).not.toBeNull();
    expect(within(details as HTMLElement).getByText("Read full consent details")).toBeInTheDocument();
    expect(screen.getByText(/HCI experiment conducted as part of graduate study at Florida Polytechnic University/)).toBeInTheDocument();
    expectNoResearcher(container.textContent ?? "");

    const cont = screen.getByRole("button", { name: "Continue" });
    expect(cont).toBeDisabled();
    await user.click(cont);
    expect(mocks.api.consent).not.toHaveBeenCalled();

    await user.click(screen.getByRole("checkbox", { name: "I am 18 or older and I agree to take part" }));
    expect(cont).toBeEnabled();
    await user.click(cont);
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/instructions"));
    expect(mocks.api.consent).toHaveBeenCalledWith("s-1");
    expect(loggedTypes()).toContain("consent_given");
  });

  it("'I do not agree' shows a thank-you, says the page can be closed, and records nothing", async () => {
    const user = userEvent.setup();
    const { container } = wrap(<ConsentScreen />);
    await user.click(screen.getByRole("button", { name: "I do not agree" }));
    expect(screen.getByRole("heading", { name: "Thank you" })).toBeInTheDocument();
    expect(screen.getByText(/close this page/i)).toBeInTheDocument();
    expectNoResearcher(container.textContent ?? "");
    expect(mocks.api.consent).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("shows a self-guided error when saving consent fails", async () => {
    const user = userEvent.setup();
    mocks.api.consent.mockRejectedValueOnce(new Error("down"));
    const { container } = wrap(<ConsentScreen />);
    await user.click(screen.getByRole("checkbox", { name: /18 or older/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/try again/);
    expectNoResearcher(container.textContent ?? "");
  });
});

describe("InstructionsScreen", () => {
  it.each([
    { protocol: "calibrated-media-full-v1", media: true },
    { protocol: "calibrated-full-v1", media: false },
  ])("loads practice and preloads images only for the media protocol: $protocol", async ({ protocol, media }) => {
    mocks.session = { ...session, protocolVersion: protocol };
    const { unmount } = wrap(<InstructionsScreen />);
    await screen.findByTestId("post-card");
    expect(mocks.api.getPractice).toHaveBeenCalledWith(media);
    const hints = document.head.querySelectorAll('link[rel="preload"][as="image"]');
    expect(hints).toHaveLength(media ? 3 : 0);
    for (const hint of hints) expect(hint.getAttribute("href")).toMatch(/^\/post-images\//);
    unmount();
    expect(document.head.querySelectorAll('link[rel="preload"][as="image"]')).toHaveLength(0);
  });

  it.each([2, 6])("uses the saved assignment for %i posts per part", async (size) => {
    if (size === 2) useShortSession();
    const { container } = wrap(<InstructionsScreen />);
    await screen.findByTestId("post-card");
    expect(container.textContent).toContain(`You will read ${size * 4} short social media posts`);
    expect(container.textContent).toContain(`4 parts of ${size} posts each`);
  });

  it("is one short screen with 3 bullets, a keyboard hint, and never says labels may be wrong", async () => {
    const { container } = wrap(<InstructionsScreen />);
    expect(screen.getByRole("heading", { name: "How this study works" })).toBeInTheDocument();
    expect(container.querySelectorAll(".instructions-list > li")).toHaveLength(3);
    expect(container.querySelector(".keyboard-hint")?.textContent).toMatch(/agree.*disagree.*fact sheet/i);
    await screen.findByTestId("post-card");
    const text = container.textContent ?? "";
    // The only "wrong" allowed is the stimuli.md definition of the Disagree button.
    const stripped = text.replace("if you think the label is wrong for this post", "");
    expect(stripped).not.toMatch(/wrong/i);
    expect(stripped).not.toMatch(/mistake|error|deliberate|incorrect|planted|scripted/i);
    expect(text).toContain("Click Agree with label if you think the label is right for this post.");
    expectNoResearcher(text);
  });

  it("shows the practice inline with no reading lock; Start part 1 appears after the decision", async () => {
    const user = userEvent.setup();
    wrap(<InstructionsScreen />);
    expect(screen.queryByRole("button", { name: "Start practice" })).toBeNull();
    expect(await screen.findByTestId("post-card")).toBeInTheDocument();
    expect(screen.getByTestId("label-panel")).toBeInTheDocument();
    expect(screen.getByTestId("fact-sheet")).toBeInTheDocument();
    expect(document.querySelector(".explanation")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Start part 1" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Agree with label" }));
    expect(screen.getByRole("button", { name: "Agree with label" })).toHaveAttribute("aria-pressed", "true");
    const start = screen.getByRole("button", { name: "Start part 1" });
    expect(start).toBeEnabled();
    await user.click(start);
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/trial/1/1"));
    expect(mocks.advance).toHaveBeenCalledWith({ blockIndex: 1, positionInBlock: 1, phase: "trial" });
    expect(loggedTypes()).toEqual(["practice_start", "practice_complete", "block_start"]);
    expect(mocks.log.mock.calls.every((c) => c[0].trialId === null)).toBe(true);
    expect(mocks.log.mock.calls[2][0]).toMatchObject({ blockIndex: 1, condition: "C" });
  });

  it("accepts the D key as a practice decision", async () => {
    const user = userEvent.setup();
    wrap(<InstructionsScreen />);
    await screen.findByTestId("post-card");
    await user.keyboard("d");
    expect(screen.getByRole("button", { name: "Disagree with label" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Start part 1" })).toBeInTheDocument();
  });

  it("lets the participant start part 1 if the practice post fails to load", async () => {
    mocks.api.getPractice.mockRejectedValueOnce(new Error("down"));
    const { container } = wrap(<InstructionsScreen />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start part 1" })).toBeEnabled();
    expectNoResearcher(container.textContent ?? "");
  });
});

describe("ExitSurveyScreen", () => {
  const group = (name: RegExp) => screen.getByRole("radiogroup", { name });

  async function fillRequired(user: ReturnType<typeof userEvent.setup>, part: string) {
    await user.click(within(group(/Age range/)).getByRole("radio", { name: "25–34" }));
    await user.click(within(group(/Education/)).getByRole("radio", { name: "Bachelor's degree" }));
    await user.click(within(group(/use social media/)).getByRole("radio", { name: "Daily" }));
    await user.click(within(group(/fact-check labels/)).getByRole("radio", { name: "Sometimes" }));
    await user.click(within(group(/prefer/)).getByRole("radio", { name: new RegExp(`^${part}(?: —|$)`) }));
  }

  it("uses chip radio groups (no selects) and never shows condition letters", () => {
    const { container } = wrap(<ExitSurveyScreen />);
    expect(container.querySelector("select")).toBeNull();
    expect(screen.getAllByRole("radiogroup")).toHaveLength(6);
    for (const label of [
      "Part 1 — Why? with expandable details",
      "Part 2 — What-if explanation",
      "Part 3 — One short reason",
      "Part 4 — Label only",
      "No preference",
    ]) expect(within(group(/prefer/)).getByRole("radio", { name: label })).toBeInTheDocument();
    expect(screen.queryByText(/Condition [ABCD]\b/)).toBeNull();
    expect(screen.queryByRole("radio", { name: /^[ABCD]$/ })).toBeNull();
    expectNoResearcher(container.textContent ?? "");
  });

  it("blocks submit until required fields are answered", async () => {
    const user = userEvent.setup();
    wrap(<ExitSurveyScreen />);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Age range.*Education.*Social media use.*Label exposure.*Preferred part/);
    expect(group(/Age range/)).toHaveAttribute("aria-invalid", "true");
    expect(mocks.api.submitExitSurvey).not.toHaveBeenCalled();
    expect(mocks.clearParticipantStorage).not.toHaveBeenCalled();
  });

  it("maps 'Part 2' to the condition shown in block 2, submits, then clears storage and goes to debrief", async () => {
    const user = userEvent.setup();
    localStorage.setItem("xai-study:activeSessionId", "s-1");
    sessionStorage.setItem("xai-study:adminToken", "tok");
    wrap(<ExitSurveyScreen />);
    await fillRequired(user, "Part 2");
    await user.click(within(group(/Gender/)).getByRole("radio", { name: "Woman" }));
    await user.type(screen.getByLabelText(/Any comments/), "nice");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/debrief"));
    expect(mocks.api.submitExitSurvey).toHaveBeenCalledWith("s-1", {
      ageRange: "25-34", gender: "woman", education: "bachelors", socialMediaUse: "daily",
      labelExposure: "sometimes", preferredCondition: "D", comment: "nice",
    });
    expect(loggedTypes()).toEqual(["exit_survey_submit", "session_complete"]);
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: "SESSION_LOADED", session: { ...session, status: "completed" } });
    expect(mocks.clearParticipantStorage).toHaveBeenCalledTimes(1);
    const clearAt = mocks.clearParticipantStorage.mock.invocationCallOrder[0];
    expect(mocks.api.submitExitSurvey.mock.invocationCallOrder[0]).toBeLessThan(clearAt);
    expect(mocks.flush.mock.invocationCallOrder[0]).toBeLessThan(clearAt);
    expect(mocks.dispatch.mock.invocationCallOrder[0]).toBeLessThan(clearAt);
    expect(clearAt).toBeLessThan(mocks.navigate.mock.invocationCallOrder[0]);
    expect(localStorage.getItem("xai-study:activeSessionId")).toBeNull();
    expect(sessionStorage.getItem("xai-study:adminToken")).toBe("tok");
  });

  it("still clears storage and goes to debrief when the logger flush fails after a successful submit", async () => {
    const user = userEvent.setup();
    mocks.flush.mockRejectedValueOnce(new Error("offline"));
    localStorage.setItem("xai-study:activeSessionId", "s-1");
    wrap(<ExitSurveyScreen />);
    await fillRequired(user, "Part 1");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/debrief"));
    expect(localStorage.getItem("xai-study:activeSessionId")).toBeNull();
  });

  it("maps 'No preference' to none and leaves gender null when skipped", async () => {
    const user = userEvent.setup();
    wrap(<ExitSurveyScreen />);
    await fillRequired(user, "No preference");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(mocks.api.submitExitSurvey).toHaveBeenCalled());
    expect(mocks.api.submitExitSurvey.mock.calls[0][1]).toMatchObject({ preferredCondition: "none", gender: null });
  });

  it("clears nothing when saving fails", async () => {
    const user = userEvent.setup();
    localStorage.setItem("xai-study:activeSessionId", "s-1");
    mocks.api.submitExitSurvey.mockRejectedValueOnce(new Error("down"));
    const { container } = wrap(<ExitSurveyScreen />);
    await fillRequired(user, "Part 1");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/try again/);
    expect(mocks.clearParticipantStorage).not.toHaveBeenCalled();
    expect(localStorage.getItem("xai-study:activeSessionId")).toBe("s-1");
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expectNoResearcher(container.textContent ?? "");
  });
});

describe("DebriefScreen", () => {
  it.each(["legacy-full-v1", "calibrated-brief-v1"] as const)(
    "explains appropriate reliance and simulation for the %s protocol",
    (protocolVersion) => {
      useShortSession();
      mocks.session = { ...(mocks.session as SessionView), protocolVersion };
      const { container } = wrap(<DebriefScreen />);
      const text = (container.textContent ?? "").replace(/\s+/g, " ");
      expect(text).toContain("accept correct labels and question wrong ones");
      expect(text).toContain("More trust is not automatically better.");
      expect(text).toContain("No AI model or large language model (LLM) generated");
      expect(text).toContain("4 of the 8 labels were deliberately wrong.");
    },
  );

  it("keeps early-exit disclosure, planned counts and saved-data facts", () => {
    useShortSession();
    mocks.session = { ...(mocks.session as SessionView), status: "abandoned" };
    localStorage.setItem("xai-study:activeSessionId", "s-1");
    localStorage.setItem("other-app:setting", "keep");
    sessionStorage.setItem("xai-study:adminToken", "tok");
    const { container } = wrap(<DebriefScreen />);
    expect(screen.getByRole("heading", { name: "You've left the study" })).toBeInTheDocument();
    expect(container.textContent).toContain("unfinished answers are not submitted by exiting");
    expect(container.textContent).toContain("In the planned session, 4 of the 8 labels were deliberately wrong.");
    expect(container.textContent).toContain("Clearing browser storage does not delete your saved answers.");
    expect(localStorage.getItem("xai-study:activeSessionId")).toBeNull();
    expect(localStorage.getItem("other-app:setting")).toBe("keep");
    expect(sessionStorage.getItem("xai-study:adminToken")).toBe("tok");
  });

  it("describes four wrong labels in eight posts and only shows assigned corrections", async () => {
    useShortSession();
    const { container } = wrap(<DebriefScreen />);
    expect(screen.getByText("4 of the 8 labels were deliberately wrong.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Show the real facts/ }));
    expect(container.querySelectorAll("#debrief-facts li")).toHaveLength(4);
    expect(container.querySelector('[data-post-id="p04"]')).toBeNull();
    expect(container.querySelector('[data-post-id="p03"]')).toBeInTheDocument();
    expectNoResearcher(container.textContent ?? "");
  });

  it("is self-guided: explains the scripted labels, quotes the pid from memory, and clears storage", () => {
    localStorage.setItem("xai-study:activeSessionId", "s-1");
    sessionStorage.setItem("xai-study:adminToken", "tok");
    const { container } = wrap(<DebriefScreen />);
    const text = container.textContent ?? "";
    expect(screen.getByText(/8 of the 24 labels were deliberately wrong/)).toBeInTheDocument();
    expect(text).toMatch(/scripted/);
    expect(text).toMatch(/false alarm/);
    expect(text).toMatch(/miss/);
    expect(text).toMatch(/don't tell anyone else/);
    expect(text).not.toMatch(/email|withdraw|deadline|many studies/i);
    expect(text).toContain("Clearing browser storage does not delete your saved answers.");
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(text).toMatch(/participant number: 7/);
    expect(screen.getByText("You can close this page now.")).toBeInTheDocument();
    expectNoResearcher(text);
    expect(localStorage.getItem("xai-study:activeSessionId")).toBeNull();
    expect(sessionStorage.getItem("xai-study:adminToken")).toBe("tok");
  });

  it("renders the pid even when storage was already cleared", () => {
    expect(localStorage.length).toBe(0);
    wrap(<DebriefScreen />);
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("'Next participant' resets the study context and goes to the welcome page", async () => {
    const user = userEvent.setup();
    wrap(<DebriefScreen />);
    expect(screen.getByText("You can close this page now.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next participant" }));
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: "RESET" });
    expect(mocks.navigate).toHaveBeenCalledWith("/", { replace: true });
  });

  it("'Show the real facts' reveals all 8 wrong-label facts", async () => {
    const user = userEvent.setup();
    const { container } = wrap(<DebriefScreen />);
    expect(DEBRIEF_FACTS).toHaveLength(8);
    expect(DEBRIEF_FACTS.map((f) => f.postId).sort()).toEqual(
      ["p03", "p04", "p09", "p10", "p15", "p16", "p21", "p22"],
    );
    expect(container.querySelector("#debrief-facts")).toBeNull();
    const btn = screen.getByRole("button", { name: /Show the real facts/ });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    await user.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelectorAll("#debrief-facts li")).toHaveLength(8);
    for (const f of DEBRIEF_FACTS) expect(container.textContent).toContain(f.fact);
  });
});
