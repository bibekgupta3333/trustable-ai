// Welcome (route "/start", linked from the landing page at "/"): self-start with a participation code, or continue an active session
// (CONTRACT-v2 §A, §C). Once-per-person is enforced by the server (409 -> thank-you message);
// browser storage is wiped after each completed session, so there is no local "participated" flag.
import React, { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { ApiClientError } from "../api/client";
import {
  AlreadyParticipatedError, getStoredSessionId, routeForCursor, setStoredSessionId, useStudy,
} from "../state/StudyContext";

const CODE_MIN = 3;
const CODE_MAX = 120;
const ALREADY_MSG = "You've already taken part in this study — thank you!";
const INVALID_MSG = `Please enter a code between ${CODE_MIN} and ${CODE_MAX} characters.`;

export default function WelcomeScreen(): JSX.Element {
  const { session, startSession, resume } = useStudy();
  const [activeId, setActiveId] = useState<string | null>(getStoredSessionId);
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session && session.status === "in_progress") return <Navigate to={routeForCursor(session.cursor)} replace />;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (sending) return;
    const trimmed = code.trim();
    if (trimmed.length < CODE_MIN || trimmed.length > CODE_MAX) {
      setError(INVALID_MSG);
      return;
    }
    setSending(true);
    setError(null);
    try {
      await startSession(trimmed);
      // startSession navigates to the session's current screen.
    } catch (err) {
      if (err instanceof AlreadyParticipatedError) setError(ALREADY_MSG);
      else if (err instanceof ApiClientError && err.status === 400) setError(INVALID_MSG);
      else setError("Something went wrong starting the study. Please check your connection and try again.");
      setSending(false);
    }
  }

  async function onContinue() {
    setSending(true);
    setError(null);
    const ok = await resume();
    if (!ok) {
      setActiveId(getStoredSessionId());
      setError("We couldn't find your previous session. Please enter your code to continue.");
    }
    setSending(false);
  }

  function onStartOver() {
    setStoredSessionId(null);
    setActiveId(null);
    setError(null);
  }

  return (
    <main className="screen screen-welcome">
      <p className="welcome__back">
        <Link to="/" className="btn btn--link">
          ← Back
        </Link>
      </p>
      <h1>Post Review Study</h1>
      <p className="welcome__intro">
        You'll judge 8 short made-up social media posts across 4 parts, each shown with an AI accuracy label.
        <br />
        A short study with a questionnaire after each part. Take it at your own pace.
      </p>

      {activeId ? (
        <div className="welcome__continue">
          <button type="button" className="btn btn--primary" onClick={onContinue} disabled={sending} autoFocus>
            {sending ? "Loading…" : "Continue where you left off"}
          </button>
          <p>
            <button type="button" className="btn btn--link welcome__start-over" onClick={onStartOver} disabled={sending}>
              Start over with a different code
            </button>
          </p>
        </div>
      ) : (
        <form className="welcome__form" onSubmit={onSubmit} noValidate>
          <div className="field" aria-invalid={error === INVALID_MSG ? true : undefined}>
            <label htmlFor="participation-code">Your participation code</label>
            <input
              id="participation-code"
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={CODE_MAX}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              aria-describedby="participation-code-hint"
              autoFocus
            />
            <p id="participation-code-hint" className="welcome__hint">
              Use your university email or student ID. We store a scrambled version, never the code itself,
              to recognize this code when you return and prevent repeat submissions with it.
            </p>
          </div>
          <button type="submit" className="btn btn--primary" disabled={sending}>
            {sending ? "Starting…" : "Start"}
          </button>
        </form>
      )}

      {error && (
        <p className="error welcome__error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
