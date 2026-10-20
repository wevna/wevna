import { EventEmitter } from "node:events";
import { PLUGIN_API_VERSION, type PluginContext, type PluginEvent } from "@wevna/sdk";
import { describe, expect, it, vi } from "vitest";
import { createMongoDbPlugin } from "./mongodb-plugin.js";

function makeContext(correlation?: { id: string }): PluginContext & { published: PluginEvent[] } {
  const published: PluginEvent[] = [];
  return {
    published,
    pluginName: "@wevna/plugin-mongodb",
    publish: (event) => {
      published.push(event);
    },
    currentCorrelation: () => correlation,
    startCorrelation: (fn) => fn(),
    runWithCorrelation: (_correlation, fn) => fn(),
    logger: { warn: vi.fn(), error: vi.fn() },
  };
}

function started(requestId: number, commandName: string, collection: unknown = "users") {
  return {
    requestId,
    commandName,
    databaseName: "app",
    command: { [commandName]: collection, filter: { email: "secret@example.com" } },
  };
}

describe("createMongoDbPlugin", () => {
  it("declares a valid plugin descriptor", () => {
    const plugin = createMongoDbPlugin();

    expect(plugin.name).toBe("@wevna/plugin-mongodb");
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(plugin.eventKinds).toEqual(["mongodb.command"]);
  });

  it("publishes the operation, collection, database and duration of a command", async () => {
    const plugin = createMongoDbPlugin();
    const context = makeContext();
    const client = new EventEmitter();
    await plugin.setup(context);
    plugin.instrument(client);

    client.emit("commandStarted", started(1, "find"));
    client.emit("commandSucceeded", { requestId: 1, duration: 7 });

    expect(context.published).toEqual([
      {
        kind: "mongodb.command",
        attributes: { operation: "find", target: "users", database: "app", durationMs: 7 },
      },
    ]);
  });

  it("never records the command document", async () => {
    const plugin = createMongoDbPlugin();
    const context = makeContext();
    const client = new EventEmitter();
    await plugin.setup(context);
    plugin.instrument(client);

    client.emit("commandStarted", started(1, "find"));
    client.emit("commandSucceeded", { requestId: 1, duration: 1 });

    expect(JSON.stringify(context.published)).not.toContain("secret@example.com");
  });

  it("reports a failed command by code name, not message", async () => {
    const plugin = createMongoDbPlugin();
    const context = makeContext();
    const client = new EventEmitter();
    await plugin.setup(context);
    plugin.instrument(client);

    client.emit("commandStarted", started(1, "insert"));
    client.emit("commandFailed", {
      requestId: 1,
      duration: 2,
      failure: Object.assign(new Error("E11000 dup key { email: 'secret@example.com' }"), {
        codeName: "DuplicateKey",
      }),
    });

    expect(context.published[0]?.attributes.error).toBe("DuplicateKey");
    expect(JSON.stringify(context.published)).not.toContain("secret@example.com");
  });

  it("carries the correlation captured at commandStarted to the finish event", async () => {
    const plugin = createMongoDbPlugin();
    const context = makeContext({ id: "req-1" });
    const client = new EventEmitter();
    await plugin.setup(context);
    plugin.instrument(client);

    client.emit("commandStarted", started(1, "find"));
    // The finish event fires from a socket callback with no active context.
    context.currentCorrelation = () => undefined;
    client.emit("commandSucceeded", { requestId: 1, duration: 1 });

    expect(context.published[0]?.correlation).toEqual({ id: "req-1" });
  });

  it("ignores driver housekeeping and caller-ignored commands", async () => {
    const plugin = createMongoDbPlugin({ ignoreCommands: ["count"] });
    const context = makeContext();
    const client = new EventEmitter();
    await plugin.setup(context);
    plugin.instrument(client);

    for (const [id, name] of [
      [1, "hello"],
      [2, "ping"],
      [3, "count"],
    ] as const) {
      client.emit("commandStarted", started(id, name, 1));
      client.emit("commandSucceeded", { requestId: id, duration: 1 });
    }

    expect(context.published).toEqual([]);
  });

  it("takes the collection of a getMore from command.collection, not the cursor id", async () => {
    const plugin = createMongoDbPlugin();
    const context = makeContext();
    const client = new EventEmitter();
    await plugin.setup(context);
    plugin.instrument(client);

    client.emit("commandStarted", {
      requestId: 1,
      commandName: "getMore",
      databaseName: "app",
      command: { getMore: 123456789n, collection: "users", batchSize: 101 },
    });
    client.emit("commandSucceeded", { requestId: 1, duration: 1 });

    expect(context.published[0]?.attributes).toMatchObject({
      operation: "getMore",
      target: "users",
    });
  });

  it("omits the target for a command that is not about a collection", async () => {
    const plugin = createMongoDbPlugin();
    const context = makeContext();
    const client = new EventEmitter();
    await plugin.setup(context);
    plugin.instrument(client);

    client.emit("commandStarted", started(1, "listCollections", 1));
    client.emit("commandSucceeded", { requestId: 1, duration: 1 });

    expect(context.published[0]?.attributes).not.toHaveProperty("target");
  });

  it("attaches a client instrumented before Wevna started", async () => {
    const plugin = createMongoDbPlugin();
    const client = new EventEmitter();
    plugin.instrument(client);
    const context = makeContext();

    await plugin.setup(context);
    client.emit("commandStarted", started(1, "find"));
    client.emit("commandSucceeded", { requestId: 1, duration: 1 });

    expect(context.published).toHaveLength(1);
  });

  it("stops listening and publishes nothing after teardown", async () => {
    const plugin = createMongoDbPlugin();
    const context = makeContext();
    const client = new EventEmitter();
    const teardown = await plugin.setup(context);
    plugin.instrument(client);

    await teardown?.();
    client.emit("commandStarted", started(1, "find"));
    client.emit("commandSucceeded", { requestId: 1, duration: 1 });

    expect(client.listenerCount("commandStarted")).toBe(0);
    expect(context.published).toEqual([]);
  });

  it("does not attach twice when the same client is instrumented again", async () => {
    const plugin = createMongoDbPlugin();
    const client = new EventEmitter();
    await plugin.setup(makeContext());

    plugin.instrument(client);
    plugin.instrument(client);

    expect(client.listenerCount("commandStarted")).toBe(1);
  });
});
