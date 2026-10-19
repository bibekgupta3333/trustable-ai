import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { clearParticipantStorage, useStudy } from "../state/StudyContext";
import { useLogger } from "../logging/logger";

/** Shared by all active participant screens; never uses researcher credentials. */
export default function StudyExitControl() {
  const { session, dispatch } = useStudy();
  const logger = useLogger();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const exitButton = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);

  useEffect(() => {
    if (!open || !dialog.current) return;
    const el = dialog.current;
    if (typeof el.showModal === "function") el.showModal();
    else el.setAttribute("open", ""); // jsdom / older browsers
    keepButton.current?.focus();
    return () => { if (typeof el.close === "function") el.close(); };
  }, [open]);

  if (!session || session.status !== "in_progress" || session.cursor.phase === "done") return null;

  function dismiss() {
    if (submitting.current) return;
    setOpen(false);
    setError(null);
    exitButton.current?.focus();
  }

  async function confirmExit() {
    if (!session || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      // Interaction logging is best effort; it must not prevent voluntary exit.
      void logger?.flush().catch(() => {});
      const ended = await api.cancelSession(session.sessionId);
      clearParticipantStorage();
      dispatch({ type: "SESSION_LOADED", session: ended });
      navigate("/debrief", { replace: true });
    } catch {
      setError("We couldn't end your session. Please try again. You can also close this page; saved answers will remain and the session will expire after inactivity.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="study-exit">
      <button ref={exitButton} type="button" className="study-exit__trigger" onClick={() => setOpen(true)}>
        Exit study
      </button>
      {open && (
        <dialog ref={dialog} className="study-exit__dialog" aria-labelledby="study-exit-title"
          aria-describedby="study-exit-description" onCancel={(event) => { event.preventDefault(); dismiss(); }}>
          <h2 id="study-exit-title">Leave the study?</h2>
          <p id="study-exit-description">You can stop at any time. Answers already saved will be kept. Unsaved answers on this page may be lost. Your session will end and the same participation code cannot start again.</p>
          {error && <p role="alert">{error}</p>}
          <div className="button-row">
            <button ref={keepButton} type="button" disabled={busy} onClick={dismiss}>Keep participating</button>
            <button type="button" disabled={busy} onClick={() => void confirmExit()}>
              {busy ? "Exiting…" : "Yes, exit study"}
            </button>
          </div>
        </dialog>
      )}
    </div>
  );
}
