/** Shared startup for the local server and Vercel's request handler. */
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postBank from "../shared/data/posts.json";
import pkg from "../package.json";
import { loadPostBank } from "../shared/labelEngine";
import { createApp } from "./app";
import { openDb, SCHEMA_VERSION } from "./db/db";
import { asAsyncDatabase, openTursoDatabase } from "./db/async";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function createRuntime(options: { serverless?: boolean; staticDir?: string } = {}) {
  const hosted = options.serverless || process.env.VERCEL === "1";
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (hosted && (!url || !authToken || !process.env.ADMIN_TOKEN?.trim() || !process.env.PARTICIPANT_SALT?.trim())) {
    throw new Error("Vercel requires TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, ADMIN_TOKEN and PARTICIPANT_SALT");
  }
  if (Boolean(url) !== Boolean(authToken)) {
    throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set together");
  }
  const path = process.env.DB_PATH ?? "data/study.db";
  const db = url
    ? openTursoDatabase(url, authToken!)
    : asAsyncDatabase(openDb(isAbsolute(path) || path === ":memory:" ? path : join(APP_ROOT, path)));
  try {
    if (url) {
      const row = await db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
      if (row?.value !== SCHEMA_VERSION) throw new Error("Remote schema is not ready; run npm run db:setup before deploying");
    }
    const stale = Number(process.env.STALE_MINUTES);
    const app = await createApp({
      db,
      bank: loadPostBank(postBank),
      appVersion: pkg.version,
      adminToken: process.env.ADMIN_TOKEN || undefined,
      participantSalt: process.env.PARTICIPANT_SALT || undefined,
      staleMinutes: Number.isFinite(stale) && stale > 0 ? stale : undefined,
      staticDir: options.staticDir,
    });
    return { app, close: () => db.close(), storage: url ? "Turso SQLite" : path };
  } catch (error) {
    await db.close();
    throw error;
  }
}
