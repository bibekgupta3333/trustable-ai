/**
 * TrialScreen: one fast screen per post (CONTRACT-v2 §C).
 * Flow: presentation (prefetched when possible) → 800 ms "AI is checking…" → label + condition
 * view (trial_shown) → Agree/Disagree → confidence chips on the same screen → 1 s "Saving… Undo"
 * → submit → navigate by the returned cursor. "Change" re-opens Agree/Disagree until a chip is
 * picked; the payload carries the final decision and its timer snapshot only.
 *
 * Keys: A agree · D disagree · 1–7 confidence · F fact sheet · W Why? (C only) · Esc close sheet.
 *
 * CSS classes:
 *   .trial-screen, .trial-screen--sheet-open   <main>
 *   .trial__top            top bar (heading + ProgressBar)
 *   .trial-header          "Part x of 4 · Post y of 6" heading
 *   .trial-loading, .trial-error, .trial-saving
 *   .trial-layout, .trial-main, .explanation-area, .consequence-banner, .decision-buttons
 *   .trial__decide         one Agree/Disagree button (also --agree / --disagree)
 *   .trial__decision       wrapper for the chosen line + confidence chips (slides in)
 *   .trial__choice         "You chose: Agree ✓ · Change" line
 *   .trial__choice-value   the chosen word
 *   .trial__change         "Change" link-style button
 *   .kbd-hint              keyboard shortcut hint line
 *   (also uses .progress* from ProgressBar and .confidence-chips* from PostRatingStrip)
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import { useStudy, routeForCursor } from "../state/StudyContext";
import { useLogger } from "../logging/logger";
import { useTrialTimer } from "../logging/useTrialTimer";
import type { TimerSnapshot } from "../logging/useTrialTimer";
import PostCard from "../components/PostCard";
import LabelPanel from "../components/LabelPanel";
import FactSheetPanel from "../components/FactSheetPanel";
import PostRatingStrip, { type PostRatingStripHandle } from "../components/PostRatingStrip";
import ProgressBar from "../components/ProgressBar";
import { conditionRegistry } from "../conditions/conditionRegistry";
import surveyItemsRaw from "../../shared/data/surveyItems.json";
import type { EventType, FactorKey, Likert7, Presentation, SurveyItems } from "../../shared/types";
import type { Cursor, EventSubmission, TrialSubmission } from "../../shared/api";

export const CHECKING_MS = 800;
export const POSTS_PER_BLOCK = 6;
export const TOTAL_POSTS = 24;
const BANNER_TEXT = "Posts you agree are accurate stay visible to other users";
const confidenceItem = (surveyItemsRaw as unknown as SurveyItems).confidence;
const CONFIDENCE_PROMPT = "How sure are you?";
const CONFIDENCE_MIN = "Not at all sure";
const CONFIDENCE_MAX = "Completely sure";

const PART_HELP = {
  A: { label: "Label only", hint: "This part shows the AI label without an explanation beneath it." },
  B: { label: "Fixed reason", hint: "This part shows a short, fixed reason beneath each AI label." },
  C: { label: "Explore with Why?", hint: "This part has a Why? button. You can open it, then expand Source, Claim vs record or Wording independently." },
  D: { label: "What-if explanation", hint: "This part shows a what-if sentence describing a change that would lead to a different label." },
};

/** Shared help mechanism; dismissal lasts for this part, without changing trial state. */
function PartHelp({ condition, position }: { condition: Presentation["condition"]; position: number }) {
  const [open, setOpen] = useState(true);
  const help = PART_HELP[condition];
  if (position > 2) return null;
  return (
    <aside className="trial-help" aria-label="Help for this part">
      <div className="trial-help__header">
        <span>This part: <strong>{help.label}</strong></span>
        <button type="button" aria-expanded={open} aria-controls="trial-part-help" onClick={() => setOpen(!open)}>
          {open ? "Hide help" : "Show help"}
        </button>
      </div>
      <div id="trial-part-help" hidden={!open}>
        <p>{help.hint}</p>
        <p>Read at your own pace. The fact sheet is optional. Choose Agree or Disagree with the label, then how sure you are.</p>
      </div>
    </aside>
  );
}

