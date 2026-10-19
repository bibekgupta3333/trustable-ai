// Condition D: one counterfactual sentence (presentation.counterfactualExplanation).
// CSS classes: explanation, explanation--counterfactual, explanation__text
import type { ExplanationProps } from "./conditionRegistry";

export function CounterfactualView({ presentation }: ExplanationProps) {
  return (
    <section className="explanation explanation--counterfactual" aria-label="Explanation">
      <p className="explanation__text">{presentation.counterfactualExplanation ?? ""}</p>
    </section>
  );
}

export default CounterfactualView;
