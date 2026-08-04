import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "./pg-instrumentation.js";
import { PgInstrumentation } from "./pg-instrumentation.js";
import type { PluginEvent } from "./plugin.js";

function makeQueryable(implementation: (...args: unknown[]) => unknown): PgQueryable {
  return { query: implementation };
}

describe("PgInstrumentation", () => {
  it("publishes a sql.query event with the query text and duration on success", async () => {
    const queryable = makeQueryable(async () => ({ rows: [{ id: 1 }], rowCount: 1 }));
    const publish = vi.fn<(event: PluginEvent) => void>();
    new PgInstrumentation(publish).instrument(queryable);

    await queryable.query("SELECT * FROM users WHERE id = $1", [42]);

    expect(publish).toHaveBeenCalledOnce();
    const event = publish.mock.calls[0]?.[0];
    expect(event?.kind).toBe("sql.query");
    expect(event?.attributes.query).toBe("SELECT * FROM users WHERE id = $1");
    expect(event?.attributes.rows).toBe(1);
    expect(event?.attributes.durationMs).toBeTypeOf("number");
  });

  it("never includes query parameter values in the published event", async () => {
    const queryable = makeQueryable(async () => ({ rows: [], rowCount: 0 }));
    const publish = vi.fn<(event: PluginEvent) => void>();
    new PgInstrumentation(publish).instrument(queryable);

    await queryable.query("SELECT * FROM users WHERE email = $1", ["secret@example.com"]);

    const attributes = JSON.stringify(publish.mock.calls[0]?.[0].attributes);
    expect(attributes).not.toContain("secret@example.com");
  });

  it("reads the query text from a QueryConfig-style object argument", async () => {
    const queryable = makeQueryable(async () => ({ rowCount: 0 }));
    const publish = vi.fn<(event: PluginEvent) => void>();
    new PgInstrumentation(publish).instrument(queryable);

    await queryable.query({ text: "SELECT 1", values: [] });

    expect(publish.mock.calls[0]?.[0].attributes.query).toBe("SELECT 1");
  });

  it("omits rows when the result has no rowCount", async () => {
    const queryable = makeQueryable(async () => ({}));
    const publish = vi.fn<(event: PluginEvent) => void>();
    new PgInstrumentation(publish).instrument(queryable);

    await queryable.query("BEGIN");

    expect(publish.mock.calls[0]?.[0].attributes.rows).toBeUndefined();
  });

  it("still publishes an event, without rows, when the query rejects", async () => {
    const queryable = makeQueryable(async () => {
      throw new Error("connection terminated");
    });
    const publish = vi.fn<(event: PluginEvent) => void>();
    new PgInstrumentation(publish).instrument(queryable);

    await expect(queryable.query("SELECT 1")).rejects.toThrow("connection terminated");

    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0].attributes.rows).toBeUndefined();
  });

  it("still rejects with the original error after publishing", async () => {
    const originalError = new Error("boom");
    const queryable = makeQueryable(async () => {
      throw originalError;
    });
    new PgInstrumentation(vi.fn()).instrument(queryable);

    await expect(queryable.query("SELECT 1")).rejects.toBe(originalError);
  });

  it("passes through callback-style calls unobserved", () => {
    const callback = vi.fn();
    const queryable = makeQueryable((_text: unknown, cb: unknown) => {
      (cb as () => void)();
      return undefined;
    });
    const publish = vi.fn<(event: PluginEvent) => void>();
    new PgInstrumentation(publish).instrument(queryable);

    queryable.query("SELECT 1", callback);

    expect(callback).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not double-wrap the same queryable when instrumented twice", async () => {
    let callCount = 0;
    const queryable = makeQueryable(async () => {
      callCount += 1;
      return { rowCount: 0 };
    });
    const publish = vi.fn<(event: PluginEvent) => void>();
    const instrumentation = new PgInstrumentation(publish);
    instrumentation.instrument(queryable);
    instrumentation.instrument(queryable);

    await queryable.query("SELECT 1");

    expect(callCount).toBe(1);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("preserves the resolved value returned to the caller", async () => {
    const queryable = makeQueryable(async () => ({ rows: [{ id: 1 }], rowCount: 1 }));
    new PgInstrumentation(vi.fn()).instrument(queryable);

    const result = await queryable.query("SELECT 1");

    expect(result).toEqual({ rows: [{ id: 1 }], rowCount: 1 });
  });

  it("accepts a real pg.Pool instance (structural compatibility, no connection made)", () => {
    // pg.Pool is lazy: constructing one, and wrapping its query method,
    // never opens a connection — only calling query() would. This just
    // confirms the real type satisfies PgQueryable.
    const pool = new Pool();

    expect(() => new PgInstrumentation(vi.fn()).instrument(pool)).not.toThrow();

    void pool.end();
  });
});
