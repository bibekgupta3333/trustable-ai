// Condition C: a "Why?" toggle that opens 3 factor rows (Source, Claim vs record, Wording).
// Each row is a disclosure button showing displayValue and a ✓/✗ mark from factor.passes (true values);
// expanding a row reveals its detail sentence. Everything starts collapsed on every post.
// CSS classes: explanation, explanation--interactive, why-button, why-button__arrow,
//   factor-list, factor-row, factor-row--expanded, factor-row__toggle, factor-row__arrow,
//   factor-row__label, factor-row__value, factor-row__mark, factor-row__mark--pass,
//   factor-row__mark--fail, factor-row__detail
import { useId, useState } from "react";
import type { Factor, FactorKey } from "../../shared/types";
import type { ExplanationProps } from "./conditionRegistry";

interface RowProps {
  factor: Factor;
  idBase: string;
  expanded: boolean;
  onToggle(): void;
}

function FactorRow({ factor, idBase, expanded, onToggle }: RowProps) {
  const detailId = `${idBase}-${factor.key}-detail`;
  return (
    <li className={`factor-row${expanded ? " factor-row--expanded" : ""}`}>
      <button
        type="button"
        className="factor-row__toggle"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={onToggle}
      >
        <span className="factor-row__arrow" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        <span className="factor-row__label">{factor.label}</span>
        <span className="factor-row__value">{factor.displayValue}</span>
        <span
          className={`factor-row__mark ${factor.passes ? "factor-row__mark--pass" : "factor-row__mark--fail"}`}
          role="img"
          aria-label={factor.passes ? "points to accurate" : "points to misleading"}
        >
          {factor.passes ? "✓" : "✗"}
        </span>
      </button>
      <p id={detailId} className="factor-row__detail" hidden={!expanded}>
        {expanded ? factor.detail : null}
      </p>
    </li>
  );
}

function InteractiveInner({ presentation, onWhy, onFactorToggle }: ExplanationProps) {
  const idBase = useId();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<FactorKey, boolean>>({
    source: false,
    claimVsRecord: false,
    wording: false,
  });
  const factors = presentation.factors ?? [];
  const listId = `${idBase}-factors`;

  const toggleWhy = () => {
    const next = !open;
    setOpen(next);
    onWhy?.(next);
  };

  const toggleFactor = (key: FactorKey) => {
    const next = !expanded[key];
    setExpanded((prev) => ({ ...prev, [key]: next }));
    onFactorToggle?.(key, next);
  };

  return (
    <section className="explanation explanation--interactive" aria-label="Explanation">
      <button
        type="button"
        className="why-button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={toggleWhy}
      >
        Why? <span className="why-button__arrow" aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {/* Keep the controlled target present even while its content is collapsed. */}
      <ul id={listId} className="factor-list" hidden={!open}>
        {open && factors.map((f) => (
          <FactorRow
            key={f.key}
            factor={f}
            idBase={idBase}
            expanded={expanded[f.key]}
            onToggle={() => toggleFactor(f.key)}
          />
        ))}
      </ul>
    </section>
  );
}

export function InteractiveExplanationView(props: ExplanationProps) {
  // Keyed by post so the panel starts collapsed on every trial.
  return <InteractiveInner key={props.presentation.postId} {...props} />;
}

export default InteractiveExplanationView;
