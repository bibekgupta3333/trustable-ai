/**
 * FactSheetPanel: "Fact sheet ▸" toggle plus a panel (wireframes §6). Identical in every
 * condition and never mentions the AI label. [×], Esc, the toggle again, or (on phones) a tap
 * on the backdrop closes it.
 *
 * Layout is pure CSS (global.css):
 *   ≥ 1000 px  right-hand side panel; the page makes room so post + buttons stay usable.
 *   700–999 px panel flows in place under its toggle.
 *   < 700 px   bottom sheet: slides up, max-height 70vh, scrolls, drag-handle visual, backdrop.
 *
 * Focus: opening moves focus to the panel title; closing returns focus to the toggle (only when
 * focus would otherwise be lost, i.e. it was inside the panel or on <body>).
 *
 * CSS classes:
 *   .fact-sheet                 wrapper (toggle + panel)
 *   .fact-sheet--open           wrapper modifier while open
 *   .fact-sheet__toggle         "Fact sheet ▸" / "Fact sheet ◂" button
 *   .fact-sheet__backdrop       tap-to-close scrim (visible only in bottom-sheet mode)
 *   .fact-sheet__panel          <aside> panel
 *   .fact-sheet__handle         drag-handle visual (bottom-sheet mode only, decorative)
 *   .fact-sheet__header         panel header row (heading + close)
 *   .fact-sheet__heading        "Fact sheet" small heading
 *   .fact-sheet__close          [×] close button
 *   .fact-sheet__title          fact sheet title (receives focus on open)
 *   .fact-sheet__body           1–3 sentence body
 *   .fact-sheet__source         "Source: … (fictional)"
 */
import { useEffect, useId, useRef } from "react";
import type { FactSheet } from "../../shared/types";

export interface FactSheetPanelProps {
  factSheet: FactSheet;
  open: boolean;
  onToggle(open: boolean): void;
  /** Disables the toggle (e.g. during "AI is checking…"). */
  disabled?: boolean;
}

export default function FactSheetPanel({ factSheet, open, onToggle, disabled = false }: FactSheetPanelProps) {
  const panelId = useId();
  const titleId = `${panelId}-title`;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const focusInPanel = useRef(false);
  const wasOpen = useRef(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onToggle(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onToggle]);

  // Focus management: heading on open, toggle on close.
  useEffect(() => {
    if (open && !wasOpen.current) {
      focusInPanel.current = false;
      titleRef.current?.focus({ preventScroll: true });
    } else if (!open && wasOpen.current) {
      const active = document.activeElement;
      const lost = !active || active === document.body || focusInPanel.current;
      if (lost && toggleRef.current && !toggleRef.current.disabled) toggleRef.current.focus();
      focusInPanel.current = false;
    }
    wasOpen.current = open;
  }, [open]);

  return (
    <div className={`fact-sheet${open ? " fact-sheet--open" : ""}`}>
      <button
        ref={toggleRef}
        type="button"
        className="fact-sheet__toggle"
        aria-expanded={open}
        aria-controls={panelId}
        disabled={disabled}
        onClick={() => onToggle(!open)}
      >
        {open ? "Fact sheet ◂" : "Fact sheet ▸"}
      </button>
      {open && (
        <>
          <div className="fact-sheet__backdrop" aria-hidden="true" onClick={() => onToggle(false)} />
          <aside
            id={panelId}
            ref={panelRef}
            className="fact-sheet__panel"
            aria-labelledby={titleId}
            onFocus={() => {
              focusInPanel.current = true;
            }}
            onBlur={(e) => {
              focusInPanel.current = panelRef.current?.contains(e.relatedTarget as Node | null) ?? false;
            }}
          >
            <span className="fact-sheet__handle" aria-hidden="true" />
            <div className="fact-sheet__header">
              <span className="fact-sheet__heading">Fact sheet</span>
              <button
                type="button"
                className="fact-sheet__close"
                aria-label="Close fact sheet"
                onClick={() => onToggle(false)}
              >
                ×
              </button>
            </div>
            <h2 id={titleId} ref={titleRef} tabIndex={-1} className="fact-sheet__title">
              {factSheet.title}
            </h2>
            <p className="fact-sheet__body">{factSheet.body}</p>
            <p className="fact-sheet__source">Source: {factSheet.source}</p>
          </aside>
        </>
      )}
    </div>
  );
}
