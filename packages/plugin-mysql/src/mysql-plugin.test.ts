import { PLUGIN_API_VERSION, type PluginContext, type PluginEvent } from "@wevna/sdk";
import { describe, expect, it, vi } from "vitest";
import { createMysqlPlugin, type MysqlQueryable } from "./mysql-plugin.js";

function makeContext(): PluginContext & { published: PluginEvent[] } {
  const published: PluginEvent[] = [];
  return {
    published,
    pluginName: "@wevna/plugin-mysql",
    publish: (event) => {
      published.push(event);
    },
    currentCorrelation: () => undefined,
    startCorrelation: (fn) => fn(),
    runWithCorrelation: (_correlation, fn) => fn(),
    logger: { warn: vi.fn(), error: vi.fn() },
  };
}

function setup(result: () => Promise<unknown>) {
  const plugin = createMysqlPlugin();
  const context = makeContext();
  const queryable: MysqlQueryable = { query: vi.fn(result), execute: vi.fn(result) };
  const original = queryable.query;
  return { plugin, context, queryable, original };
}

describe("createMysqlPlugin", () => {
  it("declares a valid plugin descriptor", () => {
    const plugin = createMysqlPlugin();

    expect(plugin.name).toBe("@wevna/plugin-mysql");
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(plugin.eventKinds).toEqual(["sql.query"]);
  });

  it("publishes a sql.query with the row count of a SELECT and returns the result untouched", async () => {
    const reply = [[{ id: 1 }, { id: 2 }], []];
    const { plugin, context, queryable } = setup(async () => reply);
    await plugin.setup(context);
    plugin.instrument(queryable);

    const result = await queryable.query("select * from users where id in (?, ?)", [1, 2]);

    expect(result).toBe(reply);
    expect(context.published).toHaveLength(1);
    expect(context.published[0]).toMatchObject({
      kind: "sql.query",
      attributes: { query: "select * from users where id in (?, ?)", rows: 2 },
    });
  });

  it("reports affectedRows for a write", async () => {
    const { plugin, context, queryable } = setup(async () => [{ affectedRows: 3 }, undefined]);
    await plugin.setup(context);
    plugin.instrument(queryable);

    await queryable.query("update users set active = 1");

    expect(context.published[0]?.attributes.rows).toBe(3);
  });

  it("wraps execute() too, and reads the statement from a config object", async () => {
    const { plugin, context, queryable } = setup(async () => [[], []]);
    await plugin.setup(context);
    plugin.instrument(queryable);

    await queryable.execute?.({ sql: "select 1" });

    expect(context.published[0]?.attributes.query).toBe("select 1");
  });

  it("never records the parameter values", async () => {
    const { plugin, context, queryable } = setup(async () => [[], []]);
    await plugin.setup(context);
    plugin.instrument(queryable);

    await queryable.query("select * from users where email = ?", ["secret@example.com"]);

    expect(JSON.stringify(context.published)).not.toContain("secret@example.com");
  });

  it("reports a failure by error code, not message, and rethrows the original", async () => {
    const failure = Object.assign(new Error("Duplicate entry 'secret@example.com' for key"), {
      code: "ER_DUP_ENTRY",
    });
    const { plugin, context, queryable } = setup(async () => {
      throw failure;
    });
    await plugin.setup(context);
    plugin.instrument(queryable);

    await expect(queryable.query("insert into users values (?)", ["x"])).rejects.toBe(failure);

    expect(context.published[0]?.attributes.error).toBe("ER_DUP_ENTRY");
    expect(JSON.stringify(context.published)).not.toContain("secret@example.com");
  });

  it("passes a callback-style call straight through, unobserved", async () => {
    const plugin = createMysqlPlugin();
    const context = makeContext();
    const commandObject = { on: vi.fn() };
    const queryable: MysqlQueryable = { query: vi.fn(() => commandObject) };
    await plugin.setup(context);
    plugin.instrument(queryable);

    expect(queryable.query("select 1", () => {})).toBe(commandObject);
    expect(context.published).toEqual([]);
  });

  it("does not wrap the same object twice", async () => {
    const { plugin, context, queryable } = setup(async () => [[], []]);
    await plugin.setup(context);

    plugin.instrument(queryable);
    plugin.instrument(queryable);
    await queryable.query("select 1");

    expect(context.published).toHaveLength(1);
  });

  it("still runs the query when Wevna has not started, and goes quiet after teardown", async () => {
    const { plugin, context, queryable } = setup(async () => [[], []]);
    plugin.instrument(queryable);
    await expect(queryable.query("select 1")).resolves.toEqual([[], []]);

    const teardown = await plugin.setup(context);
    await teardown?.();
    await queryable.query("select 2");

    expect(context.published).toEqual([]);
  });
});
