/*
 * AdminScreen: route /admin. Data collection + KPI dashboard only (CONTRACT-v2 §B).
 * There is no "start session" control: participants self-start from the Welcome screen.
 * The pid preview shows condition order, set rotation, sets and post ids only; it never shows
 * which labels are wrong (the client never receives correctness data).
 *
 * CSS classes (styled in src/styles/global.css; no inline colors here):
 *   .admin                    page wrapper (<main>)
 *   .admin__header            title row (title + refresh status)
 *   .admin__title             h1 "Study dashboard"
 *   .admin__refresh           "Last updated" + Refresh + Pause group
 *   .admin__updated           "Last updated hh:mm:ss" text
 *   .admin__section           one card/section
 *   .admin__section-title     h2 inside a section
 *   .admin__field             label + input row
 *   .admin__input             text / number inputs
 *   .admin__actions           row of buttons
 *   .admin__button            any button
 *   .admin__button--danger    "Mark abandoned", "Delete (withdrawal)", "Delete permanently"
 *   .admin__error             error message (role=alert)
 *   .admin__notice            neutral status line
 *   .admin__cards             grid of KPI cards
 *   .admin__card              one KPI card
 *   .admin__card-label        card caption
 *   .admin__card-value        big number
 *   .admin__card-sub          small secondary line
 *   .admin__table-wrap        horizontal-scroll wrapper for wide tables
 *   .admin__table             any data table (conditions, sessions, error types, preview)
 *   .admin__balance           balance grid (<ul>)
 *   .admin__balance-cell      one condition order cell; plus .admin__balance-cell--met when completed >= expected
 *   .admin__balance-order     order string (e.g. "ABDC")
 *   .admin__balance-count     "n / expected"
 *   .admin__status            status cell; plus .admin__status--in_progress / --completed / --abandoned
 *   .admin__confirm           inline delete confirmation (role=dialog)
 *   (export section: see the admin__export* classes listed in ExportPanel.tsx)
 *   .admin__preview           pid preview result box
 *   (charts use the kpi__* classes listed in KpiCharts.tsx)
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { CURRENT_PROTOCOL } from "../../shared/types";
import type { AdminSessionRow, Assignment, Kpis } from "../../shared/api";
import ExportPanel from "./ExportPanel";
import { BarCell, DASH, PairBar, ProgressMeter, Sparkline, fmtNum, fmtPct } from "./KpiCharts";

export const ADMIN_TOKEN_KEY = "xai-study:adminToken";
export const REFRESH_MS = 15_000;
const ORDERS = ["ABDC", "BCAD", "CDBA", "DACB"] as const;
const CONDITION_NAMES: Record<string, string> = {
  A: "No explanation",
  B: "Static",
  C: "Interactive",
  D: "Counterfactual",
};

function readToken(): string {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function errStatus(err: unknown): number | null {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : null;
}

function errMessage(err: unknown): string {
  const status = errStatus(err);
  if (status === 401) return "Enter the admin token.";
  if (status === 403) return "Open this page on the study computer.";
  const body = (err as { body?: { error?: string; detail?: string } } | null)?.body;
  if (body && typeof body === "object" && (body.error || body.detail)) {
    return [body.error, body.detail].filter(Boolean).join(": ");
  }
  return err instanceof Error ? err.message : "Request failed.";
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtClock(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return DASH;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return DASH;
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function fmtMinutes(v: number | null | undefined): string {
  return v == null ? DASH : `${v.toFixed(1)} min`;
}

function fmtSeconds(ms: number | null | undefined): string {
  return ms == null ? DASH : `${(ms / 1000).toFixed(1)} s`;
}

export default function AdminScreen() {
  const [token, setToken] = useState<string>(readToken);
  const [tokenNotice, setTokenNotice] = useState<string | null>(null);

  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [rows, setRows] = useState<AdminSessionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [paused, setPaused] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);

  const [deleting, setDeleting] = useState<AdminSessionRow | null>(null);
  const [deleteText, setDeleteText] = useState("");

  const [previewPid, setPreviewPid] = useState("");
  const [preview, setPreview] = useState<Assignment | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const [k, s] = await Promise.allSettled([api.admin.getKpis(), api.admin.listSessions()]);
      if (k.status === "fulfilled") setKpis(k.value);
      if (s.status === "fulfilled") setRows(s.value);
      const failed = k.status === "rejected" ? k.reason : s.status === "rejected" ? s.reason : null;
      setError(failed ? errMessage(failed) : null);
      if (!failed) setLastUpdated(new Date());
    } finally {
      inFlight.current = false;
      setLoading(false);
      setRefreshCount((n) => n + 1);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, [paused, refresh]);

  function saveToken(e: React.FormEvent) {
    e.preventDefault();
    const t = token.trim();
    try {
      if (t) sessionStorage.setItem(ADMIN_TOKEN_KEY, t);
      else sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      setTokenNotice(t ? "Token saved for this tab." : "Token cleared.");
    } catch {
      setTokenNotice("Could not store the token in this browser.");
    }
    void refresh();
  }

  async function handleAbandon(row: AdminSessionRow) {
    if (!window.confirm(`Mark the session for pid ${row.pid} as abandoned? Its data is kept and the pid can be reused.`)) return;
    setActionError(null);
    try {
      await api.admin.abandon(row.sessionId);
      await refresh();
    } catch (err) {
      setActionError(errMessage(err));
    }
  }

  async function confirmDelete() {
    if (!deleting || deleteText.trim() !== String(deleting.pid)) return;
    setActionError(null);
    try {
      await api.admin.remove(deleting.sessionId);
      setDeleting(null);
      setDeleteText("");
      await refresh();
    } catch (err) {
      setActionError(errMessage(err));
    }
  }

  async function handlePreview(e: React.FormEvent) {
    e.preventDefault();
    setPreviewError(null);
    const pid = Number(previewPid);
    if (previewPid.trim() === "" || !Number.isInteger(pid) || pid < 1) {
      setPreview(null);
      setPreviewError("Enter a whole-number participant ID of 1 or more.");
      return;
    }
    try {
      setPreview(await api.admin.getAssignmentPreview(pid));
    } catch (err) {
      setPreview(null);
      setPreviewError(errMessage(err));
    }
  }

  const now = Date.now();
  const target = kpis?.target;
  const expectedPerOrder = target ? target.n / ORDERS.length : null;
  const balanceMap = new Map((kpis?.balance ?? []).map((b) => [b.conditionOrder, b.completed]));

  return (
    <main className="admin">
      <header className="admin__header">
        <h1 className="admin__title">Study dashboard</h1>
        <div className="admin__refresh">
          <span className="admin__updated" aria-live="polite">
            Last updated {lastUpdated ? fmtClock(lastUpdated) : DASH}
            {paused ? " (paused)" : ""}
          </span>
          <button type="button" className="admin__button" onClick={() => void refresh()} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
          <button type="button" className="admin__button" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>
            {paused ? "Resume auto-refresh" : "Pause auto-refresh"}
          </button>
        </div>
      </header>

      {error && <p className="admin__error" role="alert">{error}</p>}

      <section className="admin__section" aria-labelledby="admin-token-title">
        <h2 id="admin-token-title" className="admin__section-title">Admin token</h2>
        <form onSubmit={saveToken} className="admin__actions">
          <label className="admin__field">
            Token (only if the server sets ADMIN_TOKEN)
            <input
              className="admin__input"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <button type="submit" className="admin__button">Save token</button>
        </form>
        {tokenNotice && <p className="admin__notice">{tokenNotice}</p>}
      </section>

      <section className="admin__section" aria-labelledby="admin-kpi-title">
        <p className="admin__notice">KPI cohort: {kpis?.cohort ?? CURRENT_PROTOCOL}. New sessions use text-only posts with original engagement counts and the full questionnaire. Exploratory interface package comparisons; recruitment targets are not a power guarantee. Session management and raw exports include all protocols.</p>
        <h2 id="admin-kpi-title" className="admin__section-title">Progress</h2>
        <div className="admin__cards">
          <div className="admin__card" data-testid="kpi-appropriate-reliance">
            <span className="admin__card-label">Appropriate reliance (primary)</span>
            <span className="admin__card-value">{fmtPct(kpis?.primaryOutcome?.appropriateRelianceRate)}</span>
            <span className="admin__card-sub">Correct labels accepted + wrong labels rejected / all trials</span>
          </div>
          <div className="admin__card" data-testid="kpi-correct-acceptance">
            <span className="admin__card-label">Correct-label acceptance</span>
            <span className="admin__card-value">{fmtPct(kpis?.primaryOutcome?.correctAcceptanceRate)}</span>
            <span className="admin__card-sub">Among correct labels</span>
          </div>
          <div className="admin__card" data-testid="kpi-wrong-rejection">
            <span className="admin__card-label">Wrong-label rejection</span>
            <span className="admin__card-value">{fmtPct(kpis?.primaryOutcome?.wrongRejectionRate)}</span>
            <span className="admin__card-sub">Among wrong labels</span>
          </div>
          <div className="admin__card" data-testid="kpi-completed">
            <span className="admin__card-label">Completed</span>
            <span className="admin__card-value">
              {target ? `${target.completed} / ${target.n}` : DASH}
            </span>
            {target && (
              <span role="img" aria-label={`${target.completed} of ${target.n} completed; joint balance requires 32 participants`}>
                <span aria-hidden="true"><ProgressMeter completed={target.completed} target={target.n} minimum={16} /></span>
              </span>
            )}
            <span className="admin__card-sub">
              {target
                ? `Order/set cycles (16 each): ${target.cycle1Completed}/16 · ${target.cycle2Completed}/16 · joint balance: 32 participants`
                : DASH}
            </span>
          </div>
          <div className="admin__card" data-testid="kpi-in-progress">
            <span className="admin__card-label">In progress</span>
            <span className="admin__card-value">{kpis ? kpis.sessions.inProgress : DASH}</span>
            <span className="admin__card-sub">
              {kpis ? `${kpis.sessions.started} started · ${kpis.sessions.abandoned} abandoned` : DASH}
            </span>
          </div>
          <div className="admin__card" data-testid="kpi-completion-rate">
            <span className="admin__card-label">Completion rate</span>
            <span className="admin__card-value">{fmtPct(kpis?.sessions.completionRate)}</span>
            <span className="admin__card-sub">Completed / (completed + abandoned); excludes in-progress sessions</span>
          </div>
          <div className="admin__card" data-testid="kpi-duration">
            <span className="admin__card-label">Session time</span>
            <span className="admin__card-value">{fmtMinutes(kpis?.durationMin.median)}</span>
            <span className="admin__card-sub">median · p90 {fmtMinutes(kpis?.durationMin.p90)}</span>
          </div>
          <div className="admin__card" data-testid="kpi-daily">
            <span className="admin__card-label">Completed per day</span>
            <Sparkline data={kpis?.dailyCompleted ?? []} />
          </div>
        </div>
      </section>

      <section className="admin__section" aria-labelledby="admin-cond-title">
        <h2 id="admin-cond-title" className="admin__section-title">By condition (completed sessions)</h2>
        <p className="admin__notice">New sessions use 8 text-only posts with original engagement counts and the full questionnaire after each part: 12 Jian-based trust items, 2 fairness items, tension and frustration (64 block ratings total). Existing sessions retain their saved protocol. Analyse protocolVersion and studyVariant separately. Historical brief trust is a custom, unvalidated 1–7 item and is separate from the full trust score.</p>
        <div className="admin__table-wrap">
          <table className="admin__table" aria-labelledby="admin-cond-title">
            <thead>
              <tr>
                <th scope="col">Condition</th>
                <th scope="col">Trials</th>
                <th scope="col">Appropriate reliance</th>
                <th scope="col">Correct acceptance</th>
                <th scope="col">Wrong rejection</th>
                <th scope="col">Overreliance</th>
                <th scope="col">Underreliance</th>
                <th scope="col">Agreement</th>
                <th scope="col">Detection</th>
                <th scope="col">False alarm vs miss</th>
                <th scope="col">Fact sheet</th>
                <th scope="col">Confidence</th>
                <th scope="col">Median decision</th>
                <th scope="col">Brief trust (custom)</th>
                <th scope="col">Jian-based trust (full)</th>
                <th scope="col">Fairness</th>
                <th scope="col">Tension</th>
                <th scope="col">Frustration</th>
              </tr>
            </thead>
            <tbody>
              {(kpis?.byCondition ?? []).map((c) => {
                const n = `condition ${c.condition}`;
                return (
                  <tr key={c.condition}>
                    <th scope="row">
                      {c.condition} · {CONDITION_NAMES[c.condition] ?? ""}
                    </th>
                    <td>{c.trials}</td>
                    <td>{fmtPct(c.appropriateRelianceRate)}</td>
                    <td>{fmtPct(c.correctAcceptanceRate)}</td>
                    <td>{fmtPct(c.wrongRejectionRate)}</td>
                    <td>{fmtPct(c.overrelianceRate)}</td>
                    <td>{fmtPct(c.underrelianceRate)}</td>
                    <td>{fmtPct(c.agreementRate)}</td>
                    <td>
                      <BarCell value={c.detectionRate} label={fmtPct(c.detectionRate)} name={`Detection, ${n}`} />
                    </td>
                    <td>
                      <PairBar falseAlarm={c.falseAlarmDetection} miss={c.missDetection} name={`Detection by error type, ${n}`} />
                    </td>
                    <td>{fmtPct(c.factSheetOpenRate)}</td>
                    <td>{fmtNum(c.meanConfidence)}</td>
                    <td>{fmtSeconds(c.medianDecisionMs)}</td>
                    <td><BarCell value={c.briefTrustMean ?? null} min={1} max={7} label={fmtNum(c.briefTrustMean)} name={`Brief trust (custom), ${n}`} /></td>
                    <td>
                      <BarCell value={c.trustMean} min={1} max={7} label={fmtNum(c.trustMean)} name={`Trust, ${n}`} />
                    </td>
                    <td>{fmtNum(c.fairnessMean)}</td>
                    <td>
                      <BarCell value={c.tensionMean} min={1} max={7} label={fmtNum(c.tensionMean)} name={`Tension, ${n}`} />
                    </td>
                    <td>{fmtNum(c.frustrationMean)}</td>
                  </tr>
                );
              })}
              {(!kpis || kpis.byCondition.length === 0) && (
                <tr>
                  <td colSpan={18}>No completed sessions yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {kpis && kpis.byErrorType.length > 0 && (
          <table className="admin__table" aria-label="Detection by error type">
            <thead>
              <tr>
                <th scope="col">Error type</th>
                <th scope="col">n</th>
                <th scope="col">Detection</th>
              </tr>
            </thead>
            <tbody>
              {kpis.byErrorType.map((e) => (
                <tr key={e.errorType}>
                  <th scope="row">{e.errorType === "false_alarm" ? "False alarm" : "Miss"}</th>
                  <td>{e.n}</td>
                  <td>{fmtPct(e.detectionRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="admin__section" aria-labelledby="admin-balance-title">
        <h2 id="admin-balance-title" className="admin__section-title">Condition-order balance</h2>
        <ul className="admin__balance">
          {ORDERS.map((o) => {
            const done = balanceMap.get(o) ?? 0;
            const met = expectedPerOrder != null && done >= expectedPerOrder;
            return (
              <li
                key={o}
                className={`admin__balance-cell${met ? " admin__balance-cell--met" : ""}`}
                aria-label={`Order ${o}: ${done} completed of ${expectedPerOrder ?? DASH} expected`}
              >
                <span className="admin__balance-order">{o}</span>
                <span className="admin__balance-count">
                  {kpis ? done : DASH} / {expectedPerOrder ?? DASH}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="admin__section" aria-labelledby="admin-sessions-title">
        <h2 id="admin-sessions-title" className="admin__section-title">Sessions</h2>
        {actionError && <p className="admin__error" role="alert">{actionError}</p>}
        {rows.length === 0 ? (
          <p className="admin__notice">No sessions yet.</p>
        ) : (
          <div className="admin__table-wrap">
            <table className="admin__table" aria-label="Sessions">
              <thead>
                <tr>
                  <th scope="col">pid</th>
                  <th scope="col">Status</th>
                  <th scope="col">Order</th>
                  <th scope="col">Trials</th>
                  <th scope="col">Surveys</th>
                  <th scope="col">Started</th>
                  <th scope="col">Last activity</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.sessionId}>
                    <td>{r.pid}</td>
                    <td><span className={`admin__status admin__status--${r.status}`}>{r.status.replace("_", " ")}</span></td>
                    <td>{r.conditionOrder}</td>
                    <td>{r.trialsSaved}/{r.plannedTrials ?? 24}</td>
                    <td>{r.surveysSaved}/4</td>
                    <td>{fmtDateTime(r.startedAt)}</td>
                    <td title={fmtDateTime(r.lastActivityAt)}>{relativeTime(r.lastActivityAt, now)}</td>
                    <td>
                      <div className="admin__actions">
                        {r.status === "in_progress" && (
                          <button
                            type="button"
                            className="admin__button admin__button--danger"
                            onClick={() => void handleAbandon(r)}
                          >
                            Mark abandoned
                          </button>
                        )}
                        <button
                          type="button"
                          className="admin__button admin__button--danger"
                          onClick={() => {
                            setDeleting(r);
                            setDeleteText("");
                          }}
                        >
                          Delete (withdrawal)
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {deleting && (
          <div className="admin__confirm" role="dialog" aria-label="Confirm deletion">
            <p>
              This permanently deletes every record of pid {deleting.pid} (session {deleting.sessionId}). Type the
              pid to confirm.
            </p>
            <label className="admin__field">
              Type {deleting.pid} to confirm
              <input className="admin__input" value={deleteText} onChange={(e) => setDeleteText(e.target.value)} />
            </label>
            <div className="admin__actions">
              <button
                type="button"
                className="admin__button admin__button--danger"
                disabled={deleteText.trim() !== String(deleting.pid)}
                onClick={() => void confirmDelete()}
              >
                Delete permanently
              </button>
              <button type="button" className="admin__button" onClick={() => setDeleting(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      <ExportPanel refreshKey={refreshCount} />

      <section className="admin__section" aria-labelledby="admin-preview-title">
        <h2 id="admin-preview-title" className="admin__section-title">Assignment preview</h2>
        <form onSubmit={handlePreview} className="admin__actions">
          <label className="admin__field">
            Participant ID
            <input
              className="admin__input"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={previewPid}
              onChange={(e) => {
                setPreviewPid(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          <button type="submit" className="admin__button">Preview</button>
        </form>
        {previewError && <p className="admin__error" role="alert">{previewError}</p>}
        {preview && (
          <div className="admin__preview" aria-label={`Assignment preview, pid ${preview.pid}`}>
            <p>
              Condition order: <strong>{preview.conditionOrder.join(" → ")}</strong> · Set rotation:{" "}
              <strong>{preview.setRotation}</strong>
            </p>
            <table className="admin__table">
              <thead>
                <tr>
                  <th scope="col">Part</th>
                  <th scope="col">Condition</th>
                  <th scope="col">Set</th>
                  <th scope="col">Post order</th>
                </tr>
              </thead>
              <tbody>
                {preview.blocks.map((b) => (
                  <tr key={b.blockIndex}>
                    <td>Part {b.blockIndex}</td>
                    <td>{b.condition}</td>
                    <td>{b.set}</td>
                    <td>{b.postOrder.join(" ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
