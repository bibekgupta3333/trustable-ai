import { openTursoDatabase } from "../server/db/async";
import { initializeTursoSchema } from "../server/db/setup";

async function setup() {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) {
    throw new Error("Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN together before running schema setup");
  }
  const db = openTursoDatabase(url, authToken);
  try {
    const status = await initializeTursoSchema(db);
    console.log(status === "created" ? "Turso SQLite study schema initialized." : "Existing study schema is current; no changes made.");
  } finally {
    await db.close();
  }
}

try {
  await setup();
} catch {
  // SDK errors may include connection details. Never print the exception or credentials.
  console.error("Turso schema setup failed. Check TURSO_DATABASE_URL, TURSO_AUTH_TOKEN and database schema compatibility. No destructive migration was attempted.");
  process.exitCode = 1;
}
