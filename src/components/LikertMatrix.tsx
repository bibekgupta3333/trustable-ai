/**
 * LikertMatrix: several Likert items that share one scale (CONTRACT-v2 §C, block survey).
 * Each row is an ARIA radiogroup of chip buttons (min..max, ≥ 44 px targets via CSS).
 * Wide screens: CSS lays .matrix out as a table (item text column + one column per value, header row
 * with the anchors and column numbers). Under 600 px: CSS stacks each row (item text above a chip row)
 * and shows the per-row anchors instead of the header.
 *
 * Keyboard (focus on any chip in a row):
 *   number keys min..max  answer that row, then move focus to the next unanswered row
 *   ArrowLeft / ArrowRight, Home / End   move focus within the row
 *   ArrowUp / ArrowDown   move focus to the same column in the previous / next row
 *   Space / Enter         answer with the focused chip
 * Roving tabindex: one tab stop per row (the selected chip, else the first chip).
 *
 * CSS classes:
 *   .matrix                    wrapper (<div role="group">)
 *   .matrix__header            header row (aria-hidden): anchors + column numbers
 *   .matrix__header-spacer     empty cell above the item-text column
 *   .matrix__colnums           container of the column numbers
 *   .matrix__colnum            one column number (also --min / --max)
 *   .matrix__anchor            anchor text (also .matrix__anchor--min / --max), in header and per row
 *   .matrix__rows              <ol> of rows
 *   .matrix__row               one item (<li>); .matrix__row--answered once answered
 *   .matrix__item              item text (number + statement)
 *   .matrix__num               the item number inside .matrix__item
 *   .matrix__chips             the radiogroup holding the chips
 *   .matrix__row-anchors       per-row anchor line (show only on narrow screens)
 *   .matrix__chip              one chip <button role="radio">; .matrix__chip--selected when checked
 */
import { useId, useRef, type KeyboardEvent } from "react";

export interface LikertMatrixItem {
  id: string;
  text: string;
}

export interface LikertMatrixProps {
  items: LikertMatrixItem[];
  min?: number;
  max?: number;
  minLabel: string;
  maxLabel: string;
  values: Record<string, number | null>;
  onChange(id: string, v: number): void;
  /** Accessible name for the whole matrix. */
  label?: string;
  /** First display number (default 1), so a second matrix can continue the numbering. */
  startNumber?: number;
}

export default function LikertMatrix({
  items,
  min = 1,
  max = 7,
  minLabel,
  maxLabel,
  values,
  onChange,
  label,
  startNumber = 1,
}: LikertMatrixProps) {
  const uid = useId();
  const chipRefs = useRef<Record<string, (HTMLButtonElement | null)[]>>({});
  const options: number[] = [];
  for (let v = min; v <= max; v++) options.push(v);

  const focusChip = (rowIdx: number, optIdx: number) => {
    const item = items[rowIdx];
    if (!item) return;
    chipRefs.current[item.id]?.[optIdx]?.focus();
  };

  const tabIndexFor = (id: string) => {
    const v = values[id];
    return v == null ? 0 : v - min;
  };

  const answer = (rowIdx: number, v: number, advance: boolean) => {
    const item = items[rowIdx];
    onChange(item.id, v);
    if (!advance) return;
    // Next unanswered row after this one, wrapping to the start; this row now counts as answered.
    const n = items.length;
    for (let k = 1; k < n; k++) {
      const j = (rowIdx + k) % n;
      if (values[items[j].id] == null) {
        focusChip(j, 0);
        return;
      }
    }
  };

  const onKeyDown = (rowIdx: number, optIdx: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const last = options.length - 1;
    if (/^[0-9]$/.test(e.key)) {
      const v = Number(e.key);
      if (v >= min && v <= max) {
        e.preventDefault();
        e.stopPropagation();
        answer(rowIdx, v, true);
      }
      return;
    }
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        focusChip(rowIdx, Math.min(last, optIdx + 1));
        break;
      case "ArrowLeft":
        e.preventDefault();
        focusChip(rowIdx, Math.max(0, optIdx - 1));
        break;
      case "Home":
        e.preventDefault();
        focusChip(rowIdx, 0);
        break;
      case "End":
        e.preventDefault();
        focusChip(rowIdx, last);
        break;
      case "ArrowDown":
        e.preventDefault();
        focusChip(Math.min(items.length - 1, rowIdx + 1), optIdx);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusChip(Math.max(0, rowIdx - 1), optIdx);
        break;
      default:
        break;
    }
  };

  return (
    <div className="matrix" role="group" aria-label={label}>
      <div className="matrix__header" aria-hidden="true">
        <span className="matrix__header-spacer" />
        <span className="matrix__anchor matrix__anchor--min">{min} = {minLabel}</span>
        <span className="matrix__colnums">
          {options.map((v) => (
            <span
              key={v}
              className={`matrix__colnum${v === min ? " matrix__colnum--min" : ""}${v === max ? " matrix__colnum--max" : ""}`}
            >
              {v}
            </span>
          ))}
        </span>
        <span className="matrix__anchor matrix__anchor--max">{max} = {maxLabel}</span>
      </div>
      <ol className="matrix__rows">
        {items.map((item, rowIdx) => {
          const value = values[item.id] ?? null;
          const textId = `${uid}-${item.id}-text`;
          const tabbable = tabIndexFor(item.id);
          return (
            <li
              key={item.id}
              id={`matrix-row-${item.id}`}
              className={`matrix__row${value != null ? " matrix__row--answered" : ""}`}
            >
              <span className="matrix__item" id={textId}>
                <span className="matrix__num">{startNumber + rowIdx}.</span> {item.text}
              </span>
              <div className="matrix__chips" role="radiogroup" aria-labelledby={textId}>
                {options.map((v, optIdx) => {
                  const selected = value === v;
                  const aria = v === min ? `${v}, ${minLabel}` : v === max ? `${v}, ${maxLabel}` : String(v);
                  return (
                    <button
                      key={v}
                      ref={(el) => {
                        (chipRefs.current[item.id] ??= [])[optIdx] = el;
                      }}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={aria}
                      tabIndex={optIdx === tabbable ? 0 : -1}
                      className={`matrix__chip${selected ? " matrix__chip--selected" : ""}`}
                      onClick={() => answer(rowIdx, v, false)}
                      onKeyDown={onKeyDown(rowIdx, optIdx)}
                    >
                      {v}
                    </button>
                  );
                })}
              </div>
              <div className="matrix__row-anchors" aria-hidden="true">
                <span className="matrix__anchor matrix__anchor--min">{minLabel}</span>
                <span className="matrix__anchor matrix__anchor--max">{maxLabel}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