type Phase = "loading" | "checking" | "shown" | "rating" | "submitting" | "error";

interface Decision {
  agreed: boolean;
  snapshot: TimerSnapshot;
}

type BlockIdx = 1 | 2 | 3 | 4;
type PosIdx = 1 | 2 | 3 | 4 | 5 | 6;

// ---------- prefetch cache (module level; only within a block, never across the survey) ----------
interface CacheEntry {
  promise: Promise<Presentation>;
  value?: Presentation;
}
const presentationCache = new Map<string, CacheEntry>();
const MAX_CACHE = 4;
const cacheKey = (sessionId: string, block: number, pos: number) => `${sessionId}/${block}/${pos}`;

function prefetchPresentation(sessionId: string, block: number, pos: number) {
  const key = cacheKey(sessionId, block, pos);
  if (presentationCache.has(key)) return;
  while (presentationCache.size >= MAX_CACHE) {
    const oldest = presentationCache.keys().next().value;
    if (oldest === undefined) break;
    presentationCache.delete(oldest);
  }
  const entry: CacheEntry = { promise: api.getPresentation(sessionId, block, pos) };
  entry.promise.then(
    (p) => {
      entry.value = p;
    },
    () => {
      if (presentationCache.get(key) === entry) presentationCache.delete(key);
    },
  );
  presentationCache.set(key, entry);
}

/** Takes (and removes) a cached presentation, if one was prefetched. */
function takeCached(sessionId: string, block: number, pos: number): CacheEntry | undefined {
  const key = cacheKey(sessionId, block, pos);
  const entry = presentationCache.get(key);
  if (entry) presentationCache.delete(key);
  return entry;
}

/** Test helper. */
export function clearPresentationCache() {
  presentationCache.clear();
}

function parseIndex(raw: string | undefined, max: number): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

function errorStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status: unknown }).status;
    return typeof s === "number" ? s : undefined;
  }
  return undefined;
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (t as HTMLInputElement).type;
    return !["radio", "checkbox", "button", "submit", "reset", "range"].includes(type);
  }
  return false;
}

