// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Cursor, SessionView, Presentation, PracticePresentation } from "../shared/api";
import App from "./App";
import { api, ApiClientError } from "./api/client";
import { ACTIVE_SESSION_KEY } from "./state/StudyContext";
import { clearPresentationCache } from "./study/TrialScreen";

function session(cursor: Cursor): SessionView {
  return {
    sessionId: "route-audit-demo", pid: 1, status: "in_progress", protocolVersion: "calibrated-full-v1",
    conditionOrder: ["A", "B", "D", "C"], setRotation: 0,
    blocks: ([1, 2, 3, 4] as const).map((blockIndex) => ({
      blockIndex, condition: (["A", "B", "D", "C"] as const)[blockIndex - 1],
      set: (["S1", "S2", "S3", "S4"] as const)[blockIndex - 1],
      postOrder: [`p${String((blockIndex - 1) * 6 + 1).padStart(2, "0")}`, `p${String((blockIndex - 1) * 6 + 3).padStart(2, "0")}`],
    })) as SessionView["blocks"],
    cursor, consequenceBanner: false, anxiety: false, resumeCount: 2, nextEventSeq: 37,
    consentAt: null, startedAt: "2026-10-19T10:00:00.000Z", completedAt: null,
  };
}

const practice: PracticePresentation = {
  id: "practice-01", topic: "svc", set: null,
  author: { handle: "@DemoTown", displayName: "Demo Town", verified: false },
  text: "Fictional practice for route testing.", postedAgo: "2h", likes: 7, reposts: 1,
  aiLabel: "accurate", factSheet: { title: "Demo record", body: "Fictional record.", source: "Demo source" },
  staticExplanation: "A fixed practice reason.", factors: [
    { key: "source", label: "Source", displayValue: "Demo source", passes: true, detail: "Fictional source." },
    { key: "claimVsRecord", label: "Claim vs record", displayValue: "Demo comparison", passes: true, detail: "Fictional comparison." },
    { key: "wording", label: "Wording", displayValue: "Neutral", passes: true, detail: "Fictional wording." },
  ], counterfactualExplanation: "A practice what-if reason.",
};

const trialCursor: Cursor = { blockIndex: 2, positionInBlock: 2, phase: "trial" };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
  clearPresentationCache();
  // A missed mock must fail here, never contact a study server.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request in route audit")));
  vi.spyOn(api, "resumeSession").mockResolvedValue(session(trialCursor));
  vi.spyOn(api, "getPractice").mockResolvedValue(practice);
  vi.spyOn(api, "getPresentation").mockImplementation(async (_id, block, pos): Promise<Presentation> => ({
    postId: `demo-${block}-${pos}`, condition: (["A", "B", "D", "C"] as const)[block - 1],
    author: practice.author, text: `Route audit post ${block}/${pos}.`, postedAgo: "2h", likes: 7, reposts: 1,
    aiLabel: "accurate", factSheet: practice.factSheet,
    staticExplanation: "A fixed reason.", counterfactualExplanation: "A what-if reason.", factors: practice.factors,
  }));
  vi.spyOn(api, "submitEvents").mockImplementation(async (_id, events) => ({ inserted: events.length }));
  vi.spyOn(api.admin, "getKpis").mockRejectedValue(new ApiClientError(401, { error: "unauthorized" }));
  vi.spyOn(api.admin, "listSessions").mockResolvedValue([]);
  vi.spyOn(api.admin, "getExportIndex").mockResolvedValue([]);
});

