-- SQLite schema for the study app. Applied idempotently at server start (CREATE ... IF NOT EXISTS).
-- Field meanings follow docs/data-model.md; column names are snake_case of the TS fields.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
); -- schema_version, post_bank_hash, participant_salt (when PARTICIPANT_SALT is unset)

CREATE TABLE IF NOT EXISTS sessions (
  session_id         TEXT PRIMARY KEY,           -- uuid v4
  protocol_version   TEXT NOT NULL DEFAULT 'legacy-full-v1' CHECK (protocol_version IN ('legacy-full-v1','calibrated-brief-v1','calibrated-full-v1','calibrated-media-full-v1')),
  pid                INTEGER NOT NULL CHECK (pid >= 1),
  condition_order    TEXT NOT NULL,              -- e.g. "CDBA"
  set_rotation       INTEGER NOT NULL CHECK (set_rotation BETWEEN 0 AND 3),
  seed               INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','abandoned')),
  consequence_banner INTEGER NOT NULL DEFAULT 0,
  anxiety            INTEGER NOT NULL DEFAULT 0,
  cursor_block       INTEGER NOT NULL DEFAULT 1,
  cursor_position    INTEGER NOT NULL DEFAULT 1,
  cursor_phase       TEXT NOT NULL DEFAULT 'consent',
  resume_count       INTEGER NOT NULL DEFAULT 0,
  post_bank_hash     TEXT NOT NULL,
  app_version        TEXT NOT NULL,
  started_at         TEXT NOT NULL,
  consent_at         TEXT,
  completed_at       TEXT,
  participant_hash   TEXT,                       -- hex HMAC-SHA256(salt, normalised participation code); raw code never stored
  last_activity_at   TEXT                        -- ISO time of the last participant write (stale-session sweep)
);
CREATE INDEX IF NOT EXISTS idx_sessions_pid ON sessions(pid);
-- idx_sessions_participant_hash (UNIQUE, partial: WHERE participant_hash IS NOT NULL) is created in db.ts
-- after the column migration, so this file still applies cleanly to databases made with the v1 schema.

CREATE TABLE IF NOT EXISTS blocks (
  session_id   TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  block_index  INTEGER NOT NULL CHECK (block_index BETWEEN 1 AND 4),
  condition    TEXT NOT NULL CHECK (condition IN ('A','B','C','D')),
  set_id       TEXT NOT NULL CHECK (set_id IN ('S1','S2','S3','S4')),
  post_order   TEXT NOT NULL,                    -- JSON array of 6 post ids
  started_at   TEXT,
  ended_at     TEXT,
  PRIMARY KEY (session_id, block_index)
);

CREATE TABLE IF NOT EXISTS trials (
  trial_id                 TEXT NOT NULL,        -- `${pid}-${blockIndex}-${positionInBlock}` (docs format; not unique across replacement sessions)
  session_id               TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  pid                      INTEGER NOT NULL,
  block_index              INTEGER NOT NULL,
  position_in_block        INTEGER NOT NULL,
  trial_index              INTEGER NOT NULL,     -- 1-24
  post_id                  TEXT NOT NULL,
  condition                TEXT NOT NULL,
  set_id                   TEXT NOT NULL,
  topic                    TEXT NOT NULL,
  ai_label                 TEXT NOT NULL,
  ground_truth             TEXT NOT NULL,
  is_ai_correct            INTEGER NOT NULL,
  error_type               TEXT,                 -- NULL | false_alarm | miss
  difficulty               TEXT,                 -- NULL | clear | subtle
  agreed                   INTEGER NOT NULL,
  detected_error           INTEGER,              -- NULL on correct labels
  confidence               INTEGER NOT NULL CHECK (confidence BETWEEN 1 AND 7),
  label_shown_at           TEXT NOT NULL,
  responded_at             TEXT NOT NULL,
  decision_time_raw_ms     REAL NOT NULL,
  hidden_ms                REAL NOT NULL,
  hidden_count             INTEGER NOT NULL,
  blur_count               INTEGER NOT NULL,
  decision_time_ms         REAL NOT NULL,
  timing_flag              INTEGER NOT NULL,
  fact_sheet_opened        INTEGER NOT NULL,
  fact_sheet_open_ms       REAL NOT NULL,
  explanation_opened       INTEGER,              -- NULL unless C
  factors_expanded         TEXT NOT NULL,        -- pipe-separated keys, '' if none
  time_to_first_expand_ms  REAL,
  resumed                  INTEGER NOT NULL,
  saved_at                 TEXT NOT NULL,
  PRIMARY KEY (session_id, block_index, position_in_block)
);
CREATE INDEX IF NOT EXISTS idx_trials_session ON trials(session_id);

CREATE TABLE IF NOT EXISTS events (
  session_id   TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  trial_id     TEXT,
  block_index  INTEGER,
  condition    TEXT,
  post_id      TEXT,
  type         TEXT NOT NULL,
  factor_key   TEXT,
  t_ms         REAL,
  perf_now     REAL NOT NULL,
  wall_clock   TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS block_surveys (
  session_id               TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  block_index              INTEGER NOT NULL CHECK (block_index BETWEEN 1 AND 4),
  condition                TEXT NOT NULL,
  trust_raw                TEXT NOT NULL,        -- JSON array of 12 raw answers
  trust_scored             TEXT NOT NULL,        -- JSON array of 12 scored answers (items 1-5 reversed: 8 - raw)
  questionnaire_version    TEXT NOT NULL DEFAULT 'full-v1' CHECK (questionnaire_version IN ('full-v1','brief-v1')),
  brief_trust              INTEGER CHECK (brief_trust BETWEEN 1 AND 7),
  trust_mean               REAL,
  fairness1                INTEGER,
  fairness2                INTEGER,
  fairness_mean            REAL,
  tension                  INTEGER NOT NULL CHECK (tension BETWEEN 1 AND 7),
  frustration_tlx          INTEGER NOT NULL CHECK (frustration_tlx BETWEEN 0 AND 100 AND frustration_tlx % 5 = 0),
  frustration_tlx_touched  INTEGER NOT NULL CHECK (frustration_tlx_touched = 1),
  n_wrong_detected         INTEGER NOT NULL CHECK (n_wrong_detected BETWEEN 0 AND 2),
  anxiety                  TEXT,                 -- JSON or NULL (optional feature)
  submitted_at             TEXT NOT NULL,
  PRIMARY KEY (session_id, block_index)
);

CREATE TABLE IF NOT EXISTS exit_surveys (
  session_id          TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  age_range           TEXT NOT NULL,
  gender              TEXT,
  education           TEXT NOT NULL,
  social_media_use    TEXT NOT NULL,
  label_exposure      TEXT NOT NULL,
  preferred_condition TEXT NOT NULL,
  comment             TEXT NOT NULL DEFAULT '',
  submitted_at        TEXT NOT NULL
);
