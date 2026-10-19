/**
 * PostRatingStrip: required per-post confidence rating (wireframes §9).
 *
 * Two modes:
 *  - default ("likert"): a LikertScale plus a Next button. Wording and anchors come from the
 *    `confidence` ScaleItem in surveyItems.json. Next stays disabled until a value is chosen and
 *    disables after one press (double-submit guard).
 *  - mode="chips": a row of 1–7 chips (role=radiogroup). With `autoSubmit`, tapping a chip shows a
 *    short "Saving… Undo" state (`undoMs`, default 1000 ms) and then calls onSubmit; Undo cancels
 *    and lets the participant pick again. Without `autoSubmit`, a Next button submits.
 *    `label`, `minLabel`, `maxLabel` override the item's wording. A parent can pick a chip from
 *    the keyboard through the imperative handle (`ref.current.choose(v)`).
 *
 * CSS classes:
 *   .rating-strip                   wrapper (<form>) in the default mode
 *   .rating-strip__actions          row holding the Next button
 *   .rating-strip__next             Next button
 *   (the default scale uses LikertScale's .likert* classes)
 *   .confidence-chips               wrapper in chips mode (also .confidence-chips--pending)
 *   .confidence-chips__prompt       "How sure are you?"
 *   .confidence-chips__row          the radiogroup row
 *   .confidence-chips__chip         one chip (≥ 44 px); .confidence-chips__chip--selected
 *   .confidence-chips__anchors      endpoint labels row
 *   .confidence-chips__anchor       one endpoint label (also --min / --max)
 *   .confidence-chips__status       "Saving… Undo" line (role=status)
 *   .confidence-chips__undo         Undo button
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { Likert7, ScaleItem } from "../../shared/types";
import LikertScale from "./LikertScale";

export const UNDO_MS = 1000;

export interface PostRatingStripProps {
  item: ScaleItem;
  onSubmit(confidence: Likert7): void;
  /** Optional: called on each choice (e.g. to log `confidence_submit`). */
  onChange?(confidence: Likert7): void;
  mode?: "likert" | "chips";
  /** Chips mode: submit after the undo window instead of waiting for Next. */
  autoSubmit?: boolean;
  undoMs?: number;
  /** Chips mode: called when the undo window opens (true) or is cancelled/finished (false). */
  onPendingChange?(pending: boolean): void;
  label?: string;
  minLabel?: string;
  maxLabel?: string;
}

export interface PostRatingStripHandle {
  /** Picks a value as if the chip was tapped (ignored while locked). */
  choose(v: Likert7): void;
}

const PostRatingStrip = forwardRef<PostRatingStripHandle, PostRatingStripProps>(function PostRatingStrip(
  props,
  ref,
) {
  return props.mode === "chips" ? <ChipStrip {...props} innerRef={ref} /> : <LikertStrip {...props} innerRef={ref} />;
});

export default PostRatingStrip;

type InnerProps = PostRatingStripProps & { innerRef: React.ForwardedRef<PostRatingStripHandle> };

function LikertStrip({ item, onSubmit, onChange, label, minLabel, maxLabel, innerRef }: InnerProps) {
  const [value, setValue] = useState<Likert7 | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const lock = useRef(false);

  const pick = useCallback(
    (v: Likert7) => {
      if (lock.current) return;
      setValue(v);
      onChange?.(v);
    },
    [onChange],
  );
  useImperativeHandle(innerRef, () => ({ choose: pick }), [pick]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (value === null || lock.current) return;
    lock.current = true;
    setSubmitted(true);
    onSubmit(value);
  };

  return (
    <form className="rating-strip" onSubmit={handleSubmit} noValidate>
      <LikertScale
        name={`rating-${item.id}`}
        label={label ?? item.text}
        min={item.min}
        max={item.max}
        minLabel={minLabel ?? item.minLabel}
        maxLabel={maxLabel ?? item.maxLabel}
        value={value}
        onChange={(v) => pick(v as Likert7)}
      />
      <div className="rating-strip__actions">
        <button type="submit" className="rating-strip__next" disabled={value === null || submitted}>
          Next
        </button>
      </div>
    </form>
  );
}

