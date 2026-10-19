// Pure reducer for the client's view of the active session.
import type { Cursor, SessionView } from "../../shared/api";

export interface StudyState {
  status: "idle" | "loading" | "ready" | "error";
  session: SessionView | null;
  error: string | null;
  /** True while the participant is on the trial they were on when the session was resumed (sets Trial.resumed). */
  resumed: boolean;
}

export type StudyAction =
  | { type: "LOADING" }
  | { type: "SESSION_LOADED"; session: SessionView; resumed?: boolean }
  | { type: "CURSOR_CHANGED"; cursor: Cursor }
  | { type: "ERROR"; error: string }
  | { type: "RESET" };

export const initialStudyState: StudyState = { status: "idle", session: null, error: null, resumed: false };

export function studyReducer(state: StudyState, action: StudyAction): StudyState {
  switch (action.type) {
    case "LOADING":
      return { ...state, status: "loading", error: null };
    case "SESSION_LOADED":
      return { status: "ready", session: action.session, error: null, resumed: Boolean(action.resumed) };
    case "CURSOR_CHANGED":
      if (!state.session) return state;
      return { ...state, resumed: false, session: { ...state.session, cursor: { ...action.cursor } } };
    case "ERROR":
      return { ...state, status: "error", error: action.error };
    case "RESET":
      return initialStudyState;
    default:
      return state;
  }
}
