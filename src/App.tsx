import React, { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { StudyProvider, routeForCursor, useStudy } from "./state/StudyContext";
import LandingScreen from "./study/LandingScreen";
import WelcomeScreen from "./study/WelcomeScreen";
import ConsentScreen from "./study/ConsentScreen";
import InstructionsScreen from "./study/InstructionsScreen";
import TrialScreen from "./study/TrialScreen";
import BlockSurveyScreen from "./study/BlockSurveyScreen";
import ExitSurveyScreen from "./study/ExitSurveyScreen";
import DebriefScreen from "./study/DebriefScreen";
import AdminScreen from "./admin/AdminScreen";
import { LoggerProvider } from "./logging/logger";
import StudyExitControl from "./study/StudyExitControl";

/** Keeps participants on the route for the server cursor (blocks Back-button skipping and URL edits). */
function ParticipantGuard({ children }: { children: JSX.Element }) {
  const { session, resume } = useStudy();
  const location = useLocation();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (session) return;
    let alive = true;
    void resume().then(() => {
      if (alive) setChecked(true);
    });
    return () => {
      alive = false;
    };
  }, [session, resume]);

  if (!session) {
    if (checked) return <Navigate to="/" replace />;
    return (
      <main className="screen">
        <p>Loading…</p>
      </main>
    );
  }
  const expected = routeForCursor(session.cursor);
  if (location.pathname !== expected) return <Navigate to={expected} replace />;
  return <><StudyExitControl />{children}</>;
}

/** One event logger per active session; numbering continues from the server after a resume. */
function SessionLogger({ children }: { children: React.ReactNode }) {
  const { session } = useStudy();
  return (
    <LoggerProvider sessionId={session?.sessionId ?? null} startSeq={session?.nextEventSeq ?? 1}>
      {children}
    </LoggerProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <StudyProvider>
        <SessionLogger>
        <Routes>
          <Route path="/" element={<LandingScreen />} />
          <Route path="/start" element={<WelcomeScreen />} />
          {/* Admin is reached by URL only (no link from the participant pages). */}
          <Route path="/admin" element={<AdminScreen />} />
          <Route path="/consent" element={<ParticipantGuard><ConsentScreen /></ParticipantGuard>} />
          <Route path="/instructions" element={<ParticipantGuard><InstructionsScreen /></ParticipantGuard>} />
          <Route path="/trial/:block/:pos" element={<ParticipantGuard><TrialScreen /></ParticipantGuard>} />
          <Route path="/survey/:block" element={<ParticipantGuard><BlockSurveyScreen /></ParticipantGuard>} />
          <Route path="/exit" element={<ParticipantGuard><ExitSurveyScreen /></ParticipantGuard>} />
          <Route path="/debrief" element={<ParticipantGuard><DebriefScreen /></ParticipantGuard>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </SessionLogger>
      </StudyProvider>
    </BrowserRouter>
  );
}