afterEach(async () => {
  await act(async () => { cleanup(); }); // retain and exercise the real logger's unmount cleanup
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function open(path: string, saved?: SessionView) {
  if (saved) {
    localStorage.setItem(ACTIVE_SESSION_KEY, saved.sessionId);
    vi.mocked(api.resumeSession).mockResolvedValue(saved);
  }
  window.history.replaceState({}, "", path);
  return render(<App />);
}

async function expectPath(path: string) {
  await waitFor(() => expect(window.location.pathname).toBe(path));
}

const protectedPaths = ["/consent", "/instructions", "/trial/1/1", "/survey/1", "/exit", "/debrief"];

describe("public routes and wildcard", () => {
  it.each(["/", "/start", "/admin"])("keeps %s accessible with a stored participant session and does not auto-resume it", async (path) => {
    open(path, session(trialCursor));
    if (path === "/admin") {
      expect(await screen.findByRole("heading", { name: "Study dashboard" })).toBeInTheDocument();
      expect(await screen.findByText("Enter the admin token.")).toBeInTheDocument();
      expect(api.admin.getKpis).toHaveBeenCalledOnce();
    } else if (path === "/start") {
      expect(screen.getByRole("button", { name: "Continue where you left off" })).toBeInTheDocument();
    } else {
      expect(screen.getByRole("link", { name: "Take part" })).toBeInTheDocument();
    }
    await expectPath(path);
    expect(api.resumeSession).not.toHaveBeenCalled();
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBe("route-audit-demo");
    expect(screen.queryByRole("button", { name: "Exit study" })).not.toBeInTheDocument();
  });

  it.each(["/unknown", "/trial/1", "/survey", "/admin/unknown"])("returns the unmatched URL %s to the landing page", async (path) => {
    open(path);
    await expectPath("/");
    expect(screen.getByRole("link", { name: "Take part" })).toBeInTheDocument();
    expect(api.resumeSession).not.toHaveBeenCalled();
  });
});

describe("participant guards and saved cursor", () => {
  it.each(protectedPaths)("returns fresh direct access to %s to the landing page without revealing the screen", async (path) => {
    open(path);
    await expectPath("/");
    expect(screen.getByRole("link", { name: "Take part" })).toBeInTheDocument();
    expect(screen.queryByText("The AI labels were scripted.")).not.toBeInTheDocument();
    expect(api.resumeSession).not.toHaveBeenCalled();
    expect(api.getPractice).not.toHaveBeenCalled();
    expect(api.getPresentation).not.toHaveBeenCalled();
  });

  it.each([
    { path: "/consent", cursor: { blockIndex: 1, positionInBlock: 1, phase: "consent" }, heading: "Before you start" },
    { path: "/instructions", cursor: { blockIndex: 1, positionInBlock: 1, phase: "instructions" }, heading: "How this study works" },
    { path: "/trial/2/2", cursor: trialCursor, heading: /Part 2 of 4/ },
    { path: "/trial/2/2", cursor: { ...trialCursor, phase: "post_rating" }, heading: /Part 2 of 4/ },
    { path: "/survey/3", cursor: { blockIndex: 3, positionInBlock: 2, phase: "block_survey" }, heading: "Part 3 of 4: Your ratings" },
    { path: "/exit", cursor: { blockIndex: 4, positionInBlock: 2, phase: "exit_survey" }, heading: "A few last questions" },
  ])("resumes $cursor.phase on its assigned route $path", async ({ path, cursor, heading }) => {
    open(path, session(cursor as Cursor));
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
    await expectPath(path);
    expect(api.resumeSession).toHaveBeenCalledExactlyOnceWith("route-audit-demo");
    expect(screen.getByRole("button", { name: "Exit study" })).toBeInTheDocument();
    if (path.startsWith("/trial")) expect(api.getPresentation).toHaveBeenCalledWith("route-audit-demo", 2, 2);
  });

  it.each([
    "/consent", "/instructions", "/trial/1/1", "/trial/nope/2", "/trial/0/2", "/trial/5/1",
    "/trial/2/0", "/trial/2/3", "/trial/2/6", "/trial/2/1.5", "/trial/02/02",
    "/survey/nope", "/survey/0", "/survey/5", "/exit", "/debrief",
  ])("corrects %s to the persisted cursor before mounting an incorrect screen", async (path) => {
    open(path, session(trialCursor));
    await expectPath("/trial/2/2");
    expect(await screen.findByText("Route audit post 2/2.")).toBeInTheDocument();
    expect(api.getPresentation).toHaveBeenCalledExactlyOnceWith("route-audit-demo", 2, 2);
    expect(api.getPractice).not.toHaveBeenCalled();
    expect(screen.queryByText("The AI labels were scripted.")).not.toBeInTheDocument();
  });

  it("corrects browser URL edits while a session is already in memory without resuming twice", async () => {
    open("/trial/2/2", session(trialCursor));
    await screen.findByText("Route audit post 2/2.");
    await act(async () => {
      window.history.pushState({}, "", "/trial/1/1");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expectPath("/trial/2/2");
    expect(api.resumeSession).toHaveBeenCalledOnce();
    expect(vi.mocked(api.getPresentation).mock.calls.every(([id, block, pos]) =>
      id === "route-audit-demo" && block === 2 && pos === 2)).toBe(true);
  });

  it.each(["completed", "abandoned"] as const)("clears a stored %s session and does not restore its debrief on refresh", async (status) => {
    localStorage.setItem(ACTIVE_SESSION_KEY, "closed-demo");
    vi.mocked(api.resumeSession).mockRejectedValue(new ApiClientError(409, {
      error: "conflict", detail: `session is ${status}`,
    }));
    open("/debrief");
    await expectPath("/");
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull();
    expect(screen.queryByText("The AI labels were scripted.")).not.toBeInTheDocument();
  });

  it("clears a missing saved session and returns to the public landing", async () => {
    localStorage.setItem(ACTIVE_SESSION_KEY, "missing-demo");
    vi.mocked(api.resumeSession).mockRejectedValue(new ApiClientError(404, { error: "not_found" }));
    open("/survey/1");
    await expectPath("/");
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull();
  });

  it.each([
    { kind: "network", error: new Error("offline") },
    { kind: "server", error: new ApiClientError(500, { error: "internal" }) },
    { kind: "unrelated conflict", error: new ApiClientError(409, { error: "validation" }) },
  ])("retains storage after a $kind resume failure and permits retry from the landing page", async ({ error }) => {
    localStorage.setItem(ACTIVE_SESSION_KEY, "route-audit-demo");
    vi.mocked(api.resumeSession).mockRejectedValueOnce(error);
    open("/trial/2/2");
    await expectPath("/");
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBe("route-audit-demo");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await expectPath("/trial/2/2");
    expect(api.resumeSession).toHaveBeenCalledTimes(2);
  });
});

describe("routing after participant actions", () => {
  it.each([false, true])("navigates a code submission using the returned cursor (resumed=%s)", async (resumed) => {
    const cursor: Cursor = resumed ? { blockIndex: 3, positionInBlock: 2, phase: "block_survey" }
      : { blockIndex: 1, positionInBlock: 1, phase: "consent" };
    vi.spyOn(api, "startOrResume").mockResolvedValue({ session: session(cursor), resumed });
    open("/start");
    await userEvent.type(screen.getByLabelText("Your participation code"), "routing-demo-code");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await expectPath(resumed ? "/survey/3" : "/consent");
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBe("route-audit-demo");
    expect(api.resumeSession).not.toHaveBeenCalled();
  });

  it("reaches early-exit debrief in memory and resets for the next participant", async () => {
    const saved = session({ blockIndex: 1, positionInBlock: 1, phase: "consent" });
    vi.spyOn(api, "cancelSession").mockResolvedValue({ ...saved, status: "abandoned", cursor: { ...saved.cursor, phase: "done" } });
    sessionStorage.setItem("xai-study:adminToken", "demo-admin");
    open("/consent", saved);
    await userEvent.click(await screen.findByRole("button", { name: "Exit study" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, exit study" }));
    await expectPath("/debrief");
    expect(await screen.findByRole("heading", { name: "You've left the study" })).toBeInTheDocument();
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull();
    expect(sessionStorage.getItem("xai-study:adminToken")).toBe("demo-admin");
    await userEvent.click(screen.getByRole("button", { name: "Next participant" }));
    await expectPath("/");
    await userEvent.click(screen.getByRole("link", { name: "Take part" }));
    await expectPath("/start");
    expect(screen.getByLabelText("Your participation code")).toBeInTheDocument();
    expect(api.resumeSession).toHaveBeenCalledOnce();
  });

  it("keeps the completed debrief in memory after exit submission but starts fresh on reload", async () => {
    const saved = session({ blockIndex: 4, positionInBlock: 2, phase: "exit_survey" });
    vi.spyOn(api, "submitExitSurvey").mockResolvedValue({ ...saved, status: "completed", cursor: { ...saved.cursor, phase: "done" } });
    const view = open("/exit", saved);
    await screen.findByRole("heading", { name: "A few last questions" });
    for (const [group, name] of [[/Age range/, "25–34"], [/Education/, "Bachelor's degree"],
      [/use social media/, "Daily"], [/fact-check labels/, "Sometimes"], [/prefer/, "No preference"]] as const) {
      fireEvent.click(within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name }));
    }
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    await expectPath("/debrief");
    expect(screen.getByRole("heading", { name: "Thank you!" })).toBeInTheDocument();
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull();
    await act(async () => { view.unmount(); });
    render(<App />);
    await expectPath("/");
    expect(screen.getByRole("link", { name: "Take part" })).toBeInTheDocument();
    expect(api.resumeSession).toHaveBeenCalledOnce();
  });
});
