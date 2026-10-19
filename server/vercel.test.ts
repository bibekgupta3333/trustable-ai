import express from "express";
import request from "supertest";
import { createHandler } from "../api/index";
import type { createRuntime } from "./runtime";

const runtime = () => {
  const app = express();
  app.get("/api/health", async (_req, res) => {
    await new Promise((done) => setTimeout(done, 10));
    res.json({ ok: true });
  });
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  return { app, close: async () => {}, storage: "test" };
};

describe("Vercel API entry point", () => {
  it("shares initialization and waits for async Express responses", async () => {
    const initialize = vi.fn(async () => runtime());
    const handler = createHandler(initialize);
    const app = express();
    app.use(handler);
    const responses = await Promise.all([
      request(app).get("/api/health"), request(app).get("/api/health"),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(responses[0].body).toEqual({ ok: true });
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledWith({ serverless: true });
  });

  it("retries failed startup without returning connection secrets", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const startupError = new Error("postgresql://private:secret@database.invalid/study");
    startupError.name = "private-secret-name";
    const initialize = vi.fn<typeof createRuntime>()
      .mockRejectedValueOnce(startupError)
      .mockResolvedValue(runtime());
    const app = express(); app.use(createHandler(initialize));
    try {
      const failed = await request(app).get("/api/health");
      expect(failed.status).toBe(503);
      expect(failed.text).not.toContain("secret");
      expect(log.mock.calls.flat().join(" ")).not.toContain("secret");
      expect((await request(app).get("/api/health")).status).toBe(200);
      expect(initialize).toHaveBeenCalledTimes(2);
    } finally { log.mockRestore(); }
  });

  it("keeps unknown API routes as JSON 404s rather than SPA HTML", async () => {
    const app = express(); app.use(createHandler(async () => runtime()));
    const response = await request(app).get("/api/missing");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "not_found" });
  });
});
