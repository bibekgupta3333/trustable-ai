import express from "express";
import type Database from "better-sqlite3";
import { getSession, listSessions, setStatus, deleteSession } from "../db/repo";
import {
  trialsCsv, surveysCsv, eventsCsv, exitCsv, sessionsJson, participantsCsv, kpisCsv, exportIndex,
} from "../export/exporters";
import { CURRENT_PROTOCOL, type PostBank } from "../../shared/types";
import { assignShortFromBank } from "../../shared/counterbalance";
import { computeKpis } from "../kpi";

type Exporter = (db: Database.Database) => string;

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

/** session_id -> last_activity_at, read only if the column exists (added by the v2 migration). */
function lastActivityMap(db: Database.Database): Map<string, string | null> {
  const cols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "last_activity_at")) return new Map();
  const rows = db.prepare("SELECT session_id, last_activity_at FROM sessions").all() as {
    session_id: string;
    last_activity_at: string | null;
  }[];
  return new Map(rows.map((r) => [r.session_id, r.last_activity_at ?? null]));
}

export function adminRouter(deps: { db: Database.Database; adminToken?: string; bank?: PostBank }): express.Router {
  const { db, adminToken, bank } = deps;
  const router = express.Router();

  // Header for API calls, ?token= for downloads.
  router.use((req, res, next) => {
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

  router.get("/kpis", (req, res) => {
    const protocol = req.query.protocolVersion ?? CURRENT_PROTOCOL;
    if (protocol !== "all" && protocol !== "legacy-full-v1" && protocol !== "calibrated-brief-v1" && protocol !== "calibrated-full-v1" && protocol !== "calibrated-media-full-v1") {
      return void res.status(400).json({ error: "validation", detail: "invalid protocolVersion" });
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(computeKpis(db, new Date(), protocol));
  });

  router.get("/assignments/:pid", (req, res) => {
    if (!bank) return void res.status(503).json({ error: "unavailable", detail: "post bank not configured" });
    const raw = req.params.pid;
    const pid = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(pid) || pid < 1)
      return void res.status(400).json({ error: "validation", detail: "pid must be a positive integer" });
    res.json(assignShortFromBank(pid, bank));
  });

  router.get("/sessions", (_req, res) => {
    const last = lastActivityMap(db);
    res.json(
      listSessions(db).map((r) => ({
        ...r,
        lastActivityAt: (r as { lastActivityAt?: string | null }).lastActivityAt ?? last.get(r.sessionId) ?? null,
      })),
    );
  });

  router.post("/sessions/:id/abandon", (req, res) => {
    const s = getSession(db, req.params.id);
    if (!s) return void res.status(404).json({ error: "not_found", detail: "session not found" });
    if (s.status !== "in_progress") {
      return void res
        .status(409)
        .json({ error: "conflict", detail: `only in_progress sessions can be abandoned (status: ${s.status})` });
    }
    setStatus(db, s.sessionId, "abandoned", new Date().toISOString());
    res.status(204).end();
  });

  router.delete("/sessions/:id", (req, res) => {
    const s = getSession(db, req.params.id);
    if (!s) return void res.status(404).json({ error: "not_found", detail: "session not found" });
    deleteSession(db, s.sessionId);
    res.status(204).end();
  });

  router.get("/export", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(exportIndex(db));
  });

  router.get("/export/:name", (req, res) => {
    const spec = Object.hasOwn(EXPORTS, req.params.name) ? EXPORTS[req.params.name] : undefined;
    if (!spec) return void res.status(404).json({ error: "not_found", detail: `unknown export: ${req.params.name}` });
    const body = (spec.bom ? "﻿" : "") + spec.build(db);
    res.setHeader("Content-Type", spec.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${exportFilename(req.params.name)}"`);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(Buffer.from(body, "utf8"));
  });

  return router;
}
