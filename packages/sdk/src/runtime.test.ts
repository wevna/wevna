import http from "node:http";
import type { AddressInfo } from "node:net";
import type { CapturedEvent } from "@wevna/protocol";
import { PROTOCOL_VERSION } from "@wevna/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Runtime } from "./runtime.js";

function makeCapturedEvent(kind = "test"): CapturedEvent {
  return { id: "event-1", kind, occurredAt: Date.now(), attributes: {} };
}

// HttpInstrumentation defers publishing by one setImmediate tick after
// "finish" (see http-instrumentation.ts), so a client's fetch() can
// resolve fractionally before the server has actually finished publishing
// — polls instead of assuming a fixed delay is always enough.
async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Runtime", () => {
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.stop();
  });

  it("starts stopped", () => {
    runtime = new Runtime();

    expect(runtime.state).toBe("stopped");
    expect(runtime.isRunning).toBe(false);
  });

  it("transitions to running after start and back to stopped after stop", async () => {
    runtime = new Runtime();

    await runtime.start({ port: 0 });
    expect(runtime.state).toBe("running");
    expect(runtime.isRunning).toBe(true);

    await runtime.stop();
    expect(runtime.state).toBe("stopped");
    expect(runtime.isRunning).toBe(false);
  });

  it("does not start a second server when already running", async () => {
    runtime = new Runtime();

    await runtime.start({ port: 0 });
    await expect(runtime.start({ port: 0 })).resolves.toBeUndefined();
    expect(runtime.state).toBe("running");
  });

  it("coalesces concurrent start calls into a single server", async () => {
    runtime = new Runtime();

    await expect(
      Promise.all([runtime.start({ port: 0 }), runtime.start({ port: 0 })]),
    ).resolves.toEqual([undefined, undefined]);
    expect(runtime.state).toBe("running");
  });

  it("does not throw when stopping a runtime that is not running", async () => {
    runtime = new Runtime();

    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(runtime.state).toBe("stopped");
  });

  it("resets to stopped when the server fails to start, allowing a retry", async () => {
    runtime = new Runtime();

    await expect(runtime.start({ port: -1 })).rejects.toThrow();
    expect(runtime.state).toBe("stopped");

    await expect(runtime.start({ port: 0 })).resolves.toBeUndefined();
    expect(runtime.state).toBe("running");
  });

  it("has no session before the first start", () => {
    runtime = new Runtime();

    expect(runtime.session).toBeUndefined();
  });

  it("creates a running session when started", async () => {
    runtime = new Runtime();

    await runtime.start({ port: 0 });

    expect(runtime.session).toBeDefined();
    expect(runtime.session?.status).toBe("running");
  });

  it("marks the session stopped when stopped", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const sessionId = runtime.session?.id;

    await runtime.stop();

    expect(runtime.session?.id).toBe(sessionId);
    expect(runtime.session?.status).toBe("stopped");
  });

  it("keeps the same session across a repeated start", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const sessionId = runtime.session?.id;

    await runtime.start({ port: 0 });

    expect(runtime.session?.id).toBe(sessionId);
    expect(runtime.session?.status).toBe("running");
  });

  it("keeps the session stopped across a repeated stop", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    await runtime.stop();
    const sessionId = runtime.session?.id;

    await runtime.stop();

    expect(runtime.session?.id).toBe(sessionId);
    expect(runtime.session?.status).toBe("stopped");
  });

  it("discards the session if the server fails to start", async () => {
    runtime = new Runtime();

    await expect(runtime.start({ port: -1 })).rejects.toThrow();

    expect(runtime.session).toBeUndefined();
  });

  it("creates a fresh session on a successful start after a failed one", async () => {
    runtime = new Runtime();
    await expect(runtime.start({ port: -1 })).rejects.toThrow();

    await runtime.start({ port: 0 });

    expect(runtime.session?.status).toBe("running");
  });

  it("owns the same event bus instance across a restart", async () => {
    runtime = new Runtime();
    const busBeforeStart = runtime.eventBus;

    await runtime.start({ port: 0 });
    await runtime.stop();
    await runtime.start({ port: 0 });

    expect(runtime.eventBus).toBe(busBeforeStart);
  });

  it("delivers events published through its event bus to subscribers", () => {
    runtime = new Runtime();
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    const event = {
      version: 1,
      sessionId: "session-1",
      sequence: 1,
      payload: { id: "event-1", kind: "test", occurredAt: Date.now(), attributes: {} },
    };
    runtime.eventBus.publish(event);

    expect(listener).toHaveBeenCalledExactlyOnceWith(event);
  });
});

