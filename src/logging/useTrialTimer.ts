// Per-trial timing (docs/system-design.md §5). All durations use performance.now().
// The decision timer starts at markShown() (label painted) and snapshot() is taken at the decision.
import { useCallback, useEffect, useRef, useState } from "react";
import type { FactorKey } from "../../shared/types";

export interface TimerSnapshot {
  labelShownAt: string;
  respondedAt: string;
  decisionTimeRawMs: number;
  hiddenMs: number;
  hiddenCount: number;
  blurCount: number;
  factSheetOpened: boolean;
  factSheetOpenMs: number;
  explanationOpened: boolean;
  factorsExpanded: FactorKey[];
  timeToFirstExpandMs: number | null;
}

interface TimerState {
  shownPerf: number | null;
  shownIso: string | null;
  hiddenSince: number | null;
  hiddenMs: number;
  hiddenCount: number;
  blurCount: number;
  factSheetOpen: boolean;
  factSheetSince: number | null; // null while closed or while the tab is hidden
  factSheetOpened: boolean;
  factSheetOpenMs: number;
  explanationOpened: boolean;
  timeToFirstExpandMs: number | null;
  factorsExpanded: FactorKey[];
}

const fresh = (): TimerState => ({
  shownPerf: null,
  shownIso: null,
  hiddenSince: null,
  hiddenMs: 0,
  hiddenCount: 0,
  blurCount: 0,
  factSheetOpen: false,
  factSheetSince: null,
  factSheetOpened: false,
  factSheetOpenMs: 0,
  explanationOpened: false,
  timeToFirstExpandMs: null,
  factorsExpanded: [],
});

const round = (n: number) => Math.max(0, Math.round(n));

export function useTrialTimer() {
  const s = useRef<TimerState>(fresh());
  const [shownAtIso, setShownAtIso] = useState<string | null>(null);

  useEffect(() => {
    const onVisibility = () => {
      const st = s.current;
      if (st.shownPerf === null) return;
      const now = performance.now();
      if (document.visibilityState === "hidden") {
        if (st.hiddenSince === null) st.hiddenSince = now;
        // Fact-sheet time counts only while the tab is visible.
        if (st.factSheetSince !== null) {
          st.factSheetOpenMs += now - st.factSheetSince;
          st.factSheetSince = null;
        }
      } else if (st.hiddenSince !== null) {
        st.hiddenMs += now - st.hiddenSince;
        st.hiddenCount += 1;
        st.hiddenSince = null;
        if (st.factSheetOpen) st.factSheetSince = now;
      }
    };
    const onBlur = () => {
      if (s.current.shownPerf !== null) s.current.blurCount += 1;
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const markShown = useCallback(() => {
    const st = s.current;
    if (st.shownPerf !== null) return;
    st.shownPerf = performance.now();
    st.shownIso = new Date().toISOString();
    setShownAtIso(st.shownIso);
  }, []);

  const onFactSheet = useCallback((open: boolean) => {
    const st = s.current;
    if (st.shownPerf === null) return;
    const now = performance.now();
    if (open && !st.factSheetOpen) {
      st.factSheetOpen = true;
      st.factSheetOpened = true;
      st.factSheetSince = st.hiddenSince === null ? now : null;
    } else if (!open && st.factSheetOpen) {
      if (st.factSheetSince !== null) st.factSheetOpenMs += now - st.factSheetSince;
      st.factSheetOpen = false;
      st.factSheetSince = null;
    }
  }, []);

  const onWhy = useCallback((open: boolean) => {
    const st = s.current;
    if (!open || st.shownPerf === null) return;
    if (!st.explanationOpened) {
      st.explanationOpened = true;
      st.timeToFirstExpandMs = round(performance.now() - st.shownPerf);
    }
  }, []);

  const onFactorExpand = useCallback((key: FactorKey) => {
    const st = s.current;
    if (st.shownPerf === null) return;
    if (!st.factorsExpanded.includes(key)) st.factorsExpanded.push(key);
  }, []);

  const snapshot = useCallback((): TimerSnapshot => {
    const st = s.current;
    const now = performance.now();
    const shown = st.shownPerf ?? now;
    let hiddenMs = st.hiddenMs;
    let hiddenCount = st.hiddenCount;
    if (st.hiddenSince !== null) {
      hiddenMs += now - st.hiddenSince;
      hiddenCount += 1;
    }
    let factSheetOpenMs = st.factSheetOpenMs;
    if (st.factSheetSince !== null) factSheetOpenMs += now - st.factSheetSince;
    return {
      labelShownAt: st.shownIso ?? new Date().toISOString(),
      respondedAt: new Date().toISOString(),
      decisionTimeRawMs: round(now - shown),
      hiddenMs: round(hiddenMs),
      hiddenCount,
      blurCount: st.blurCount,
      factSheetOpened: st.factSheetOpened,
      factSheetOpenMs: round(factSheetOpenMs),
      explanationOpened: st.explanationOpened,
      factorsExpanded: [...st.factorsExpanded],
      timeToFirstExpandMs: st.timeToFirstExpandMs,
    };
  }, []);

  const reset = useCallback(() => {
    s.current = fresh();
    setShownAtIso(null);
  }, []);

  return { markShown, shownAtIso, onFactSheet, onWhy, onFactorExpand, snapshot, reset };
}
