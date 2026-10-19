# Report handoff for the group

**Project:** Do People Trust AI More When It Explains Itself? A Comparative Study of Explanation

**Course:** CEN5728 Advanced HCI — Group 4, graduate study at Florida Polytechnic University.

**Members:** Afzal Hossain Sohag, Bibek Gupta, Deepthi Reddy Chelladi, Md Shamimul Islam, Mohamed Sylla and Siwani Sah.

This document is for the friend assembling the final report. Sections 1–5 provide text to adapt into the report. Sections 6–8 specify the genuine screenshot/photo evidence to collect and insert. This is a report handoff, not a claim that captures, a video or an archive have already been supplied. The technical reference is [README.md](README.md); the course checklist is [implementation.txt](../HCI/implementation.txt).

## 1. Brief project description

The project is a browser-based HCI research application comparing four ways an AI labeling interface explains its decisions. Participants read fictional social-media posts and decide whether they agree with a label of “Likely accurate” or “Likely misleading.” They also report confidence, trust, fairness, tension and frustration. The main behavioral goal is appropriate reliance: accepting correct labels and rejecting incorrect ones, rather than increasing trust indiscriminately.

New sessions contain eight text-only posts, sampled from a 24-post bank, organized into four parts of two posts. Each part contains one correct and one incorrect AI label. Participants see every explanation condition, in an assigned order:

| Condition | What it represents |
|---|---|
| A — No explanation | AI label only |
| B — Static explanation | AI label plus one short reason |
| C — Interactive explanation | Why? opens Source, Claim vs record and Wording details |
| D — Counterfactual explanation | Describes what would change the label |

Part numbers reflect assigned order; Part 1 does not always mean A. After each part, participants answer 12 Jian-based trust items, two fairness items, tension and frustration: 16 ratings per part, 64 total. Eight trial confidence ratings and final questions are additional.

Labels and explanations are scripted using a **Wizard-of-Oz** approach; no live AI model or fact-checking service runs. Optional fact sheets provide verification evidence. C additionally exposes factual comparison, so the study compares interface packages and cannot isolate the causal effect of interactivity alone. The short design is exploratory; report no uncollected results, proven novelty, established statistical power or measured completion duration.

Generic photographs and image captions are not used in new sessions. Older saved sessions retain their protocol and must be distinguished from the current presentation in analysis and reporting.

## 2. Technologies used

| Category | Implementation and purpose |
|---|---|
| Runtime/platform | Node.js 22+; Node 22 LTS recommended for reproduction |
| Languages | TypeScript, HTML and CSS |
| Frontend | React 18, React Router 6 and Vite for screens, routing and build tooling |
| Backend | Express 5 and tsx for the API and server execution |
| Database | SQLite via better-sqlite3 for persistent sessions, trials, surveys and events |
| Study materials | JSON post/questionnaire banks; scripted labels and explanations |
| Assignment | Williams condition orders, set rotation and seeded randomization |
| Testing | Vitest, Testing Library, jsdom and Supertest |
| Research outputs | Admin dashboard with CSV and JSON exports |

Architecture: browser React interface → Express HTTP API → repository → SQLite. Hidden truth fields are controlled by the server; fact sheets, C’s factual comparison and the final debrief deliberately expose appropriate checking information. See [CONTRACT.md](CONTRACT.md) for implementation details.

## 3. Intended devices

Participants use current desktop/laptop browsers and responsive phone/tablet browsers. No native application installation is required. Desktop/laptop is recommended for the full questionnaire and demonstration. Layout targets include 360 px phone and 1280 px desktop widths; intended support does not establish testing on every device.

The server runs on a computer or deployment host. Other devices need a reachable deployment URL; opening localhost on a phone refers to that phone. In the final report, separately list the devices/browsers actually used for your captures and demonstration.

## 4. Step-by-step guide: run from source

1. Extract the submitted source ZIP. Open a terminal in the extracted project root containing `package.json`.
2. Install Node.js, preferably 22 LTS. Check `node --version` and `npm --version`.
3. Install the locked dependencies:

   ```bash
   npm ci --include=dev
   ```