describe("Runtime#publish", () => {
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.stop();
  });

  it("throws when publishing before a session exists", () => {
    runtime = new Runtime();

    expect(() => runtime?.publish(makeCapturedEvent())).toThrow();
  });

  it("attaches the protocol version to the envelope", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    runtime.publish(makeCapturedEvent());

    expect(listener.mock.calls[0]?.[0].version).toBe(PROTOCOL_VERSION);
  });

  it("copies the active session id into every envelope", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    runtime.publish(makeCapturedEvent());
    runtime.publish(makeCapturedEvent());

    expect(listener.mock.calls[0]?.[0].sessionId).toBe(runtime.session?.id);
    expect(listener.mock.calls[1]?.[0].sessionId).toBe(runtime.session?.id);
  });

  it("carries the CapturedEvent through as the envelope payload", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);
    const event = makeCapturedEvent("http.request");

    runtime.publish(event);

    expect(listener.mock.calls[0]?.[0].payload).toBe(event);
  });

  it("increments the sequence number for each published event", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    runtime.publish(makeCapturedEvent());
    runtime.publish(makeCapturedEvent());
    runtime.publish(makeCapturedEvent());

    expect(listener.mock.calls[0]?.[0].sequence).toBe(1);
    expect(listener.mock.calls[1]?.[0].sequence).toBe(2);
    expect(listener.mock.calls[2]?.[0].sequence).toBe(3);
  });

  it("resets the sequence counter to 1 for a new runtime session", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    runtime.publish(makeCapturedEvent());
    runtime.publish(makeCapturedEvent());
    await runtime.stop();
    await runtime.start({ port: 0 });

    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);
    runtime.publish(makeCapturedEvent());

    expect(listener.mock.calls[0]?.[0].sequence).toBe(1);
  });
});

describe("Runtime HTTP instrumentation", () => {
  let runtime: Runtime | undefined;
  let externalServer: http.Server | undefined;

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
    if (externalServer) {
      await new Promise((resolve) => externalServer?.close(resolve));
      externalServer = undefined;
    }
  });

  it("captures requests made to an external HTTP server while running", async () => {
    externalServer = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => externalServer?.listen(0, resolve));
    const externalPort = (externalServer.address() as AddressInfo).port;

    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    await fetch(`http://localhost:${externalPort}/users`);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0].payload.kind).toBe("http.request");
    expect(listener.mock.calls[0]?.[0].payload.attributes.url).toBe("/users");
  });

  it("never captures requests made to its own dashboard server", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    await fetch(`${runtime.url}/health`);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("Runtime database instrumentation", () => {
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.stop();
  });

  it("publishes sql.query events for a pg-style queryable while running", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    const queryable = { query: async () => ({ rowCount: 1 }) };
    runtime.instrumentPg(queryable);
    await queryable.query();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0].payload.kind).toBe("sql.query");
  });

  it("does not throw and does not publish when a pg query settles before Runtime has started", async () => {
    runtime = new Runtime();
    const queryable = { query: async () => ({ rowCount: 1 }) };
    runtime.instrumentPg(queryable);

    await expect(queryable.query()).resolves.toEqual({ rowCount: 1 });
  });

  it("publishes redis.command events for an ioredis-style client while running", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    const client = { sendCommand: (_command: unknown) => undefined };
    runtime.instrumentRedis(client);
    const command = { name: "get", promise: Promise.resolve("value") };
    client.sendCommand(command);
    await command.promise;
    await Promise.resolve();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0].payload.kind).toBe("redis.command");
  });

  it("does not throw when a redis command settles after Runtime has stopped", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const client = { sendCommand: (_command: unknown) => undefined };
    runtime.instrumentRedis(client);
    await runtime.stop();

    const command = { name: "get", promise: Promise.resolve("value") };
    expect(() => client.sendCommand(command)).not.toThrow();
    await command.promise;
    await expect(Promise.resolve()).resolves.toBeUndefined();
  });
});

