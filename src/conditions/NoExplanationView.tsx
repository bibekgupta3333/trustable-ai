// Condition A: no explanation. Keeps the fixed-height explanation box but renders nothing visible inside.
// The empty spacer is decorative, not an empty Explanation landmark for screen readers.
// CSS classes: explanation, explanation--none
import type { ExplanationProps } from "./conditionRegistry";

export function NoExplanationView(_props: ExplanationProps) {
  return <div className="explanation explanation--none" aria-hidden="true" />;
}

export default NoExplanationView;
