// Thin fetch wrapper for the Express API. See CONTRACT.md "client".
import type {
  Assignment, CreateSessionRequest, SessionView, PracticePresentation, Presentation,
  TrialSubmission, TrialSaved, EventSubmission, Cursor, BlockSurveySubmission,
  ExitSurveySubmission, AdminSessionRow, Kpis,
} from "../../shared/api";

export const ADMIN_TOKEN_KEY = "xai-study:adminToken";

export class ApiClientError extends Error {
  constructor(public readonly status: number, public readonly body: unknown) {
    super(
      `API error ${status}` +
        (body && typeof body === "object" && "error" in body ? `: ${String((body as { error: unknown }).error)}` : ""),
    );
    this.name = "ApiClientError";
  }
}

function adminToken(): string | null {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

async function requestWithStatus<T>(
  method: string, path: string, body?: unknown, admin = false,
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (admin) {
    const token = adminToken();
    if (token) headers["x-admin-token"] = token;
  }
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) throw new ApiClientError(res.status, parsed ?? null);
  return { status: res.status, data: parsed as T };
}

async function request<T>(method: string, path: string, body?: unknown, admin = false): Promise<T> {
  return (await requestWithStatus<T>(method, path, body, admin)).data;
}

const getAdminAssignmentPreview = (pid: number) =>
  request<Assignment>("GET", `/admin/assignments/${pid}`, undefined, true);

const enc = encodeURIComponent;

export const EXPORT_NAMES = [
  "participants.csv",
  "kpis.csv",
  "trials.csv",
  "surveys.csv",
  "events.csv",
  "exit.csv",
  "sessions.json",
] as const;

export type ExportName = (typeof EXPORT_NAMES)[number];

/** One entry of GET /api/admin/export (the export index). */
export interface ExportIndexEntry {
  name: ExportName;
  description: string;
  rows: number;
}

export const api = {
  /** @deprecated Admin-only now; use `api.admin.getAssignmentPreview`. */
  getAssignmentPreview: getAdminAssignmentPreview,
  createSession: (req: CreateSessionRequest) => request<SessionView>("POST", "/sessions", req),
  /** POST /api/sessions: 201 = new session, 200 = resumed in-progress session for this code. 409 throws ApiClientError. */
  startOrResume: async (req: CreateSessionRequest): Promise<{ session: SessionView; resumed: boolean }> => {
    const { status, data } = await requestWithStatus<SessionView>("POST", "/sessions", req);
    return { session: data, resumed: status === 200 };
  },
  getSession: (id: string) => request<SessionView>("GET", `/sessions/${enc(id)}`),
  resumeSession: (id: string) => request<SessionView>("POST", `/sessions/${enc(id)}/resume`),
  cancelSession: (id: string) => request<SessionView>("POST", `/sessions/${enc(id)}/cancel`),
  consent: (id: string) => request<SessionView>("POST", `/sessions/${enc(id)}/consent`),
  getPractice: (contextMedia = false) => request<PracticePresentation>("GET", `/practice${contextMedia ? "?contextMedia=1" : ""}`),
  getPresentation: (id: string, blockIndex: number, position: number) =>
    request<Presentation>("GET", `/sessions/${enc(id)}/presentation/${blockIndex}/${position}`),
  submitTrial: (id: string, t: TrialSubmission) => request<TrialSaved>("POST", `/sessions/${enc(id)}/trials`, t),
  submitEvents: (id: string, evs: EventSubmission[]) =>
    request<{ inserted: number }>("POST", `/sessions/${enc(id)}/events`, { events: evs }),
  setCursor: async (id: string, c: Cursor): Promise<void> => {
    await request<void>("PUT", `/sessions/${enc(id)}/cursor`, c);
  },
  submitBlockSurvey: (id: string, s: BlockSurveySubmission) =>
    request<{ nWrongDetected: number; cursor: Cursor }>("POST", `/sessions/${enc(id)}/block-surveys`, s),
  submitExitSurvey: (id: string, s: ExitSurveySubmission) =>
    request<SessionView>("POST", `/sessions/${enc(id)}/exit-survey`, s),
  admin: {
    getKpis: () => request<Kpis>("GET", "/admin/kpis", undefined, true),
    getAssignmentPreview: getAdminAssignmentPreview,
    listSessions: () => request<AdminSessionRow[]>("GET", "/admin/sessions", undefined, true),
    abandon: async (id: string): Promise<void> => {
      await request<void>("POST", `/admin/sessions/${enc(id)}/abandon`, undefined, true);
    },
    remove: async (id: string): Promise<void> => {
      await request<void>("DELETE", `/admin/sessions/${enc(id)}`, undefined, true);
    },
    /** GET /api/admin/export: one entry per downloadable file, with its current row count. */
    getExportIndex: () => request<ExportIndexEntry[]>("GET", "/admin/export", undefined, true),
    exportUrl: (name: ExportName): string => {
      const token = adminToken();
      return `/api/admin/export/${name}` + (token ? `?token=${enc(token)}` : "");
    },
  },
};
