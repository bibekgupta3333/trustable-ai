import express from "express";
import type { ErrorRequestHandler } from "express";
import { asAsyncDatabase, type DatabaseInput } from "./db/async.js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PostBank } from "../shared/types.js";
import { postBankHash } from "../shared/labelEngine.js";
import { ConflictError, participantSalt as resolveParticipantSalt } from "./db/repo.js";
import { adminRouter } from "./routes/admin.js";
import { HttpError, ValidationError, participantRouter } from "./routes/participant.js";
import { sessionsRouter } from "./routes/sessions.js";
import { safeErrorDetails, safeRequestDetails } from "./errors.js";

export interface AppDeps {
  db: DatabaseInput;
  bank: PostBank;
  appVersion: string;
  adminToken?: string;
  staticDir?: string;
  participantSalt?: string; // env PARTICIPANT_SALT; when unset a salt is generated once into meta.participant_salt
  staleMinutes?: number;    // env STALE_MINUTES (default 120)
}

export const DEFAULT_STALE_MINUTES = 120;

export async function createApp(deps: AppDeps): Promise<express.Express> {
  const { bank, appVersion, adminToken, staticDir } = deps;
  const db = asAsyncDatabase(deps.db);
  const hash = postBankHash(bank);
  const salt = await resolveParticipantSalt(db, deps.participantSalt);
  const staleMinutes = deps.staleMinutes ?? DEFAULT_STALE_MINUTES;
  const app = express();
  app.disable("x-powered-by");

  app.use(express.json({ limit: "2mb" }));
  app.use(express.text({ type: "text/plain", limit: "2mb" })); // navigator.sendBeacon for events

  const api = express.Router();
  api.use("/", participantRouter({ db, bank, appVersion, postBankHash: hash }));
  api.use("/sessions", sessionsRouter({ db, bank, appVersion, postBankHash: hash, participantSalt: salt, staleMinutes }));
  api.use("/admin", adminRouter({ db, bank, adminToken }));
  api.use((req, res) => {
    res.status(404).json({ error: "not_found", detail: `no route for ${req.method} ${req.originalUrl}` });
  });
  app.use("/api", api);

  if (staticDir) {
    const dir = resolve(staticDir);
    app.use(express.static(dir, { index: false }));
    const indexHtml = join(dir, "index.html");
    app.use((req, res, next) => {
      if ((req.method !== "GET" && req.method !== "HEAD") || !existsSync(indexHtml)) return next();
      res.sendFile(indexHtml);
    });
  }

  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    void _next;
    if (res.headersSent) return;
    if (err instanceof ConflictError) return void res.status(409).json({ error: "conflict", detail: err.message });
    if (err instanceof ValidationError) return void res.status(400).json({ error: "validation", detail: err.detail });
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.error, detail: err.detail });
    const e = err as { type?: string; status?: number; message?: string };
    if (e?.type === "entity.parse.failed" || e?.status === 400)
      return void res.status(400).json({ error: "validation", detail: "malformed request body" });
    if (e?.type === "entity.too.large") return void res.status(413).json({ error: "too_large" });
    console.error("Unhandled API request error", { ...safeErrorDetails(err), ...safeRequestDetails(req) });
    res.status(500).json({ error: "internal" });
  };
  app.use(onError);

  return app;
}