4. Start frontend and backend together:

   ```bash
   npm run dev
   ```

5. Keep the terminal open. Visit **http://localhost:5173/** for participants and **http://localhost:5173/admin** for admin. The API runs on port 3001; Vite proxies API requests. Use Vite’s printed URL if 5173 is occupied.
6. The SQLite database/schema is created automatically. No separate database service or manual SQL import is required.
7. Stop with Ctrl+C. To run the production build on macOS/Linux:

   ```bash
   npm run build
   npm start
   ```

8. Open **http://localhost:3001/** and `/admin` for production. On Windows, use Git Bash/WSL, or after building run `set NODE_ENV=production&& npx tsx server/index.ts` in `cmd`.
9. Optional verification: `npm test`, `npm run typecheck` and `npm run build`. HTTP tests require permission to bind local loopback ports.

Use a separate demo database for all captures. On macOS/Linux: `DB_PATH=data/submission-demo.db npm start`. On Windows `cmd`, first run `set DB_PATH=data/submission-demo.db`, then the production command. Do not delete or include real study databases. Native better-sqlite3 compilation may require Python and a platform C++ toolchain. See the README for configuration and deployment.

## 5. Steps to interact with the application

### Participant

1. Open the landing page and select Take part.
2. Enter a non-identifying demo participation code and select Start. Admin approval is not required. Completed/abandoned codes cannot start again; unfinished sessions can resume subject to stale-session handling.
3. Read consent, confirm adult eligibility and try the unscored practice post.
4. Read each assigned post and its AI label. Optionally open the Fact sheet; in C, optionally open Why and expand the detail rows.
5. Select Agree with label or Disagree with label, then confidence 1–7. A brief Undo opportunity precedes saving and automatic progression.
6. After each two-post part, complete all 16 questionnaire ratings. Deliberately move the frustration slider; its initial position is not an answer.
7. Finish the four parts, final survey and debrief. The debrief explains scripted errors and factual corrections.
8. Select Next participant to return to the landing page. Successful completion clears participant study browser-storage keys, preserving admin/unrelated storage.

Exit study confirms early cancellation, preserves saved answers and shows an early debrief. Resume uses Continue in the same browser or the same participation code on another device. Keyboard controls include A/D, confidence 1–7, F for fact sheet, W for Why when shown and Escape to close panels.

### Admin

1. Open `/admin` on the frontend origin. Enter the configured token if required.
2. Review sessions, progress, protocol cohort and KPIs. Admin does not start participants.
3. Download `participants.csv` or another export, or use Download all CSVs. Open a demo CSV to verify it.
4. Explain that outcome summaries use completed non-pilot sessions in the selected cohort, while raw exports also include unfinished/abandoned sessions. Demo values are not study findings.

Analysis exports omit participation hashes/salt and are not recovery backups. See the README for SQLite backup handling.

## 6. Source-code screenshots and responsibilities

Capture readable excerpts, not entire unreadable files. Show the file path and explain **what the section does and where its effect appears in the application**. These are proposed capture assignments, not claims of code authorship; describe actual contributions separately if required.

| Member | Source to capture | Responsibility to explain | Suggested application capture |
|---|---|---|---|
| Afzal Hossain Sohag | [src/App.tsx](src/App.tsx) | Routes, participant navigation and admin entry | Landing, start and consent |
| Bibek Gupta | [shared/counterbalance.ts](shared/counterbalance.ts) | Condition order, set rotation and deterministic short-session assignment | Part/post progress and A/B trials |
| Deepthi Reddy Chelladi | [src/conditions/conditionRegistry.ts](src/conditions/conditionRegistry.ts) and condition views | Mapping A–D to explanation interfaces; interactive and counterfactual behavior | Expanded C and D |
| Md Shamimul Islam | [server/db/schema.sql](server/db/schema.sql) and [server/db/repo.ts](server/db/repo.ts) | Persistent session/response tables and saved state used for resume | Demo session resume |
| Mohamed Sylla | [shared/data/surveyItems.json](shared/data/surveyItems.json) and [src/study/BlockSurveyScreen.tsx](src/study/BlockSurveyScreen.tsx) | Questionnaire definitions, scale presentation and required answers | Trust, fairness, tension and frustration |
| Siwani Sah | [server/kpi.ts](server/kpi.ts) and [server/export/exporters.ts](server/export/exporters.ts) | Outcome summaries, cohort filters and downloadable data | Admin and CSV exports |

