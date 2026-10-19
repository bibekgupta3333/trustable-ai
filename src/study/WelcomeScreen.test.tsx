// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { Cursor, SessionView } from "../../shared/api";

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

import { ApiClientError } from "../api/client";
import {
  ACTIVE_SESSION_KEY, StudyProvider, clearParticipantStorage, markParticipated,
} from "../state/StudyContext";
import WelcomeScreen from "./WelcomeScreen";

function makeSession(cursor: Cursor): SessionView {
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
    cursor,
    consequenceBanner: false,
    anxiety: false,
    resumeCount: 0,
    nextEventSeq: 1,
    consentAt: null,
    startedAt: "2026-10-17T10:00:00.000Z",
    completedAt: null,
  };
}

function renderApp() {
  return render(
    <MemoryRouter initialEntries={["/start"]}>
      <StudyProvider>
        <Routes>
          <Route path="/" element={<p>LANDING PAGE</p>} />
          <Route path="/start" element={<WelcomeScreen />} />
          <Route path="/consent" element={<p>CONSENT SCREEN</p>} />
          <Route path="/trial/:block/:pos" element={<p>TRIAL SCREEN</p>} />
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

describe("WelcomeScreen", () => {
  it("shows the title, description and code field with Start", () => {
    renderApp();
    expect(screen.getByRole("heading", { name: "Post Review Study" })).toBeInTheDocument();
    expect(screen.getByText(/8 short made-up social media posts across 4 parts/)).toBeInTheDocument();
    expect(screen.getByText(/Take it at your own pace/)).toBeInTheDocument();
    const input = screen.getByLabelText("Your participation code");
    expect(input).toHaveFocus();
    expect(screen.getByText(/We store a scrambled version, never the code itself/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
    expect(screen.queryByRole("link", { name: /admin/i })).not.toBeInTheDocument();
  });

  it("has a Back link to the landing page", async () => {
    renderApp();
    await userEvent.click(screen.getByRole("link", { name: "← Back" }));
    expect(screen.getByText("LANDING PAGE")).toBeInTheDocument();
  });

  it("rejects a too-short code without calling the server", async () => {
    renderApp();
    await userEvent.type(screen.getByLabelText("Your participation code"), "ab{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/between 3 and 120 characters/);
    expect(mocks.startOrResume).not.toHaveBeenCalled();
  });

  it("starts a session on Enter, stores the id and goes to consent", async () => {
    mocks.startOrResume.mockResolvedValue({
      session: makeSession({ blockIndex: 1, positionInBlock: 1, phase: "consent" }),
      resumed: false,
    });
    renderApp();
    await userEvent.type(screen.getByLabelText("Your participation code"), "  Jane@Uni.edu {Enter}");
    expect(await screen.findByText("CONSENT SCREEN")).toBeInTheDocument();
    expect(mocks.startOrResume).toHaveBeenCalledWith({ participantCode: "Jane@Uni.edu" });
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBe("s-42");
  });

  it("resumes an in-progress session for the same code (200) at its cursor", async () => {
    mocks.startOrResume.mockResolvedValue({
      session: makeSession({ blockIndex: 2, positionInBlock: 3, phase: "trial" }),
      resumed: true,
    });
    renderApp();
    await userEvent.type(screen.getByLabelText("Your participation code"), "u1234567");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("TRIAL SCREEN")).toBeInTheDocument();
  });

  it("shows the already-participated message on 409", async () => {
    mocks.startOrResume.mockRejectedValue(new ApiClientError(409, { error: "already_participated" }));
    renderApp();
    await userEvent.type(screen.getByLabelText("Your participation code"), "u1234567{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("You've already taken part in this study — thank you!");
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull();
  });

  it("shows a server 400 as an invalid code", async () => {
    mocks.startOrResume.mockRejectedValue(new ApiClientError(400, { error: "invalid_code" }));
    renderApp();
    await userEvent.type(screen.getByLabelText("Your participation code"), "abc{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/between 3 and 120 characters/);
  });

  it("disables Start while the request is in flight", async () => {
    let resolve!: (v: unknown) => void;
    mocks.startOrResume.mockReturnValue(new Promise((r) => (resolve = r)));
    renderApp();
    await userEvent.type(screen.getByLabelText("Your participation code"), "abc{Enter}");
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
    resolve({ session: makeSession({ blockIndex: 1, positionInBlock: 1, phase: "consent" }), resumed: false });
    expect(await screen.findByText("CONSENT SCREEN")).toBeInTheDocument();
  });

  it("offers Continue when an active session id is stored, and resumes it", async () => {
    localStorage.setItem(ACTIVE_SESSION_KEY, "s-42");
    mocks.resumeSession.mockResolvedValue(makeSession({ blockIndex: 1, positionInBlock: 1, phase: "consent" }));
    renderApp();
    expect(screen.queryByLabelText("Your participation code")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue where you left off" }));
    expect(await screen.findByText("CONSENT SCREEN")).toBeInTheDocument();
    expect(mocks.resumeSession).toHaveBeenCalledWith("s-42");
  });

  it("'Start over with a different code' clears the stored id and shows the form", async () => {
    localStorage.setItem(ACTIVE_SESSION_KEY, "s-42");
    renderApp();
    await userEvent.click(screen.getByRole("button", { name: "Start over with a different code" }));
    expect(screen.getByLabelText("Your participation code")).toBeInTheDocument();
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull();
  });

  it("ignores a legacy participated flag: no thank-you message without a server 409", () => {
    localStorage.setItem("xai-study:participated", "1");
    renderApp();
    expect(screen.queryByText("You've already taken part in this study — thank you!")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Your participation code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });
});

describe("clearParticipantStorage", () => {
  it("removes every xai-study: key from both storages but keeps the admin token and other apps' keys", () => {
    localStorage.setItem(ACTIVE_SESSION_KEY, "s-42");
    localStorage.setItem("xai-study:participated", "1");
    localStorage.setItem("xai-study:other", "x");
    localStorage.setItem("unrelated", "keep");
    sessionStorage.setItem("xai-study:adminToken", "tok");
    sessionStorage.setItem("xai-study:draft", "d");
    sessionStorage.setItem("unrelated", "keep");
    clearParticipantStorage();
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem("unrelated")).toBe("keep");
    expect(sessionStorage.getItem("xai-study:adminToken")).toBe("tok");
    expect(sessionStorage.getItem("xai-study:draft")).toBeNull();
    expect(sessionStorage.getItem("unrelated")).toBe("keep");
    clearParticipantStorage(); // idempotent
    expect(sessionStorage.getItem("xai-study:adminToken")).toBe("tok");
  });

  it("markParticipated is a deprecated alias that clears storage and sets no flag", () => {
    localStorage.setItem(ACTIVE_SESSION_KEY, "s-42");
    markParticipated();
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull();
    expect(localStorage.getItem("xai-study:participated")).toBeNull();
  });
});
