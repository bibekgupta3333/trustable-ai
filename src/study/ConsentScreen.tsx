// Consent screen (wireframes.md §1; CONTRACT-v2 §C). Self-guided: a short plain-language summary,
// the full consent text (study-protocol.md §4, adapted for self-guided sessions) behind a
// "Read full consent details" disclosure, an 18+ checkbox and Continue.
// "I do not agree" shows a thank-you and records no study answers.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useStudy } from "../state/StudyContext";
import { useLogger } from "../logging/logger";

export default function ConsentScreen() {
  const { session, advance } = useStudy();
  const totalPosts = session?.blocks.reduce((total, block) => total + block.postOrder.length, 0) || 8;
  const logger = useLogger();
  const navigate = useNavigate();
  const [checked, setChecked] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (declined) {
    return (
      <main className="screen consent-screen consent-declined">
        <h1>Thank you</h1>
        <p>You have chosen not to take part. None of your answers have been recorded.</p>
        <p>You can simply close this page.</p>
      </main>
    );
  }

  async function onContinue() {
    if (!session || !checked || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.consent(session.sessionId);
      logger?.log({
        trialId: null, blockIndex: null, condition: null, postId: null,
        type: "consent_given", factorKey: null, tMs: null,
      });
      await advance({ blockIndex: 1, positionInBlock: 1, phase: "instructions" });
      navigate("/instructions");
    } catch {
      setError("Something went wrong saving your answer. Please check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <main className="screen consent-screen">
      <h1>Before you start</h1>
      <p className="consent-lead">How people use AI labels on social media posts</p>
      <ul className="consent-summary">
        <li>
          <strong>What you'll do:</strong> read {totalPosts} short posts about a made-up town, decide whether
          you agree with an AI tool's label on each one, and answer a few short questionnaires.
        </li>
        <li>
          <strong>Pace:</strong> a short study with a questionnaire after each part. Take it at your own pace.
        </li>
        <li>
          <strong>Voluntary:</strong> taking part is your choice, and you can stop at any time by
          closing the page.
        </li>
        <li>
          <strong>Your data:</strong> we don't ask for your name. Only a scrambled version of your
          participation code is kept to prevent repeat submissions with the same code.
        </li>
        <li>
          Answers already saved remain on the study server if you stop.
        </li>
      </ul>

      <details className="consent-details">
        <summary>Read full consent details</summary>
        <div className="consent-full">
          <h2>Consent to take part in a research study</h2>
          <p>
            <strong>Study:</strong> How people use AI labels on social media posts
            <br />
            HCI experiment conducted as part of graduate study at Florida Polytechnic University.
          </p>
          <p>
            We are studying how people use an AI tool that labels social media posts. You will read
            {totalPosts} short posts about a made-up town. Each post has a label from the AI tool, and you
            decide whether you agree with it. You will also answer short questionnaires, including
            how tense or frustrated you felt. You do the study on your own, at your own pace.
          </p>
          <p>
            All posts, people and places are fictional, and some posts contain claims that are not
            true. You may feel tense or frustrated while judging the labels. Some parts of the study
            will be explained to you fully at the end.
          </p>
          <p>
            We do not ask for your name. The participation code you typed is never stored; we keep
            only a scrambled version of it to recognize repeat use of the same code. Your answers,
            response times and interactions are saved on the study server under a session identifier
            and participant number. Results will be reported as group summaries. Please do not
            type personal details in the comment box.
          </p>
          <p>
            Taking part is voluntary. You can stop at any time without giving a reason, simply by
            closing the page, without any penalty. Closing the page does not delete answers already
            saved on the study server.
          </p>
          <p>
            By ticking the box below and clicking Continue, you confirm that you are 18 or older and
            agree to take part.
          </p>
        </div>
      </details>

      <label className="consent-check">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
        />{" "}
        I am 18 or older and I agree to take part
      </label>

      {error && <p role="alert" className="error">{error}</p>}

      <div className="button-row">
        <button
          type="button"
          className="primary"
          disabled={!checked || !session || busy}
          onClick={onContinue}
        >
          Continue
        </button>
        <button type="button" className="secondary" onClick={() => setDeclined(true)} disabled={busy}>
          I do not agree
        </button>
      </div>
    </main>
  );
}
