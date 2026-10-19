# Do People Trust AI More When It Explains Itself? A Comparative Study of Explanation

CEN5728 Advanced HCI — Group 4, graduate study at Florida Polytechnic University.

**Members:** Afzal Hossain Sohag, Bibek Gupta, Deepthi Reddy Chelladi, Md Shamimul Islam, Mohamed Sylla and Siwani Sah.

## Project overview and current design

The application studies whether explanation interfaces help people accept correct AI labels and reject incorrect ones, alongside trust, fairness, tension and frustration. Participants judge fictional social-media claims from Riverton and Alder County. Labels and explanations are scripted **Wizard-of-Oz** stimuli; no live AI model, external fact-checker or social feed runs.

New sessions use `calibrated-full-v1`: **8 text-only posts, 4 parts of 2 posts**, sampled from a 24-post bank. Each part has one correct and one wrong label. Participants agree/disagree and select confidence from 1–7. Optional fact sheets provide checking evidence. After every part, the full questionnaire collects 12 Jian-based trust items, 2 fairness items, tension and frustration: **16 ratings per part, 64 total**, in addition to trial confidence and final questions.

| Condition | Interface beneath the AI label |
|---|---|
| A | Label only |
| B | One static reason |
| C | Why? opens Source, Claim vs record and Wording details |
| D | A counterfactual sentence describing what would change the label |


## Technologies and devices

| Layer | Technologies and purpose |
|---|---|
| Platform/language | Node.js 22+, TypeScript, HTML and CSS |
| Frontend | React 18, React Router 6 and Vite: screens, navigation and builds |
| Backend | Express 5 and tsx: HTTP API, validation and session transitions |
| Persistence | SQLite via better-sqlite3 locally; remote Turso via @tursodatabase/serverless on Vercel |
| Study logic | Scripted JSON bank, Williams orders and seeded randomization |
| Verification | Vitest, Testing Library, jsdom and Supertest |
| Analysis | Admin dashboard and CSV/JSON exports |

Participants use a web browser on a desktop/laptop or responsive phone/tablet; no native app is required. Desktop/laptop is recommended for the full questionnaire and demonstration. Layout targets include 360 px phones and 1280 px desktops; this is not a claim that every browser/device has been tested. The Node/SQLite server runs on a computer or deployment host, not in the participant's phone.

The application has moved from `HCI/app/` to `/Users/bibekgupta/Downloads/projects/trustable-ai/`. The HCI research documents remain in the sibling `HCI/` folder. Run npm commands from this project root.

## Step-by-step: run from source

1. Extract the source ZIP and open a terminal in its project root containing `package.json`.
2. Install Node.js; Node 22 LTS is recommended. Check `node --version` and `npm --version`.
3. Run `npm ci --include=dev` using the included lockfile. Registry access is needed. If better-sqlite3 requires compilation, install Python and the platform C++ toolchain.
4. Run `npm run dev` and keep the terminal open. This starts Express on port 3001 and Vite on port 5173.
5. Open **http://localhost:5173/** for participants and **http://localhost:5173/admin** for admin. Vite proxies `/api` to port 3001. If Vite selects another port, use the URL it prints.
6. Follow the interaction steps below. With neither Turso variable configured, the local server creates the SQLite schema automatically; no database service or manual SQL import is needed. Hosted Turso requires the explicit bootstrap described below.
7. Stop development with Ctrl+C. For a single production server, run `npm run build`, then `npm start`; open **http://localhost:3001/** and `/admin`.

```bash
cd trustable-ai
npm ci --include=dev
npm run dev
```

Production on macOS/Linux:

```bash
npm run build
npm start
```

`npm start` uses POSIX environment syntax. On Windows, use Git Bash/WSL, or after building run this in `cmd`:

```bat
set NODE_ENV=production&& npx tsx server/index.ts
```

