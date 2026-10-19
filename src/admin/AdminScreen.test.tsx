// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getKpis: vi.fn(),
  listSessions: vi.fn(),
  abandon: vi.fn(),
  remove: vi.fn(),
  getAssignmentPreview: vi.fn(),
  getExportIndex: vi.fn(),
}));

// exportUrl is the real implementation (reads the admin token from sessionStorage).
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      admin: {
        getKpis: mocks.getKpis,
        listSessions: mocks.listSessions,
        abandon: mocks.abandon,
        remove: mocks.remove,
        getAssignmentPreview: mocks.getAssignmentPreview,
        getExportIndex: mocks.getExportIndex,
        exportUrl: actual.api.admin.exportUrl,
      },
    },
  };
});

import AdminScreen, { REFRESH_MS, relativeTime } from "./AdminScreen";
import ExportPanel, { DOWNLOAD_GAP_MS } from "./ExportPanel";

const ALL_EXPORTS = [
  "participants.csv", "kpis.csv", "trials.csv", "surveys.csv", "events.csv", "exit.csv", "sessions.json",
] as const;

const exportIndex = ALL_EXPORTS.map((name, i) => ({ name, description: `About ${name}`, rows: (i + 1) * 10 }));

const cond = (c: string, over: Record<string, unknown> = {}) => ({
  condition: c,
  trials: 48,
  agreementRate: 0.75,
  wrongTrials: 16,
  detectionRate: 0.5,
  falseAlarmDetection: 0.625,
  missDetection: 0.375,
  factSheetOpenRate: 0.4,
  meanConfidence: 5.25,
  medianDecisionMs: 6400,
  trustMean: 4.5,
  fairnessMean: 4.1,
  tensionMean: 3.2,
  frustrationMean: 2.8,
  ...over,
});

const kpis = {
  cohort: "calibrated-full-v1",
  primaryOutcome: { trials: 100, correctTrials: 50, wrongTrials: 50, correctAcceptanceRate: 0.8, wrongRejectionRate: 0.6, appropriateRelianceRate: 0.7, overrelianceRate: 0.4, underrelianceRate: 0.2 },
  generatedAt: "2026-10-17T10:00:00Z",
  sessions: { started: 12, inProgress: 2, completed: 8, abandoned: 2, completionRate: 0.6667 },
  target: { n: 32, minimum: 16, completed: 8, cycle1Completed: 8, cycle2Completed: 0 },
  durationMin: { median: 17.4, p90: 22.9 },
  byCondition: ["A", "B", "C", "D"].map((c) => cond(c)),
  byErrorType: [
    { errorType: "false_alarm", n: 32, detectionRate: 0.6 },
    { errorType: "miss", n: 32, detectionRate: 0.4 },
  ],
  balance: [
    { conditionOrder: "ABDC", completed: 2 },
    { conditionOrder: "BCAD", completed: 3 },
    { conditionOrder: "CDBA", completed: 2 },
    { conditionOrder: "DACB", completed: 1 },
  ],
  dailyCompleted: [
    { date: "2026-10-16", n: 3 },
    { date: "2026-10-17", n: 5 },
  ],
};

const nullKpis = {
  ...kpis,
  primaryOutcome: { trials: 0, correctTrials: 0, wrongTrials: 0, correctAcceptanceRate: null, wrongRejectionRate: null, appropriateRelianceRate: null, overrelianceRate: null, underrelianceRate: null },
  sessions: { started: 0, inProgress: 0, completed: 0, abandoned: 0, completionRate: null },
  target: { n: 32, minimum: 16, completed: 0, cycle1Completed: 0, cycle2Completed: 0 },
  durationMin: { median: null, p90: null },
  byCondition: [
    cond("A", {
      trials: 0, agreementRate: null, detectionRate: null, falseAlarmDetection: null, missDetection: null,
      factSheetOpenRate: null, meanConfidence: null, medianDecisionMs: null, trustMean: null,
      fairnessMean: null, tensionMean: null, frustrationMean: null,
    }),
  ],
  byErrorType: [],
  balance: [],
  dailyCompleted: [],
};

const row = {
  sessionId: "sess-7",
  pid: 7,
  status: "in_progress",
  conditionOrder: "CDBA",
  setRotation: 1,
  trialsSaved: 11,
  surveysSaved: 1,
  startedAt: "2026-10-17T09:30:00Z",
  completedAt: null,
  lastActivityAt: new Date(Date.now() - 5 * 60_000).toISOString(),
};