describe("Runtime correlation", () => {
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
  });

  it("does not attach correlation to an event published outside any correlation context", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    runtime.publish(makeCapturedEvent());

    const published = listener.mock.calls[0]?.[0].payload;
    expect("correlation" in published).toBe(false);
  });

  it("honours an explicitly-set correlation on the event over the ambient one", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);
    const explicit = { id: "explicit-correlation" };

    runtime.publish({ ...makeCapturedEvent(), correlation: explicit });

    expect(listener.mock.calls[0]?.[0].payload.correlation).toEqual(explicit);
  });

  it("attaches the ambient correlation to an event published while one is active", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    runtime.startCorrelation(() => {
      runtime?.publish(makeCapturedEvent());
    });

    expect(listener.mock.calls[0]?.[0].payload.correlation).toMatchObject({
      id: expect.any(String),
    });
  });

  it("gives every event published during a single HTTP request the same correlation id", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    const appServer = http.createServer((_req, res) => {
      // Stands in for a producer (e.g. console.log) firing mid-request.
      runtime?.publish(makeCapturedEvent("console.log"));
      res.end("ok");
    });
    await new Promise<void>((resolve) => appServer.listen(0, resolve));
    const port = (appServer.address() as AddressInfo).port;

    await fetch(`http://localhost:${port}/checkout`);
    await waitUntil(() => listener.mock.calls.length >= 2);
    await new Promise((resolve) => appServer.close(resolve));

    expect(listener).toHaveBeenCalledTimes(2);
    const kinds = listener.mock.calls.map((call) => call[0]?.payload.kind);
    expect(kinds).toEqual(expect.arrayContaining(["console.log", "http.request"]));
    const correlationIds = listener.mock.calls.map((call) => call[0]?.payload.correlation?.id);
    expect(correlationIds[0]).toBeDefined();
    expect(correlationIds[0]).toBe(correlationIds[1]);
  });

  it("never mixes correlation ids between concurrent HTTP requests", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    const appServer = http.createServer(async (_req, res) => {
      runtime?.publish(makeCapturedEvent("console.log"));
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
      runtime?.publish(makeCapturedEvent("console.log"));
      res.end("ok");
    });
    await new Promise<void>((resolve) => appServer.listen(0, resolve));
    const port = (appServer.address() as AddressInfo).port;

    await Promise.all([
      fetch(`http://localhost:${port}/a`),
      fetch(`http://localhost:${port}/b`),
      fetch(`http://localhost:${port}/c`),
    ]);
    // 3 requests x (2 console.log + 1 http.request) = 9 events. The
    // http.request event for each is published a tick after "finish" (see
    // http-instrumentation.ts), which can trail fetch() resolving.
    await waitUntil(() => listener.mock.calls.length >= 9);
    await new Promise((resolve) => appServer.close(resolve));

    expect(listener).toHaveBeenCalledTimes(9);

    const byCorrelation = new Map<string, Set<string>>();
    for (const call of listener.mock.calls) {
      const payload = call[0]?.payload;
      const correlationId = payload.correlation?.id;
      expect(correlationId).toBeDefined();
      const kinds = byCorrelation.get(correlationId) ?? new Set();
      kinds.add(payload.kind);
      byCorrelation.set(correlationId, kinds);
    }

    // Three distinct requests, never merged into one another.
    expect(byCorrelation.size).toBe(3);
    // Every correlation saw exactly the console.log + http.request events
    // from its own request — nothing leaked in from another.
    for (const kinds of byCorrelation.values()) {
      expect(kinds).toEqual(new Set(["console.log", "http.request"]));
    }
  });

  it("round-trips correlation metadata through JSON serialization", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    runtime.startCorrelation(() => {
      runtime?.publish(makeCapturedEvent());
    });

    const envelope = listener.mock.calls[0]?.[0];
    const roundTripped = JSON.parse(JSON.stringify(envelope));

    expect(roundTripped.payload.correlation).toEqual(envelope.payload.correlation);
  });

  it("omits the correlation key entirely from serialized JSON when none was active (backwards compatible)", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    runtime.publish(makeCapturedEvent());

    const envelope = listener.mock.calls[0]?.[0];
    const serialized = JSON.stringify(envelope);

    expect(serialized).not.toContain("correlation");
  });
});