Use a separate database for rehearsals. On macOS/Linux: `DB_PATH=data/submission-demo.db npm start`. On Windows `cmd`, set `DB_PATH=data/submission-demo.db` before the production command. Never delete the study database to restart a demo.

Verification commands, from the project root:

```bash
npm test
npm run typecheck
npm run build
```

HTTP tests need permission to open local loopback ports. No lint script is defined.

## How to interact: participant

1. Open the landing page, read the study summary and select **Take part**.
2. Enter a non-identifying participation code and select **Start**. No admin/researcher permission is required. One completed or abandoned session is allowed per code; codes do not verify identity.
3. Read consent, confirm adult eligibility and proceed to instructions and one unscored practice post.
4. For each study post, optionally open **Fact sheet**. In C, use **Why?** and its expandable rows if desired.
5. Choose **Agree with label** or **Disagree with label**, then confidence 1–7. A brief Undo opportunity appears before saving; the flow advances automatically.
6. After each two-post part, answer all 16 questionnaire ratings. Move the frustration slider deliberately; its initial position is not an answer.
7. Complete all four parts, the final survey and debrief. The preference question names the actual explanation style for each assigned part.
8. Select **Next participant** to return to a fresh landing page. Successful completion clears participant study browser-storage keys while preserving the admin token and unrelated storage.

Keyboard: A agree, D disagree, 1–7 confidence, F fact sheet, W Why when available, Escape closes panels. Use **Exit study** on an active participant screen to confirm early cancellation. Saved responses remain, the session becomes abandoned and an early debrief appears. Cancellation does not submit unfinished answers.

To resume an unfinished session, use **Continue** on the same browser or enter the same code on another device. The saved server cursor is authoritative. Stale sessions can be abandoned during a subsequent session-creation request after the inactivity threshold; indefinite resume is not guaranteed.

## How to interact: admin and exports

Open `/admin` on the same frontend origin. Admin monitors data, KPIs and exports; it does not start participants. Enter the configured admin token if required. The page refreshes about every 15 seconds.

1. Inspect status/progress and the selected protocol cohort. Outcome summaries default to current full-questionnaire sessions and use completed non-pilot sessions; status counts also describe unfinished/abandoned sessions.
2. Inspect appropriate reliance, wrong-label rejection, correct-label acceptance, trust and affect. Higher agreement alone is not success.
3. In **Export**, download an individual file or **Download all CSVs**. Optionally include raw JSON. Open a downloaded demonstration CSV to verify it is usable.
4. Use abandon/delete controls only for intentional session management: abandon preserves saved data; withdrawal deletion removes the session and linked rows.

| Export | Contents |
|---|---|
| `participants.csv` | One row per session, all statuses, summaries and exit answers |
| `trials.csv` | Saved trial decisions, truth/scoring, confidence, timing and interactions |
| `surveys.csv` | Versioned questionnaire answers and scores; historical brief rows leave uncollected full fields blank |
| `events.csv` | Interaction events and timestamps |
| `exit.csv` | Final survey answers |
| `kpis.csv` | Dashboard metrics; outcome and status denominators differ |
| `sessions.json` | Nested analysis data, excluding participation-code hash and salt |

New completed sessions contain eight trials; older plans can contain 24. Raw exports include unfinished/abandoned sessions and multiple protocols. Filter appropriately before analysis. The frustration measure is one NASA-TLX item, not the full weighted instrument.

## Vercel deployment — frontend and backend together

One Vercel project serves the Vite frontend and Express API on the same domain; browser requests use relative `/api` URLs. Hosted responses use **remote Turso through `@tursodatabase/serverless`**. Local development retains the better-sqlite3 fallback when neither Turso variable is configured. See [DEPLOYMENT.md](DEPLOYMENT.md) for schema bootstrap, environment variables and deployment verification.

Set all four server variables in Vercel: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `ADMIN_TOKEN` and a stable `PARTICIPANT_SALT`. The database URL is `turso://trustableai-bibekgupta3333.aws-us-east-1.turso.io`. Enter the auth token directly in Vercel; keep it out of source, screenshots and shared messages.

