import { performance } from "node:perf_hooks";
import {
  PLUGIN_API_VERSION,
  type PluginContext,
  type PluginSetupResult,
  type WevnaPlugin,
} from "@wevna/sdk";

// Structural, not mysql2's types: the two methods this wraps, so a real
// mysql2/promise Pool, PoolConnection or Connection satisfies it without this
// package depending on the driver.
export interface MysqlQueryable {
  query: (...args: unknown[]) => unknown;
  execute?: (...args: unknown[]) => unknown;
}

export interface MysqlPlugin extends WevnaPlugin {
  // Wraps query() and execute() in place; the same object keeps working
  // exactly as before. Takes the object from `mysql2/promise` — see the
  // README for why not the callback API.
  instrument(queryable: MysqlQueryable): void;
}

function statementText(args: readonly unknown[]): string {
  const first = args[0];
  if (typeof first === "string") {
    return first;
  }
  if (first && typeof first === "object" && "sql" in first) {
    const sql = (first as { sql?: unknown }).sql;
    if (typeof sql === "string") {
      return sql;
    }
  }
  return "";
}

// mysql2/promise resolves [rowsOrResultHeader, fields]. A SELECT's first
// element is the row array; an INSERT/UPDATE/DELETE's is a ResultSetHeader
// carrying affectedRows.
function rowCount(result: unknown): number | undefined {
  const first = Array.isArray(result) ? result[0] : undefined;
  if (Array.isArray(first)) {
    return first.length;
  }
  if (first && typeof first === "object" && "affectedRows" in first) {
    const affected = (first as { affectedRows?: unknown }).affectedRows;
    return typeof affected === "number" ? affected : undefined;
  }
  return undefined;
}

// A MySQL error carries a stable `code` ("ER_DUP_ENTRY") and `sqlState`. The
// message can quote the offending value ("Duplicate entry 'a@b.com'"), so the
// code is reported instead.
function describeFailure(error: unknown): string {
  if (error && typeof error === "object") {
    const { code, sqlState, name } = error as {
      code?: unknown;
      sqlState?: unknown;
      name?: unknown;
    };
    if (typeof code === "string") {
      return code;
    }
    if (typeof sqlState === "string") {
      return sqlState;
    }
    if (typeof name === "string") {
      return name;
    }
  }
  return "QueryFailed";
}

// MySQL / MariaDB instrumentation, publishing the same `sql.query` events the
// Postgres plugin does — so repeated-query (N+1) detection, SQL timing and the
// SQL filter all work on MySQL without the dashboard knowing which database it
// is. Only the statement text is read; with the `?` placeholders mysql2
// encourages it contains no data, and the values array is never touched.
export function createMysqlPlugin(): MysqlPlugin {
  // Undefined before setup() and after teardown: instrument() may be called
  // before Wevna starts, and a query must never fail because Wevna was not
  // listening.
  let context: PluginContext | undefined;
  const wrapped = new WeakSet<object>();

  function wrap(queryable: MysqlQueryable, method: "query" | "execute"): void {
    const original = queryable[method];
    if (typeof original !== "function") {
      return;
    }
    const bound = original.bind(queryable);

    queryable[method] = (...args: unknown[]): unknown => {
      const startedAt = performance.now();
      const query = statementText(args);
      const result = bound(...args);

      // Callback-style calls return a Query/Command object, not a Promise.
      // Passed through untouched rather than guessed at.
      if (!result || typeof (result as Promise<unknown>).then !== "function") {
        return result;
      }

      return (result as Promise<unknown>).then(
        (value) => {
          const rows = rowCount(value);
          context?.publish({
            kind: "sql.query",
            attributes: {
              query,
              durationMs: performance.now() - startedAt,
              ...(rows !== undefined ? { rows } : {}),
            },
          });
          return value;
        },
        (error: unknown) => {
          context?.publish({
            kind: "sql.query",
            attributes: {
              query,
              durationMs: performance.now() - startedAt,
              error: describeFailure(error),
            },
          });
          throw error;
        },
      );
    };
  }

  return {
    name: "@wevna/plugin-mysql",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    eventKinds: ["sql.query"],

    setup(ctx: PluginContext): PluginSetupResult {
      context = ctx;
      // Like the pg wrapper, left installed: the object may outlive this
      // runtime, so the wrapper goes quiet instead of being removed.
      return () => {
        context = undefined;
      };
    },

    instrument(queryable: MysqlQueryable): void {
      if (wrapped.has(queryable)) {
        return;
      }
      wrapped.add(queryable);
      wrap(queryable, "query");
      wrap(queryable, "execute");
    },
  };
}
