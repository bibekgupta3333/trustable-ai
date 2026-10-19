// Condition B: one fixed sentence (presentation.staticExplanation).
// CSS classes: explanation, explanation--static, explanation__text
import type { ExplanationProps } from "./conditionRegistry";

export function StaticExplanationView({ presentation }: ExplanationProps) {
  return (
    <section className="explanation explanation--static" aria-label="Explanation">
      <p className="explanation__text">{presentation.staticExplanation ?? ""}</p>
    </section>
  );
}

export default StaticExplanationView;