**Before the first deployment**, run the non-destructive schema bootstrap once from an operator environment with `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` set: `npm run db:setup` runs the Turso setup script and loads the local environment files. It initializes an empty database and checks existing schema compatibility without deleting participant records. Bootstrap needs those two Turso variables, not the admin token or participant salt. Setting Vercel variables alone does not run this command. Remote setup cannot be performed without credentials and is not claimed as completed here.

Vercel requires remote persistence and all four variables; it must not fall back to a local SQLite file. Adding this configuration does not deploy the app or verify its cloud connection.

## Configuration, data and deployment

| Variable | Default / purpose |
|---|---|
| `PORT` | 3001, Express port |
| `HOST` | 127.0.0.1, local binding; use 0.0.0.0 only for deliberate network access |
| `DB_PATH` | Local SQLite only: `data/study.db`, relative to the project root |
| `TURSO_DATABASE_URL` | Remote Turso URL; required on Vercel |
| `TURSO_AUTH_TOKEN` | Private Turso database token; required on Vercel |
| `ADMIN_TOKEN` | Required on Vercel and every shared/proxy deployment; optional for local loopback use |
| `PARTICIPANT_SALT` | Required stable HMAC secret on Vercel; local SQLite generates one in database metadata if unset |
| `STALE_MINUTES` | 120; stale sweeping occurs during session creation |

`npm run dev`, `npm start` and `npm run db:setup` load `.env` and then `.env.local` when present. Existing shell/host variables take precedence. With Turso credentials in either file, the backend uses Turso; local SQLite is used only when both Turso variables are absent. Restart the backend after editing environment files. Vite's proxy targets port 3001; changing backend `PORT` also requires updating the proxy. Remote participants need a reachable HTTPS URL; `localhost` on a phone refers to that phone. A local proxy can appear as loopback, so configure `ADMIN_TOKEN` rather than relying on network origin alone. Keep the participation salt stable across restarts.

Local SQLite uses WAL and foreign keys. Successfully committed answers persist; unfinished input and unflushed events may need re-entry. For a recovery backup, stop the server before copying the database, or use a SQLite-aware backup. Copying only the main file while WAL writes are active is unsafe. Analysis exports omit identity linkage/salt and are not a restorable database backup. For hosted recovery, use Turso backup/recovery facilities and verify restoration separately; a local SQLite file copy is not a backup of the remote database. Analysis exports are not a restorable Turso backup either. Preserve real study data separately from demos.

## Application screenshots

These are genuine Chromium screenshots of the running application. Desktop captures use a 1440 px viewport; the full-questionnaire captures use a taller viewport to keep the fixed footer clear. Mobile examples use 390 × 844 px. Demonstration answers and KPI values are not research findings. The gallery covers every application route and the important interaction states; all eight posts use the same trial-page template.

### Landing page — `/`

Introduces the study, four parts, eligibility and privacy.

![Public landing page](docs/screenshots/01-landing.png)

### Participation code — `/start`

Starts a new session or resumes an unfinished one without admin approval.

![Participation-code entry](docs/screenshots/02-start.png)

### Consent — `/consent`

Explains voluntary participation and asks for consent and adult eligibility.

![Consent page](docs/screenshots/03-consent.png)

<details>
<summary>Expanded full consent details</summary>

![Expanded consent details](docs/screenshots/03b-consent-details.png)

</details>

### Instructions and practice — `/instructions`

Explains decisions, confidence and fact-sheet access, followed by an unscored practice post.

![Instructions and practice](docs/screenshots/04-instructions-practice.png)

### Study trials — `/trial/:block/:pos`

A–D use the same post, label and response controls. The explanation style changes by assigned part; the part numbers in these captures are examples, not a fixed mapping.

**A — Label only.** The common explanation frame is intentionally empty.

![Condition A: label only](docs/screenshots/05-condition-a.png)

