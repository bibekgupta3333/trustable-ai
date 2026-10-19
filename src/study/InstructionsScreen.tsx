// Instructions + inline practice post (wireframes.md §2–3; CONTRACT-v2 §C). One short screen:
// 3 bullets built from the stimuli.md §2 sentences (verbatim where they carry meaning), a keyboard
// hint, and the practice post in part 1's condition. It never says that labels may be wrong beyond
// the stimuli.md definition of Disagree. No reading lock. The practice post is never saved as a
// trial (events only, trialId null). "Start part 1" appears once a practice decision is made.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useStudy } from "../state/StudyContext";
import { useLogger } from "../logging/logger";
import PostCard from "../components/PostCard";
import LabelPanel from "../components/LabelPanel";
import FactSheetPanel from "../components/FactSheetPanel";
import { conditionRegistry } from "../conditions/conditionRegistry";
import type { PracticePresentation } from "../../shared/api";
import type { Condition, EventType, Presentation } from "../../shared/types";

const CONTEXT_IMAGE_SOURCES = [
  "/post-images/environment.png",
  "/post-images/public-services.png",
  "/post-images/local-events.png",
];

function practiceAsPresentation(p: PracticePresentation, condition: Condition): Presentation {
  return {
    postId: p.id,
    condition,
    author: p.author,
    text: p.text,
    postedAgo: p.postedAgo,
    likes: p.likes,
    reposts: p.reposts,
    ...(p.image ? { image: p.image } : {}),
    factSheet: p.factSheet,
    aiLabel: p.aiLabel,
    ...(condition === "B" ? { staticExplanation: p.staticExplanation } : {}),
    ...(condition === "C" ? { factors: p.factors } : {}),
    ...(condition === "D" ? { counterfactualExplanation: p.counterfactualExplanation } : {}),
  };
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

export default function InstructionsScreen() {
  const { session, advance } = useStudy();
  const totalPosts = session?.blocks.reduce((total, block) => total + block.postOrder.length, 0) || 8;
  const postsPerPart = session?.blocks.map((block) => block.postOrder.length) ?? [2, 2, 2, 2];
  const partCount = postsPerPart.length || 4;
  const partSizes = postsPerPart.length && postsPerPart.every((size) => size === postsPerPart[0])
    ? `${postsPerPart[0]} posts each`
    : `${postsPerPart.join(", ")} posts in the respective parts`;
  const logger = useLogger();
  const navigate = useNavigate();
  const [practice, setPractice] = useState<PracticePresentation | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [factSheetOpen, setFactSheetOpen] = useState(false);
  const [choice, setChoice] = useState<"agree" | "disagree" | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const part1Condition: Condition = session?.conditionOrder[0] ?? "A";

  function log(type: EventType, withBlock = false) {
    logger?.log({
      trialId: null,
      blockIndex: withBlock ? 1 : null,
      condition: withBlock ? part1Condition : null,
      postId: withBlock ? null : "practice-01",
      type, factorKey: null, tMs: null,
    });
  }

  useEffect(() => {
    if (started.current) return; // StrictMode double effect: load + log once
    started.current = true;
    log("practice_start");
    api.getPractice(session?.protocolVersion === "calibrated-media-full-v1").then(setPractice, () => setLoadError(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (session?.protocolVersion !== "calibrated-media-full-v1") return;
    // Warm the three shared assets without waiting for load/decode or gating participation.
    const hints = CONTEXT_IMAGE_SOURCES.map((src) => {
      const hint = document.createElement("link");
      hint.rel = "preload";
      hint.setAttribute("as", "image");
      hint.href = src;
      hint.setAttribute("fetchpriority", "low");
      document.head.appendChild(hint);
      return hint;
    });
    return () => hints.forEach((hint) => hint.remove());
  }, [session?.protocolVersion]);

  useEffect(() => {
    if (!practice) return;
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "a") setChoice("agree");
      else if (k === "d") setChoice("disagree");
      else if (k === "f") setFactSheetOpen((v) => !v);
      else if (k === "escape") setFactSheetOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [practice]);

  async function startPart1() {
    if (busy) return;
    setBusy(true);
    log("practice_complete");
    log("block_start", true);
    try {
      await advance({ blockIndex: 1, positionInBlock: 1, phase: "trial" });
      navigate("/trial/1/1");
    } catch {
      setBusy(false);
    }
  }

  const Explanation = conditionRegistry[part1Condition];
  const canStart = choice !== null || loadError;

  return (
    <main className="screen instructions-screen">
      <h1>How this study works</h1>
      <ul className="instructions-list">
        <li>
          You will read {totalPosts} short social media posts from Riverton, a small town in Alder County.
          The town, the people and the accounts are all made up for this study. An AI tool has read
          each post and given it an <strong>AI label</strong>: <strong>✓ Likely accurate</strong>{" "}
          (the AI judges that the post's claim is correct) or <strong>⚠ Likely misleading</strong>{" "}
          (the AI judges that the post's claim is not correct). In some parts of the study, the
          label comes with an explanation from the AI.
        </li>
        <li>
          Every post also has a <strong>fact sheet</strong>: the official town or county record on
          the topic. Open it at any time with the <strong>Fact sheet ▸</strong> button. It is the
          same in every part of the study.
        </li>
        <li>
          For each post, decide whether you agree with the AI label. Click{" "}
          <strong>Agree with label</strong> if you think the label is right for this post. Click{" "}
          <strong>Disagree with label</strong> if you think the label is wrong for this post. After
          each post you'll rate how confident you are. The study has {partCount} parts of {partSizes}, with
          a short questionnaire after each part.
        </li>
      </ul>
      <p className="keyboard-hint">
        Keyboard: <kbd>A</kbd> agree · <kbd>D</kbd> disagree · <kbd>1</kbd>–<kbd>7</kbd> how sure
        you are · <kbd>F</kbd> fact sheet · <kbd>W</kbd> “Why?” (when shown) · <kbd>Esc</kbd> close
      </p>

      <section className="practice" aria-label="Practice post">
        <h2>Practice post · not scored</h2>
        {loadError && (
          <p role="alert" className="error">
            The practice post could not be loaded. You can start part 1 anyway.
          </p>
        )}
        {!practice && !loadError && <p className="loading">Loading…</p>}
        {practice && (
          <>
            <PostCard
              author={practice.author}
              text={practice.text}
              postedAgo={practice.postedAgo}
              likes={practice.likes}
              reposts={practice.reposts}
              image={practice.image}
            />
            <LabelPanel label={practice.aiLabel} checking={false} />
            <Explanation presentation={practiceAsPresentation(practice, part1Condition)} />
            <FactSheetPanel
              factSheet={practice.factSheet}
              open={factSheetOpen}
              onToggle={setFactSheetOpen}
            />
            <div className="button-row decision-row">
              <button
                type="button"
                className="decision decision-agree"
                aria-pressed={choice === "agree"}
                onClick={() => setChoice("agree")}
              >
                Agree with label
              </button>
              <button
                type="button"
                className="decision decision-disagree"
                aria-pressed={choice === "disagree"}
                onClick={() => setChoice("disagree")}
              >
                Disagree with label
              </button>
            </div>
            {choice && (
              <p className="practice-note" role="status">
                That's how it works. In the study you'll then tap how sure you are, and the next
                post appears.
              </p>
            )}
          </>
        )}
        {canStart && (
          <div className="button-row">
            <button type="button" className="primary" disabled={busy} onClick={startPart1}>
              Start part 1
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
