# Deploy frontend and backend to Vercel with Turso

One Vercel project serves the React/Vite build and Express API on the same domain. Hosted responses persist in **remote Turso**, accessed with `@tursodatabase/serverless`. Local development retains SQLite through better-sqlite3 when neither Turso variable is configured. Vercel requires remote storage and must not fall back to its ephemeral local filesystem.

The SDK and `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` connection settings follow the [official Turso TypeScript reference](https://docs.turso.tech/sdk/ts/reference). This app uses the remote serverless SDK; local better-sqlite3 is a separate development fallback.

## Included setup

- `vercel.json`: Vite build, `/api` routing to a Node function, static files and React Router fallback.
- `api/index.ts`: Express entry point for Vercel Functions.
- `server/runtime.ts`: selects remote Turso or local SQLite and checks required hosted configuration.
- `server/db/async.ts`: asynchronous adapters used by repository queries and transactions.
- `scripts/setup-turso.ts`: explicit, non-destructive remote schema bootstrap, invoked by `npm run db:setup`.
- `.env.example`, `.gitignore`, `.vercelignore`: server variable examples and exclusions for local data and secrets.

The frontend calls relative `/api` URLs. A second backend domain and separate CORS configuration are unnecessary.

Vercel runs the compiled backend with native Node ESM. Keep `.js` extensions on relative imports in API/server/shared TypeScript dependencies, and `with { type: "json" }` on runtime JSON imports. Local `tsx` execution can hide these deployment errors; the native-module regression test checks compiled imports without that loader.

The Turso adapter opens a fresh SQL stream for each top-level operation or transaction, closes it afterward, and keeps nested statements on that transaction's stream. Streams are not reused across participant pauses or warm-function idle gaps. A failed or uncertain write is never automatically replayed. Cleanup failures cannot turn a confirmed commit into an apparent save failure.

## 1. Bootstrap the Turso schema before deploying

Use this database URL:

```text
turso://trustableai-bibekgupta3333.aws-us-east-1.turso.io
```

Before the first deployment, an operator must initialize the schema once. From the project root, install dependencies with `npm ci --include=dev`. In a private operator environment, set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`, then run:

```bash
npm run db:setup
```

This command runs the Turso setup script and loads `.env` followed by `.env.local` when present. Shell/host variables take precedence. **Only the two Turso variables are required for bootstrap.** The script initializes an empty database and checks an existing schema without deleting participant records. An incompatible or incomplete existing schema must be investigated rather than reset. Do not drop tables or delete data to make deployment succeed.

For an explicitly loaded private local file, copy `.env.example` to `.env.local`, configure the two Turso values privately, then use:

```bash
node --env-file=.env.local --import tsx scripts/setup-turso.ts
```

The npm run commands load `.env` and `.env.local` automatically; direct `node` commands need the explicit `--env-file` flag. Enter the deployment token directly in Vercel; do not share it in chat, source code, screenshots or frontend variables. If running bootstrap locally, provide the token privately to that operator environment too. Merely saving variables in Vercel does not bootstrap the database. Remote bootstrap requires credentials and has not been run as part of these documentation changes.

### Existing local study data

Schema bootstrap does **not** upload or migrate local participant data. Preserve the original SQLite database. For a consistent local backup, stop the application before copying it or use a SQLite-aware backup; copying only the main file while WAL writes are active is unsafe.

If existing participants must continue in Turso, plan and validate a separate data transfer before switching collection. Preserve session IDs, saved plans, protocol versions and the original HMAC salt. Verify schema compatibility, table counts, representative saved sessions and resume/duplicate-code behavior. Do not assume an arbitrary local SQLite file can be restored directly into this Turso engine. An empty schema is appropriate for a fresh study, not a substitute for transferring existing records.

## 2. Configure one Vercel project

Import the `trustable-ai` repository:

| Setting | Value |
|---|---|
| Root Directory | Repository root containing `package.json` and `vercel.json` |
| Framework | Vite |
| Node.js | 22.x |
| Install | `npm ci --include=dev` |
| Build | `npm run build` |
| Output | `dist` |

There is no production `npm start` process on Vercel. Express runs as a Node function; Vercel serves the frontend assets. React Router paths such as `/start`, `/survey/1` and `/admin` receive the SPA; `/api/...` goes to Express. Keep frontend and backend in this single project. See [Vercel Vite support](https://vercel.com/docs/frameworks/frontend/vite) and [Node runtime](https://vercel.com/docs/functions/runtimes/node-js).

### Deploy the dev branch

`vercel.json` enables automatic Git deployments for `dev` and disables them for other branches. Commit and push this configuration to `dev` so Vercel can use it.

To have `dev` update the production domain, set **Project Settings → Environments → Production → Branch Tracking** to **dev**, then save. The production branch is a Vercel project setting; `git.deploymentEnabled` controls which branches trigger deployments and does not select the production branch. See [Vercel branch tracking](https://vercel.com/docs/git#customizing-the-production-branch) and [Git configuration](https://vercel.com/docs/project-configuration/git-configuration).

## 3. Set the four required Vercel variables

In Vercel → Project → Settings → Environment Variables:

| Variable | Required value |
|---|---|
| `TURSO_DATABASE_URL` | `turso://trustableai-bibekgupta3333.aws-us-east-1.turso.io` |
| `TURSO_AUTH_TOKEN` | Private database token; enter it directly in Vercel |
| `ADMIN_TOKEN` | Strong private admin secret |
| `PARTICIPANT_SALT` | Stable private HMAC secret; preserve the original value for existing participants |
| `STALE_MINUTES` | Optional; defaults to 120 |

All four required values must be present for Vercel runtime startup. Bootstrap uses only the first two. Generate the admin token and participant salt separately; `openssl rand -hex 32` can generate each new secret for a fresh study. Store them securely and keep the salt stable across redeployments.

Do not prefix these variables with `VITE_`. Do not use `DB_PATH` for hosted persistence. A partially configured Turso connection is an error, not permission to use local storage. Use separate Turso databases for Preview/rehearsal and Production, with the matching tokens and Vercel environment scopes. Redeploy after changing variables.

## 4. Deploy and verify

After successful bootstrap and variable configuration, deploy through Vercel's dashboard or authenticated CLI. Documentation changes do not publish the application or verify a cloud connection.

1. Open the deployment URL and confirm the landing page loads.
2. Open `/api/health`; expect JSON with `ok: true`, app version and post-bank hash.
3. On Preview with its separate demonstration database, start a demo session and exercise consent, practice, trial decisions, confidence and the full questionnaire.
4. Refresh mid-session and verify resume and the saved cursor.
5. Complete eight trials, four questionnaires and the final survey; verify debrief and participant browser-storage cleanup.
6. Open `/admin`, enter the admin token and verify missing/incorrect tokens are rejected.
7. Download a CSV and check saved rows. Verify data remains after a redeployment or cold start.
8. Inspect logs for connection/schema errors without exposing credentials.

If production reports `ERR_MODULE_NOT_FOUND` while a newer Preview works, compare deployment IDs and commits. The production domain can still point to an older deployment. Confirm **Production → Branch Tracking → dev**, configure the required variables in **Production**, and create a Production deployment from the updated `dev` commit. A new Preview URL alone does not update production.

Unexpected request errors log only safe classifications (known error name, SQLite code, upstream HTTP status and route template). They omit SQL, raw error messages, credentials and session identifiers. Use those classifications to diagnose later failures; a historical generic `Unhandled API request error` does not establish its underlying cause.

A `503 backend_unavailable` can indicate missing variables, an invalid token, a connection failure or schema bootstrap still required. Check settings and bootstrap before inviting participants. Treat ambiguous participant-save failures carefully; session and duplicate checks remain authoritative.

## Local operation and recovery

The npm run commands load `.env` and then `.env.local`; existing shell variables take precedence. Restart the backend after editing these files. With neither `TURSO_DATABASE_URL` nor `TURSO_AUTH_TOKEN` set in the shell or loaded files, `npm run dev` uses local better-sqlite3 and `data/study.db` (or `DB_PATH`). For a local rehearsal, use a separate file. Copying `.env.example` with its configured Turso URL and an empty token does not enable the local fallback: leave both Turso variables unset for local-only work.

To run the local API against Turso, explicitly load private variables:

```bash
node --env-file=.env.local --import tsx server/index.ts
```

For general local verification:

```bash
npm run typecheck
npm test
npm run build
```

Tests do not establish connectivity to the real Turso database or a successful Vercel deployment. Those require private configuration and separate verification.

Local SQLite backup instructions apply only to local files. For hosted recovery, configure and verify the appropriate Turso backup/recovery process separately. CSV/JSON analysis exports omit identity linkage and salt and are not a restorable database backup. Vercel's local filesystem is not persistent study storage. See [Vercel's SQLite persistence guidance](https://vercel.com/kb/guide/is-sqlite-supported-in-vercel).
