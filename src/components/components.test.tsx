// @vitest-environment jsdom
import { createRef, useState } from "react";
import { act, render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PostCard from "./PostCard";
import LabelPanel from "./LabelPanel";
import FactSheetPanel from "./FactSheetPanel";
import LikertScale from "./LikertScale";
import SliderScale from "./SliderScale";
import PostRatingStrip, { type PostRatingStripHandle } from "./PostRatingStrip";
import ProgressBar from "./ProgressBar";
import type { FactSheet, PostImage, ScaleItem } from "../../shared/types";

const factSheet: FactSheet = {
  title: "March Water Quality Report",
  body: "In March, Riverton's tap water was tested for 12 regulated substances. All 12 results were within safety limits.",
  source: "Riverton Water Department (fictional)",
};

const confidenceItem: ScaleItem = {
  id: "confidence",
  text: "How confident are you in your decision?",
  min: 1,
  max: 7,
  step: 1,
  minLabel: "Not at all confident",
  maxLabel: "Extremely confident",
  widget: "likert",
};

describe("PostCard", () => {
  const base = { text: "Good news: Riverton tap water met all 12 safety limits in March.", postedAgo: "6h", likes: 187, reposts: 52 };
  const author = { displayName: "Riverton Neighbors", handle: "@RivertonNeighbors", verified: false };
  const image: PostImage = {
    src: "/post-images/environment.png",
    alt: "Trees beside a small-town lake",
    width: 1536,
    height: 1024,
  };

  it("renders author, handle, time, text and stats", () => {
    render(<PostCard {...base} author={{ displayName: "Riverton Neighbors", handle: "@RivertonNeighbors", verified: true }} />);
    expect(screen.getByText("Riverton Neighbors")).toBeInTheDocument();
    expect(screen.getByText("@RivertonNeighbors")).toBeInTheDocument();
    expect(screen.getByText("6h")).toBeInTheDocument();
    expect(screen.getByText(base.text)).toBeInTheDocument();
    expect(screen.getByLabelText("187 likes")).toHaveTextContent("♡ 187");
    expect(screen.getByLabelText("52 reposts")).toHaveTextContent("↻ 52");
    expect(screen.getByRole("img", { name: "verified account" })).toHaveTextContent("✔");
  });

  it("shows no badge for unverified accounts", () => {
    render(<PostCard {...base} author={{ displayName: "Dana", handle: "@dana_reads", verified: false }} />);
    expect(screen.queryByLabelText("verified account")).toBeNull();
    expect(screen.queryByText("✔")).toBeNull();
  });

  it("keeps legacy cards free of media and preserves their original counts", () => {
    render(<PostCard {...base} author={author} />);
    expect(screen.queryByRole("figure")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText("Illustrative scene")).not.toBeInTheDocument();
    expect(screen.getByText(base.text)).toBeInTheDocument();
    expect(screen.getByLabelText("187 likes")).toBeInTheDocument();
    expect(screen.getByLabelText("52 reposts")).toBeInTheDocument();
  });

  it("renders historical media with its accessible description and dimensions but no caption", () => {
    const { container } = render(<PostCard {...base} author={author} image={image} />);
    const photo = screen.getByRole("img", { name: image.alt });
    expect(photo).toHaveAttribute("src", image.src);
    expect(photo).toHaveAttribute("width", "1536");
    expect(photo).toHaveAttribute("height", "1024");
    expect(container.querySelector("figcaption")).toBeNull();
    expect(screen.getByText(base.text)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("hides a failed picture while retaining its frame, text and counts", () => {
    const { container } = render(<PostCard {...base} author={author} image={image} />);
    const frame = container.querySelector(".post-card__image-frame");
    fireEvent.error(screen.getByRole("img", { name: image.alt }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.querySelector(".post-card__image-frame")).toBe(frame);
    expect(frame).toHaveTextContent("Image unavailable");
    expect(container.querySelector("figcaption")).toBeNull();
    expect(screen.getByText(base.text)).toBeInTheDocument();
    expect(screen.getByLabelText("187 likes")).toBeInTheDocument();
    expect(screen.getByLabelText("52 reposts")).toBeInTheDocument();
  });

  it("tries a different image after an earlier image fails", () => {
    const { rerender } = render(<PostCard {...base} author={author} image={image} />);
    fireEvent.error(screen.getByRole("img", { name: image.alt }));
    const nextImage = { ...image, src: "/post-images/public-services.png", alt: "A quiet town street" };
    rerender(<PostCard {...base} author={author} image={nextImage} />);
    expect(screen.getByRole("img", { name: nextImage.alt })).toHaveAttribute("src", nextImage.src);
    expect(screen.queryByText("Image unavailable")).not.toBeInTheDocument();
  });
});

describe("LabelPanel", () => {
  it("shows the checking state with role=status", () => {
    render(<LabelPanel label="accurate" checking />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("AI is checking…");
    expect(status).not.toHaveTextContent("Likely");
    expect(status).toHaveClass("label-panel", "label-panel--checking");
  });

  it("shows the accurate label", () => {
    render(<LabelPanel label="accurate" checking={false} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("AI label: ✓ Likely accurate");
    expect(status).toHaveClass("label-panel--accurate");
  });

  it("shows the misleading label and keeps the same element across states", () => {
    const { rerender } = render(<LabelPanel label="misleading" checking />);
    const before = screen.getByTestId("label-panel");
    rerender(<LabelPanel label="misleading" checking={false} />);
    const after = screen.getByTestId("label-panel");
    expect(after).toBe(before);
    expect(after).toHaveTextContent("AI label: ⚠ Likely misleading");
    expect(after).toHaveClass("label-panel--misleading");
  });
});

function FactSheetHarness({ onToggle }: { onToggle?: (o: boolean) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <FactSheetPanel
      factSheet={factSheet}
      open={open}
      onToggle={(o) => {
        onToggle?.(o);
        setOpen(o);
      }}
    />
  );
}

describe("FactSheetPanel", () => {
  it("toggles open and closed with the button", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<FactSheetHarness onToggle={spy} />);
    const toggle = screen.getByRole("button", { name: "Fact sheet ▸" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(factSheet.title)).toBeNull();

    await user.click(toggle);
    expect(spy).toHaveBeenLastCalledWith(true);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("heading", { name: factSheet.title })).toBeInTheDocument();
    expect(screen.getByText(factSheet.body)).toBeInTheDocument();
    expect(screen.getByText(`Source: ${factSheet.source}`)).toBeInTheDocument();
    expect(screen.getByRole("complementary")).not.toHaveTextContent(/likely|label/i);

    await user.click(toggle);
    expect(spy).toHaveBeenLastCalledWith(false);
    expect(screen.queryByText(factSheet.title)).toBeNull();
  });

  it("closes on Esc and on the × button", async () => {
    const user = userEvent.setup();
    render(<FactSheetHarness />);
    await user.click(screen.getByRole("button", { name: /fact sheet/i }));
    expect(screen.getByText(factSheet.title)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByText(factSheet.title)).toBeNull();

    await user.click(screen.getByRole("button", { name: /fact sheet/i }));
    await user.click(screen.getByRole("button", { name: "Close fact sheet" }));
    expect(screen.queryByText(factSheet.title)).toBeNull();
  });

  it("can be disabled", () => {
    render(<FactSheetPanel factSheet={factSheet} open={false} onToggle={() => {}} disabled />);
    expect(screen.getByRole("button", { name: "Fact sheet ▸" })).toBeDisabled();
  });
});

describe("LikertScale", () => {
  function Harness({ spy }: { spy: (v: number) => void }) {
    const [v, setV] = useState<number | null>(null);
    return (
      <LikertScale
        name="tension"
        label="How tense did you feel?"
        minLabel="Not at all"
        maxLabel="Extremely tense"
        value={v}
        onChange={(n) => {
          spy(n);
          setV(n);
        }}
      />
    );
  }

  it("renders a fieldset with 7 radios and endpoint labels", () => {
    render(<Harness spy={() => {}} />);
    expect(screen.getByRole("group", { name: "How tense did you feel?" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(7);
    expect(screen.getByText("1 = Not at all")).toBeInTheDocument();
    expect(screen.getByText("7 = Extremely tense")).toBeInTheDocument();
  });

  it("selects by click and by keyboard", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    await user.click(screen.getByRole("radio", { name: "3" }));
    expect(spy).toHaveBeenLastCalledWith(3);
    expect(screen.getByRole("radio", { name: "3" })).toBeChecked();
    await user.keyboard("{ArrowRight}");
    expect(spy).toHaveBeenLastCalledWith(4);
    expect(screen.getByRole("radio", { name: "4" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "7, Extremely tense" }));
    expect(spy).toHaveBeenLastCalledWith(7);
  });
});

describe("SliderScale", () => {
  function Harness({ onTouch, onChange }: { onTouch: () => void; onChange: (v: number) => void }) {
    const [v, setV] = useState<number | null>(null);
    const [t, setT] = useState(false);
    return (
      <SliderScale
        name="frustrationTlx"
        label="How irritated, stressed or annoyed did you feel during this part?"
        minLabel="Very low"
        maxLabel="Very high"
        value={v}
        touched={t}
        onChange={(n) => {
          onChange(n);
          setV(n);
        }}
        onTouch={() => {
          onTouch();
          setT(true);
        }}
      />
    );
  }

  it("starts at 50, untouched, with a hint", () => {
    const onTouch = vi.fn();
    const onChange = vi.fn();
    render(<Harness onTouch={onTouch} onChange={onChange} />);
    const input = screen.getByRole("slider", { name: /irritated/ });
    expect(input).toHaveValue("50");
    expect(input).toHaveAttribute("min", "0");
    expect(input).toHaveAttribute("max", "100");
    expect(input).toHaveAttribute("step", "5");
    expect(screen.getByText("Move the slider to select your answer")).toBeInTheDocument();
    expect(input).toHaveAccessibleDescription("Move the slider to select your answer");
    expect(input).toHaveAttribute("aria-valuetext", "Unanswered. Move the slider to select your answer");
    expect(screen.queryByText(/50/)).toBeNull();
    fireEvent.focus(input);
    expect(onTouch).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("calls onTouch once on first change and shows the value", () => {
    const onTouch = vi.fn();
    const onChange = vi.fn();
    render(<Harness onTouch={onTouch} onChange={onChange} />);
    const input = screen.getByRole("slider");
    fireEvent.change(input, { target: { value: "65" } });
    expect(onTouch).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(65);
    expect(screen.queryByText("Move the slider to select your answer")).toBeNull();
    expect(screen.getByText("65")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-valuetext", "65");
    expect(input).toHaveAccessibleDescription("65");
    fireEvent.change(input, { target: { value: "70" } });
    expect(onTouch).toHaveBeenCalledTimes(1);
  });

  it("counts a keyboard move as touched even without a value change", () => {
    const onTouch = vi.fn();
    render(<Harness onTouch={onTouch} onChange={() => {}} />);
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });
    expect(onTouch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Move the slider to select your answer")).toBeNull();
  });

  it.each(["{Enter}", " "])("allows intentional keyboard selection of 50 with %s", async (key) => {
    const user = userEvent.setup();
    const onTouch = vi.fn();
    const onChange = vi.fn();
    render(<Harness onTouch={onTouch} onChange={onChange} />);
    await user.tab();
    expect(onTouch).not.toHaveBeenCalled();
    await user.keyboard(key);
    expect(onTouch).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(50);
    expect(screen.getByText("50")).toBeInTheDocument();
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "50");
    expect(screen.getByRole("slider")).toHaveAccessibleDescription("50");
    await user.keyboard(key);
    expect(onTouch).toHaveBeenCalledTimes(1);
  });

  it("allows intentional pointer selection of 50 without a value-change event", async () => {
    const user = userEvent.setup();
    const onTouch = vi.fn();
    const onChange = vi.fn();
    render(<Harness onTouch={onTouch} onChange={onChange} />);
    await user.pointer({ target: screen.getByRole("slider"), keys: "[MouseLeft]" });
    expect(onTouch).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(50);
    expect(screen.getByText("50")).toBeInTheDocument();
    expect(screen.getByRole("slider")).toHaveAccessibleDescription("50");
  });

  it("counts touch input at the current position as an intentional answer", async () => {
    const user = userEvent.setup();
    const onTouch = vi.fn();
    const onChange = vi.fn();
    render(<Harness onTouch={onTouch} onChange={onChange} />);
    await user.pointer({ target: screen.getByRole("slider"), keys: "[TouchA]" });
    expect(onTouch).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(50);
    expect(screen.getByText("50")).toBeInTheDocument();
  });

  it("ignores non-movement keys", () => {
    const onTouch = vi.fn();
    render(<Harness onTouch={onTouch} onChange={() => {}} />);
    fireEvent.keyDown(screen.getByRole("slider"), { key: "Tab" });
    expect(onTouch).not.toHaveBeenCalled();
  });
});

describe("PostRatingStrip", () => {
  it("uses the item wording and requires an answer", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<PostRatingStrip item={confidenceItem} onSubmit={onSubmit} />);
    expect(screen.getByRole("group", { name: confidenceItem.text })).toBeInTheDocument();
    expect(screen.getByText("1 = Not at all confident")).toBeInTheDocument();
    const next = screen.getByRole("button", { name: "Next" });
    expect(next).toBeDisabled();
    await user.click(next);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits exactly once", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    render(<PostRatingStrip item={confidenceItem} onSubmit={onSubmit} onChange={onChange} />);
    await user.click(screen.getByRole("radio", { name: "5" }));
    expect(onChange).toHaveBeenLastCalledWith(5);
    const next = screen.getByRole("button", { name: "Next" });
    expect(next).toBeEnabled();
    await user.dblClick(next);
    await user.click(next);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(5);
    expect(next).toBeDisabled();
  });

  it("guards a rapid double submit before re-render", () => {
    const onSubmit = vi.fn();
    render(<PostRatingStrip item={confidenceItem} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("radio", { name: "2" }));
    const form = screen.getByRole("button", { name: "Next" }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(2);
  });
});

describe("PostRatingStrip (chips mode)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const renderChips = (extra: Partial<React.ComponentProps<typeof PostRatingStrip>> = {}) => {
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    const onPendingChange = vi.fn();
    const ref = createRef<PostRatingStripHandle>();
    render(
      <PostRatingStrip
        ref={ref}
        mode="chips"
        autoSubmit
        item={confidenceItem}
        label="How sure are you?"
        minLabel="Not at all sure"
        maxLabel="Completely sure"
        onSubmit={onSubmit}
        onChange={onChange}
        onPendingChange={onPendingChange}
        {...extra}
      />,
    );
    return { onSubmit, onChange, onPendingChange, ref };
  };

  it("renders a labelled radiogroup of 7 chips with anchors", () => {
    renderChips();
    expect(screen.getByRole("radiogroup", { name: "How sure are you?" })).toBeInTheDocument();
    const chips = screen.getAllByRole("radio");
    expect(chips).toHaveLength(7);
    expect(chips[0]).toHaveAccessibleName("1, Not at all sure");
    expect(chips[6]).toHaveAccessibleName("7, Completely sure");
    expect(chips.every((c) => c.getAttribute("aria-checked") === "false")).toBe(true);
    expect(screen.getByText("1 Not at all sure")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  });

  it("auto-submits once after the undo window", () => {
    vi.useFakeTimers();
    const { onSubmit, onChange, onPendingChange } = renderChips();
    fireEvent.click(screen.getByRole("radio", { name: /^5/ }));
    expect(onChange).toHaveBeenCalledWith(5);
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByText(/Saving/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /^3/ })); // locked while pending
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(onSubmit).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(5);
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
  });

  it("Undo cancels and allows a new choice; the handle picks a value", () => {
    vi.useFakeTimers();
    const { onSubmit, ref } = renderChips();
    fireEvent.click(screen.getByRole("radio", { name: /^2/ }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: /^2/ })).toHaveAttribute("aria-checked", "false");
    act(() => ref.current!.choose(6));
    expect(screen.getByRole("radio", { name: /^6/ })).toHaveAttribute("aria-checked", "true");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(6);
  });

  it("without autoSubmit uses a Next button", () => {
    const { onSubmit } = renderChips({ autoSubmit: false });
    const next = screen.getByRole("button", { name: "Next" });
    expect(next).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /^4/ }));
    fireEvent.click(next);
    fireEvent.click(next);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(4);
  });
});

describe("ProgressBar", () => {
  it("shows the label and an accessible progressbar", () => {
    render(<ProgressBar current={9} total={24} label="Post 9 of 24" />);
    const bar = screen.getByRole("progressbar", { name: "Post 9 of 24" });
    expect(bar).toHaveAttribute("aria-valuenow", "9");
    expect(bar).toHaveAttribute("aria-valuemax", "24");
    expect(screen.getByText("Post 9 of 24")).toBeInTheDocument();
    expect((bar.firstChild as HTMLElement).style.width).toBe("37.5%");
  });

  it("clamps out-of-range values", () => {
    render(<ProgressBar current={30} total={24} label="x" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "24");
  });
});
