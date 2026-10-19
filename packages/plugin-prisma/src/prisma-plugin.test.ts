import { PLUGIN_API_VERSION, type PluginContext, type PluginEvent } from "@wevna/sdk";
import { describe, expect, it, vi } from "vitest";
import { createPrismaPlugin, type PrismaClientLike } from "./prisma-plugin.js";

function makeContext(): PluginContext & { published: PluginEvent[] } {
  const published: PluginEvent[] = [];
  return {
    published,
    pluginName: "@wevna/plugin-prisma",
    publish: (event) => {
      published.push(event);
    },
    currentCorrelation: () => undefined,
    startCorrelation: (fn) => fn(),
    runWithCorrelation: (_correlation, fn) => fn(),
    logger: { warn: vi.fn(), error: vi.fn() },
  };
}

type Hook = (params: {
  model?: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}) => Promise<unknown>;

// A client whose $extends hands back an object exposing the registered hook,
// which is all the real one does that this plugin depends on.
function makeClient(): PrismaClientLike & { hook?: Hook } {
  const client: PrismaClientLike & { hook?: Hook } = {
    $extends(extension) {
      client.hook = extension.query.$allOperations;
      return client;
    },
  };
  return client;
}

describe("createPrismaPlugin", () => {
  it("declares a valid plugin descriptor", () => {
    const plugin = createPrismaPlugin();

    expect(plugin.name).toBe("@wevna/plugin-prisma");
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(plugin.eventKinds).toEqual(["prisma.query"]);
  });

  it("publishes the model, operation and duration, and returns the result untouched", async () => {
    const plugin = createPrismaPlugin();
    const context = makeContext();
    await plugin.setup(context);
    const client = makeClient();
    plugin.extend(client);

    const result = await client.hook?.({
      model: "User",
      operation: "findMany",
      args: { where: { email: "secret@example.com" } },
      query: async () => [{ id: 1 }],
    });

    expect(result).toEqual([{ id: 1 }]);
    expect(context.published).toHaveLength(1);
    expect(context.published[0]).toMatchObject({
      kind: "prisma.query",
      attributes: { operation: "findMany", target: "User" },
    });
    expect(JSON.stringify(context.published)).not.toContain("secret@example.com");
  });

  it("reports a failure by code and rethrows the original error", async () => {
    const plugin = createPrismaPlugin();
    const context = makeContext();
    await plugin.setup(context);
    const client = makeClient();
    plugin.extend(client);
    const failure = Object.assign(new Error("Unique constraint failed on email=secret"), {
      code: "P2002",
    });

    await expect(
      client.hook?.({
        model: "User",
        operation: "create",
        args: {},
        query: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(context.published[0]?.attributes.error).toBe("P2002");
  });

  it("omits the target for operations with no model", async () => {
    const plugin = createPrismaPlugin();
    const context = makeContext();
    await plugin.setup(context);
    const client = makeClient();
    plugin.extend(client);

    await client.hook?.({ operation: "$queryRaw", args: {}, query: async () => [] });

    expect(context.published[0]?.attributes).not.toHaveProperty("target");
  });

  it("still runs the query when Wevna is not started", async () => {
    const plugin = createPrismaPlugin();
    const client = makeClient();
    plugin.extend(client);

    await expect(
      client.hook?.({ model: "User", operation: "count", args: {}, query: async () => 3 }),
    ).resolves.toBe(3);
  });

  it("goes quiet after teardown", async () => {
    const plugin = createPrismaPlugin();
    const context = makeContext();
    const teardown = await plugin.setup(context);
    const client = makeClient();
    plugin.extend(client);

    await teardown?.();
    await client.hook?.({ model: "User", operation: "count", args: {}, query: async () => 3 });

    expect(context.published).toEqual([]);
  });
});
