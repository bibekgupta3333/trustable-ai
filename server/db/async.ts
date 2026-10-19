import { AsyncLocalStorage } from "node:async_hooks";
import type Database from "better-sqlite3";
import { connect, type Connection as TursoConnection } from "@tursodatabase/serverless";

export interface StudyStatement {
  get(...params: any[]): Promise<any>;
  all(...params: any[]): Promise<any[]>;
  run(...params: any[]): Promise<{ changes: number }>;
}

export interface StudyTransaction<Args extends any[], Result> {
  (...args: Args): Promise<Result>;
  immediate(...args: Args): Promise<Result>;
}

export interface StudyDatabase {
  prepare(sql: string): StudyStatement;
  exec(sql: string): Promise<void>;
  pragma(source: string, options?: { simple?: boolean }): Promise<any>;
  transaction<Args extends any[], Result>(fn: (...args: Args) => Promise<Result>): StudyTransaction<Args, Result>;
  close(): Promise<void>;
}

export type DatabaseInput = Database.Database | StudyDatabase;

class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
}

interface Connection {
  exec(sql: string): Promise<void>;
}

interface TransactionContext<C> {
  connection: C;
  gate: Mutex;
  active: boolean;
}

/** Each nested scope holds its parent's gate until its savepoint has finished. */
function transactionRunner<C extends Connection>(
  context: AsyncLocalStorage<TransactionContext<C>>,
  outside: <T>(fn: (connection: C) => Promise<T>) => Promise<T>,
) {
  let savepoint = 0;
  return <Args extends any[], Result>(fn: (...args: Args) => Promise<Result>): StudyTransaction<Args, Result> => {
    const invoke = async (immediate: boolean, args: Args): Promise<Result> => {
      const parent = context.getStore();
      if (parent && !parent.active) throw new Error("Transaction scope is no longer active");
      const perform = async (connection: C): Promise<Result> => {
        const name = parent ? `study_sp_${++savepoint}` : undefined;
        await connection.exec(name ? `SAVEPOINT ${name}` : immediate ? "BEGIN IMMEDIATE" : "BEGIN");
        const scope: TransactionContext<C> = { connection, gate: new Mutex(), active: true };
        try {
          const result = await context.run(scope, () => fn(...args));
          // Wait for queries already queued in this scope before closing it.
          await scope.gate.run(async () => {
            scope.active = false;
            await connection.exec(name ? `RELEASE SAVEPOINT ${name}` : "COMMIT");
          });
          return result;
        } catch (error) {
          await scope.gate.run(async () => {
            scope.active = false;
            try {
              await connection.exec(name ? `ROLLBACK TO SAVEPOINT ${name}` : "ROLLBACK");
              if (name) await connection.exec(`RELEASE SAVEPOINT ${name}`);
            } catch {
              // Preserve the original query/callback error.
            }
          });
          throw error;
        } finally {
          scope.active = false;
        }
      };
      return parent ? parent.gate.run(() => {
        if (!parent.active) throw new Error("Transaction scope is no longer active");
        return perform(parent.connection);
      }) : outside(perform);
    };
    const tx = (...args: Args) => invoke(false, args);
    return Object.assign(tx, { immediate: (...args: Args) => invoke(true, args) });
  };
}

const adapters = new WeakMap<Database.Database, StudyDatabase>();

/** Adapt a raw local handle once, so all repository calls share the same lock/context. */
export function asAsyncDatabase(input: DatabaseInput): StudyDatabase {
  // better-sqlite3 exposes this boolean; StudyDatabase deliberately does not.
  if (!("inTransaction" in input)) return input as StudyDatabase;
  const raw = input as Database.Database;
  const existing = adapters.get(raw);
  if (existing) return existing;
  const mutex = new Mutex();
  const context = new AsyncLocalStorage<TransactionContext<Connection>>();
  const connection: Connection = { exec: async (sql) => { raw.exec(sql); } };
  const outside = <T>(fn: (c: Connection) => Promise<T>) => mutex.run(() => fn(connection));
  const execute = <T>(fn: () => T): Promise<T> => {
    const scope = context.getStore();
    if (scope && !scope.active) return Promise.reject(new Error("Transaction scope is no longer active"));
    const run = async () => {
      if (scope && !scope.active) throw new Error("Transaction scope is no longer active");
      return fn();
    };
    return scope ? scope.gate.run(run) : mutex.run(run);
  };
  const statements = new Map<string, Database.Statement>();
  const statement = (sql: string) => {
    let cached = statements.get(sql);
    if (!cached) { cached = raw.prepare(sql); statements.set(sql, cached); }
    return cached;
  };
  const adapted: StudyDatabase = {
    prepare: (sql) => ({
      get: (...params) => execute(() => statement(sql).get(...params)),
      all: (...params) => execute(() => statement(sql).all(...params)),
      run: (...params) => execute(() => ({ changes: statement(sql).run(...params).changes })),
    }),
    exec: (sql) => execute(() => { raw.exec(sql); }),
    pragma: (source, options) => execute(() => raw.pragma(source, options)),
    transaction: transactionRunner(context, outside),
    close: () => {
      if (context.getStore()) return Promise.reject(new Error("Cannot close a database inside a transaction"));
      return execute(() => { raw.close(); });
    },
  };
  adapters.set(raw, adapted);
  return adapted;
}

