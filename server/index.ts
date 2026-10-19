import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "./runtime.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";
const runtime = await createRuntime({ staticDir: process.env.NODE_ENV === "production" ? join(root, "dist") : undefined });
const server = runtime.app.listen(port, host, () => {
  console.log(`Study server listening on http://${host === "127.0.0.1" ? "localhost" : host}:${port}`);
  console.log(`Database: ${runtime.storage}`);
});
const shutdown = () => server.close(() => { void runtime.close().then(() => process.exit(0)); });
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