function err(status: number) {
  return Object.assign(new Error(`API error ${status}`), { status, body: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.getKpis.mockResolvedValue(kpis);
  mocks.listSessions.mockResolvedValue([row]);
  mocks.abandon.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  mocks.getExportIndex.mockResolvedValue(exportIndex);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AdminScreen", () => {
  it("renders the header and KPI cards from a fixture", async () => {
    render(<AdminScreen />);
    expect(screen.getByRole("heading", { level: 1, name: "Study dashboard" })).toBeInTheDocument();
    const completed = await screen.findByTestId("kpi-completed");
    expect(within(screen.getByTestId("kpi-appropriate-reliance")).getByText("70%")).toBeInTheDocument();
    expect(within(screen.getByTestId("kpi-correct-acceptance")).getByText("80%")).toBeInTheDocument();
    expect(within(screen.getByTestId("kpi-wrong-rejection")).getByText("60%")).toBeInTheDocument();
    expect(screen.getByText(/KPI cohort: calibrated-full-v1/)).toHaveTextContent(/text-only posts with original engagement counts and the full questionnaire/);
    expect(within(completed).getByText("8 / 32")).toBeInTheDocument();
    expect(within(completed).getByRole("img", { name: "8 of 32 completed; joint balance requires 32 participants" })).toBeInTheDocument();
    expect(within(completed).getByText("Order/set cycles (16 each): 8/16 · 0/16 · joint balance: 32 participants")).toBeInTheDocument();
    expect(within(screen.getByTestId("kpi-in-progress")).getByText("2")).toBeInTheDocument();
    expect(within(screen.getByTestId("kpi-completion-rate")).getByText("67%")).toBeInTheDocument();
    expect(within(screen.getByTestId("kpi-completion-rate")).getByText("Completed / (completed + abandoned); excludes in-progress sessions")).toBeInTheDocument();
    const dur = screen.getByTestId("kpi-duration");
    expect(within(dur).getByText("17.4 min")).toBeInTheDocument();
    expect(within(dur).getByText(/p90 22\.9 min/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Completed per day: 8 over 2 days/ })).toBeInTheDocument();
  });

  it("renders per-condition rows with accessible SVG bars, and the balance grid", async () => {
    render(<AdminScreen />);
    expect(await screen.findByRole("img", { name: "Detection, condition A: 50%" })).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Detection by error type, condition B: false alarm 63%, miss 38%" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Trust, condition C: 4.5" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Tension, condition D: 3.2" })).toBeInTheDocument();
    expect(screen.getAllByText("75%")).toHaveLength(4); // agreement
    expect(screen.getAllByText("6.4 s")).toHaveLength(4);
    expect(screen.getByLabelText("Order BCAD: 3 completed of 8 expected")).toBeInTheDocument();
    expect(screen.getByLabelText("Order DACB: 1 completed of 8 expected")).toBeInTheDocument();
  });

  it("shows custom brief trust separately from legacy Jian trust", async () => {
    mocks.getKpis.mockResolvedValue({ ...kpis, byCondition: [cond("C", {
      briefTrustMean: 6, trustMean: null, fairnessMean: null,
      correctAcceptanceRate: 0.8, wrongRejectionRate: 0.4, appropriateRelianceRate: 0.6,
      overrelianceRate: 0.6, underrelianceRate: 0.2,
    })] });
    render(<AdminScreen />);
    expect(await screen.findByRole("img", { name: "Brief trust (custom), condition C: 6.0" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Trust, condition C: no data" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Jian-based trust (full)" })).toBeInTheDocument();
    expect(screen.getByText(/custom, unvalidated 1–7 item/)).toBeInTheDocument();
  });

  it("shows — for null values", async () => {
    mocks.getKpis.mockResolvedValue(nullKpis);
    mocks.listSessions.mockResolvedValue([{ ...row, lastActivityAt: null }]);
    render(<AdminScreen />);
    const rate = await screen.findByTestId("kpi-completion-rate");
    await waitFor(() => expect(within(rate).getByText("—")).toBeInTheDocument());
    expect(within(screen.getByTestId("kpi-duration")).getByText("—")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Detection, condition A: no data" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Trust, condition A: no data" })).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Detection by error type, condition A: false alarm no data, miss no data" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Completed per day: no data" })).toBeInTheDocument();
    const sessions = screen.getByRole("table", { name: "Sessions" });
    expect(within(sessions).getByText("—")).toBeInTheDocument();
    expect(screen.queryByText(/NaN|null|undefined/)).not.toBeInTheDocument();
  });

  it("shows friendly 403 and 401 messages", async () => {
    mocks.getKpis.mockRejectedValue(err(403));
    mocks.listSessions.mockRejectedValue(err(403));
    const { unmount } = render(<AdminScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Open this page on the study computer");
    unmount();

    mocks.getKpis.mockRejectedValue(err(401));
    render(<AdminScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the admin token");
  });

  it("saves the token to sessionStorage and refreshes", async () => {
    render(<AdminScreen />);
    await screen.findByTestId("kpi-completed");
    fireEvent.change(screen.getByLabelText(/Token/), { target: { value: " secret " } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));
    expect(sessionStorage.getItem("xai-study:adminToken")).toBe("secret");
    await waitFor(() => expect(mocks.getKpis).toHaveBeenCalledTimes(2));
  });

  it("renders the sessions table with progress and relative last activity", async () => {
    render(<AdminScreen />);
    const table = await screen.findByRole("table", { name: "Sessions" });
    await waitFor(() => expect(within(table).getByText("11/24")).toBeInTheDocument());
    expect(within(table).getByText("1/4")).toBeInTheDocument();
    expect(within(table).getByText("CDBA")).toBeInTheDocument();
    expect(within(table).getByText("5 min ago")).toBeInTheDocument();
  });

  it("asks for confirmation before marking abandoned", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<AdminScreen />);
    const btn = await screen.findByRole("button", { name: "Mark abandoned" });
    fireEvent.click(btn);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mocks.abandon).not.toHaveBeenCalled();
    fireEvent.click(btn);
    await waitFor(() => expect(mocks.abandon).toHaveBeenCalledWith("sess-7"));
  });

  it("requires typing the pid before deleting", async () => {
    render(<AdminScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete (withdrawal)" }));
    const dialog = screen.getByRole("dialog", { name: "Confirm deletion" });
    const del = within(dialog).getByRole("button", { name: "Delete permanently" });
    expect(del).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Type 7 to confirm"), { target: { value: "8" } });
    expect(del).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Type 7 to confirm"), { target: { value: "7" } });
    expect(del).toBeEnabled();
    fireEvent.click(del);
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("sess-7"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("has no start-session control", async () => {
    render(<AdminScreen />);
    await screen.findByTestId("kpi-completed");
    expect(screen.queryByRole("button", { name: /start/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new session/i })).not.toBeInTheDocument();
  });

  it("renders the export panel and refetches the index on each dashboard refresh", async () => {
    render(<AdminScreen />);
    await waitFor(() => expect(screen.getByText("8 / 32")).toBeInTheDocument());
    for (const name of ALL_EXPORTS) {
      expect(await screen.findByRole("link", { name: `Download ${name}` })).toHaveAttribute(
        "href",
        `/api/admin/export/${name}`,
      );
    }
    const calls = mocks.getExportIndex.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(mocks.getExportIndex.mock.calls.length).toBeGreaterThan(calls));
  });

  it("previews a pid assignment without correctness data", async () => {
    mocks.getAssignmentPreview.mockResolvedValue({
      pid: 7,
      conditionOrder: ["C", "D", "B", "A"],
      setRotation: 1,
      seed: 7,
      blocks: [{ blockIndex: 1, condition: "C", set: "S4", postOrder: ["p20", "p23", "p21", "p19", "p22", "p24"] }],
    });
    render(<AdminScreen />);
    await waitFor(() => expect(screen.getByText("8 / 32")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Participant ID"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const box = await screen.findByLabelText("Assignment preview, pid 7");
    expect(mocks.getAssignmentPreview).toHaveBeenCalledWith(7);
    expect(within(box).getByText("C → D → B → A")).toBeInTheDocument();
    expect(within(box).getByText("p20 p23 p21 p19 p22 p24")).toBeInTheDocument();
    expect(within(box).queryByText(/wrong|correct/i)).not.toBeInTheDocument();
  });

  it("auto-refreshes every 15 s and can be paused", async () => {
    vi.useFakeTimers();
    render(<AdminScreen />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.getKpis).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Last updated \d{2}:\d{2}:\d{2}/)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
    });
    expect(mocks.getKpis).toHaveBeenCalledTimes(2);
    expect(mocks.listSessions).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Pause auto-refresh" }));
    expect(screen.getByText(/\(paused\)/)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
    });
    expect(mocks.getKpis).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Resume auto-refresh" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
    });
    expect(mocks.getKpis).toHaveBeenCalledTimes(3);
  });
});

