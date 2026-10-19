// Landing (route "/"): public page that explains the study and links to code entry at "/start".
// Recruitment wording rules (docs/study-protocol.md): plain and neutral; never hint at how the labels were made.
//
// CSS classes (styled in global.css):
//   landing, landing__skip, landing__resume, landing__resume-text, landing__resume-btn,
//   landing__main, landing__hero, landing__hero-text, landing__title, landing__pitch,
//   landing__actions, landing__cta, landing__secondary, landing__illustration,
//   landing__section, landing__section-title, landing__steps, landing__step,
//   landing__step-num, landing__step-text, landing__note, landing__list,
//   landing__faq, landing__faq-item, landing__faq-q, landing__faq-a, landing__footer
import { useState } from "react";
import { Link } from "react-router-dom";
import { getStoredSessionId, useStudy } from "../state/StudyContext";
import LandingIllustration from "../components/LandingIllustration";

const FAQ: ReadonlyArray<{ q: string; a: string }> = [
  { q: "What will I complete?", a: "One practice post, 8 study posts and 4 questionnaires of 16 ratings each (64 ratings total), followed by a few final questions. Take it at your own pace." },
  { q: "Do I need to know about AI?", a: "No. No experience with AI or social media is needed." },
  { q: "Can I stop?", a: "Yes. Use Exit study at any time, with no penalty. Answers already saved remain on the study server." },
  {
    q: "What if I close the tab?",
    a: "You can continue where you left off with the same code within 2 hours.",
  },
];

export default function LandingScreen(): JSX.Element {
  const { resume } = useStudy();
  const [activeId, setActiveId] = useState<string | null>(getStoredSessionId);
  const [resuming, setResuming] = useState(false);
  const [resumeFailed, setResumeFailed] = useState(false);

  async function onContinue() {
    setResuming(true);
    setResumeFailed(false);
    const ok = await resume(); // navigates to the session's current screen on success
    if (!ok) {
      setActiveId(getStoredSessionId());
      setResumeFailed(true);
      setResuming(false);
    }
  }

  return (
    <div className="landing">
      <a className="landing__skip" href="#main-content">
        Skip to main content
      </a>

      {activeId && (
        <aside className="landing__resume" aria-label="Session in progress">
          <p className="landing__resume-text">You have a session in progress.</p>
          <button
            type="button"
            className="btn btn--primary landing__resume-btn"
            onClick={onContinue}
            disabled={resuming}
          >
            {resuming ? "Loading…" : "Continue"}
          </button>
        </aside>
      )}
      {resumeFailed && (
        <p className="error landing__resume-text" role="alert">
          We couldn't find your previous session. Choose "Take part" and enter your code to continue.
        </p>
      )}

      <main id="main-content" className="landing__main" tabIndex={-1}>
        <section className="landing__hero" aria-labelledby="landing-title">
          <div className="landing__hero-text">
            <h1 id="landing-title" className="landing__title">
              Post Review Study
            </h1>
            <p className="landing__pitch">Help us understand how people use AI labels on social media posts.</p>
            <p className="landing__note">4 parts · 2 posts per part · 8 posts total</p>
            <div className="landing__actions">
              <Link to="/start" className="btn btn--primary landing__cta">
                Take part
              </Link>
              <a href="#how-it-works" className="btn btn--link landing__secondary">
                How it works ↓
              </a>
            </div>
          </div>
          <div className="landing__illustration" aria-hidden="true">
            <LandingIllustration />
          </div>
        </section>

        <section id="how-it-works" className="landing__section" aria-labelledby="how-title">
          <h2 id="how-title" className="landing__section-title">
            How it works
          </h2>
          <ol className="landing__steps">
            <li className="landing__step">
              <span className="landing__step-num" aria-hidden="true">1</span>
              <span className="landing__step-text">Enter a participation code, read the consent information and try one practice post.</span>
            </li>
            <li className="landing__step">
              <span className="landing__step-num" aria-hidden="true">2</span>
              <span className="landing__step-text">
                Read 8 short made-up posts across 4 parts. Agree or disagree with each AI label, then rate your confidence from 1 to 7.
              </span>
            </li>
            <li className="landing__step">
              <span className="landing__step-num" aria-hidden="true">3</span>
              <span className="landing__step-text">After each part, answer 16 ratings about trust, fairness and how you felt. Finish with a few final questions.</span>
            </li>
          </ol>
          <p className="landing__note">Use a web browser on a computer or phone. No app installation is needed. Take it at your own pace.</p>
        </section>

        <section className="landing__section" aria-labelledby="labels-title">
          <h2 id="labels-title" className="landing__section-title">What are AI labels?</h2>
          <p>These are badges beneath each post: <strong>Likely accurate</strong> suggests the claim is true; <strong>Likely misleading</strong> suggests the claim may be false or misleading. You decide whether you agree with the label.</p>
          <p className="landing__note">The made-up posts are text-based, with like/repost counts. An optional Fact sheet is available for every post if you want to check the supporting record.</p>
        </section>

        <section className="landing__section" aria-labelledby="parts-title">
          <h2 id="parts-title" className="landing__section-title">Four parts, four explanation styles</h2>
          <ul className="landing__list">
            <li><strong>Label only:</strong> the AI label without an explanation.</li>
            <li><strong>Short reason:</strong> the label plus one sentence explaining it.</li>
            <li><strong>Why? details:</strong> open Source, Claim vs record and Wording details.</li>
            <li><strong>What-if explanation:</strong> a sentence describing what would change the label.</li>
          </ul>
          <p className="landing__note">You will see each style once, in an assigned order. Both posts within a part use the same style.</p>
        </section>

        <section className="landing__section" aria-labelledby="who-title">
          <h2 id="who-title" className="landing__section-title">
            Who can take part
          </h2>
          <ul className="landing__list">
            <li>Anyone aged 18 or over who reads English.</li>
            <li>Once per person.</li>
            <li>No experience needed.</li>
          </ul>
        </section>

        <section className="landing__section" aria-labelledby="privacy-title">
          <h2 id="privacy-title" className="landing__section-title">
            Your privacy
          </h2>
          <ul className="landing__list">
            <li>We don't ask for your name. Responses are linked to a study session.</li>
            <li>We only keep a scrambled version of your code, never the code itself.</li>
            <li>You can stop at any time.</li>
            <li>Answers already saved remain on the study server if you stop.</li>
          </ul>
        </section>

        <section className="landing__section landing__faq" aria-labelledby="faq-title">
          <h2 id="faq-title" className="landing__section-title">
            Questions
          </h2>
          {FAQ.map(({ q, a }) => (
            <details key={q} className="landing__faq-item">
              <summary className="landing__faq-q">{q}</summary>
              <p className="landing__faq-a">{a}</p>
            </details>
          ))}
        </section>
      </main>

      <footer className="landing__footer">
        <p>HCI experiment conducted as part of graduate study at Florida Polytechnic University.</p>
      </footer>
    </div>
  );
}
