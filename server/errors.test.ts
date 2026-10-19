import request from "supertest";
import { safeErrorDetails, safeRequestDetails } from "./errors.js";
import { createApp } from "./app.js";
import { openDb } from "./db/db.js";
import * as repo from "./db/repo.js";
import * as kpi from "./kpi.js";
import { loadPostBank } from "../shared/labelEngine.js";
import bankData from "../shared/data/posts.json";

const SECRETS = [
  "private-token-123", "person@example.invalid", "raw-participation-code",
  "64f32cc9-baba-4121-8742-f820bf5518ec", "https://private.invalid/db?auth=hidden",
  "INSERT INTO sessions VALUES ('sensitive-bound-value')",
];
const privateMessage = SECRETS.join(" ");

function expectNoSecrets(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const secret of SECRETS) expect(serialized).not.toContain(secret);
}

describe("safe error classification", () => {
  it.each(["Error", "DatabaseError", "SqliteError", "TimeoutError", "TypeError", "AbortError"])("retains the known %s classification without the message or stack", (name) => {
    const error = Object.assign(new Error(privateMessage), { name, stack: privateMessage, sql: privateMessage, cause: new Error(privateMessage) });
    expect(safeErrorDetails(error)).toEqual({ name });
    expectNoSecrets(safeErrorDetails(error));
  });

  it.each(["SQLITE_BUSY", "SQLITE_ERROR", "SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_FOREIGNKEY"])("retains the exact approved SQLite code %s", (code) => {
    expect(safeErrorDetails(Object.assign(new Error(privateMessage), { code }))).toEqual({ name: "Error", code });
  });

  it.each([`SQLITE_CONSTRAINT_${privateMessage}`, `SQLITE_BUSY ${privateMessage}`, `SQLITE_ERROR\n${privateMessage}`, privateMessage, 400])("drops unapproved or injected SQLite code %#", (code) => {
    const error = { name: privateMessage, code, message: privateMessage, stack: privateMessage };
    expect(safeErrorDetails(error)).toEqual({ name: "UnknownError" });
    expectNoSecrets(safeErrorDetails(error));
  });

  it.each([401, 403, 429, 500, 503])("extracts only the SDK's exact HTTP status %s", (status) => {
    expect(safeErrorDetails({ name: "DatabaseError", message: `HTTP error! status: ${status}` }))
      .toEqual({ name: "DatabaseError", httpStatus: status });
  });

  it.each([
    `HTTP error! status: 401 ${privateMessage}`, `${privateMessage} HTTP error! status: 401`,
    "HTTP error! status: 401\n", "HTTP error! status: 4010", "HTTP error! status: 999",
    "HTTP error! status: 0401", "HTTP error status: 401", "http error! status: 401",
  ])("rejects nonexact SDK HTTP messages %#", (message) => {
    expect(safeErrorDetails({ name: "DatabaseError", message, status: 401 }))
      .toEqual({ name: "DatabaseError" });
  });

  it("does not trust status fields, invoke getters, or coerce hostile field values", () => {
    const access = vi.fn(() => { throw new Error(privateMessage); });
    const convert = vi.fn(() => privateMessage);
    const error = Object.defineProperties({}, {
      name: { get: access }, message: { get: access },
      code: { value: { toString: convert } }, status: { value: 503 },
    });
    expect(safeErrorDetails(error)).toEqual({ name: "UnknownError" });
    expect(access).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
    expect(safeErrorDetails(new Proxy({}, { getOwnPropertyDescriptor: access }))).toEqual({ name: "UnknownError" });
    for (const value of [undefined, null, privateMessage, 123]) {
      expect(safeErrorDetails(value)).toEqual({ name: "UnknownError" });
    }
  });
});

describe("safe request classification", () => {
  it("uses only the known method and registered route template", () => {
    expect(safeRequestDetails({ method: "POST", route: { path: "/:id/consent" },
      originalUrl: privateMessage, path: privateMessage, baseUrl: privateMessage,
      params: { id: SECRETS[3] }, query: { token: SECRETS[0] }, body: { participantCode: SECRETS[2] },
    })).toEqual({ method: "POST", route: "/api/sessions/:id/consent" });
  });

  it("drops arbitrary paths and methods, including secret-bearing route metadata", () => {
    const result = safeRequestDetails({ method: privateMessage, route: { path: `/${privateMessage}` } });
    expect(result).toEqual({ method: "UNKNOWN", route: "unmatched" });
    expectNoSecrets(result);
    expect(safeRequestDetails({ method: "GET", route: { path: [/privateMessage/] } }))
      .toEqual({ method: "GET", route: "unmatched" });
  });
});

describe("API error diagnostics", () => {
  let db: ReturnType<typeof openDb>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    db = openDb(":memory:");
    app = await createApp({ db, bank: loadPostBank(bankData), appVersion: "test", participantSalt: "demo-salt", adminToken: "demo-admin" });
    log = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it("classifies a failed consent request without logging its session ID, query, body or error payload", async () => {
    const error = Object.assign(new Error("HTTP error! status: 401"), {
      name: "DatabaseError", stack: privateMessage, sql: privateMessage, args: SECRETS,
    });
    vi.spyOn(repo, "getSession").mockRejectedValueOnce(error);
    const response = await request(app).post(`/api/sessions/${SECRETS[3]}/consent`)
      .query({ token: SECRETS[0], email: SECRETS[1] }).send({ participantCode: SECRETS[2] });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "internal" });
    expect(log).toHaveBeenCalledExactlyOnceWith("Unhandled API request error", {
      name: "DatabaseError", httpStatus: 401, method: "POST", route: "/api/sessions/:id/consent",
    });
    expectNoSecrets(log.mock.calls);
  });

  it("classifies an admin database failure and drops malicious error names and code suffixes", async () => {
    vi.spyOn(kpi, "computeKpis").mockRejectedValueOnce(Object.assign(new Error(privateMessage), {
      name: privateMessage, code: `SQLITE_CONSTRAINT_${privateMessage}`, stack: privateMessage,
    }));
    const response = await request(app).get("/api/admin/kpis").set("x-admin-token", "demo-admin")
      .query({ token: SECRETS[0] });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "internal" });
    expect(log).toHaveBeenCalledExactlyOnceWith("Unhandled API request error", {
      name: "UnknownError", method: "GET", route: "/api/admin/kpis",
    });
    expectNoSecrets(log.mock.calls);
  });

  it("keeps expected body-parser and validation errors out of internal diagnostics", async () => {
    const malformed = await request(app).post("/api/sessions").set("Content-Type", "application/json").send("{bad");
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: "validation", detail: "malformed request body" });
    await request(app).post("/api/sessions").send({ participantCode: "a" }).expect(400);
    expect(log).not.toHaveBeenCalled();
  });
});
