// @vitest-environment jsdom
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { SessionView } from "../../shared/api";

const mocks = vi.hoisted(() => ({
  startOrResume: vi.fn(),
  resumeSession: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: { ...actual.api, startOrResume: mocks.startOrResume, resumeSession: mocks.resumeSession },
  };
});

vi.mock("../components/LandingIllustration", () => ({
  default: () => <svg data-testid="landing-illustration" />,
}));

import { ACTIVE_SESSION_KEY, StudyProvider } from "../state/StudyContext";
import LandingScreen from "./LandingScreen";
import App from "../App";

function makeSession(): SessionView {
  return {
    sessionId: "s-42",
    pid: 3,
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
}

function renderLanding() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <StudyProvider>
        <Routes>
          <Route path="/" element={<LandingScreen />} />
          <Route path="/start" element={<p>CODE ENTRY</p>} />
          <Route path="/consent" element={<p>CONSENT SCREEN</p>} />
        </Routes>
      </StudyProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  mocks.startOrResume.mockReset();
  mocks.resumeSession.mockReset();
});
afterEach(cleanup);

describe("LandingScreen", () => {
  it("renders the hero, sections, FAQ, footer and accessible landmarks", () => {
    const { container } = renderLanding();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Post Review Study" })).toBeInTheDocument();
    expect(screen.getByText("Help us understand how people use AI labels on social media posts.")).toBeInTheDocument();
    for (const name of ["How it works", "What are AI labels?", "Four parts, four explanation styles", "Who can take part", "Your privacy", "Questions"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getByRole("contentinfo")).toHaveTextContent("HCI experiment conducted as part of graduate study at Florida Polytechnic University.");
    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute("href", "#main-content");
    expect(screen.getByRole("link", { name: "How it works ↓" })).toHaveAttribute("href", "#how-it-works");
    expect(container.querySelector("#how-it-works")).not.toBeNull();
    const steps = within(container.querySelector(".landing__steps") as HTMLElement).getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(screen.getByText(/8 short made-up posts across 4 parts/)).toBeInTheDocument();
    expect(screen.getByText(/Use a web browser on a computer or phone/)).toBeInTheDocument();
    expect(screen.getByText(/4 parts · 2 posts per part · 8 posts total/)).toBeInTheDocument();
    expect(screen.getByText(/64 ratings total/)).toBeInTheDocument();
    expect(screen.getByText(/You will see each style once, in an assigned order/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "What are AI labels?" })).toHaveTextContent("Likely accurate");
    expect(screen.getByRole("region", { name: "What are AI labels?" })).toHaveTextContent("Likely misleading");
    expect(screen.getByRole("region", { name: "What are AI labels?" })).toHaveTextContent("posts are text-based");
    expect(container.textContent).not.toContain("illustrative pictures");
    expect(screen.getByText(/18 or over who reads English/)).toBeInTheDocument();
    expect(screen.getByText(/scrambled version of your code/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/PLACEHOLDER|\bIRB\b|professor|supervisor|contact|anonymous/i);
    expect(container.textContent).toContain("Answers already saved remain on the study server if you stop.");
    expect(container.querySelectorAll("details.landing__faq-item")).toHaveLength(4);
    expect(screen.getByText("What if I close the tab?")).toBeInTheDocument();
    expect(screen.getByText(/same code within 2 hours/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Your participation code")).not.toBeInTheDocument();
    expect(screen.queryByText(/session in progress/)).not.toBeInTheDocument();
  });

  it("'Take part' goes to code entry at /start", async () => {
    renderLanding();
    await userEvent.click(screen.getByRole("link", { name: "Take part" }));
    expect(screen.getByText("CODE ENTRY")).toBeInTheDocument();
  });

  it("uses none of the forbidden recruitment words anywhere in its text", () => {
    const { container } = renderLanding();
    const text = (container.textContent ?? "").toLowerCase();
    for (const word of ["wrong", "mistake", "error", "scripted", "deliberately", "fact-check", "fact check"]) {
      expect(text).not.toContain(word);
    }
  });

  it("shows a Continue banner when a session id is stored, and resumes it", async () => {
    localStorage.setItem(ACTIVE_SESSION_KEY, "s-42");
    mocks.resumeSession.mockResolvedValue(makeSession());
    renderLanding();
    expect(screen.getByText("You have a session in progress.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("CONSENT SCREEN")).toBeInTheDocument();
    expect(mocks.resumeSession).toHaveBeenCalledWith("s-42");
  });
});

describe("App routes", () => {
  it('"/" shows the landing page, not the code input', () => {
    window.history.pushState({}, "", "/");
    render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: "Post Review Study" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Take part" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Your participation code")).not.toBeInTheDocument();
  });

  it('"/start" shows the code input', () => {
    window.history.pushState({}, "", "/start");
    render(<App />);
    expect(screen.getByLabelText("Your participation code")).toBeInTheDocument();
  });
});
