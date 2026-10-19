/**
 * LikertScale: a 1–7 (by default) radio group in a fieldset with endpoint labels. Native radios,
 * so arrow keys move between options and Tab enters/leaves the group.
 *
 * CSS classes:
 *   .likert                 <fieldset>
 *   .likert__legend         question text
 *   .likert__anchors        endpoint-label row ("1 = …", "7 = …")
 *   .likert__anchor         one endpoint label (also .likert__anchor--min / --max)
 *   .likert__options        row of options
 *   .likert__desc           compact only: hidden anchor description (kept for screen readers)
 *   .likert__row            compact only: anchors + options on one line
 *   .likert__option         <label> wrapping one radio + number
 *   .likert__option--selected  selected option
 *   .likert__input          the radio input (keep visible focus ring)
 *   .likert__number         the visible number
 *   .likert--compact        modifier for `compact`: one chip row, anchors inline at the row ends
 *                           (order: min anchor, options, max anchor; anchors show the label only)
 */
import { useId } from "react";

export interface LikertScaleProps {
  name: string;
  label: string;
  min?: number;
  max?: number;
  minLabel: string;
  maxLabel: string;
  value: number | null;
  onChange(v: number): void;
  /** One-line chip row with the anchors at either end (block survey). Default false. */
  compact?: boolean;
}

export default function LikertScale({
  name,
  label,
  min = 1,
  max = 7,
  minLabel,
  maxLabel,
  value,
  onChange,
  compact = false,
}: LikertScaleProps) {
  const id = useId();
  const options: number[] = [];
  for (let v = min; v <= max; v++) options.push(v);

  const optionsRow = (
    <div className="likert__options">
      {options.map((v) => {
        const selected = value === v;
        const aria = v === min ? `${v}, ${minLabel}` : v === max ? `${v}, ${maxLabel}` : String(v);
        return (
          <label key={v} className={`likert__option${selected ? " likert__option--selected" : ""}`}>
            <input
              className="likert__input"
              type="radio"
              name={name}
              value={v}
              checked={selected}
              aria-label={aria}
              onChange={() => onChange(v)}
            />
            <span className="likert__number" aria-hidden="true">{v}</span>
          </label>
        );
      })}
    </div>
  );

  if (compact) {
    return (
      <fieldset className="likert likert--compact" aria-describedby={`${id}-anchors`}>
        <legend className="likert__legend">{label}</legend>
        <span className="likert__desc" id={`${id}-anchors`} hidden>
          {min} = {minLabel}, {max} = {maxLabel}
        </span>
        <div className="likert__row">
          <span className="likert__anchor likert__anchor--min" aria-hidden="true">{minLabel}</span>
          {optionsRow}
          <span className="likert__anchor likert__anchor--max" aria-hidden="true">{maxLabel}</span>
        </div>
      </fieldset>
    );
  }

  return (
    <fieldset className="likert" aria-describedby={`${id}-anchors`}>
      <legend className="likert__legend">{label}</legend>
      <div className="likert__anchors" id={`${id}-anchors`}>
        <span className="likert__anchor likert__anchor--min">{min} = {minLabel}</span>
        <span className="likert__anchor likert__anchor--max">{max} = {maxLabel}</span>
      </div>
      {optionsRow}
    </fieldset>
  );
}