function validateTursoUrl(source: string): string {
  let url: URL;
  try { url = new URL(source); } catch { throw new Error("Turso requires a turso:// or https:// database URL"); }
  if (!["turso:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password ||
      url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new Error("Turso requires a turso:// or https:// database URL without credentials, path or query options");
  }
  // Normalize explicitly: the SDK only rewrites lowercase turso:// prefixes.
  return `https://${url.host}`;
}

function safeNumber(value: bigint | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("SQLite integer exceeds JavaScript's safe range");
  return result;
}

function numericRow(row: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!row) return undefined;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    typeof value === "bigint" ? safeNumber(value) : value,
  ]));
}

interface RemoteConnection extends Connection {
  sdk: TursoConnection;
}

/** Each top-level operation owns a fresh stream; nested transactions reuse it via ALS. */
export function openTursoDatabase(url: string, authToken: string): StudyDatabase {
  const endpoint = validateTursoUrl(url);
  if (!authToken?.trim()) throw new Error("Turso requires an authentication token");
  const mutex = new Mutex();
  const context = new AsyncLocalStorage<TransactionContext<RemoteConnection>>();
  let closed = false;

  const outside = <T>(fn: (connection: RemoteConnection) => Promise<T>): Promise<T> => mutex.run(async () => {
    if (closed) throw new Error("Database is closed");
    const sdk = connect({ url: endpoint, authToken: authToken.trim(), defaultQueryTimeout: 15_000 });
    try {
      sdk.defaultSafeIntegers(true);
      // New streams start with their own PRAGMA state. Initialize before any BEGIN.
      await sdk.exec("PRAGMA foreign_keys = ON");
      // Turso Cloud manages lock waiting; its SQL API rejects busy_timeout.
      return await fn({ sdk, exec: async (sql) => {
        if (sql !== "BEGIN" && sql !== "BEGIN IMMEDIATE" && !sdk.inTransaction) {
          throw new Error("Turso transaction stream was lost");
        }
        await sdk.exec(sql);
      } });
    } finally {
      // No stream survives participant think time or a warm function's idle gap.
      // Cleanup must not turn a confirmed commit/result into an apparent failure,
      // or replace the original operation error. Never replay an uncertain write.
      try { await sdk.close(); } catch { /* Best-effort remote stream cleanup. */ }
    }
  });
  const execute = <T>(fn: (sdk: TursoConnection) => Promise<T>): Promise<T> => {
    const scope = context.getStore();
    if (scope && !scope.active) return Promise.reject(new Error("Transaction scope is no longer active"));
    if (!scope) return outside(({ sdk }) => fn(sdk));
    return scope.gate.run(async () => {
      if (!scope.active) throw new Error("Transaction scope is no longer active");
      const { sdk } = scope.connection;
      // The SDK clears its baton after a transport failure. Even if the callback
      // catches that error, never continue its work on a fresh autocommit stream.
      if (!sdk.inTransaction) throw new Error("Turso transaction stream was lost");
      return fn(sdk);
    });
  };
  return {
    prepare: (sql) => ({
      get: (...params) => execute(async (sdk) => numericRow(await sdk.get(sql, params))),
      all: (...params) => execute(async (sdk) => (await sdk.all(sql, params)).map((row) => numericRow(row))),
      run: (...params) => execute(async (sdk) => ({ changes: safeNumber((await sdk.run(sql, params)).changes) })),
    }),
    // SDK exec uses the sequence endpoint: comments, quoted semicolons and triggers
    // are parsed by SQLite, with no client-side statement splitting.
    exec: (sql) => execute(async (sdk) => { await sdk.exec(sql); }),
    pragma: (source, options) => execute(async (sdk) => {
      const rows = (await sdk.all(`PRAGMA ${source}`)).map((row) => numericRow(row)!);
      return options?.simple ? (rows[0] ? Object.values(rows[0])[0] : undefined) : rows;
    }),
    transaction: transactionRunner(context, outside),
    close: () => {
      if (context.getStore()) return Promise.reject(new Error("Cannot close a database inside a transaction"));
      return mutex.run(async () => {
        closed = true;
      });
    },
  };
}

