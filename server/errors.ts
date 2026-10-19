/** Diagnostics are classifications only: never serialize the error or request. */
const ERROR_NAMES = new Set([
  "Error", "DatabaseError", "SqliteError", "TimeoutError", "AbortError", "TypeError",
  "RangeError", "SyntaxError", "ReferenceError", "URIError", "EvalError", "AggregateError",
  "ConflictError", "ValidationError", "HttpError",
]);

// Exact codes, not an arbitrary SQLITE_* prefix: suffixes can contain private data.
const SQLITE_CODES = new Set([
  "SQLITE_ERROR", "SQLITE_INTERNAL", "SQLITE_PERM", "SQLITE_ABORT", "SQLITE_BUSY",
  "SQLITE_LOCKED", "SQLITE_NOMEM", "SQLITE_READONLY", "SQLITE_INTERRUPT", "SQLITE_IOERR",
  "SQLITE_CORRUPT", "SQLITE_NOTFOUND", "SQLITE_FULL", "SQLITE_CANTOPEN", "SQLITE_PROTOCOL",
  "SQLITE_SCHEMA", "SQLITE_TOOBIG", "SQLITE_CONSTRAINT", "SQLITE_MISMATCH", "SQLITE_MISUSE",
  "SQLITE_AUTH", "SQLITE_RANGE", "SQLITE_NOTADB",
  "SQLITE_CONSTRAINT_CHECK", "SQLITE_CONSTRAINT_COMMITHOOK", "SQLITE_CONSTRAINT_DATATYPE",
  "SQLITE_CONSTRAINT_FOREIGNKEY", "SQLITE_CONSTRAINT_FUNCTION", "SQLITE_CONSTRAINT_NOTNULL",
  "SQLITE_CONSTRAINT_PINNED", "SQLITE_CONSTRAINT_PRIMARYKEY", "SQLITE_CONSTRAINT_ROWID",
  "SQLITE_CONSTRAINT_TRIGGER", "SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_VTAB",
  "SQLITE_BUSY_RECOVERY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_BUSY_TIMEOUT",
  "SQLITE_LOCKED_SHAREDCACHE", "SQLITE_LOCKED_VTAB",
]);

/** Read data properties without invoking arbitrary getters or coercion methods. */
function dataProperty(input: unknown, key: string): unknown {
  if ((typeof input !== "object" && typeof input !== "function") || input === null) return undefined;
  try {
    let object: object | null = input;
    for (let depth = 0; object && depth < 8; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
      object = Object.getPrototypeOf(object);
    }
  } catch {
    // Untrusted proxies must not prevent the original error from being handled.
  }
  return undefined;
}

export interface SafeErrorDetails {
  name: string;
  code?: string;
  httpStatus?: number;
}

export function safeErrorDetails(error: unknown): SafeErrorDetails {
  const name = dataProperty(error, "name");
  const code = dataProperty(error, "code");
  const message = dataProperty(error, "message");
  const details: SafeErrorDetails = {
    name: typeof name === "string" && ERROR_NAMES.has(name) ? name : "UnknownError",
  };
  if (typeof code === "string" && SQLITE_CODES.has(code)) details.code = code;
  if (typeof message === "string") {
    const match = /^HTTP error! status: ([1-5][0-9]{2})$/.exec(message);
    // JS $ can match before a final newline; require the whole string as well.
    if (match && match[0] === message) details.httpStatus = Number(match[1]);
  }
  return details;
}

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
// Express route.path is the registered template, but accept only our known templates.
// Do not read baseUrl/originalUrl/path: they may contain resolved session IDs or tokens.
const ROUTES = new Map([
  ["/", "/api/sessions"],
  ["/:id", "/api/sessions/:id"],
  ["/:id/resume", "/api/sessions/:id/resume"],
  ["/:id/cancel", "/api/sessions/:id/cancel"],
  ["/:id/consent", "/api/sessions/:id/consent"],
  ["/:id/presentation/:block/:pos", "/api/sessions/:id/presentation/:block/:pos"],
  ["/:id/trials", "/api/sessions/:id/trials"],
  ["/:id/events", "/api/sessions/:id/events"],
  ["/:id/cursor", "/api/sessions/:id/cursor"],
  ["/:id/block-surveys", "/api/sessions/:id/block-surveys"],
  ["/:id/exit-survey", "/api/sessions/:id/exit-survey"],
  ["/health", "/api/health"], ["/practice", "/api/practice"],
  ["/kpis", "/api/admin/kpis"], ["/assignments/:pid", "/api/admin/assignments/:pid"],
  ["/sessions", "/api/admin/sessions"],
  ["/sessions/:id/abandon", "/api/admin/sessions/:id/abandon"],
  ["/sessions/:id", "/api/admin/sessions/:id"],
  ["/export", "/api/admin/export"], ["/export/:name", "/api/admin/export/:name"],
]);

export function safeRequestDetails(request: unknown): { method: string; route: string } {
  const method = dataProperty(request, "method");
  const path = dataProperty(dataProperty(request, "route"), "path");
  return {
    method: typeof method === "string" && METHODS.has(method) ? method : "UNKNOWN",
    route: typeof path === "string" ? ROUTES.get(path) ?? "unmatched" : "unmatched",
  };
}
