import { performance } from "node:perf_hooks";
import type { PluginEvent } from "./plugin.js";

// Emits PluginEvent, not CapturedEvent: this producer reaches the runtime
// through the plugin api (see pg-plugin.ts), which stamps the event id and
// timestamp. Nothing here mints an id or reads a clock for bookkeeping
// anymore — only the durations it actually measures.
export type PublishPluginEvent = (event: PluginEvent) => void;

// Structural, not pg.Pool/pg.Client: only the one method this needs to
// wrap, so a real Pool or Client instance satisfies it without wevna
// depending on the pg package.
export interface PgQueryable {
  query: (...args: unknown[]) => unknown;
}

function extractQueryText(args: readonly unknown[]): string {
  const first = args[0];
  if (typeof first === "string") {
    return first;
  }
  if (first && typeof first === "object" && "text" in first) {
    const text = (first as { text?: unknown }).text;
    if (typeof text === "string") {
      return text;
    }
  }
  return "";
}

function extractRowCount(result: unknown): number | undefined {
  if (!result || typeof result !== "object" || !("rowCount" in result)) {
    return undefined;
  }
  const rowCount = (result as { rowCount?: unknown }).rowCount;
  return typeof rowCount === "number" ? rowCount : undefined;
}

// Wevna's node-postgres producer. Wraps a Pool or Client's query() so
// calling it still behaves exactly as before, but also publishes a
// sql.query event once the query settles. Only supports the
// Promise-returning call form (query(text) / query(text, values) /
// query(queryConfig) with no callback) — the common, recommended form,
// and the only one pg gives back a Promise for; callback-style calls pass
// through unobserved rather than being guessed at.
//
// Never parses SQL, never records parameter values (only args[0] — the
// query text/config — is ever read, never args[1], the values array), and
// never touches connection strings or credentials. Query *text* is
// captured on the assumption of parameterized queries ($1, $2, ...)
// being standard practice, so it normally contains no data — that's a
// property of how pg is meant to be used, not something this
// instrumentation itself enforces or verifies.
export class PgInstrumentation {
  readonly #publish: PublishPluginEvent;
  #wrapped = new WeakSet<PgQueryable>();

  constructor(publish: PublishPluginEvent) {
    this.#publish = publish;
  }

  instrument(queryable: PgQueryable): void {
    if (this.#wrapped.has(queryable)) {
      return;
    }
    this.#wrapped.add(queryable);

    const originalQuery = queryable.query.bind(queryable);
    const publish = this.#publish;

    queryable.query = (...args: unknown[]): unknown => {
      const startedAt = performance.now();
      const queryText = extractQueryText(args);
      const result = originalQuery(...args);

      if (!result || typeof (result as Promise<unknown>).then !== "function") {
        // Callback-style call — pg doesn't return a Promise for these;
        // pass through untouched rather than guessing at completion.
        return result;
      }

      return (result as Promise<unknown>).then(
        (value) => {
          const rows = extractRowCount(value);
          publish({
            kind: "sql.query",
            attributes: {
              query: queryText,
              durationMs: performance.now() - startedAt,
              ...(rows !== undefined ? { rows } : {}),
            },
          });
          return value;
        },
        (error: unknown) => {
          publish({
            kind: "sql.query",
            attributes: { query: queryText, durationMs: performance.now() - startedAt },
          });
          throw error;
        },
      );
    };
  }
}
