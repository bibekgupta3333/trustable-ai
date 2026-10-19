import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPostBank } from "../shared/labelEngine";
import { openDb } from "./db/db";
import { createApp } from "./app";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fromRoot = (p: string) => (isAbsolute(p) || p === ":memory:" ? p : join(APP_ROOT, p));

const port = Number(process.env.PORT ?? 3001);
const dbPath = fromRoot(process.env.DB_PATH ?? "data/study.db");
const adminToken = process.env.ADMIN_TOKEN || undefined;
const production = process.env.NODE_ENV === "production";
const participantSalt = process.env.PARTICIPANT_SALT || undefined;
const staleEnv = Number(process.env.STALE_MINUTES);
const staleMinutes = Number.isFinite(staleEnv) && staleEnv > 0 ? staleEnv : undefined; // createApp default: 120

const pkg = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")) as { version: string };
const bank = loadPostBank(JSON.parse(readFileSync(join(APP_ROOT, "shared/data/posts.json"), "utf8")));
const db = openDb(dbPath);

const app = createApp({
  db,
  bank,
  appVersion: pkg.version,
  adminToken,
  participantSalt,
  staleMinutes,
  staticDir: production ? join(APP_ROOT, "dist") : undefined,
});

// Bind to localhost by default so study data isn't reachable from the lab network; set HOST=0.0.0.0 to share.
const host = process.env.HOST ?? "127.0.0.1";
const server = app.listen(port, host, () => {
  console.log(`Study server listening on http://${host === "127.0.0.1" ? "localhost" : host}:${port}${production ? "" : " (API only; client on Vite)"}`);
  console.log(`Database: ${dbPath}${adminToken ? " · admin token required" : ""}`);
});

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
