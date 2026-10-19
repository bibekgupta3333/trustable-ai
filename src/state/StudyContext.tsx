// Session state for the participant flow. Browser-side persistence is only the active session id
// (localStorage "xai-study:activeSessionId"); everything else lives on the server. Once the exit
// survey is stored on the server, clearParticipantStorage() wipes all "xai-study:" keys so the next
// person on a shared lab device starts fresh. Once-per-person is enforced only by the server's
// hashed participation code (409 already_participated); there is no browser "participated" flag.
import React, { createContext, useCallback, useContext, useMemo, useReducer, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { CreateSessionRequest, Cursor, SessionView } from "../../shared/api";
import { api, ApiClientError } from "../api/client";
import { initialStudyState, studyReducer, type StudyAction, type StudyState } from "./studyReducer";

export const ACTIVE_SESSION_KEY = "xai-study:activeSessionId";
export const STORAGE_PREFIX = "xai-study:";
/** Admin token (sessionStorage, same key as api/client.ts) must survive a participant wipe. */
const ADMIN_TOKEN_KEY = "xai-study:adminToken";

/** Thrown by startSession when the server answers 409 already_participated. */
export class AlreadyParticipatedError extends Error {
  constructor() {
    super("already_participated");
    this.name = "AlreadyParticipatedError";
  }
}

export function routeForCursor(c: Cursor): string {
  switch (c.phase) {
    case "consent":
      return "/consent";
    case "instructions":
      return "/instructions";
    case "trial":
    case "post_rating":
      return `/trial/${c.blockIndex}/${c.positionInBlock}`;
    case "block_survey":
      return `/survey/${c.blockIndex}`;
    case "exit_survey":
      return "/exit";
    case "done":
      return "/debrief";
  }
}

export function getStoredSessionId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_SESSION_KEY);
  } catch {
    return null;
  }
}

export function setStoredSessionId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_SESSION_KEY, id);
    else localStorage.removeItem(ACTIVE_SESSION_KEY);
  } catch {
    /* storage unavailable: session can still run in this tab */
  }
}

function removePrefixedKeys(storage: Storage, keep: readonly string[]): void {
  const doomed: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k !== null && k.startsWith(STORAGE_PREFIX) && !keep.includes(k)) doomed.push(k);
  }
  for (const k of doomed) storage.removeItem(k);
}

/**
 * Removes every "xai-study:" key from localStorage and sessionStorage (except the admin token).
 * Called only after the exit survey is stored on the server, and again on the debrief (idempotent).
 */
export function clearParticipantStorage(): void {
  try {
    removePrefixedKeys(localStorage, []);
  } catch {
    /* storage unavailable */
  }
  try {
    removePrefixedKeys(sessionStorage, [ADMIN_TOKEN_KEY]);
  } catch {
    /* storage unavailable */
  }
}

/** @deprecated Use clearParticipantStorage(); kept as an alias for older callers. */
export function markParticipated(): void {
  clearParticipantStorage();
}

export interface StartSessionOptions {
  consequenceBanner?: boolean;
}

export type StartResult = "started" | "resumed";

export interface StudyContextValue {
  state: StudyState;
  dispatch: React.Dispatch<StudyAction>;
  session: SessionView | null;
  startSession(participantCode: string, opts?: StartSessionOptions): Promise<StartResult>;
  resume(): Promise<boolean>;
  advance(c: Cursor): Promise<void>;
}

const StudyContext = createContext<StudyContextValue | null>(null);

function errorMessage(e: unknown): string {
  if (e instanceof ApiClientError) {
    const b = e.body as { error?: string; detail?: string } | null;
    if (b && typeof b === "object" && b.error) return b.detail ? `${b.error}: ${b.detail}` : b.error;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export function StudyProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(studyReducer, initialStudyState);
  const navigate = useNavigate();
  const resumeInFlight = useRef<Promise<boolean> | null>(null);
  const sessionRef = useRef<SessionView | null>(null);
  sessionRef.current = state.session;

  const startSession = useCallback(
    async (participantCode: string, opts: StartSessionOptions = {}): Promise<StartResult> => {
      dispatch({ type: "LOADING" });
      try {
        const req: CreateSessionRequest = { participantCode };
        if (opts.consequenceBanner !== undefined) req.consequenceBanner = opts.consequenceBanner;
        const { session, resumed } = await api.startOrResume(req);
        setStoredSessionId(session.sessionId);
        const midTrial = resumed && (session.cursor.phase === "trial" || session.cursor.phase === "post_rating");
        dispatch({ type: "SESSION_LOADED", session, resumed: midTrial });
        navigate(routeForCursor(session.cursor), { replace: true });
        return resumed ? "resumed" : "started";
      } catch (e) {
        if (e instanceof ApiClientError && e.status === 409) {
          dispatch({ type: "ERROR", error: "already_participated" });
          throw new AlreadyParticipatedError();
        }
        dispatch({ type: "ERROR", error: errorMessage(e) });
        throw e;
      }
    },
    [navigate],
  );

  const resume = useCallback((): Promise<boolean> => {
    // Dedupe concurrent calls (StrictMode double effects, guard + home) so resume_count is bumped once.
    if (resumeInFlight.current) return resumeInFlight.current;
    const id = getStoredSessionId();
    if (!id) return Promise.resolve(false);
    const p = (async () => {
      dispatch({ type: "LOADING" });
      try {
        const session = await api.resumeSession(id);
        if (session.status !== "in_progress") {
          setStoredSessionId(null);
          dispatch({ type: "RESET" });
          return false;
        }
        const midTrial = session.cursor.phase === "trial" || session.cursor.phase === "post_rating";
        dispatch({ type: "SESSION_LOADED", session, resumed: midTrial });
        navigate(routeForCursor(session.cursor), { replace: true });
        return true;
      } catch (e) {
        if (e instanceof ApiClientError && e.status === 404) {
          setStoredSessionId(null);
          dispatch({ type: "RESET" });
        } else {
          dispatch({ type: "ERROR", error: errorMessage(e) });
        }
        return false;
      } finally {
        resumeInFlight.current = null;
      }
    })();
    resumeInFlight.current = p;
    return p;
  }, [navigate]);

  const advance = useCallback(async (c: Cursor) => {
    const s = sessionRef.current;
    if (!s) throw new Error("No active session");
    try {
      await api.setCursor(s.sessionId, c);
    } catch (e) {
      dispatch({ type: "ERROR", error: errorMessage(e) });
      throw e;
    }
    dispatch({ type: "CURSOR_CHANGED", cursor: c });
    navigate(routeForCursor(c));
  }, [navigate]);

  const value = useMemo<StudyContextValue>(
    () => ({ state, dispatch, session: state.session, startSession, resume, advance }),
    [state, startSession, resume, advance],
  );

  return <StudyContext.Provider value={value}>{children}</StudyContext.Provider>;
}

export function useStudy(): StudyContextValue {
  const ctx = useContext(StudyContext);
  if (!ctx) throw new Error("useStudy must be used inside <StudyProvider>");
  return ctx;
}