function ChipStrip({
  item,
  onSubmit,
  onChange,
  autoSubmit = false,
  undoMs = UNDO_MS,
  onPendingChange,
  label,
  minLabel,
  maxLabel,
  innerRef,
}: InnerProps) {
  const id = useId();
  const promptId = `${id}-prompt`;
  const anchorsId = `${id}-anchors`;
  const minText = minLabel ?? item.minLabel;
  const maxText = maxLabel ?? item.maxLabel;
  const options: Likert7[] = [];
  for (let v = item.min; v <= item.max; v++) options.push(v as Likert7);

  const [value, setValue] = useState<Likert7 | null>(null);
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const lock = useRef(false); // true while pending or after submit
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Keep callbacks fresh without restarting the undo timer.
  const cbRef = useRef({ onSubmit, onPendingChange });
  cbRef.current = { onSubmit, onPendingChange };

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const doSubmit = useCallback((v: Likert7) => {
    setSubmitted(true);
    cbRef.current.onSubmit(v);
  }, []);

  const pick = useCallback(
    (v: Likert7) => {
      if (lock.current) return;
      setValue(v);
      onChange?.(v);
      if (!autoSubmit) return;
      lock.current = true;
      setPending(true);
      cbRef.current.onPendingChange?.(true);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setPending(false);
        cbRef.current.onPendingChange?.(false);
        doSubmit(v);
      }, undoMs);
    },
    [autoSubmit, undoMs, onChange, doSubmit],
  );
  useImperativeHandle(innerRef, () => ({ choose: pick }), [pick]);

  const undo = () => {
    if (!timerRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
    lock.current = false;
    setPending(false);
    setValue(null);
    cbRef.current.onPendingChange?.(false);
  };

  const next = () => {
    if (value === null || lock.current) return;
    lock.current = true;
    doSubmit(value);
  };

  // Roving focus: arrow keys move between chips; Space/Enter (native button click) selects.
  const onRowKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const current = chipRefs.current.findIndex((el) => el === document.activeElement);
    const last = options.length - 1;
    let to = current < 0 ? 0 : current;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = Math.max(0, to - 1);
    else if (e.key === "ArrowRight" || e.key === "ArrowDown") to = Math.min(last, to + 1);
    else if (e.key === "Home") to = 0;
    else to = last;
    chipRefs.current[to]?.focus();
  };

  const tabIndexFor = (v: Likert7, i: number) => (value === null ? (i === 0 ? 0 : -1) : value === v ? 0 : -1);

  return (
    <div className={`confidence-chips${pending ? " confidence-chips--pending" : ""}`}>
      <p id={promptId} className="confidence-chips__prompt">
        {label ?? item.text}
      </p>
      <div
        className="confidence-chips__row"
        role="radiogroup"
        aria-labelledby={promptId}
        aria-describedby={anchorsId}
        onKeyDown={onRowKey}
      >
        {options.map((v, i) => {
          const selected = value === v;
          const aria = v === item.min ? `${v}, ${minText}` : v === item.max ? `${v}, ${maxText}` : String(v);
          return (
            <button
              key={v}
              ref={(el) => {
                chipRefs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={aria}
              tabIndex={tabIndexFor(v, i)}
              className={`confidence-chips__chip${selected ? " confidence-chips__chip--selected" : ""}`}
              aria-disabled={lock.current && !selected ? true : undefined}
              onClick={() => pick(v)}
            >
              {v}
            </button>
          );
        })}
      </div>
      <div className="confidence-chips__anchors" id={anchorsId}>
        <span className="confidence-chips__anchor confidence-chips__anchor--min">
          {item.min} {minText}
        </span>
        <span className="confidence-chips__anchor confidence-chips__anchor--max">
          {item.max} {maxText}
        </span>
      </div>
      {pending && (
        <p className="confidence-chips__status" role="status">
          Saving…{" "}
          <button type="button" className="confidence-chips__undo" onClick={undo}>
            Undo
          </button>
        </p>
      )}
      {!autoSubmit && (
        <div className="rating-strip__actions">
          <button
            type="button"
            className="rating-strip__next"
            disabled={value === null || submitted}
            onClick={next}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
