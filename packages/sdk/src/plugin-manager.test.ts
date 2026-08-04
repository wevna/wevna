import type { CapturedEvent, Correlation } from "@wevna/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_API_VERSION, type PluginContext, type WevnaPlugin } from "./plugin.js";
import { type PluginHost, PluginManager } from "./plugin-manager.js";

function makeHost(overrides: Partial<PluginHost> = {}): PluginHost & {
  published: CapturedEvent[];
} {
  const published: CapturedEvent[] = [];
  return {
    published,
    publish: (event) => {
      published.push(event);
    },
    currentCorrelation: () => undefined,
    startCorrelation: (fn) => fn(),
    runWithCorrelation: (_correlation, fn) => fn(),
    ...overrides,
  };
}

function makePlugin(overrides: Partial<WevnaPlugin> = {}): WevnaPlugin {
  return {
    name: "test-plugin",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    setup: () => undefined,
    ...overrides,
  };
}

// Plugin diagnostics go to console.warn/console.error, so they are silenced
// here to keep test output readable — and restored after each test, since a
// spy left in place would accumulate calls across tests and make any
// call-count assertion meaningless.
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PluginManager", () => {
  describe("registration", () => {
    it("starts with no plugins", () => {
      expect(new PluginManager(makeHost()).descriptors).toEqual([]);
    });

    it("records a registered plugin before the runtime starts", () => {
      const manager = new PluginManager(makeHost());

      manager.register(makePlugin({ name: "a", version: "2.1.0" }));

      expect(manager.descriptors).toEqual([
        {
          name: "a",
          version: "2.1.0",
          apiVersion: PLUGIN_API_VERSION,
          eventKinds: [],
          status: "registered",
        },
      ]);
    });

    it("does not call setup() until the runtime starts", () => {
      const setup = vi.fn();
      const manager = new PluginManager(makeHost());

      manager.register(makePlugin({ setup }));

      expect(setup).not.toHaveBeenCalled();
    });

    it("exposes declared event kinds for capability discovery", () => {
      const manager = new PluginManager(makeHost());

      manager.register(makePlugin({ eventKinds: ["mongodb.query", "mongodb.aggregate"] }));

      expect(manager.descriptors[0]?.eventKinds).toEqual(["mongodb.query", "mongodb.aggregate"]);
    });
  });

  describe("rejecting unusable plugins", () => {
    it("never throws, so a bad plugin cannot break application startup", () => {
      const manager = new PluginManager(makeHost());

      expect(() => manager.register(makePlugin({ apiVersion: 99 }))).not.toThrow();
      expect(() => manager.register(undefined as unknown as WevnaPlugin)).not.toThrow();
      expect(() => manager.register({} as unknown as WevnaPlugin)).not.toThrow();
    });

    it("refuses a plugin built against a different api version", () => {
      const manager = new PluginManager(makeHost());

      manager.register(makePlugin({ apiVersion: 99 }));

      expect(manager.descriptors[0]?.status).toBe("failed");
      expect(manager.descriptors[0]?.error).toContain("plugin api version 99");
    });

    it("refuses a second plugin using an already-registered name", () => {
      const manager = new PluginManager(makeHost());

      manager.register(makePlugin({ name: "dup" }));
      manager.register(makePlugin({ name: "dup" }));

      expect(manager.descriptors.map((d) => d.status)).toEqual(["registered", "failed"]);
      expect(manager.descriptors[1]?.error).toContain("already registered");
    });

    it("lets a name be reused if the previous registration failed", () => {
      const manager = new PluginManager(makeHost());

      manager.register(makePlugin({ name: "same", apiVersion: 99 }));
      manager.register(makePlugin({ name: "same" }));

      expect(manager.descriptors.map((d) => d.status)).toEqual(["failed", "registered"]);
    });

    it("refuses a plugin with no setup function", () => {
      const manager = new PluginManager(makeHost());

      manager.register({
        name: "no-setup",
        version: "1.0.0",
        apiVersion: PLUGIN_API_VERSION,
      } as unknown as WevnaPlugin);

      expect(manager.descriptors[0]?.error).toContain("missing a setup()");
    });

    it("ignores input with no usable name, since there is nothing to describe", () => {
      const manager = new PluginManager(makeHost());

      manager.register(undefined as unknown as WevnaPlugin);
      manager.register({} as unknown as WevnaPlugin);
      manager.register(makePlugin({ name: "" }));

      expect(manager.descriptors).toEqual([]);
      expect(console.warn).toHaveBeenCalledTimes(3);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("not an object with a name"),
      );
    });

    it("warns about a rejected plugin without using console.log", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const manager = new PluginManager(makeHost());

      manager.register(makePlugin({ name: "bad", apiVersion: 99 }));

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('plugin "bad"'));
      // console.log is instrumented, so diagnostics there would become
      // captured events in the developer's own stream.
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe("lifecycle", () => {
    it("sets plugins up on startAll, in registration order", async () => {
      const order: string[] = [];
      const manager = new PluginManager(makeHost());
      manager.register(makePlugin({ name: "first", setup: () => void order.push("first") }));
      manager.register(makePlugin({ name: "second", setup: () => void order.push("second") }));

      await manager.startAll();

      expect(order).toEqual(["first", "second"]);
      expect(manager.descriptors.map((d) => d.status)).toEqual(["active", "active"]);
    });

    it("awaits an async setup before considering the plugin active", async () => {
      let resolved = false;
      const manager = new PluginManager(makeHost());
      manager.register(
        makePlugin({
          setup: async () => {
            await Promise.resolve();
            resolved = true;
          },
        }),
      );

      await manager.startAll();

      expect(resolved).toBe(true);
      expect(manager.descriptors[0]?.status).toBe("active");
    });

    it("sets a plugin up immediately when registered after startAll", async () => {
      const setup = vi.fn();
      const manager = new PluginManager(makeHost());
      await manager.startAll();

      manager.register(makePlugin({ setup }));
      await manager.settled();

      expect(setup).toHaveBeenCalledOnce();
      expect(manager.descriptors[0]?.status).toBe("active");
    });

    it("runs teardowns in reverse registration order", async () => {
      const order: string[] = [];
      const manager = new PluginManager(makeHost());
      manager.register(makePlugin({ name: "first", setup: () => () => void order.push("first") }));
      manager.register(
        makePlugin({ name: "second", setup: () => () => void order.push("second") }),
      );
      await manager.startAll();

      await manager.stopAll();

      expect(order).toEqual(["second", "first"]);
      expect(manager.descriptors.map((d) => d.status)).toEqual(["stopped", "stopped"]);
    });

    it("awaits an async teardown", async () => {
      let torn = false;
      const manager = new PluginManager(makeHost());
      manager.register(
        makePlugin({
          setup: () => async () => {
            await Promise.resolve();
            torn = true;
          },
        }),
      );
      await manager.startAll();

      await manager.stopAll();

      expect(torn).toBe(true);
    });

    it("tolerates a plugin that returns no teardown", async () => {
      const manager = new PluginManager(makeHost());
      manager.register(makePlugin({ setup: () => undefined }));
      await manager.startAll();

      await expect(manager.stopAll()).resolves.toBeUndefined();
      expect(manager.descriptors[0]?.status).toBe("stopped");
    });

    it("does not set the same plugin up twice across repeated startAll calls", async () => {
      const setup = vi.fn();
      const manager = new PluginManager(makeHost());
      manager.register(makePlugin({ setup }));

      await manager.startAll();
      await manager.startAll();

      expect(setup).toHaveBeenCalledOnce();
    });

    it("supports a stop/start cycle without re-running a stopped plugin's setup", async () => {
      const setup = vi.fn();
      const manager = new PluginManager(makeHost());
      manager.register(makePlugin({ setup }));
      await manager.startAll();
      await manager.stopAll();

      await manager.startAll();

      // A stopped plugin stays stopped: re-setting it up would re-patch
      // clients its teardown already unwrapped.
      expect(setup).toHaveBeenCalledOnce();
      expect(manager.descriptors[0]?.status).toBe("stopped");
    });

    it("tears down a plugin whose async setup finished after stopAll began", async () => {
      const teardown = vi.fn();
      const manager = new PluginManager(makeHost());
      await manager.startAll();
      manager.register(
        makePlugin({
          setup: async () => {
            await Promise.resolve();
            return teardown;
          },
        }),
      );

      await manager.stopAll();

      // Never left "active" holding a teardown nobody would call.
      expect(teardown).toHaveBeenCalledOnce();
      expect(manager.descriptors[0]?.status).toBe("stopped");
    });
  });

  describe("fault isolation", () => {
    it("quarantines a plugin whose setup throws, without rejecting startAll", async () => {
      const manager = new PluginManager(makeHost());
      manager.register(
        makePlugin({
          name: "explodes",
          setup: () => {
            throw new Error("boom");
          },
        }),
      );

      await expect(manager.startAll()).resolves.toBeUndefined();

      expect(manager.descriptors[0]?.status).toBe("failed");
      expect(manager.descriptors[0]?.error).toBe("boom");
    });

    it("quarantines a plugin whose async setup rejects", async () => {
      const manager = new PluginManager(makeHost());
      manager.register(makePlugin({ setup: () => Promise.reject(new Error("async boom")) }));

      await manager.startAll();

      expect(manager.descriptors[0]?.status).toBe("failed");
      expect(manager.descriptors[0]?.error).toBe("async boom");
    });

    it("still sets up later plugins after an earlier one fails", async () => {
      const setup = vi.fn();
      const manager = new PluginManager(makeHost());
      manager.register(
        makePlugin({
          name: "bad",
          setup: () => {
            throw new Error("boom");
          },
        }),
      );
      manager.register(makePlugin({ name: "good", setup }));

      await manager.startAll();

      expect(setup).toHaveBeenCalledOnce();
      expect(manager.descriptors.map((d) => d.status)).toEqual(["failed", "active"]);
    });

    it("never tears down a plugin that failed setup", async () => {
      const teardown = vi.fn();
      const manager = new PluginManager(makeHost());
      manager.register(
        makePlugin({
          setup: () => {
            // Returning a teardown is irrelevant — it was never received,
            // because setup threw before handing it back.
            throw new Error("boom");
          },
        }),
      );
      await manager.startAll();

      await manager.stopAll();

      expect(teardown).not.toHaveBeenCalled();
    });

    it("keeps tearing down other plugins when one teardown throws", async () => {
      const survivor = vi.fn();
      const manager = new PluginManager(makeHost());
      manager.register(makePlugin({ name: "first", setup: () => survivor }));
      manager.register(
        makePlugin({
          name: "second",
          setup: () => () => {
            throw new Error("teardown boom");
          },
        }),
      );
      await manager.startAll();

      await expect(manager.stopAll()).resolves.toBeUndefined();

      expect(survivor).toHaveBeenCalledOnce();
      expect(manager.descriptors.map((d) => d.status)).toEqual(["stopped", "stopped"]);
    });

    it("does not let a publish failure escape into the plugin's call site", async () => {
      const host = makeHost({
        publish: () => {
          throw new Error("bus exploded");
        },
      });
      let threw = false;
      const manager = new PluginManager(host);
      manager.register(
        makePlugin({
          setup: (context) => {
            try {
              context.publish({ kind: "x.y", attributes: {} });
            } catch {
              threw = true;
            }
          },
        }),
      );

      await manager.startAll();

      // The plugin is wrapping a real operation in the developer's app; a
      // failed observation must not surface there.
      expect(threw).toBe(false);
      expect(manager.descriptors[0]?.status).toBe("active");
    });
  });

  describe("plugin context", () => {
    function captureContext(manager: PluginManager): Promise<PluginContext> {
      return new Promise((resolve) => {
        manager.register(
          makePlugin({
            setup: (context) => {
              resolve(context);
            },
          }),
        );
        void manager.startAll();
      });
    }

    it("stamps id, occurredAt and source onto a published event", async () => {
      const host = makeHost();
      const manager = new PluginManager(host);
      const context = await captureContext(manager);

      context.publish({ kind: "mongodb.query", attributes: { collection: "users" } });

      const event = host.published[0];
      expect(event?.kind).toBe("mongodb.query");
      expect(event?.attributes).toEqual({ collection: "users" });
      expect(event?.source).toBe("test-plugin");
      expect(typeof event?.id).toBe("string");
      expect(typeof event?.occurredAt).toBe("number");
    });

    it("mints a distinct id per published event", async () => {
      const host = makeHost();
      const context = await captureContext(new PluginManager(host));

      context.publish({ kind: "a.b", attributes: {} });
      context.publish({ kind: "a.b", attributes: {} });

      expect(host.published[0]?.id).not.toBe(host.published[1]?.id);
    });

    it("honours an explicit occurredAt when the plugin knows better", async () => {
      const host = makeHost();
      const context = await captureContext(new PluginManager(host));

      context.publish({ kind: "a.b", attributes: {}, occurredAt: 12345 });

      expect(host.published[0]?.occurredAt).toBe(12345);
    });

    it("omits the correlation key entirely when none is given", async () => {
      const host = makeHost();
      const context = await captureContext(new PluginManager(host));

      context.publish({ kind: "a.b", attributes: {} });

      // Absent, not undefined: Runtime attaches the ambient correlation, and
      // an explicit `correlation: undefined` key would shadow it.
      expect(host.published[0]).not.toHaveProperty("correlation");
    });

    it("passes an explicit correlation through", async () => {
      const host = makeHost();
      const context = await captureContext(new PluginManager(host));

      context.publish({ kind: "a.b", attributes: {}, correlation: { id: "job-1" } });

      expect(host.published[0]?.correlation).toEqual({ id: "job-1" });
    });

    it("exposes the host's correlation helpers", async () => {
      const correlation: Correlation = { id: "corr-9" };
      const host = makeHost({
        currentCorrelation: () => correlation,
        startCorrelation: (fn) => fn(),
        runWithCorrelation: (_c, fn) => fn(),
      });
      const context = await captureContext(new PluginManager(host));

      expect(context.currentCorrelation()).toBe(correlation);
      expect(context.startCorrelation(() => "started")).toBe("started");
      expect(context.runWithCorrelation(correlation, () => "joined")).toBe("joined");
    });

    it("tells the plugin its own name", async () => {
      const context = await captureContext(new PluginManager(makeHost()));

      expect(context.pluginName).toBe("test-plugin");
    });

    it("namespaces logger output with the plugin name", async () => {
      const context = await captureContext(new PluginManager(makeHost()));

      context.logger.warn("careful");
      context.logger.error("broke", new Error("why"));

      expect(console.warn).toHaveBeenCalledWith('[wevna] plugin "test-plugin": careful');
      expect(console.error).toHaveBeenCalledWith('[wevna] plugin "test-plugin": broke: why');
    });
  });

  describe("settled", () => {
    it("resolves immediately when nothing is in flight", async () => {
      await expect(new PluginManager(makeHost()).settled()).resolves.toBeUndefined();
    });

    it("waits for a post-start async setup to finish", async () => {
      let done = false;
      const manager = new PluginManager(makeHost());
      await manager.startAll();
      manager.register(
        makePlugin({
          setup: async () => {
            await Promise.resolve();
            done = true;
          },
        }),
      );

      await manager.settled();

      expect(done).toBe(true);
    });
  });
});