describe("ExportPanel", () => {
  function spyClicks() {
    const hrefs: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      hrefs.push(this.getAttribute("href") ?? "");
    });
    return hrefs;
  }

  it("renders the index with descriptions, row counts and highlights", async () => {
    render(<ExportPanel refreshKey={0} />);
    const participants = await screen.findByTestId("export-participants.csv");
    expect(within(participants).getByText("Start here — one row per session")).toBeInTheDocument();
    expect(within(participants).getByText("About participants.csv")).toBeInTheDocument();
    expect(within(participants).getByText("10")).toBeInTheDocument();
    expect(participants).toHaveClass("admin__export--featured");
    expect(within(screen.getByTestId("export-kpis.csv")).getByText("Dashboard numbers")).toBeInTheDocument();
    const json = screen.getByTestId("export-sessions.json");
    expect(within(json).getByText("70")).toBeInTheDocument();
    expect(json).not.toHaveClass("admin__export--featured");
    expect(within(json).getByRole("link", { name: "Download sessions.json" })).toHaveAttribute(
      "href",
      "/api/admin/export/sessions.json",
    );
    expect(screen.queryByText(/row counts are unavailable/)).not.toBeInTheDocument();
  });

  it("falls back to the 7 names with links and no counts when the index fails", async () => {
    mocks.getExportIndex.mockRejectedValue(err(500));
    render(<ExportPanel refreshKey={0} />);
    expect(await screen.findByText(/row counts are unavailable/)).toBeInTheDocument();
    for (const name of ALL_EXPORTS) {
      const r = screen.getByTestId(`export-${name}`);
      expect(within(r).getByRole("link", { name: `Download ${name}` })).toHaveAttribute(
        "href",
        `/api/admin/export/${name}`,
      );
      expect(within(r).getAllByText("—")).toHaveLength(2); // description + rows
    }
    expect(screen.getByText("Start here — one row per session")).toBeInTheDocument();
  });

  it("Download all clicks each CSV in sequence and skips sessions.json by default", async () => {
    vi.useFakeTimers();
    const hrefs = spyClicks();
    render(<ExportPanel refreshKey={0} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole("button", { name: "Download all CSVs" }));
    expect(hrefs).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_GAP_MS);
    });
    expect(hrefs).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_GAP_MS * 10);
    });
    expect(hrefs).toEqual(ALL_EXPORTS.filter((n) => n.endsWith(".csv")).map((n) => `/api/admin/export/${n}`));
    expect(document.querySelectorAll("a[hidden]")).toHaveLength(0);
  });

  it("Download all includes sessions.json when the raw JSON box is ticked", async () => {
    vi.useFakeTimers();
    const hrefs = spyClicks();
    render(<ExportPanel refreshKey={0} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByLabelText(/Include raw JSON/));
    fireEvent.click(screen.getByRole("button", { name: "Download all CSVs" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_GAP_MS * 10);
    });
    expect(hrefs).toEqual(ALL_EXPORTS.map((n) => `/api/admin/export/${n}`));
  });

  it("appends the stored admin token to link and download-all URLs", async () => {
    sessionStorage.setItem("xai-study:adminToken", "s3cr t");
    const hrefs = spyClicks();
    render(<ExportPanel refreshKey={0} />);
    expect(await screen.findByRole("link", { name: "Download kpis.csv" })).toHaveAttribute(
      "href",
      "/api/admin/export/kpis.csv?token=s3cr%20t",
    );
    fireEvent.click(screen.getByRole("button", { name: "Download all CSVs" }));
    expect(hrefs[0]).toBe("/api/admin/export/participants.csv?token=s3cr%20t");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  it("formats", () => {
    expect(relativeTime(null, now)).toBe("—");
    expect(relativeTime("2026-10-17T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-10-17T11:45:00Z", now)).toBe("15 min ago");
    expect(relativeTime("2026-10-17T09:00:00Z", now)).toBe("3 h ago");
    expect(relativeTime("2026-10-14T12:00:00Z", now)).toBe("3 d ago");
  });
});
