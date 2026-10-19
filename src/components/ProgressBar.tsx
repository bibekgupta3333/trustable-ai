/**
 * ProgressBar: overall study progress ("Post n of 24") shown at the top of each trial.
 *
 * CSS classes:
 *   .progress          wrapper
 *   .progress__label   visible caption (the `label` prop)
 *   .progress__track   the bar track (role="progressbar")
 *   .progress__fill    the filled part; width is set inline as a percentage
 */
export interface ProgressBarProps {
  current: number;
  total: number;
  label: string;
}

export default function ProgressBar({ current, total, label }: ProgressBarProps) {
  const safeTotal = total > 0 ? total : 1;
  const clamped = Math.min(Math.max(current, 0), safeTotal);
  const pct = Math.round((clamped / safeTotal) * 1000) / 10;
  return (
    <div className="progress">
      <span className="progress__label" aria-hidden="true">
        {label}
      </span>
      <div
        className="progress__track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={safeTotal}
        aria-valuenow={clamped}
      >
        <div className="progress__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