**B — Static explanation.** One scripted reason appears below the label.

![Condition B: one static reason](docs/screenshots/06-condition-b.png)

**C — Interactive explanation.** Why opens Source, Claim vs record and Wording.

![Condition C: Why details open](docs/screenshots/07b-condition-c-why.png)

<details>
<summary>C before opening Why, and with Source expanded</summary>

![Condition C: Why collapsed](docs/screenshots/07-condition-c.png)

![Condition C: Source detail expanded](docs/screenshots/07c-condition-c-source.png)

</details>

**D — Counterfactual explanation.** A what-if sentence describes what would change the label.

![Condition D: counterfactual explanation](docs/screenshots/08-condition-d.png)

### Fact sheet and confidence

The optional fact sheet supplies the fictional official record. After deciding, participants select required confidence from 1–7.

![Optional fact sheet open](docs/screenshots/09-fact-sheet.png)

![Confidence selection after a decision](docs/screenshots/11-confidence.png)

<details>
<summary>Landing page with Continue for an unfinished session</summary>

![Resume banner on the landing page](docs/screenshots/10-resume.png)

</details>

### Questionnaire after each part — `/survey/:block`

Each part collects 12 trust items, two fairness items, tension and frustration. All 16 answers are required.

![Full questionnaire after part 1](docs/screenshots/12a-survey-part-1.png)

<details>
<summary>Questionnaire pages for parts 2, 3 and 4</summary>

![Questionnaire after part 2](docs/screenshots/12b-survey-part-2.png)

![Questionnaire after part 3](docs/screenshots/12c-survey-part-3.png)

![Questionnaire after part 4](docs/screenshots/12d-survey-part-4.png)

</details>

### Final questions — `/exit`

Collects background responses and preference using the actual explanation style associated with each part.

![Final survey and explanation preference](docs/screenshots/13-exit-survey.png)

### Completion debrief — `/debrief`

Explains the scripted labels, supplies factual corrections and offers Next participant.

![Completed-session debrief](docs/screenshots/14-debrief.png)

### Early-exit confirmation and debrief

Participants can cancel voluntarily. Saved answers remain; the session is abandoned and an early-exit debrief appears.

![Exit-study confirmation dialog](docs/screenshots/15-exit-confirmation.png)

![Early-exit debrief](docs/screenshots/16-early-exit-debrief.png)

### Admin dashboard and exports — `/admin`

Shows demonstration session status, protocol-aware KPIs and data exports. The participants CSV download was exercised during the walkthrough.

![Admin dashboard with demonstration data](docs/screenshots/17-admin-dashboard.png)

![Admin CSV and JSON export panel](docs/screenshots/18-admin-exports.png)

### Responsive examples

These show the actual browser rendering at a 390 px mobile viewport; they do not establish testing on every phone/browser.

<details>
<summary>Mobile landing and trial pages</summary>

![Mobile landing page at 390 pixels](docs/screenshots/19-mobile-landing.png)

![Mobile trial at 390 pixels](docs/screenshots/20-mobile-trial.png)

</details>

Capture files and viewport metadata are in [docs/screenshots/manifest.json](docs/screenshots/manifest.json). These app captures do not replace the genuine group-member interaction photographs or annotated source-code screenshots required for the report.

## Source map and references

| Location | Responsibility |
|---|---|
| `src/App.tsx`, `src/study/` | Routing and participant screens |
| `src/conditions/`, `src/components/` | Explanation interfaces and reusable controls |
| `src/state/`, `src/logging/` | Resume, storage cleanup and event timing |
| `shared/counterbalance.ts`, `shared/rng.ts` | Reproducible assignment and shuffling |
| `shared/labelEngine.ts`, `shared/data/` | Controlled stimuli, truth boundary and questionnaires |
| `server/routes/`, `server/db/` | API validation, persistence and migrations |
| `server/kpi.ts`, `server/export/` | Dashboard aggregates and exports |
