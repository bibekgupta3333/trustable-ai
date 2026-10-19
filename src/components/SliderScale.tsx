/**
 * SliderScale: a 0–100 range slider (step 5) that starts at `start` but only counts once selected
 * (wireframes §10, NASA-TLX frustration). Until touched it shows a hint.
 *
 * CSS classes:
 *   .slider                 wrapper
 *   .slider--untouched      wrapper modifier until the participant moves it
 *   .slider__label          question text (<label>)
 *   .slider__track          row holding endpoint labels + input
 *   .slider__anchor         endpoint label (also .slider__anchor--min / --max)
 *   .slider__input          the range input (keep visible focus ring)
 *   .slider__value          current value read-out
 *   .slider__hint           unanswered prompt
 */
import { useId, type KeyboardEvent } from "react";

export interface SliderScaleProps {
  name: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  start?: number;
  minLabel: string;
  maxLabel: string;
  value: number | null;
  touched: boolean;
  onChange(v: number): void;
  onTouch(): void;
}

const MOVE_KEYS = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown",
]);
const UNANSWERED_HINT = "Move the slider to select your answer";

export default function SliderScale({
  name,
  label,
  min = 0,
  max = 100,
  step = 5,
  start = 50,
  minLabel,
  maxLabel,
  value,
  touched,
  onChange,
  onTouch,
}: SliderScaleProps) {
  const id = useId();
  const shown = value ?? start;

  const touch = () => {
    if (!touched) onTouch();
  };

  const selectCurrent = (current: number) => {
    if (!touched) {
      touch();
      onChange(current);
    }
  };

  return (
    <div className={`slider${touched ? "" : " slider--untouched"}`}>
      <label className="slider__label" htmlFor={`${id}-input`}>{label}</label>
      <div className="slider__track">
        <span className="slider__anchor slider__anchor--min">{minLabel}</span>
        <input
          id={`${id}-input`}
          className="slider__input"
          type="range"
          name={name}
          min={min}
          max={max}
          step={step}
          value={shown}
          aria-valuetext={touched ? String(shown) : `Unanswered. ${UNANSWERED_HINT}`}
          aria-describedby={touched ? `${id}-value` : `${id}-hint`}
          onChange={(e) => {
            touch();
            onChange(Number(e.target.value));
          }}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (MOVE_KEYS.has(e.key)) selectCurrent(Number(e.currentTarget.value));
            // Confirming the current position also permits an intentional answer of 50.
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              selectCurrent(Number(e.currentTarget.value));
            }
          }}
          onPointerUp={(e) => {
            if (e.button === 0) selectCurrent(Number(e.currentTarget.value));
          }}
        />
        <span className="slider__anchor slider__anchor--max">{maxLabel}</span>
      </div>
      {touched
        ? <div className="slider__value" id={`${id}-value`}>{shown}</div>
        : <p className="slider__hint" id={`${id}-hint`}>{UNANSWERED_HINT}</p>}
    </div>
  );
}
