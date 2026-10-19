// Maps each condition to its explanation view. Views receive only the allow-listed Presentation
// (never correctness fields). All views render inside <section className="explanation">.
import type { ComponentType } from "react";
import type { Condition, FactorKey, Presentation } from "../../shared/types";
import { NoExplanationView } from "./NoExplanationView";
import { StaticExplanationView } from "./StaticExplanationView";
import { InteractiveExplanationView } from "./InteractiveExplanationView";
import { CounterfactualView } from "./CounterfactualView";

export interface ExplanationProps {
  presentation: Presentation;
  onWhy?(open: boolean): void;
  onFactorToggle?(key: FactorKey, expanded: boolean): void;
}

export const conditionRegistry: Record<Condition, ComponentType<ExplanationProps>> = {
  A: NoExplanationView,
  B: StaticExplanationView,
  C: InteractiveExplanationView,
  D: CounterfactualView,
};
