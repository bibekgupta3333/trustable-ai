// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Presentation } from "../../shared/types";
import { InteractiveExplanationView } from "./InteractiveExplanationView";

const presentation: Presentation = {
  postId: "test-c-1",
  condition: "C",
  author: { handle: "@fictional", displayName: "Fictional account", verified: true },
  text: "Fictional comparison fixture.",
  postedAgo: "1h",
  likes: 0,
  reposts: 0,
  aiLabel: "accurate",
  factSheet: { title: "Fictional record", body: "Record: $2 per hour.", source: "Fictional agency" },
  factors: [
    { key: "source", label: "Source", displayValue: "@fictional · verified", passes: true, detail: "Scripted source rationale." },
    { key: "claimVsRecord", label: "Claim vs record", displayValue: "Post: $4 per hour · Record: $2 per hour", passes: false, detail: "Scripted comparison rationale." },
    { key: "wording", label: "Wording", displayValue: "Neutral", passes: true, detail: "Scripted wording rationale." },
  ],
};

function controlledTarget(button: HTMLElement): HTMLElement {
  const id = button.getAttribute("aria-controls");
  expect(id).toBeTruthy();
  const target = document.getElementById(id!);
  expect(target).not.toBeNull();
  return target!;
}

describe("C disclosure accessibility and behavior", () => {
  it("keeps controlled targets present and hidden until opened, preserving values and symbols", async () => {
    const user = userEvent.setup();
    render(<InteractiveExplanationView presentation={presentation} />);
    const why = screen.getByRole("button", { name: "Why?" });
    const list = controlledTarget(why);
    expect(why).toHaveAttribute("type", "button");
    expect(why).toHaveAttribute("aria-expanded", "false");
    expect(list).toHaveAttribute("hidden");
    expect(list).not.toBeVisible();
    expect(screen.getAllByRole("button")).toEqual([why]);

    await user.click(why);
    expect(controlledTarget(why)).toBe(list);
    expect(list).toBeVisible();
    for (const factor of presentation.factors!) {
      const button = screen.getByRole("button", { name: new RegExp(factor.label) });
      const detail = controlledTarget(button);
      expect(button).toHaveAttribute("type", "button");
      expect(button).toHaveAttribute("aria-expanded", "false");
      expect(button.querySelector("button, a, input, select, textarea, [tabindex]")).toBeNull();
      expect(within(button).getByText(factor.displayValue)).toBeVisible();
      expect(within(button).getByRole("img")).toHaveTextContent(factor.passes ? "✓" : "✗");
      expect(within(button).getByRole("img")).toHaveAccessibleName(factor.passes ? "points to accurate" : "points to misleading");
      expect(detail).toHaveAttribute("hidden");
      expect(detail).not.toBeVisible();
      await user.click(button);
      expect(controlledTarget(button)).toBe(detail);
      expect(button).toHaveAttribute("aria-expanded", "true");
      expect(detail).toBeVisible();
      expect(detail.textContent).toBe(factor.detail);
      await user.click(button);
      expect(controlledTarget(button)).toBe(detail);
      expect(detail).not.toBeVisible();
    }
    await user.click(why);
    expect(controlledTarget(why)).toBe(list);
    expect(list).not.toBeVisible();
    expect(screen.getAllByRole("button")).toEqual([why]);
  });

  it("supports Tab, Enter and Space with focus retained on the disclosure control", async () => {
    const user = userEvent.setup();
    const onWhy = vi.fn();
    const onFactorToggle = vi.fn();
    render(<>
      <InteractiveExplanationView presentation={presentation} onWhy={onWhy} onFactorToggle={onFactorToggle} />
      <button type="button">After explanation</button>
    </>);
    const why = screen.getByRole("button", { name: "Why?" });
    await user.tab();
    expect(why).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(why).toHaveFocus();
    expect(onWhy.mock.calls).toEqual([[true]]);
    await user.tab();
    const source = screen.getByRole("button", { name: /Source/ });
    expect(source).toHaveFocus();
    await user.keyboard(" ");
    expect(source).toHaveFocus();
    expect(source).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Enter}");
    expect(source).toHaveFocus();
    expect(source).toHaveAttribute("aria-expanded", "false");
    expect(onFactorToggle.mock.calls).toEqual([["source", true], ["source", false]]);
    await user.tab({ shift: true });
    expect(why).toHaveFocus();
    await user.keyboard(" ");
    expect(why).toHaveFocus();
    expect(onWhy.mock.calls).toEqual([[true], [false]]);
    await user.tab();
    expect(screen.getByRole("button", { name: "After explanation" })).toHaveFocus();
  });

  it("preserves independent expansion and callbacks across Why close/reopen, then resets on a new post", async () => {
    const user = userEvent.setup();
    const onWhy = vi.fn();
    const onFactorToggle = vi.fn();
    const { rerender } = render(<InteractiveExplanationView presentation={presentation} onWhy={onWhy} onFactorToggle={onFactorToggle} />);
    expect(onWhy).not.toHaveBeenCalled();
    expect(onFactorToggle).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Why?" }));
    await user.click(screen.getByRole("button", { name: /Source/ }));
    await user.click(screen.getByRole("button", { name: /Claim vs record/ }));
    expect(screen.getByRole("button", { name: /Source/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /Claim vs record/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /Wording/ })).toHaveAttribute("aria-expanded", "false");
    await user.click(screen.getByRole("button", { name: "Why?" }));
    await user.click(screen.getByRole("button", { name: "Why?" }));
    expect(screen.getByText("Scripted comparison rationale.")).toBeVisible();
    expect(screen.getByText("Scripted source rationale.")).toBeVisible();
    expect(onWhy.mock.calls).toEqual([[true], [false], [true]]);
    expect(onFactorToggle.mock.calls).toEqual([["source", true], ["claimVsRecord", true]]);

    rerender(<InteractiveExplanationView presentation={{ ...presentation, postId: "test-c-2" }} onWhy={onWhy} onFactorToggle={onFactorToggle} />);
    const why = screen.getByRole("button", { name: "Why?" });
    expect(why).toHaveAttribute("aria-expanded", "false");
    expect(controlledTarget(why)).not.toBeVisible();
    expect(onWhy).toHaveBeenCalledTimes(3);
    expect(onFactorToggle).toHaveBeenCalledTimes(2);
    await user.click(why);
    expect(screen.getAllByRole("button", { expanded: false })).toHaveLength(3);
    for (const button of screen.getAllByRole("button")) controlledTarget(button);
  });
});
