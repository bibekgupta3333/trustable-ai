// Participant session endpoints: /api/sessions/...
import express from "express";
import type Database from "better-sqlite3";
import { CURRENT_PROTOCOL } from "../../shared/types";
import type { Post, PostBank } from "../../shared/types";
import type { Cursor, SessionView, TrialSaved } from "../../shared/api";
import { assignShortFromBank } from "../../shared/counterbalance";
import { buildPresentation } from "../../shared/labelEngine";
import {
  getSession, getTrials, hashParticipantCode, incrementResume, insertBlockSurvey, insertEvents,
  insertExitSurvey, insertTrial, recordConsent, setStatus, startOrResumeSession, touchActivity, updateCursor,
} from "../db/repo";
import {
  HttpError, ValidationError, asObject, cursorAfterSurvey, cursorAfterTrial, deriveTrial, exitWithTimestamp,
  notFound, scoreBlockSurvey, TRUST_ITEM_IDS, validateBlockSurvey, validateCursor, validateEvents,
  normaliseParticipantCode, validateExitSurvey, validateTrialSubmission,
} from "./participant";

export interface SessionsDeps {
  db: Database.Database;
  bank: PostBank;
  appVersion: string;
  postBankHash: string;
  participantSalt: string; // HMAC key for participation codes
  staleMinutes: number;    // in_progress sessions idle longer than this are marked abandoned at the next self-start
}

