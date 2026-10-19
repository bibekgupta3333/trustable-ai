// Exit survey (wireframes.md §11; CONTRACT-v2 §C). One screen; every question has ≤ 6 options,
// so each is a chip group (native radios inside role=radiogroup, ≥ 44 px targets via CSS).
// Fields follow the ExitSurvey enums in shared/types.ts. Preferred part is shown as "Part 1–4"
// and mapped to the condition letter via session.conditionOrder; letters are never shown.
// On success (and after the logger flush is attempted): SESSION_LOADED, clearParticipantStorage()
// so the next person on a shared device starts fresh, then /debrief. On failure nothing is cleared.
import { useId, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { clearParticipantStorage, useStudy } from "../state/StudyContext";
import { useLogger } from "../logging/logger";
import type { Condition, ExitSurvey } from "../../shared/types";
import type { ExitSurveySubmission, SessionView } from "../../shared/api";

type Opt<T extends string> = { value: T; label: string };

export const AGE_OPTIONS: Opt<ExitSurvey["ageRange"]>[] = [
  { value: "18-24", label: "18–24" },
  { value: "25-34", label: "25–34" },
  { value: "35-44", label: "35–44" },
  { value: "45-54", label: "45–54" },
  { value: "55+", label: "55 or older" },
  { value: "prefer_not", label: "Prefer not to say" },
];
export const GENDER_OPTIONS: Opt<NonNullable<ExitSurvey["gender"]>>[] = [
  { value: "woman", label: "Woman" },
  { value: "man", label: "Man" },
  { value: "nonbinary", label: "Non-binary" },
  { value: "self_describe", label: "Prefer to self-describe" },
  { value: "prefer_not", label: "Prefer not to say" },
];
export const EDUCATION_OPTIONS: Opt<ExitSurvey["education"]>[] = [
  { value: "high_school", label: "High school" },
  { value: "some_college", label: "Some college" },
  { value: "bachelors", label: "Bachelor's degree" },
  { value: "graduate", label: "Graduate degree" },
  { value: "prefer_not", label: "Prefer not to say" },
];
export const SOCIAL_OPTIONS: Opt<ExitSurvey["socialMediaUse"]>[] = [
  { value: "never", label: "Never" },
  { value: "less_than_weekly", label: "Less than weekly" },
  { value: "weekly", label: "Weekly" },
  { value: "daily", label: "Daily" },
  { value: "several_daily", label: "Several times a day" },
];
export const EXPOSURE_OPTIONS: Opt<ExitSurvey["labelExposure"]>[] = [
  { value: "never", label: "Never" },
  { value: "rarely", label: "Rarely" },
  { value: "sometimes", label: "Sometimes" },
  { value: "often", label: "Often" },
];

export const PART_OPTIONS: Opt<PartChoice>[] = [
  { value: "1", label: "Part 1" },
  { value: "2", label: "Part 2" },
  { value: "3", label: "Part 3" },
  { value: "4", label: "Part 4" },
  { value: "none", label: "No preference" },
];

const PART_DESCRIPTIONS: Record<Condition, string> = {
  A: "Label only",
  B: "One short reason",
  C: "Why? with expandable details",
  D: "What-if explanation",
};

const COMMENT_MAX = 1000;

type PartChoice = "1" | "2" | "3" | "4" | "none";

function ChipGroup<T extends string>(props: {
  name: string;
  legend: string;
  options: Opt<T>[];
  value: NoInfer<T> | "";
  onChange(v: NoInfer<T>): void;
  required?: boolean;
  invalid?: boolean;
}) {
  const id = useId();
  const legendId = `${id}-legend`;
  return (
    <div className={`field chip-field${props.invalid ? " field-invalid" : ""}`}>
      <p id={legendId} className="chip-legend">
        {props.legend}
        {props.required ? " *" : " (optional)"}
      </p>
      <div
        role="radiogroup"
        aria-labelledby={legendId}
        aria-required={props.required || undefined}
        aria-invalid={props.invalid || undefined}
        className="chip-group"
      >
        {props.options.map((o) => (
          <label key={o.value} className={`chip${props.value === o.value ? " chip-selected" : ""}`}>
            <input
              type="radio"
              className="chip-input"
              name={props.name}
              value={o.value}
              checked={props.value === o.value}
              onChange={() => props.onChange(o.value)}
            />
            <span className="chip-label">{o.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export default function ExitSurveyScreen() {
  const { session, dispatch } = useStudy();
  const logger = useLogger();
  const navigate = useNavigate();
  const [ageRange, setAgeRange] = useState<ExitSurvey["ageRange"] | "">("");
  const [gender, setGender] = useState<NonNullable<ExitSurvey["gender"]> | "">("");
  const [education, setEducation] = useState<ExitSurvey["education"] | "">("");
  const [socialMediaUse, setSocial] = useState<ExitSurvey["socialMediaUse"] | "">("");
  const [labelExposure, setExposure] = useState<ExitSurvey["labelExposure"] | "">("");
  const [part, setPart] = useState<PartChoice | "">("");
  const [comment, setComment] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!session) return <main className="screen">Loading…</main>;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!session || busy) return;
    const miss: string[] = [];
    if (!ageRange) miss.push("Age range");
    if (!education) miss.push("Education");
    if (!socialMediaUse) miss.push("Social media use");
    if (!labelExposure) miss.push("Label exposure");
    if (!part) miss.push("Preferred part");
    setMissing(miss);
    if (miss.length > 0) return;

    const body: ExitSurveySubmission = {
      ageRange: ageRange as ExitSurvey["ageRange"],
      gender: gender === "" ? null : gender,
      education: education as ExitSurvey["education"],
      socialMediaUse: socialMediaUse as ExitSurvey["socialMediaUse"],
      labelExposure: labelExposure as ExitSurvey["labelExposure"],
      preferredCondition: part === "none" ? "none" : session.conditionOrder[Number(part) - 1],
      comment: comment.slice(0, COMMENT_MAX),
    };

    setBusy(true);
    setError(null);
    let completed: SessionView;
    try {
      completed = await api.submitExitSurvey(session.sessionId, body);
    } catch {
      setError("Your answers could not be saved. Please check your connection and try again.");
      setBusy(false);
      return;
    }
    const base = { trialId: null, blockIndex: null, condition: null, postId: null, factorKey: null, tMs: null };
    logger?.log({ ...base, type: "exit_survey_submit" });
    logger?.log({ ...base, type: "session_complete" });
    try {
      await logger?.flush();
    } catch {
      /* best effort: the responses themselves are already stored */
    }
    // Responses are on the server: keep the completed session in memory for the debrief, then wipe storage.
    dispatch({ type: "SESSION_LOADED", session: completed });
    clearParticipantStorage();
    navigate("/debrief");
  }

  const isMissing = (name: string) => missing.includes(name);
  const partOptions = PART_OPTIONS.map((option) => option.value === "none" ? option : {
    ...option,
    label: `${option.label} — ${PART_DESCRIPTIONS[session.conditionOrder[Number(option.value) - 1]]}`,
  });

  return (
    <main className="screen exit-survey-screen">
      <h1>A few last questions</h1>
      <form onSubmit={onSubmit} noValidate>
        <ChipGroup name="ageRange" legend="Age range" required options={AGE_OPTIONS}
          value={ageRange} onChange={setAgeRange} invalid={isMissing("Age range")} />
        <ChipGroup name="gender" legend="Gender" options={GENDER_OPTIONS}
          value={gender} onChange={setGender} />
        <ChipGroup name="education" legend="Education" required options={EDUCATION_OPTIONS}
          value={education} onChange={setEducation} invalid={isMissing("Education")} />
        <ChipGroup name="socialMediaUse" legend="How often do you use social media?" required
          options={SOCIAL_OPTIONS} value={socialMediaUse} onChange={setSocial}
          invalid={isMissing("Social media use")} />
        <ChipGroup name="labelExposure"
          legend="How often have you seen accuracy or fact-check labels on real platforms?" required
          options={EXPOSURE_OPTIONS} value={labelExposure} onChange={setExposure}
          invalid={isMissing("Label exposure")} />
        <ChipGroup name="preferredPart" legend="Which part did you prefer?" required
          options={partOptions} value={part} onChange={setPart}
          invalid={isMissing("Preferred part")} />

        <div className="field">
          <label htmlFor="comment">Any comments? (optional; please no personal information)</label>
          <textarea id="comment" value={comment} maxLength={COMMENT_MAX} rows={3}
            onChange={(e) => setComment(e.target.value.slice(0, COMMENT_MAX))} />
        </div>

        {missing.length > 0 && (
          <p role="alert" className="error">Please answer: {missing.join(", ")}.</p>
        )}
        {error && <p role="alert" className="error">{error}</p>}

        <div className="button-row">
          <button type="submit" className="primary" disabled={busy}>Submit</button>
        </div>
      </form>
    </main>
  );
}
