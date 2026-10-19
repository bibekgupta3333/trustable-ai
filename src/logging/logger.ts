// One logger per session. Buffers interaction events, assigns a strictly increasing seq,
// and flushes them to the server. Failed flushes keep the events for the next attempt;
// the server ignores duplicate (session, seq) pairs, so retries never double-insert.
import { createContext, createElement, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { EventSubmission } from "../../shared/api";
import { api } from "../api/client";

export const AUTO_FLUSH_MS = 5000;

export interface Logger {
  log(e: Omit<EventSubmission, "seq" | "perfNow" | "wallClock">): void;
  flush(): Promise<void>;
  nextSeq(): number;
  /** Extra (not in CONTRACT): clears the auto-flush timer and the pagehide listener. */
  dispose(): void;
}

export function createLogger(sessionId: string, startSeq = 1): Logger {
  let seq = startSeq;
  let buffer: EventSubmission[] = [];
  let inFlight: Promise<void> | null = null;
  let disposed = false;

  const flush = async (): Promise<void> => {
    // Serialize flushes so the same events are never sent twice at once.
    while (inFlight) {
      await inFlight;
    }
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    inFlight = (async () => {
      try {
        await api.submitEvents(sessionId, batch);
      } catch {
        // Keep the events (ahead of anything logged meanwhile) for the next flush.
        buffer = batch.concat(buffer);
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  };

  const onPageHide = () => {
    if (buffer.length === 0) return;
    const events = buffer;
    const nav = typeof navigator !== "undefined" ? navigator : undefined;
    if (nav && typeof nav.sendBeacon === "function") {
      const ok = nav.sendBeacon(
        `/api/sessions/${sessionId}/events`,
        new Blob([JSON.stringify({ events })], { type: "text/plain" }),
      );
      // If the beacon was queued, the events are handed off; the server dedups by seq anyway.
      if (ok) buffer = [];
    }
  };

  const timer = setInterval(() => {
    void flush();
  }, AUTO_FLUSH_MS);
  if (typeof window !== "undefined") window.addEventListener("pagehide", onPageHide);

  return {
    log(e) {
      if (disposed) return;
      buffer.push({
        ...e,
        seq: seq++,
        perfNow: performance.now(),
        wallClock: new Date().toISOString(),
      });
    },
    flush,
    nextSeq: () => seq,
    dispose() {
      disposed = true;
      clearInterval(timer);
      if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
    },
  };
}

// ---------- React context ----------
const LoggerContext = createContext<Logger | null>(null);

export function LoggerProvider(props: { sessionId: string | null; startSeq?: number; children: ReactNode }) {
  const { sessionId, startSeq } = props;
  const logger = useMemo(
    () => (sessionId ? createLogger(sessionId, startSeq ?? 1) : null),
    // startSeq only matters when the logger is created for a new session id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId],
  );
  useEffect(() => {
    if (!logger) return;
    return () => {
      void logger.flush();
      logger.dispose();
    };
  }, [logger]);
  return createElement(LoggerContext.Provider, { value: logger }, props.children);
}

/** Returns the session logger, or null when no session is active. */
export function useLogger(): Logger | null {
  return useContext(LoggerContext);
}