export default function TrialScreen() {
  const params = useParams();
  const navigate = useNavigate();
  const study = useStudy();
  const logger = useLogger();
  const timer = useTrialTimer();

  const session = study.session;
  const sessionId = session?.sessionId ?? null;
  const blockIndex = parseIndex(params.block, 4) as BlockIdx | null;
  const blockPlan = session?.blocks.find((block) => block.blockIndex === blockIndex);
  const postsInBlock = blockPlan?.postOrder.length ?? 0;
  const totalPosts = session?.blocks.reduce((total, block) => total + block.postOrder.length, 0) ?? 0;
  const position = parseIndex(params.pos, postsInBlock) as PosIdx | null;
  const resumed = Boolean(study.state.resumed);

  const [presentation, setPresentation] = useState<Presentation | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorKind, setErrorKind] = useState<"load" | "submit" | null>(null);
  const [labelReady, setLabelReady] = useState(false); // true once trial_shown is logged
  const [factSheetOpen, setFactSheetOpen] = useState(false);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [chipPending, setChipPending] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);

  const shownPerfRef = useRef<number | null>(null);
  const decidedRef = useRef(false);
  const submittingRef = useRef(false);
  const pendingRef = useRef<TrialSubmission | null>(null);
  const factSheetOpenRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const stripRef = useRef<PostRatingStripHandle | null>(null);

  // Keep the latest helpers in refs so effects don't re-run when their identity changes.
  const timerRef = useRef(timer);
  timerRef.current = timer;
  const loggerRef = useRef(logger);
  loggerRef.current = logger;

  const trialId = session && blockIndex && position ? `${session.pid}-${blockIndex}-${position}` : null;

  const logEvent = useCallback(
    (type: EventType, factorKey: FactorKey | null = null) => {
      const lg = loggerRef.current;
      if (!lg) return;
      const tMs = shownPerfRef.current === null ? null : Math.round(performance.now() - shownPerfRef.current);
      const ev: Omit<EventSubmission, "seq" | "perfNow" | "wallClock"> = {
        trialId,
        blockIndex,
        condition: presentation?.condition ?? null,
        postId: presentation?.postId ?? null,
        type,
        factorKey,
        tMs,
      };
      lg.log(ev);
    },
    [trialId, blockIndex, presentation],
  );

  // Reset everything and load the presentation for each post.
  useEffect(() => {
    if (!sessionId || !blockIndex || !position) return;
    let cancelled = false;
    timerRef.current.reset();
    shownPerfRef.current = null;
    decidedRef.current = false;
    submittingRef.current = false;
    pendingRef.current = null;
    factSheetOpenRef.current = false;
    setDecision(null);
    setChipPending(false);
    setLabelReady(false);
    setFactSheetOpen(false);
    setErrorKind(null);
    headingRef.current?.focus();

    let checkTimer: ReturnType<typeof setTimeout> | undefined;
    const startChecking = (p: Presentation) => {
      setPresentation(p);
      setPhase("checking");
      checkTimer = setTimeout(() => {
        if (!cancelled) setPhase("shown");
      }, CHECKING_MS);
    };
    const fail = () => {
      if (cancelled) return;
      setErrorKind("load");
      setPhase("error");
    };
    const fetchFresh = () =>
      api
        .getPresentation(sessionId, blockIndex, position)
        .then((p) => {
          if (!cancelled) startChecking(p);
        })
        .catch(fail);

    const cached = loadNonce === 0 ? takeCached(sessionId, blockIndex, position) : undefined;
    if (cached?.value) {
      startChecking(cached.value); // instant: no "Loading…" flash
    } else {
      setPresentation(null);
      setPhase("loading");
      if (cached) {
        cached.promise.then(
          (p) => {
            if (!cancelled) startChecking(p);
          },
          () => {
            if (!cancelled) void fetchFresh();
          },
        );
      } else {
        void fetchFresh();
      }
    }
    return () => {
      cancelled = true;
      if (checkTimer) clearTimeout(checkTimer);
    };
  }, [sessionId, blockIndex, position, loadNonce]);

  // After the label paints, start the clock and log trial_shown.
  useEffect(() => {
    if (phase !== "shown" || labelReady) return;
    let done = false;
    const raf = requestAnimationFrame(() => {
      if (done) return;
      timerRef.current.markShown();
      shownPerfRef.current = performance.now();
      // Part 1 logs block_start from InstructionsScreen; parts 2-4 start on their first post.
      if (position === 1 && blockIndex !== null && blockIndex > 1) logEvent("block_start");
      logEvent("trial_shown");
      setLabelReady(true);
      // Prefetch the next post in the same block (never across the block survey).
      if (sessionId && blockIndex && position && position < postsInBlock) {
        prefetchPresentation(sessionId, blockIndex, position + 1);
      }
    });
    return () => {
      done = true;
      cancelAnimationFrame(raf);
    };
  }, [phase, labelReady, logEvent, sessionId, blockIndex, position, postsInBlock]);

  const onFactSheetToggle = (open: boolean) => {
    if (!labelReady || decidedRef.current) return;
    if (open === factSheetOpenRef.current) return;
    factSheetOpenRef.current = open;
    setFactSheetOpen(open);
    timer.onFactSheet(open);
    logEvent(open ? "fact_sheet_open" : "fact_sheet_close");
  };

  const onWhy = (open: boolean) => {
    if (!labelReady || decidedRef.current) return;
    timer.onWhy(open);
    logEvent(open ? "why_open" : "why_close");
  };

  const onFactorToggle = (key: FactorKey, expanded: boolean) => {
    if (!labelReady || decidedRef.current) return;
    if (expanded) timer.onFactorExpand(key);
    logEvent(expanded ? "factor_expand" : "factor_collapse", key);
  };

  const decide = (agreed: boolean) => {
    // Synchronous lock: the first click wins, anything before trial_shown is ignored.
    if (decidedRef.current || shownPerfRef.current === null) return;
    decidedRef.current = true;
    if (factSheetOpenRef.current) {
      factSheetOpenRef.current = false;
      timer.onFactSheet(false);
      setFactSheetOpen(false);
    }
    const snapshot = timer.snapshot();
    logEvent(agreed ? "decision_agree" : "decision_disagree");
    setDecision({ agreed, snapshot });
    setPhase("rating");
  };

  /** Re-opens Agree/Disagree before a confidence chip is chosen. The next decision replaces this one. */
  const changeDecision = () => {
    if (!decidedRef.current || chipPending || pendingRef.current || submittingRef.current) return;
    decidedRef.current = false;
    setDecision(null);
    setPhase("shown");
  };

  const submit = async (payload: TrialSubmission) => {
    if (!sessionId || submittingRef.current) return;
    submittingRef.current = true;
    setPhase("submitting");
    setErrorKind(null);
    try {
      let cursor: Cursor;
      try {
        const saved = await api.submitTrial(sessionId, payload);
        cursor = saved.cursor;
      } catch (err) {
        // 409: this trial was already saved (e.g. an earlier attempt reached the server).
        if (errorStatus(err) === 409) {
          cursor = (await api.getSession(sessionId)).cursor;
        } else {
          throw err;
        }
      }
      try {
        await loggerRef.current?.flush();
      } catch {
        // events stay buffered and are retried by the logger
      }
      pendingRef.current = null;
      study.dispatch({ type: "CURSOR_CHANGED", cursor });
      navigate(routeForCursor(cursor));
    } catch {
      submittingRef.current = false;
      setErrorKind("submit");
      setPhase("error");
    }
  };

  const onConfidence = (confidence: Likert7) => {
    if (!decision || !presentation || !blockIndex || !position || pendingRef.current) return;
    const s = decision.snapshot;
    const isC = presentation.condition === "C";
    const payload: TrialSubmission = {
      blockIndex,
      positionInBlock: position,
      postId: presentation.postId,
      agreed: decision.agreed,
      confidence,
      labelShownAt: s.labelShownAt,
      respondedAt: s.respondedAt,
      decisionTimeRawMs: s.decisionTimeRawMs,
      hiddenMs: s.hiddenMs,
      hiddenCount: s.hiddenCount,
      blurCount: s.blurCount,
      factSheetOpened: s.factSheetOpened,
      factSheetOpenMs: s.factSheetOpenMs,
      explanationOpened: isC ? s.explanationOpened : null,
      factorsExpanded: isC ? s.factorsExpanded : [],
      timeToFirstExpandMs: isC ? s.timeToFirstExpandMs : null,
      resumed,
    };
    pendingRef.current = payload;
    void submit(payload);
  };

  const retry = () => {
    if (errorKind === "submit" && pendingRef.current) {
      void submit(pendingRef.current);
    } else {
      setLoadNonce((n) => n + 1);
    }
  };

  // Keyboard shortcuts. The handler is refreshed every render; the listener is added once.
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    // Dialog actions (including Exit study) must not answer the trial behind them.
    if (e.target instanceof Element && e.target.closest('dialog, [role="dialog"], [role="alertdialog"]')) return;
    if (!labelReady || phase === "submitting" || phase === "loading" || phase === "checking") return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === "Escape") {
      if (factSheetOpenRef.current) onFactSheetToggle(false);
      return;
    }
    if (phase === "error") return;
    if (!decidedRef.current) {
      if (key === "a") {
        e.preventDefault();
        decide(true);
      } else if (key === "d") {
        e.preventDefault();
        decide(false);
      } else if (key === "f") {
        e.preventDefault();
        onFactSheetToggle(!factSheetOpenRef.current);
      } else if (key === "w" && presentation?.condition === "C") {
        e.preventDefault();
        mainRef.current?.querySelector<HTMLButtonElement>(".why-button")?.click();
      }
      return;
    }
    if (phase === "rating" && /^[1-7]$/.test(key)) {
      e.preventDefault();
      stripRef.current?.choose(Number(key) as Likert7);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!blockIndex || !position) {
    return <main className="trial-screen"><p role="alert">This page does not exist.</p></main>;
  }

  const header = `Part ${blockIndex} of 4 · Post ${position} of ${postsInBlock}`;
  const overall = (session?.blocks.reduce((total, block) =>
    block.blockIndex < blockIndex ? total + block.postOrder.length : total, 0) ?? 0) + position;
  const View = presentation ? conditionRegistry[presentation.condition] : null;
  const labelVisible = phase !== "loading" && phase !== "checking" && !(phase === "error" && errorKind === "load");
  const isC = presentation?.condition === "C";
  const hint = `Keys: A agree · D disagree · 1–7 confidence · F fact sheet${isC ? " · W why" : ""}`;

  return (
    <main ref={mainRef} className={`trial-screen${factSheetOpen ? " trial-screen--sheet-open" : ""}`}>
      <div className="trial__top">
        <h1 className="trial-header" tabIndex={-1} ref={headingRef}>
          {header}
        </h1>
        <ProgressBar current={overall} total={totalPosts} label={`Post ${overall} of ${totalPosts}`} />
      </div>

      {phase === "loading" && <p className="trial-loading">Loading…</p>}

      {phase === "error" && (
        <div className="trial-error" role="alert">
          <p>
            {errorKind === "submit"
              ? "Your answer could not be saved. Check your connection and try again."
              : "The post could not be loaded. Check your connection and try again."}
          </p>
          <button type="button" onClick={retry}>
            Retry
          </button>
        </div>
      )}

      {presentation && (
        <div className="trial-layout">
          <div className="trial-main">
            <PartHelp key={`${sessionId}/${blockIndex}`} condition={presentation.condition} position={position} />
            <PostCard
              author={presentation.author}
              text={presentation.text}
              postedAgo={presentation.postedAgo}
              likes={presentation.likes}
              reposts={presentation.reposts}
              image={presentation.image}
            />
            <LabelPanel label={presentation.aiLabel} checking={!labelVisible} />
            <div className="explanation-area">
              {labelVisible && View && (
                <View presentation={presentation} onWhy={onWhy} onFactorToggle={onFactorToggle} />
              )}
            </div>
            <FactSheetPanel
              factSheet={presentation.factSheet}
              open={factSheetOpen}
              onToggle={onFactSheetToggle}
              disabled={!labelReady || decision !== null}
            />
            {session?.consequenceBanner && <p className="consequence-banner">ⓘ {BANNER_TEXT}</p>}
            {!decision && (
              <div className="decision-buttons">
                <button
                  type="button"
                  className="trial__decide trial__decide--agree"
                  disabled={!labelReady}
                  onClick={() => decide(true)}
                >
                  Agree with label
                </button>
                <button
                  type="button"
                  className="trial__decide trial__decide--disagree"
                  disabled={!labelReady}
                  onClick={() => decide(false)}
                >
                  Disagree with label
                </button>
              </div>
            )}
            {decision && (
              <div className="trial__decision">
                <p className="trial__choice">
                  You chose: <span className="trial__choice-value">{decision.agreed ? "Agree" : "Disagree"}</span> ✓
                  {phase === "rating" && !chipPending && (
                    <>
                      {" · "}
                      <button type="button" className="trial__change" onClick={changeDecision}>
                        Change
                      </button>
                    </>
                  )}
                </p>
                {phase === "rating" && (
                  <PostRatingStrip
                    ref={stripRef}
                    mode="chips"
                    autoSubmit
                    item={confidenceItem}
                    label={CONFIDENCE_PROMPT}
                    minLabel={CONFIDENCE_MIN}
                    maxLabel={CONFIDENCE_MAX}
                    onChange={() => logEvent("confidence_submit")}
                    onPendingChange={setChipPending}
                    onSubmit={onConfidence}
                  />
                )}
                {phase === "submitting" && <p className="trial-saving">Saving…</p>}
              </div>
            )}
            {labelReady && phase !== "submitting" && (
              <p className="kbd-hint" aria-hidden="true">
                {hint}
              </p>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