export function sessionsRouter(deps: SessionsDeps): express.Router {
  const { db, bank, appVersion, postBankHash, participantSalt, staleMinutes } = deps;
  const router = express.Router();
  const postsById = new Map<string, Post>(bank.posts.map((p) => [p.id, p]));

  const load = (id: string): SessionView => {
    const s = getSession(db, id);
    if (!s) throw notFound("session not found");
    return s;
  };
  const loadActive = (id: string): SessionView => {
    const s = load(id);
    if (s.status !== "in_progress") throw new HttpError(409, "conflict", `session is ${s.status}`);
    return s;
  };
  const blockPlan = (s: SessionView, blockIndex: number) => {
    const plan = s.blocks.find((b) => b.blockIndex === blockIndex);
    if (!plan) throw notFound(`block ${blockIndex} not found`);
    return plan;
  };
  // Blocks' started_at / ended_at have no repo helper; set them here (first write wins).
  const markBlockStarted = db.prepare(
    "UPDATE blocks SET started_at = COALESCE(started_at, ?) WHERE session_id = ? AND block_index = ?",
  );
  const markBlockEnded = db.prepare(
    "UPDATE blocks SET ended_at = COALESCE(ended_at, ?) WHERE session_id = ? AND block_index = ?",
  );
  const countSurveys = db.prepare("SELECT COUNT(*) AS n FROM block_surveys WHERE session_id = ?");

  // Self-start: 201 new, 200 resume (same code, in_progress), 409 already_participated, 400 invalid.
  router.post("/", (req, res) => {
    const o = asObject(req.body);
    const code = normaliseParticipantCode(o.participantCode);
    if (o.consequenceBanner !== undefined && typeof o.consequenceBanner !== "boolean")
      throw new ValidationError("consequenceBanner must be a boolean");
    const result = startOrResumeSession(db, {
      participantHash: hashParticipantCode(participantSalt, code),
      staleMinutes,
      assign: (pid) => assignShortFromBank(pid, bank),
      opts: { protocolVersion: CURRENT_PROTOCOL, consequenceBanner: o.consequenceBanner === true, anxiety: false, postBankHash, appVersion },
    });
    switch (result.kind) {
      case "new": return void res.status(201).json(result.session);
      case "resumed": return void res.status(200).json(result.session);
      case "already_participated": throw new HttpError(409, "already_participated");
      case "full": throw new HttpError(503, "no_pid_available", "all participant ids 1-899 are in use");
    }
  });

  router.get("/:id", (req, res) => {
    res.json(load(req.params.id));
  });

  router.post("/:id/resume", (req, res) => {
    const s = loadActive(req.params.id);
    incrementResume(db, s.sessionId);
    touchActivity(db, s.sessionId);
    res.json(load(s.sessionId));
  });

  // Voluntary participant exit; saved responses remain, and repeat exit requests are safe.
  router.post("/:id/cancel", (req, res) => {
    const s = load(req.params.id);
    if (s.status === "completed") throw new HttpError(409, "conflict", "session is completed");
    db.transaction(() => {
      if (s.status === "in_progress") setStatus(db, s.sessionId, "abandoned", new Date().toISOString());
      updateCursor(db, s.sessionId, { ...s.cursor, phase: "done" });
      touchActivity(db, s.sessionId);
    })();
    res.json(load(s.sessionId));
  });

  router.post("/:id/consent", (req, res) => {
    const s = loadActive(req.params.id);
    if (!s.consentAt) recordConsent(db, s.sessionId, new Date().toISOString());
    if (s.cursor.phase === "consent") updateCursor(db, s.sessionId, { blockIndex: 1, positionInBlock: 1, phase: "instructions" });
    touchActivity(db, s.sessionId);
    res.json(load(s.sessionId));
  });

  router.get("/:id/presentation/:block/:pos", (req, res) => {
    const s = load(req.params.id);
    const block = Number(req.params.block);
    const pos = Number(req.params.pos);
    if (!Number.isInteger(block) || block < 1 || block > 4 || !Number.isInteger(pos) || pos < 1)
      throw notFound("block or position out of range");
    const plan = blockPlan(s, block);
    if (pos > plan.postOrder.length) throw notFound("position out of range for block plan");
    const post = postsById.get(plan.postOrder[pos - 1]);
    if (!post) throw notFound("post not found in bank");
    res.json(buildPresentation(post, plan.condition, { contextMedia: s.protocolVersion === "calibrated-media-full-v1" }));
  });

  router.post("/:id/trials", (req, res) => {
    const s = loadActive(req.params.id);
    const sub = validateTrialSubmission(req.body);
    const plan = blockPlan(s, sub.blockIndex);
    if (sub.positionInBlock > plan.postOrder.length)
      throw new ValidationError("positionInBlock is outside the saved block plan");
    const post = postsById.get(plan.postOrder[sub.positionInBlock - 1]);
    if (!post) throw new HttpError(500, "invariant", "planned post missing from bank");
    const offset = s.blocks.filter((b) => b.blockIndex < sub.blockIndex).reduce((n, b) => n + b.postOrder.length, 0);
    const trial = deriveTrial(s.pid, plan, post, sub, offset);
    const cursor = cursorAfterTrial(sub.blockIndex, sub.positionInBlock, plan.postOrder.length);
    db.transaction(() => {
      insertTrial(db, s.sessionId, trial); // ConflictError on duplicate -> 409
      markBlockStarted.run(trial.labelShownAt, s.sessionId, trial.blockIndex);
      if (trial.positionInBlock === plan.postOrder.length) markBlockEnded.run(trial.respondedAt, s.sessionId, trial.blockIndex);
      updateCursor(db, s.sessionId, cursor);
      touchActivity(db, s.sessionId);
    })();
    const out: TrialSaved = { trialId: trial.trialId, cursor };
    res.status(201).json(out);
  });

  router.post("/:id/events", (req, res) => {
    const s = load(req.params.id);
    let body: unknown = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        throw new ValidationError("events body is not valid JSON");
      }
    }
    const evs = validateEvents(body);
    const inserted = evs.length ? insertEvents(db, s.sessionId, evs) : 0;
    if (s.status === "in_progress") touchActivity(db, s.sessionId);
    res.json({ inserted });
  });

  router.put("/:id/cursor", (req, res) => {
    const s = loadActive(req.params.id);
    const cursor = validateCursor(req.body);
    if (cursor.positionInBlock > blockPlan(s, cursor.blockIndex).postOrder.length)
      throw new ValidationError("positionInBlock is outside the saved block plan");
    updateCursor(db, s.sessionId, cursor);
    touchActivity(db, s.sessionId);
    res.status(204).end();
  });

  router.post("/:id/block-surveys", (req, res) => {
    const s = loadActive(req.params.id);
    const sub = validateBlockSurvey(req.body);
    const expected = s.protocolVersion === "calibrated-brief-v1" ? "brief-v1" : "full-v1";
    if ((sub.questionnaireVersion ?? "full-v1") !== expected)
      throw new ValidationError(`questionnaireVersion must be ${expected} for the stored session protocol`);
    const plan = blockPlan(s, sub.blockIndex);
    const blockTrials = getTrials(db, s.sessionId).filter((t) => t.blockIndex === sub.blockIndex);
    if (blockTrials.length !== plan.postOrder.length)
      throw new ValidationError(`block ${sub.blockIndex} has ${blockTrials.length} of ${plan.postOrder.length} trials saved`);
    const survey = scoreBlockSurvey(sub, plan.condition, blockTrials, TRUST_ITEM_IDS, new Date().toISOString());
    const cursor = cursorAfterSurvey(sub.blockIndex, plan.postOrder.length);
    db.transaction(() => {
      insertBlockSurvey(db, s.sessionId, survey); // ConflictError on duplicate -> 409
      updateCursor(db, s.sessionId, cursor);
      touchActivity(db, s.sessionId);
    })();
    res.status(201).json({ nWrongDetected: survey.nWrongDetected, cursor });
  });

  router.post("/:id/exit-survey", (req, res) => {
    const s = loadActive(req.params.id);
    const sub = validateExitSurvey(req.body);
    const n = (countSurveys.get(s.sessionId) as { n: number }).n;
    if (n !== 4) throw new ValidationError(`${n} of 4 block surveys saved`);
    const now = new Date().toISOString();
    db.transaction(() => {
      insertExitSurvey(db, s.sessionId, exitWithTimestamp(sub, now));
      setStatus(db, s.sessionId, "completed", now);
      updateCursor(db, s.sessionId, { blockIndex: 4, positionInBlock: blockPlan(s, 4).postOrder.length as Cursor["positionInBlock"], phase: "done" });
      touchActivity(db, s.sessionId, now);
    })();
    res.json(load(s.sessionId));
  });

  return router;
}