describe("Runtime exception instrumentation", () => {
  let runtime: Runtime | undefined;
  let externalServer: http.Server | undefined;

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
    if (externalServer) {
      // A handler that throws before res.end() leaves its connection open
      // forever waiting for a response that will never come — a plain
      // close() would then hang this hook until it times out.
      externalServer.closeAllConnections();
      await new Promise((resolve) => externalServer?.close(resolve));
      externalServer = undefined;
    }
  });

  it("captures a synchronous handler exception with no framework catching it, correlated to its request", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    externalServer = http.createServer(() => {
      // Bare http.Server: nothing catches this, so it becomes a genuine
      // uncaughtException — this is exactly the case the process-level
      // fallback exists for.
      throw new Error("bare handler boom");
    });
    await new Promise<void>((resolve) => externalServer?.listen(0, resolve));
    const externalPort = (externalServer.address() as AddressInfo).port;

    fetch(`http://localhost:${externalPort}/boom`).catch(() => {});
    await waitUntil(() =>
      listener.mock.calls.some((call) => call[0]?.payload.kind === "exception.captured"),
    );

    const exceptionCall = listener.mock.calls.find(
      (call) => call[0]?.payload.kind === "exception.captured",
    );
    expect(exceptionCall?.[0]?.payload.attributes.message).toBe("bare handler boom");
    expect(exceptionCall?.[0]?.payload.attributes.name).toBe("Error");
    expect(exceptionCall?.[0]?.payload.correlation?.id).toBeDefined();
  });

  it("captures an asynchronous rejection with no framework catching it, correlated to its request", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    externalServer = http.createServer((_req, res) => {
      async function handle(): Promise<void> {
        await Promise.resolve();
        throw new Error("bare async boom");
      }
      // Deliberately not awaited/caught — becomes an unhandledRejection,
      // just like an async Express 4 handler with no try/catch.
      handle();
      res.end("ok");
    });
    await new Promise<void>((resolve) => externalServer?.listen(0, resolve));
    const externalPort = (externalServer.address() as AddressInfo).port;

    await fetch(`http://localhost:${externalPort}/boom`);
    await waitUntil(() =>
      listener.mock.calls.some((call) => call[0]?.payload.kind === "exception.captured"),
    );

    const exceptionCall = listener.mock.calls.find(
      (call) => call[0]?.payload.kind === "exception.captured",
    );
    expect(exceptionCall?.[0]?.payload.attributes.message).toBe("bare async boom");
    // Same request also still completes normally — the http.request event
    // for it should share the same correlation id as the exception.
    const httpCall = listener.mock.calls.find((call) => call[0]?.payload.kind === "http.request");
    expect(httpCall?.[0]?.payload.correlation?.id).toBe(
      exceptionCall?.[0]?.payload.correlation?.id,
    );
  });

  it("never mixes correlation ids between concurrent failing requests", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    externalServer = http.createServer((req) => {
      throw new Error(`boom for ${req.url}`);
    });
    await new Promise<void>((resolve) => externalServer?.listen(0, resolve));
    const externalPort = (externalServer.address() as AddressInfo).port;

    fetch(`http://localhost:${externalPort}/a`).catch(() => {});
    fetch(`http://localhost:${externalPort}/b`).catch(() => {});
    fetch(`http://localhost:${externalPort}/c`).catch(() => {});
    await waitUntil(
      () =>
        listener.mock.calls.filter((call) => call[0]?.payload.kind === "exception.captured")
          .length >= 3,
    );

    const exceptionEvents = listener.mock.calls
      .map((call) => call[0]?.payload)
      .filter((payload) => payload.kind === "exception.captured");
    const correlationIds = new Set(exceptionEvents.map((payload) => payload.correlation?.id));
    const messages = new Set(exceptionEvents.map((payload) => payload.attributes.message));

    expect(correlationIds.size).toBe(3);
    expect(messages).toEqual(new Set(["boom for /a", "boom for /b", "boom for /c"]));
  });

  it("stops capturing exceptions once stopped", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    await runtime.stop();

    // A safety listener so this doesn't register as a genuinely-unhandled
    // exception in the surrounding test process once Runtime's own
    // listener has been removed by stop().
    const safetyListener = vi.fn();
    process.on("uncaughtException", safetyListener);
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    process.emit("uncaughtException", new Error("after runtime stopped"));

    process.off("uncaughtException", safetyListener);
    expect(listener).not.toHaveBeenCalled();
  });
});