Example caption: “Figure 6. `shared/counterbalance.ts` assigns condition order and samples two posts per part. The participant screen displays progress from the saved plan.” Use equivalent accurate captions for every source capture, and keep excerpts consistent with the submitted source version.

## 7. Screenshots of the running application

Capture the **current text-only app** with demonstration data. Include figure numbers, screen/condition names and brief behavioral captions:

- Landing, participation-code entry, consent and practice.
- A label only, B short reason, C with Why/rows expanded, and D what-if explanation. Identify the actual condition rather than assuming its part number.
- Fact sheet open and confidence selection.
- Full questionnaire: readable trust, fairness, tension and frustration captures; split into multiple figures if needed.
- Exit-study confirmation, final survey, completed debrief and Next participant.
- Admin KPI dashboard, export panel and a downloaded demo CSV.
- At least one narrow-screen capture, labeled with actual device/viewport.

Do not use wireframes or superseded media screenshots as current running-app evidence. Keep screenshots readable in the final report. Conceal personal codes, session access identifiers, tokens and real responses.

## 8. Screenshots/photographs of group members interacting

Use genuine photographs showing members operating the running application, with the interface visible. Browser screenshots document the app; they do not establish that a group member interacted with it. Photograph each named member with their agreement, using demo data.

| Member | Suggested genuine interaction photo | Suggested filename |
|---|---|---|
| Afzal Hossain Sohag | Starting a demo session/practice | `member-afzal.png` |
| Bibek Gupta | Making a trial decision and selecting confidence | `member-bibek.png` |
| Deepthi Reddy Chelladi | Opening Why details | `member-deepthi.png` |
| Md Shamimul Islam | Resuming a demo session | `member-shamimul.png` |
| Mohamed Sylla | Completing the questionnaire | `member-mohamed.png` |
| Siwani Sah | Reviewing admin/export controls | `member-siwani.png` |

Caption each photograph with the member’s name and observable action. A group photograph can supplement these images. Do not use generated people, stock photographs or invented participation evidence. Demonstrating the app does not mean a member is an eligible research participant or supplies formal study data.

## 9. What your friend should deliver

1. Assemble sections 1–5 into the report, adjusting wording to the actual demonstrated build.
2. Collect the code captures from section 6 and insert them with responsibility captions.
3. Insert the current running-app screenshots from section 7.
4. Collect and caption the genuine member photographs from section 8.
5. Check all figures are readable and consistent with eight posts/four parts/64 questionnaire ratings.
6. Submit the report alongside one source ZIP and a playable application demonstration video, in the course-required format.

For the video, show startup → consent/practice → representative A–D trials → full questionnaire → final survey/debrief → admin CSV download. Identify edited jumps; edited video duration is not measured participant completion time. Record in the demo database and do not expose secrets or present demo KPIs as results.

### Final evidence checklist — complete before submission

- [ ] Source ZIP extracts into a clean folder and the documented run steps work.
- [ ] Video is supplied and plays correctly.
- [ ] Report covers overview, technologies, devices, setup and interaction.
- [ ] Readable source-code screenshots explain each section’s responsibility.
- [ ] Current application screenshots show participant and admin flows.
- [ ] Genuine interaction photographs identify all six group members.
- [ ] Figures use demo data and reveal no secrets or real participant records.
- [ ] Actual devices, contributions and verification are reported truthfully.

The screenshot and photo lists above are collection instructions; no missing evidence is silently marked complete.
