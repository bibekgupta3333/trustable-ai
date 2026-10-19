// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import StudyExitControl from "./StudyExitControl";

const mocks = vi.hoisted(() => ({
  session: { sessionId: "exit-session", status: "in_progress", cursor: { phase: "trial" } },
  cancel: vi.fn(), dispatch: vi.fn(), clear: vi.fn(), navigate: vi.fn(), flush: vi.fn(),
}));
vi.mock("../state/StudyContext", () => ({
  useStudy: () => ({ session: mocks.session, dispatch: mocks.dispatch }),
  clearParticipantStorage: mocks.clear,
}));
vi.mock("../api/client", () => ({ api: { cancelSession: mocks.cancel } }));
vi.mock("../logging/logger", () => ({ useLogger: () => ({ flush: mocks.flush }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.status = "in_progress";
  mocks.session.cursor.phase = "trial";
  mocks.flush.mockResolvedValue(undefined);
  mocks.cancel.mockResolvedValue({ ...mocks.session, status: "abandoned", cursor: { phase: "done" } });
});

function openExit() {
  render(<StudyExitControl />);
  fireEvent.click(screen.getByRole("button", { name: "Exit study" }));
}

describe("StudyExitControl", () => {
  it("confirms exit and lets the participant keep their unsaved screen", () => {
    openExit();
    expect(screen.getByRole("dialog", { name: "Leave the study?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep participating" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Keep participating" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Exit study" })).toHaveFocus();
  });

  it("ends the session, clears storage and opens the early-exit debrief", async () => {
    openExit();
    fireEvent.click(screen.getByRole("button", { name: "Yes, exit study" }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/debrief", { replace: true }));
    expect(mocks.cancel).toHaveBeenCalledWith("exit-session");
    expect(mocks.clear).toHaveBeenCalledOnce();
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: "SESSION_LOADED", session: expect.objectContaining({ status: "abandoned" }) });
  });

  it("retains browser state and allows retry if ending the session fails", async () => {
    mocks.cancel.mockRejectedValueOnce(new Error("offline"));
    openExit();
    fireEvent.click(screen.getByRole("button", { name: "Yes, exit study" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("couldn't end your session");
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes, exit study" }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
  });

  it("does not block voluntary exit when event logging fails", async () => {
    mocks.flush.mockRejectedValueOnce(new Error("logging unavailable"));
    openExit();
    fireEvent.click(screen.getByRole("button", { name: "Yes, exit study" }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
  });

  it("is absent after completion or abandonment", () => {
    mocks.session.status = "completed";
    const { rerender } = render(<StudyExitControl />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    mocks.session.status = "abandoned";
    rerender(<StudyExitControl />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
