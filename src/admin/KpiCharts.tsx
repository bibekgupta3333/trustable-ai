/*
 * KpiCharts: tiny inline SVG charts for the admin dashboard. Pure SVG, no chart library.
 * Every chart is role="img" with an aria-label that states the number(s).
 * Colors come from CSS (fill/stroke set via classes in src/styles/global.css); no inline colors.
 *
 * CSS classes:
 *   .kpi__bar            BarCell wrapper <span>
 *   .kpi__bar-svg        BarCell <svg>
 *   .kpi__bar-track      background track rect
 *   .kpi__bar-fill       value rect
 *   .kpi__bar-value      text label next to the bar
 *   .kpi__bar--empty     modifier when value is null
 *   .kpi__pair           PairBar wrapper <span>
 *   .kpi__pair-svg       PairBar <svg>
 *   .kpi__pair-fill--fa    false-alarm bar
 *   .kpi__pair-fill--miss  miss bar
 *   .kpi__pair-value     text label next to the pair
 *   .kpi__spark          Sparkline <svg>
 *   .kpi__spark-line     polyline
 *   .kpi__spark-dot      last-point circle
 *   .kpi__spark--empty   modifier when there is no data
 *   .kpi__meter          ProgressMeter <svg> (completed vs target)
 *   .kpi__meter-track    background rect
 *   .kpi__meter-fill     completed rect
 *   .kpi__meter-min      minimum-N marker line (needs a stroke in CSS)
 */

export const DASH = "—";

export function fmtPct(v: number | null | undefined): string {
  return v == null || Number.isNaN(v) ? DASH : `${Math.round(v * 100)}%`;
}

export function fmtNum(v: number | null | undefined, digits = 1): string {
  return v == null || Number.isNaN(v) ? DASH : v.toFixed(digits);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

const BAR_W = 60;
const BAR_H = 8;

interface BarCellProps {
  /** Raw value; null renders "—". */
  value: number | null;
  /** Scale: fraction = value / max. Default 1 (rates). */
  max?: number;
  /** Lower end of the scale (e.g. 1 for a 1–7 Likert mean). Default 0. */
  min?: number;
  /** Formatted text, e.g. "64%" or "4.2". */
  label: string;
  /** What the number is, for the aria-label, e.g. "Detection rate, condition A". */
  name: string;
}

export function BarCell({ value, max = 1, min = 0, label, name }: BarCellProps) {
  if (value == null || Number.isNaN(value)) {
    return (
      <span className="kpi__bar kpi__bar--empty" role="img" aria-label={`${name}: no data`}>
        {DASH}
      </span>
    );
  }
  const frac = max > min ? clamp01((value - min) / (max - min)) : 0;
  return (
    <span className="kpi__bar" role="img" aria-label={`${name}: ${label}`}>
      <svg className="kpi__bar-svg" width={BAR_W} height={BAR_H} viewBox={`0 0 ${BAR_W} ${BAR_H}`} aria-hidden="true" focusable="false">
        <rect className="kpi__bar-track" x={0} y={0} width={BAR_W} height={BAR_H} rx={2} />
        <rect className="kpi__bar-fill" x={0} y={0} width={frac * BAR_W} height={BAR_H} rx={2} />
      </svg>
      <span className="kpi__bar-value" aria-hidden="true">{label}</span>
    </span>
  );
}

interface PairBarProps {
  falseAlarm: number | null;
  miss: number | null;
  name: string;
}

/** Two stacked thin bars: detection of false-alarm errors vs miss errors (rates 0–1). */
export function PairBar({ falseAlarm, miss, name }: PairBarProps) {
  const fa = fmtPct(falseAlarm);
  const mi = fmtPct(miss);
  const aria = `${name}: false alarm ${falseAlarm == null ? "no data" : fa}, miss ${miss == null ? "no data" : mi}`;
  const h = 4;
  return (
    <span className="kpi__pair" role="img" aria-label={aria}>
      <svg className="kpi__pair-svg" width={BAR_W} height={h * 2 + 2} viewBox={`0 0 ${BAR_W} ${h * 2 + 2}`} aria-hidden="true" focusable="false">
        <rect className="kpi__bar-track" x={0} y={0} width={BAR_W} height={h} rx={1} />
        <rect className="kpi__pair-fill--fa" x={0} y={0} width={clamp01(falseAlarm ?? 0) * BAR_W} height={h} rx={1} />
        <rect className="kpi__bar-track" x={0} y={h + 2} width={BAR_W} height={h} rx={1} />
        <rect className="kpi__pair-fill--miss" x={0} y={h + 2} width={clamp01(miss ?? 0) * BAR_W} height={h} rx={1} />
      </svg>
      <span className="kpi__pair-value" aria-hidden="true">
        FA {fa} · Miss {mi}
      </span>
    </span>
  );
}

interface SparklineProps {
  data: Array<{ date: string; n: number }>;
  name?: string;
  width?: number;
  height?: number;
}

export function Sparkline({ data, name = "Completed per day", width = 120, height = 24 }: SparklineProps) {
  if (data.length === 0) {
    return (
      <span className="kpi__spark kpi__spark--empty" role="img" aria-label={`${name}: no data`}>
        {DASH}
      </span>
    );
  }
  const max = Math.max(1, ...data.map((d) => d.n));
  const pad = 2;
  const step = data.length > 1 ? (width - pad * 2) / (data.length - 1) : 0;
  const pts = data.map((d, i) => {
    const x = data.length > 1 ? pad + i * step : width / 2;
    const y = height - pad - (d.n / max) * (height - pad * 2);
    return [x, y] as const;
  });
  const last = data[data.length - 1];
  const total = data.reduce((s, d) => s + d.n, 0);
  const aria = `${name}: ${total} over ${data.length} day${data.length === 1 ? "" : "s"}, latest ${last.date} ${last.n}`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg className="kpi__spark" role="img" aria-label={aria} width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polyline className="kpi__spark-line" points={pts.map(([x, y]) => `${x},${y}`).join(" ")} />
      <circle className="kpi__spark-dot" cx={lx} cy={ly} r={2} />
    </svg>
  );
}

interface ProgressMeterProps {
  completed: number;
  target: number;
  minimum: number;
}

/** Horizontal meter of completed vs target, with a marker at the minimum N. */
export function ProgressMeter({ completed, target, minimum }: ProgressMeterProps) {
  const w = 160;
  const h = 10;
  const frac = target > 0 ? clamp01(completed / target) : 0;
  const mx = target > 0 ? clamp01(minimum / target) * w : 0;
  return (
    <svg
      className="kpi__meter"
      role="img"
      aria-label={`${completed} of ${target} completed (minimum ${minimum})`}
      width={w}
      height={h + 4}
      viewBox={`0 0 ${w} ${h + 4}`}
    >
      <rect className="kpi__meter-track" x={0} y={2} width={w} height={h} rx={3} />
      <rect className="kpi__meter-fill" x={0} y={2} width={frac * w} height={h} rx={3} />
      <line className="kpi__meter-min" x1={mx} x2={mx} y1={0} y2={h + 4} />
    </svg>
  );
}
