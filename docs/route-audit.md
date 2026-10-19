# Route audit — 19 October 2026

Scope: 20 API method/path patterns, 9 named frontend routes, the frontend wildcard, direct-page hosting, and the compiled Vercel entry point. Participant writes, cancellation, abandonment and deletion are tested only against isolated databases. Live production probes use public GET requests; they do not submit participation codes or create sessions.

Validation: production build/typecheck passed; **661 tests across 30 files passed** after the audit fixes.

## API coverage

`:id` below is a session UUID. Expected failures include malformed input, missing resources, duplicate submissions and inactive sessions where applicable.

| Method | Path | Expected valid response / checks |
|---|---|---|
| GET | `/api/health` | 200 JSON; version and bank hash |
| GET | `/api/practice` | 200; current and saved-media presentations, no private truth fields |
| POST | `/api/sessions` | 201 new, 200 resume, 409 used code; normalized, hashed identity |
| GET | `/api/sessions/:id` | 200 saved assignment/cursor; missing UUID 404 |
| POST | `/api/sessions/:id/resume` | 200 active; inactive 409 |
| POST | `/api/sessions/:id/consent` | 200; persisted consent and instructions cursor |
| POST | `/api/sessions/:id/cancel` | 200; retry safe, saved rows retained, completed session 409 |
| GET | `/api/sessions/:id/presentation/:block/:pos` | 200; saved assignment/ranges and public-field boundary |
| POST | `/api/sessions/:id/trials` | 201; assigned post, required confidence, scoring, timing and cursor persistence |
| POST | `/api/sessions/:id/events` | 200; JSON and beacon text, deduplication and final flush |
| PUT | `/api/sessions/:id/cursor` | 204; schema/range validation and saved cursor |
| POST | `/api/sessions/:id/block-surveys` | 201; stored questionnaire version, completed block, scoring and duplicates |
| POST | `/api/sessions/:id/exit-survey` | 200; four surveys required, completion and repeat-code rejection |
| GET | `/api/admin/kpis` | 200 authorized; cohort validation and no caching |
| GET | `/api/admin/assignments/:pid` | 200 authorized; positive safe integer validation |
| GET | `/api/admin/sessions` | 200 authorized; activity/status and no caching |
| POST | `/api/admin/sessions/:id/abandon` | 204; active only, data retained |
| DELETE | `/api/admin/sessions/:id` | 204; missing 404, related rows cascade |
| GET | `/api/admin/export` | 200 authorized; seven descriptions/counts |
| GET | `/api/admin/export/:name` | 200 for seven allowed files; others 404; content type, filename, auth and secret exclusions |

Export files checked: `participants.csv`, `trials.csv`, `surveys.csv`, `events.csv`, `exit.csv`, `kpis.csv`, `sessions.json`. Admin checks include missing/wrong tokens, header/download-token access, loopback rules and read-only behavior. Every admin response now uses `Cache-Control: no-store`.

The complete current journey covers 8 trial responses, 4 full questionnaires (64 ratings), exit, persisted scoring, completion and rejection of repeat participation. Saved brief/media and 24-trial plans remain version-specific. Unknown API routes and unsupported methods return JSON 404s, never the SPA document. Malformed JSON returns 400.

## Frontend coverage

| Route | Browser behavior |
|---|---|
| `/` | Public landing and Continue entry |
| `/start` | Public code entry; route follows returned new/resumed cursor |
| `/admin` | Public dashboard shell; data requires admin access |
| `/consent` | Session required; server cursor guard |
| `/instructions` | Session required; practice and server cursor guard |
| `/trial/:block/:pos` | Saved trial/post-rating cursor; URL edits redirect |
| `/survey/:block` | Saved block-survey cursor |
| `/exit` | Saved exit-survey cursor |
| `/debrief` | In-memory completion/cancellation only; refresh starts fresh |
| Other paths | Client redirects to `/` |

All nine named page paths serve the SPA document on direct navigation. Static assets and HEAD requests are checked separately. Browser routing tests cover missing sessions, stale storage, temporary resume failure/retry, completion, cancellation, Next participant and retention of admin access.

## Findings and limits

- Fixed missing cache protection on admin responses.
- Fixed stale browser session pointers after definitive 409 closed-session resume responses. Missing/closed sessions clear the pointer; temporary network/server failures retain it for retry.
- Existing API sequencing is permissive: a session UUID holder can set a schema-valid cursor and submit assigned trials outside the UI order. Consent and strict phase order are not enforced on every write endpoint. The frontend guard prevents ordinary URL skipping, but is not a server-side state machine. This audit preserves that existing API behavior; strict sequencing needs a separate protocol/compatibility change.
- Production at `https://trustable-ai.vercel.app` returned HTML 200 for all nine page URLs, but 500 for health, practice, admin reads and an unknown API URL during this audit. These live failures remain a deployment issue; passing local tests does not establish production readiness. Deploy the current fixed `dev` commit as Production, then repeat the API probes.
- No production participant records were created, changed, abandoned or deleted by this audit.

Compiled-handler checks against real Turso returned 200 for health, practice, admin sessions/KPIs/assignment preview/export index and all seven export files. Missing admin authorization returned 401; an unknown API path returned JSON 404. These checks were local invocations of the Vercel-compiled handler, not assertions about the live production deployment.

## Reproduce

Run `npm run typecheck`, `npm test`, and `npm run build`. Focused coverage is in `server/routes/route-audit.test.ts`, `server/routes/admin.test.ts`, `server/routing.test.ts`, `src/App.routes.test.tsx`, `server/vercel.test.ts` and `server/esm.test.ts`. The database adapter suite additionally exercises the real Turso SDK with isolated SQLite-backed HTTP streams, including stream expiry, atomic rollback and consent/admin requests.
