import http from "node:http";
import type { AddressInfo } from "node:net";
import type { CapturedEvent } from "@wevna/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentCorrelation } from "./correlation-context.js";
import { ExceptionInstrumentation } from "./exception-instrumentation.js";
import { enrichHttpRequest, HttpInstrumentation } from "./http-instrumentation.js";

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return (server.address() as AddressInfo).port;
}

function createTestServer(
  handler: http.RequestListener = (_req, res) => res.end("ok"),
): http.Server {
  return http.createServer(handler);
}

describe("HttpInstrumentation", () => {
  const servers: http.Server[] = [];
  let instrumentation: HttpInstrumentation | undefined;

  afterEach(async () => {
    instrumentation?.stop();
    instrumentation = undefined;
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  async function startServer(
    handler?: http.RequestListener,
  ): Promise<{ port: number; server: http.Server }> {
    const server = createTestServer(handler);
    servers.push(server);
    const port = await listen(server);
    return { port, server };
  }

  it("publishes exactly one event for one incoming request", async () => {
    const { port } = await startServer();
    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new HttpInstrumentation(publish);
    instrumentation.start();

    await fetch(`http://localhost:${port}/hello`);

    expect(publish).toHaveBeenCalledOnce();
  });

  it("captures method, url, statusCode, and durationMs", async () => {
    const { port } = await startServer((_req, res) => {
      res.statusCode = 201;
      res.end("created");
    });
    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new HttpInstrumentation(publish);
    instrumentation.start();

    await fetch(`http://localhost:${port}/widgets`, { method: "POST" });

    const event = publish.mock.calls[0]?.[0];
    expect(event?.kind).toBe("http.request");
    expect(event?.attributes.method).toBe("POST");
    expect(event?.attributes.url).toBe("/widgets");
    expect(event?.attributes.statusCode).toBe(201);
    expect(event?.attributes.durationMs).toBeTypeOf("number");
    expect(event?.attributes.durationMs as number).toBeGreaterThanOrEqual(0);
  });

  it("publishes one event per request across multiple requests", async () => {
    const { port } = await startServer();
    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new HttpInstrumentation(publish);
    instrumentation.start();

    await fetch(`http://localhost:${port}/a`);
    await fetch(`http://localhost:${port}/b`);
    await fetch(`http://localhost:${port}/c`);

    expect(publish).toHaveBeenCalledTimes(3);
  });

  it("does not capture requests to an ignored server", async () => {
    const { port, server } = await startServer();
    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new HttpInstrumentation(publish);
    instrumentation.start({ ignoreServers: [server] });

    await fetch(`http://localhost:${port}/health`);

    expect(publish).not.toHaveBeenCalled();
  });

  it("captures requests to a non-ignored server while ignoring another", async () => {
    const ignored = await startServer();
    const observed = await startServer();
    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new HttpInstrumentation(publish);
    instrumentation.start({ ignoreServers: [ignored.server] });

    await fetch(`http://localhost:${ignored.port}/health`);
    await fetch(`http://localhost:${observed.port}/users`);

    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0].attributes.url).toBe("/users");
  });

  it("does not capture requests before start() is called", async () => {
    const { port } = await startServer();
    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new HttpInstrumentation(publish);

    await fetch(`http://localhost:${port}/before-start`);

    expect(publish).not.toHaveBeenCalled();
  });

  it("does not capture requests after stop() is called", async () => {
    const { port } = await startServer();
    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new HttpInstrumentation(publish);
    instrumentation.start();
    instrumentation.stop();

    await fetch(`http://localhost:${port}/after-stop`);

    expect(publish).not.toHaveBeenCalled();
  });

  it("does not double-wrap when started twice", async () => {
    const { port } = await startServer();
    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new HttpInstrumentation(publish);
    instrumentation.start();
    instrumentation.start();

    await fetch(`http://localhost:${port}/x`);

    expect(publish).toHaveBeenCalledOnce();
  });

  it("is safe to stop multiple times", () => {
    instrumentation = new HttpInstrumentation(vi.fn());
    instrumentation.start();
    instrumentation.stop();

    expect(() => instrumentation?.stop()).not.toThrow();
  });

  it("merges framework enrichment attached via enrichHttpRequest into the published event", async () => {
    const { port } = await startServer((req, res) => {
      enrichHttpRequest(req, { framework: "fastify", route: "/widgets/:id", handler: "getWidget" });
      res.end("ok");
    });
    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new HttpInstrumentation(publish);
    instrumentation.start();

    await fetch(`http://localhost:${port}/widgets/42`);

    expect(publish.mock.calls[0]?.[0].attributes).toMatchObject({
      framework: "fastify",
      route: "/widgets/:id",
      handler: "getWidget",
    });
  });

  it("does not add framework attributes when nothing enriches the request", async () => {
    const { port } = await startServer();
    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new HttpInstrumentation(publish);
    instrumentation.start();

    await fetch(`http://localhost:${port}/plain`);

    const attributes = publish.mock.calls[0]?.[0].attributes;
    expect(attributes?.framework).toBeUndefined();
    expect(attributes?.route).toBeUndefined();
    expect(attributes?.handler).toBeUndefined();
  });

  it("establishes an active correlation context for the duration of the request", async () => {
    let seenDuringRequest: unknown;
    const { port } = await startServer((_req, res) => {
      seenDuringRequest = currentCorrelation();
      res.end("ok");
    });
    instrumentation = new HttpInstrumentation(vi.fn());
    instrumentation.start();

    await fetch(`http://localhost:${port}/`);

    expect(seenDuringRequest).toMatchObject({ id: expect.any(String) });
  });

  it("gives concurrent requests different, non-leaking correlation contexts", async () => {
    const seen: unknown[] = [];
    const { port } = await startServer(async (_req, res) => {
      seen.push(currentCorrelation());
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
      seen.push(currentCorrelation());
      res.end("ok");
    });
    instrumentation = new HttpInstrumentation(vi.fn());
    instrumentation.start();

    await Promise.all([
      fetch(`http://localhost:${port}/a`),
      fetch(`http://localhost:${port}/b`),
      fetch(`http://localhost:${port}/c`),
    ]);

    expect(seen).toHaveLength(6);
    const ids = seen.map((c) => (c as { id: string }).id);
    expect(new Set(ids).size).toBe(3);
  });

  it("does not establish a correlation context for a request to an ignored server", async () => {
    let seenDuringRequest: unknown = "not-set";
    const { port, server } = await startServer((_req, res) => {
      seenDuringRequest = currentCorrelation();
      res.end("ok");
    });
    instrumentation = new HttpInstrumentation(vi.fn());
    instrumentation.start({ ignoreServers: [server] });

    await fetch(`http://localhost:${port}/`);

    expect(seenDuringRequest).toBeUndefined();
  });

  describe("exception capture", () => {
    let exceptionInstrumentation: ExceptionInstrumentation | undefined;
    let safetyListener: ((error: Error) => void) | undefined;

    afterEach(() => {
      exceptionInstrumentation?.stop();
      exceptionInstrumentation = undefined;
      if (safetyListener) {
        // The dispatch catch (below) always rethrows, so with nothing else
        // handling the raw http.Server's own request dispatch, the error
        // genuinely reaches 'uncaughtException' afterward — a safety
        // listener keeps that from being reported as genuinely unhandled
        // by the surrounding test process.
        process.off("uncaughtException", safetyListener);
        safetyListener = undefined;
      }
    });

    it("captures a synchronous handler throw while a correlation context is still active, before rethrowing it", async () => {
      const { port, server } = await startServer(() => {
        throw new Error("sync handler boom");
      });
      instrumentation = new HttpInstrumentation(vi.fn());
      instrumentation.start();
      const captured: CapturedEvent[] = [];
      // ExceptionInstrumentation itself never sets .correlation on the raw
      // CapturedEvent it builds — attaching it is Runtime.publish()'s job
      // (covered in runtime.test.ts). What matters at this layer is that
      // ambient correlation is still readable at the exact moment capture()
      // runs — recorded here via the publish callback, which fires
      // synchronously from within the dispatch catch.
      const correlationsSeenDuringCapture: unknown[] = [];
      exceptionInstrumentation = new ExceptionInstrumentation((event) => {
        correlationsSeenDuringCapture.push(currentCorrelation());
        captured.push(event);
      });
      exceptionInstrumentation.start();
      safetyListener = () => {};
      process.on("uncaughtException", safetyListener);

      fetch(`http://localhost:${port}/boom`).catch(() => {});
      await waitUntil(() => captured.length > 0);
      server.closeAllConnections();

      expect(captured).toHaveLength(1);
      expect(captured[0]?.kind).toBe("exception.captured");
      expect(captured[0]?.attributes.message).toBe("sync handler boom");
      expect(captured[0]?.attributes.origin).toBe("requestDispatch");
      expect(correlationsSeenDuringCapture[0]).toMatchObject({ id: expect.any(String) });
    });

    it("does not publish an http.request event for a request whose handler threw", async () => {
      const { port, server } = await startServer(() => {
        throw new Error("sync handler boom");
      });
      const publish = vi.fn<(event: CapturedEvent) => void>();
      instrumentation = new HttpInstrumentation(publish);
      instrumentation.start();
      exceptionInstrumentation = new ExceptionInstrumentation(vi.fn());
      exceptionInstrumentation.start();
      safetyListener = () => {};
      process.on("uncaughtException", safetyListener);

      fetch(`http://localhost:${port}/boom`).catch(() => {});
      // No "finish" ever fires (res.end() was never reached), so give it a
      // moment to (not) happen rather than asserting instantly.
      await new Promise((resolve) => setTimeout(resolve, 50));
      server.closeAllConnections();

      expect(publish).not.toHaveBeenCalled();
    });
  });
});
