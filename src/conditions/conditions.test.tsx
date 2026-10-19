// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Condition, Presentation } from "../../shared/types";
import { conditionRegistry } from "./conditionRegistry";
import { NoExplanationView } from "./NoExplanationView";
import { StaticExplanationView } from "./StaticExplanationView";
import { InteractiveExplanationView } from "./InteractiveExplanationView";
import { CounterfactualView } from "./CounterfactualView";

const base: Presentation = {
  postId: "p15",
  condition: "A",
  author: { handle: "@RivertonNeighbors", displayName: "Riverton Neighbors", verified: true },
  text: "Good news: Riverton tap water met all 12 safety limits in March.",
  postedAgo: "6h",
  likes: 187,
  reposts: 52,
  factSheet: {
    title: "March Water Quality Report",
    body: "In March, Riverton's tap water was tested for 12 regulated substances. All 12 results were within safety limits.",
    source: "Riverton Water Department (fictional)",
  },
  aiLabel: "misleading",
};

const B = "Flagged: claims about water safety are often exaggerated.";
const D = "This would be labeled accurate if it cited the March test report.";

const presC: Presentation = {
  ...base,
  condition: "C",
  factors: [
    { key: "source", label: "Source", displayValue: "@RivertonNeighbors · verified", passes: true,
      detail: "Community pages can be verified without being experts on water testing." },
    { key: "claimVsRecord", label: "Claim vs record",
      displayValue: "Post: all 12 limits met in March · Record: all 12 tests within limits", passes: true,
      detail: "The post states the result without citing the March report." },
    { key: "wording", label: "Wording", displayValue: "Sensational", passes: false,
      detail: "Reassuring safety posts often leave out caveats from the full report." },
  ],
};

