import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_API_VERSION, type PluginContext, type PluginEvent } from "wevna";
import { createFetchPlugin } from "./fetch-plugin.js";

function makeContext(): PluginContext & { published: PluginEvent[] } {
  const published: PluginEvent[] = [];
  return {
    published,
    pluginName: "@wevna/plugin-fetch",
    publish: (event) => {
      published.push(event);
    },
    currentCorrelation: () => undefined,
    startCorrelation: (fn) => fn(),
    runWithCorrelation: (_correlation, fn) => fn(),
    logger: { warn: vi.fn(), error: vi.fn() },
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("createFetchPlugin", () => {
  it("declares a valid plugin descriptor", () => {
    const plugin = createFetchPlugin();

    expect(plugin.name).toBe("@wevna/plugin-fetch");
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(plugin.eventKinds).toEqual(["http.client"]);
  });

  describe("successful requests", () => {
    let context: ReturnType<typeof makeContext>;
    let upstream: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      upstream = vi.fn(async () => new Response("ok", { status: 201 }));
      globalThis.fetch = upstream as unknown as typeof globalThis.fetch;
      context = makeContext();
      createFetchPlugin().setup(context);
    });

    it("publishes an http.client event with method, url, status and duration", async () => {
      await globalThis.fetch("https://api.example.com/orders", { method: "POST" });

      expect(context.published).toHaveLength(1);
      expect(context.published[0]?.kind).toBe("http.client");
      expect(context.published[0]?.attributes).toMatchObject({
        method: "POST",
        url: "https://api.example.com/orders",
        statusCode: 201,
      });
      expect(typeof context.published[0]?.attributes.durationMs).toBe("number");
    });

    it("returns the upstream response untouched", async () => {
      const response = await globalThis.fetch("https://api.example.com/x");

      expect(response.status).toBe(201);
      expect(await response.text()).toBe("ok");
    });

    it("passes input and init through to the original fetch unchanged", async () => {
      const init = { method: "PUT", headers: { "x-test": "1" } };
      await globalThis.fetch("https://api.example.com/x", init);

      expect(upstream).toHaveBeenCalledWith("https://api.example.com/x", init);
    });

    it("records a 4xx or 5xx as a normal event with its status, not an error", async () => {
      upstream.mockResolvedValueOnce(new Response("nope", { status: 503 }));

      await globalThis.fetch("https://api.example.com/x");

      expect(context.published[0]?.attributes.statusCode).toBe(503);
      expect(context.published[0]?.attributes).not.toHaveProperty("error");
    });

    it("redacts credentials in the recorded url", async () => {
      await globalThis.fetch("https://api.example.com/x?api_key=abc123&page=2");

      const url = context.published[0]?.attributes.url as string;
      expect(url).not.toContain("abc123");
      expect(url).toContain("page=2");
    });

    it("never records headers or bodies", async () => {
      await globalThis.fetch("https://api.example.com/x", {
        method: "POST",
        headers: { authorization: "Bearer super-secret" },
        body: JSON.stringify({ ssn: "000-00-0000" }),
      });

      const serialized = JSON.stringify(context.published[0]?.attributes);
      expect(serialized).not.toContain("super-secret");
      expect(serialized).not.toContain("000-00-0000");
      expect(Object.keys(context.published[0]?.attributes ?? {}).sort()).toEqual([
        "durationMs",
        "method",
        "statusCode",
        "url",
      ]);
    });
  });

  describe("failing requests", () => {
    it("records the failure and rethrows the original error untouched", async () => {
      const failure = new Error("ECONNREFUSED");
      globalThis.fetch = vi.fn(async () => {
        throw failure;
      }) as unknown as typeof globalThis.fetch;
      const context = makeContext();
      createFetchPlugin().setup(context);

      await expect(globalThis.fetch("https://api.example.com/x")).rejects.toBe(failure);

      expect(context.published[0]?.attributes).toMatchObject({
        method: "GET",
        url: "https://api.example.com/x",
        error: "ECONNREFUSED",
      });
      // No status code exists for a connection that never completed.
      expect(context.published[0]?.attributes).not.toHaveProperty("statusCode");
    });

    it("handles a non-Error rejection without losing it", async () => {
      globalThis.fetch = vi.fn(async () => {
        throw "just a string";
      }) as unknown as typeof globalThis.fetch;
      const context = makeContext();
      createFetchPlugin().setup(context);

      await expect(globalThis.fetch("https://api.example.com/x")).rejects.toBe("just a string");
      expect(context.published[0]?.attributes.error).toBe("just a string");
    });
  });

  describe("ignoreHosts", () => {
    it("passes an ignored host straight through without publishing", async () => {
      const upstream = vi.fn(async () => new Response("ok"));
      globalThis.fetch = upstream as unknown as typeof globalThis.fetch;
      const context = makeContext();
      createFetchPlugin({ ignoreHosts: ["metrics.internal"] }).setup(context);

      await globalThis.fetch("https://metrics.internal/ingest");

      expect(upstream).toHaveBeenCalledOnce();
      expect(context.published).toHaveLength(0);
    });

    it("still captures hosts that are not ignored", async () => {
      globalThis.fetch = vi.fn(
        async () => new Response("ok"),
      ) as unknown as typeof globalThis.fetch;
      const context = makeContext();
      createFetchPlugin({ ignoreHosts: ["metrics.internal"] }).setup(context);

      await globalThis.fetch("https://api.example.com/x");

      expect(context.published).toHaveLength(1);
    });

    it("captures an unparseable target rather than silently ignoring it", async () => {
      globalThis.fetch = vi.fn(
        async () => new Response("ok"),
      ) as unknown as typeof globalThis.fetch;
      const context = makeContext();
      createFetchPlugin({ ignoreHosts: ["metrics.internal"] }).setup(context);

      await globalThis.fetch("not a url");

      // An ignore list should narrow what is captured, never widen it.
      expect(context.published).toHaveLength(1);
    });
  });

  describe("lifecycle", () => {
    it("restores the original fetch on teardown", async () => {
      const upstream = vi.fn(async () => new Response("ok"));
      globalThis.fetch = upstream as unknown as typeof globalThis.fetch;
      const context = makeContext();

      const teardown = createFetchPlugin().setup(context);
      expect(globalThis.fetch).not.toBe(upstream);
      await (teardown as () => void)();

      expect(globalThis.fetch).toBe(upstream);
      await globalThis.fetch("https://api.example.com/x");
      expect(context.published).toHaveLength(0);
    });

    it("does not clobber a wrapper installed after it", async () => {
      globalThis.fetch = vi.fn(
        async () => new Response("ok"),
      ) as unknown as typeof globalThis.fetch;
      const teardown = createFetchPlugin().setup(makeContext());

      const laterWrapper = vi.fn(async () => new Response("later"));
      globalThis.fetch = laterWrapper as unknown as typeof globalThis.fetch;
      await (teardown as () => void)();

      // Blindly restoring would silently un-instrument whoever patched last.
      expect(globalThis.fetch).toBe(laterWrapper);
    });

    it("warns and does nothing when global fetch is unavailable", () => {
      // @ts-expect-error deliberately simulating an environment without fetch
      globalThis.fetch = undefined;
      const context = makeContext();

      const teardown = createFetchPlugin().setup(context);

      expect(context.logger.warn).toHaveBeenCalledWith(expect.stringContaining("fetch"));
      expect(teardown).toBeUndefined();
    });
  });
});
