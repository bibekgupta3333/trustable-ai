/**
 * LabelPanel: the AI label box (wireframes §4, §8). The box keeps the same size in the
 * checking and labelled states so the layout never shifts.
 *
 * CSS classes:
 *   .label-panel               box (fixed min-height; same size in every state)
 *   .label-panel--checking     "AI is checking…" state
 *   .label-panel--accurate     "✓ Likely accurate"
 *   .label-panel--misleading   "⚠ Likely misleading"
 *   .label-panel__spinner      "◌" busy indicator (decorative)
 *   .label-panel__prefix       "AI label:" text
 *   .label-panel__icon         ✓ / ⚠ glyph
 *   .label-panel__value        "Likely accurate" / "Likely misleading"
 */
import type { Label } from "../../shared/types";

export interface LabelPanelProps {
  label: Label;
  checking: boolean;
}

const TEXT: Record<Label, { icon: string; value: string }> = {
  accurate: { icon: "✓", value: "Likely accurate" },
  misleading: { icon: "⚠", value: "Likely misleading" },
};

export default function LabelPanel({ label, checking }: LabelPanelProps) {
  const modifier = checking ? "checking" : label;
  return (
    <div
      className={`label-panel label-panel--${modifier}`}
      role="status"
      aria-live="polite"
      aria-busy={checking}
      data-testid="label-panel"
    >
      {checking ? (
        <>
          <span className="label-panel__spinner" aria-hidden="true">◌</span> AI is checking…
        </>
      ) : (
        <>
          <span className="label-panel__prefix">AI label:</span>{" "}
          <span className="label-panel__icon" aria-hidden="true">{TEXT[label].icon}</span>{" "}
          <span className="label-panel__value">{TEXT[label].value}</span>
        </>
      )}
    </div>
  );
}