describe("NoExplanationView (A)", () => {
  it("preserves the empty layout spacer without an empty screen-reader landmark", () => {
    const { container } = render(<NoExplanationView presentation={base} />);
    const spacer = container.firstElementChild;
    expect(spacer).toHaveClass("explanation", "explanation--none");
    expect(spacer).toBeEmptyDOMElement();
    expect(spacer).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("region", { name: "Explanation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("StaticExplanationView (B)", () => {
  it("renders the static sentence as one paragraph", () => {
    render(<StaticExplanationView presentation={{ ...base, condition: "B", staticExplanation: B }} />);
    const region = screen.getByRole("region", { name: "Explanation" });
    expect(region).toHaveClass("explanation", "explanation--static");
    const ps = region.querySelectorAll("p");
    expect(ps).toHaveLength(1);
    expect(ps[0].textContent).toBe(B);
    expect(within(region).queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("CounterfactualView (D)", () => {
  it("renders the counterfactual sentence as one paragraph", () => {
    render(<CounterfactualView presentation={{ ...base, condition: "D", counterfactualExplanation: D }} />);
    const region = screen.getByRole("region", { name: "Explanation" });
    const ps = region.querySelectorAll("p");
    expect(ps).toHaveLength(1);
    expect(ps[0].textContent).toBe(D);
    expect(within(region).queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("InteractiveExplanationView (C)", () => {
  it("starts collapsed with only the Why? button", () => {
    render(<InteractiveExplanationView presentation={presC} />);
    const why = screen.getByRole("button", { name: /why\?/i });
    expect(why).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Source")).not.toBeInTheDocument();
  });

  it("toggles Why? and calls onWhy(open)", async () => {
    const user = userEvent.setup();
    const onWhy = vi.fn();
    render(<InteractiveExplanationView presentation={presC} onWhy={onWhy} />);
    const why = screen.getByRole("button", { name: /why\?/i });
    await user.click(why);
    expect(why).toHaveAttribute("aria-expanded", "true");
    expect(onWhy).toHaveBeenLastCalledWith(true);
    expect(screen.getByText("Source")).toBeInTheDocument();
    expect(screen.getByText("Claim vs record")).toBeInTheDocument();
    expect(screen.getByText("Wording")).toBeInTheDocument();
    expect(screen.getByText("Post: all 12 limits met in March · Record: all 12 tests within limits")).toBeInTheDocument();
    await user.click(why);
    expect(why).toHaveAttribute("aria-expanded", "false");
    expect(onWhy).toHaveBeenLastCalledWith(false);
    expect(onWhy).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Source")).not.toBeInTheDocument();
  });

  it("rows are collapsed by default and expand their detail, calling onFactorToggle", async () => {
    const user = userEvent.setup();
    const onFactorToggle = vi.fn();
    render(<InteractiveExplanationView presentation={presC} onFactorToggle={onFactorToggle} />);
    await user.click(screen.getByRole("button", { name: /why\?/i }));
    const rows = screen.getAllByRole("button", { expanded: false }).filter((b) => b.classList.contains("factor-row__toggle"));
    expect(rows).toHaveLength(3);
    for (const f of presC.factors!) expect(screen.queryByText(f.detail)).not.toBeInTheDocument();

    const sourceBtn = screen.getByRole("button", { name: /Source/ });
    await user.click(sourceBtn);
    expect(sourceBtn).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(presC.factors![0].detail)).toBeInTheDocument();
    expect(screen.queryByText(presC.factors![1].detail)).not.toBeInTheDocument();
    expect(onFactorToggle).toHaveBeenLastCalledWith("source", true);

    await user.click(screen.getByRole("button", { name: /Wording/ }));
    expect(onFactorToggle).toHaveBeenLastCalledWith("wording", true);

    await user.click(sourceBtn);
    expect(onFactorToggle).toHaveBeenLastCalledWith("source", false);
    expect(screen.queryByText(presC.factors![0].detail)).not.toBeInTheDocument();
    expect(onFactorToggle).toHaveBeenCalledTimes(3);
  });

  it("✓/✗ marks follow factor.passes", async () => {
    const user = userEvent.setup();
    render(<InteractiveExplanationView presentation={presC} />);
    await user.click(screen.getByRole("button", { name: /why\?/i }));
    const pass = screen.getAllByRole("img", { name: "points to accurate" });
    const fail = screen.getAllByRole("img", { name: "points to misleading" });
    expect(pass).toHaveLength(2);
    expect(fail).toHaveLength(1);
    pass.forEach((m) => {
      expect(m).toHaveTextContent("✓");
      expect(m).toHaveClass("factor-row__mark--pass");
    });
    expect(fail[0]).toHaveTextContent("✗");
    expect(fail[0]).toHaveClass("factor-row__mark--fail");
    const wordingRow = screen.getByRole("button", { name: /Wording/ });
    expect(within(wordingRow).getByRole("img")).toHaveAccessibleName("points to misleading");
  });

  it("resets to collapsed when the post changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<InteractiveExplanationView presentation={presC} />);
    await user.click(screen.getByRole("button", { name: /why\?/i }));
    rerender(<InteractiveExplanationView presentation={{ ...presC, postId: "p16" }} />);
    expect(screen.getByRole("button", { name: /why\?/i })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("conditionRegistry", () => {
  it("has exactly A-D mapped to the four views", () => {
    expect(Object.keys(conditionRegistry).sort()).toEqual(["A", "B", "C", "D"]);
    expect(conditionRegistry.A).toBe(NoExplanationView);
    expect(conditionRegistry.B).toBe(StaticExplanationView);
    expect(conditionRegistry.C).toBe(InteractiveExplanationView);
    expect(conditionRegistry.D).toBe(CounterfactualView);
  });

  it("every view retains the shared layout class and only populated conditions expose a region", () => {
    const pres: Presentation = { ...presC, staticExplanation: B, counterfactualExplanation: D };
    for (const c of ["A", "B", "C", "D"] as Condition[]) {
      const View = conditionRegistry[c];
      const { container, unmount } = render(<View presentation={{ ...pres, condition: c }} />);
      expect(container.firstElementChild).toHaveClass("explanation");
      if (c === "A") {
        expect(screen.queryByRole("region", { name: "Explanation" })).not.toBeInTheDocument();
      } else {
        expect(screen.getByRole("region", { name: "Explanation" })).toHaveClass("explanation");
      }
      unmount();
    }
  });
});
