import express from "express";
import { asAsyncDatabase, type DatabaseInput } from "../db/async.js";
import { getSession, listSessions, setStatus, deleteSession } from "../db/repo.js";
import {
  trialsCsv, surveysCsv, eventsCsv, exitCsv, sessionsJson, participantsCsv, kpisCsv, exportIndex,
} from "../export/exporters.js";
import { CURRENT_PROTOCOL, type PostBank } from "../../shared/types.js";
import { assignShortFromBank } from "../../shared/counterbalance.js";
import { computeKpis } from "../kpi.js";

type Exporter = (db: DatabaseInput) => Promise<string>;

const EXPORTS: Record<string, { build: Exporter; contentType: string; bom: boolean }> = {
  "trials.csv": { build: trialsCsv, contentType: "text/csv; charset=utf-8", bom: true },
  "surveys.csv": { build: surveysCsv, contentType: "text/csv; charset=utf-8", bom: true },
  "events.csv": { build: eventsCsv, contentType: "text/csv; charset=utf-8", bom: true },
  "exit.csv": { build: exitCsv, contentType: "text/csv; charset=utf-8", bom: true },
  "participants.csv": { build: participantsCsv, contentType: "text/csv; charset=utf-8", bom: true },
  "kpis.csv": { build: (db) => kpisCsv(db), contentType: "text/csv; charset=utf-8", bom: true },
  "sessions.json": { build: sessionsJson, contentType: "application/json; charset=utf-8", bom: false },
};

/** Download file name, e.g. "2026-10-17-xai-study-trials.csv". */
export function exportFilename(name: string, now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 10)}-xai-study-${name}`;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** True when the request's socket address is loopback (the lab laptop itself). */
export function isLoopback(remoteAddress: string | undefined | null): boolean {
  return !!remoteAddress && LOOPBACK.has(remoteAddress);
}

/** Admin access (CONTRACT-v2 §B): with ADMIN_TOKEN set, the token is required; without it, loopback only. */
export function adminAccess(
  adminToken: string | undefined,
  req: { header?: string; queryToken?: string; remoteAddress?: string | null },
): "ok" | "unauthorized" | "forbidden" {
  if (adminToken) return req.header === adminToken || req.queryToken === adminToken ? "ok" : "unauthorized";
  return isLoopback(req.remoteAddress) ? "ok" : "forbidden";
}

/** session_id -> last_activity_at (present after startup migrations). */
async function lastActivityMap(input: DatabaseInput): Promise<Map<string, string | null>> {
  const db = asAsyncDatabase(input);
  const rows = await db.prepare("SELECT session_id, last_activity_at FROM sessions").all() as {
    session_id: string;
    last_activity_at: string | null;
  }[];
  return new Map(rows.map((r) => [r.session_id, r.last_activity_at ?? null]));
}

export function adminRouter(deps: { db: DatabaseInput; adminToken?: string; bank?: PostBank }): express.Router {
  const { adminToken, bank } = deps;
  const db = asAsyncDatabase(deps.db);
  const router = express.Router();

  // Header for API calls, ?token= for downloads.
  router.use((req, res, next) => {
    // Session access identifiers and authenticated responses must not be cached.
    res.setHeader("Cache-Control", "no-store");
    const verdict = adminAccess(adminToken, {
      header: req.get("x-admin-token"),
      queryToken: typeof req.query.token === "string" ? req.query.token : undefined,
      remoteAddress: req.socket?.remoteAddress,
    });
    if (verdict === "ok") return next();
    if (verdict === "unauthorized")
      return void res.status(401).json({ error: "unauthorized", detail: "missing or invalid admin token" });
    res.status(403).json({ error: "forbidden", detail: "admin is only available on this computer unless ADMIN_TOKEN is set" });
  });

  router.get("/kpis", async (req, res) => {
    const protocol = req.query.protocolVersion ?? CURRENT_PROTOCOL;
    if (protocol !== "all" && protocol !== "legacy-full-v1" && protocol !== "calibrated-brief-v1" && protocol !== "calibrated-full-v1" && protocol !== "calibrated-media-full-v1") {
      return void res.status(400).json({ error: "validation", detail: "invalid protocolVersion" });
    }
    const kpis = await db.transaction(async () => computeKpis(db, new Date(), protocol))();
    res.setHeader("Cache-Control", "no-store");
    res.json(kpis);
  });

  router.get("/assignments/:pid", (req, res) => {
    if (!bank) return void res.status(503).json({ error: "unavailable", detail: "post bank not configured" });
    const raw = req.params.pid;
    const pid = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(pid) || pid < 1)
      return void res.status(400).json({ error: "validation", detail: "pid must be a positive integer" });
    res.json(assignShortFromBank(pid, bank));
  });

  router.get("/sessions", async (_req, res) => {
    const sessions = await db.transaction(async () => {
      const last = await lastActivityMap(db);
      return (await listSessions(db)).map((r) => ({
        ...r,
        lastActivityAt: (r as { lastActivityAt?: string | null }).lastActivityAt ?? last.get(r.sessionId) ?? null,
      }));
    })();
    res.json(sessions);
  });

  router.post("/sessions/:id/abandon", async (req, res) => {
    const outcome = await db.transaction(async () => {
      const s = await getSession(db, req.params.id);
      if (!s) return { error: "not_found" as const };
      if (s.status !== "in_progress") return { error: "conflict" as const, status: s.status };
      await setStatus(db, s.sessionId, "abandoned", new Date().toISOString());
      return { error: null };
    }).immediate();
    if (outcome.error === "not_found")
      return void res.status(404).json({ error: "not_found", detail: "session not found" });
    if (outcome.error === "conflict") {
      return void res
        .status(409)
        .json({ error: "conflict", detail: `only in_progress sessions can be abandoned (status: ${outcome.status})` });
    }
    res.status(204).end();
  });

  router.delete("/sessions/:id", async (req, res) => {
    const deleted = await db.transaction(async () => {
      const s = await getSession(db, req.params.id);
      if (!s) return false;
      await deleteSession(db, s.sessionId);
      return true;
    }).immediate();
    if (!deleted) return void res.status(404).json({ error: "not_found", detail: "session not found" });
    res.status(204).end();
  });

  router.get("/export", async (_req, res) => {
    const index = await db.transaction(async () => exportIndex(db))();
    res.setHeader("Cache-Control", "no-store");
    res.json(index);
  });

  router.get("/export/:name", async (req, res) => {
    const spec = Object.hasOwn(EXPORTS, req.params.name) ? EXPORTS[req.params.name] : undefined;
    if (!spec) return void res.status(404).json({ error: "not_found", detail: `unknown export: ${req.params.name}` });
    const data = await db.transaction(async () => spec.build(db))();
    const body = (spec.bom ? "﻿" : "") + data;
    res.setHeader("Content-Type", spec.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${exportFilename(req.params.name)}"`);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(Buffer.from(body, "utf8"));
  });

  return router;
}
