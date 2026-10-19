import type { Request, Response } from "express";
import { createRuntime } from "../server/runtime.js";

/** Cache one initialized application per warm function; failed startup remains retryable. */
export function createHandler(initialize: typeof createRuntime = createRuntime) {
  let pending: ReturnType<typeof createRuntime> | undefined;
  return async (req: Request, res: Response): Promise<void> => {
    try {
      if (!pending) {
        pending = initialize({ serverless: true }).catch((error: unknown) => {
          pending = undefined;
          throw error;
        });
      }
      const { app } = await pending;
      await new Promise<void>((done) => {
        res.once("finish", done);
        res.once("close", done);
        app(req, res);
      });
    } catch (error) {
      // Connection errors may contain credentials/host details: never send them to clients.
      console.error("Backend startup failed", error instanceof Error ? error.name : "unknown error");
      if (!res.headersSent) {
        // Startup can fail before Express decorates the native response object.
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({
          error: "backend_unavailable",
          detail: "Check the server database connection, schema setup and required environment variables.",
        }));
      }
    }
  };
}

export default createHandler();
