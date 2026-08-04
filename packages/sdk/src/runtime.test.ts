import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapturedEvent, RecordingLine } from "@wevna/protocol";
import { PROTOCOL_VERSION } from "@wevna/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_API_VERSION, type WevnaPlugin } from "./plugin.js";
import { Runtime } from "./runtime.js";

async function readRecordingLines(filePath: string): Promise<RecordingLine[]> {
  const contents = await readFile(filePath, "utf8");
  return contents
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RecordingLine);
}

function makeCapturedEvent(kind = "test"): CapturedEvent {
  return { id: "event-1", kind, occurredAt: Date.now(), attributes: {} };
}

// HttpInstrumentation defers publishing by one setImmediate tick after
// "finish" (see http-instrumentation.ts), so a client's fetch() can
// resolve fractionally before the server has actually finished publishing
// — polls instead of assuming a fixed delay is always enough.
async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
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

describe("Runtime session recording", () => {
  let runtime: Runtime | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function makeFilePath(name = "session.jsonl"): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "wevna-runtime-recording-test-"));
    return join(dir, name);
  }

  it("throws when starting a recording before Runtime has started a session", async () => {
    runtime = new Runtime();
    const filePath = await makeFilePath();

    await expect(runtime.startRecording(filePath)).rejects.toThrow();
  });

  it("is not recording by default", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });

    expect(runtime.isRecording).toBe(false);
  });

  it("reports isRecording true once a recording has started", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const filePath = await makeFilePath();

    await runtime.startRecording(filePath);

    expect(runtime.isRecording).toBe(true);
  });

  it("reports isRecording false again after stopRecording()", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const filePath = await makeFilePath();
    await runtime.startRecording(filePath);

    await runtime.stopRecording();

    expect(runtime.isRecording).toBe(false);
  });

  it("records real published events, in order, to the file", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const filePath = await makeFilePath();
    await runtime.startRecording(filePath);

    runtime.publish(makeCapturedEvent("console.log"));
    runtime.publish(makeCapturedEvent("sql.query"));
    await runtime.stopRecording();

    const lines = await readRecordingLines(filePath);
    const eventLines = lines.filter((line) => line.type === "event");
    expect(
      eventLines.map((line) => (line.type === "event" ? line.envelope.payload.kind : null)),
    ).toEqual(["console.log", "sql.query"]);
  });

  it("records a real HTTP request end to end", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const filePath = await makeFilePath();
    await runtime.startRecording(filePath);

    const appServer = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => appServer.listen(0, resolve));
    const port = (appServer.address() as AddressInfo).port;

    await fetch(`http://localhost:${port}/widgets`);
    await waitUntil(async () => {
      const lines = await readRecordingLines(filePath);
      return lines.some(
        (line) => line.type === "event" && line.envelope.payload.kind === "http.request",
      );
    });
    await new Promise((resolve) => appServer.close(resolve));
    await runtime.stopRecording();

    const lines = await readRecordingLines(filePath);
    const httpLine = lines.find(
      (line) => line.type === "event" && line.envelope.payload.kind === "http.request",
    );
    expect(httpLine?.type === "event" && httpLine.envelope.payload.attributes.url).toBe("/widgets");
  });

  it("preserves correlation on recorded events the same way live events already do", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const filePath = await makeFilePath();
    await runtime.startRecording(filePath);

    const appServer = http.createServer((_req, res) => {
      runtime?.publish(makeCapturedEvent("console.log"));
      res.end("ok");
    });
    await new Promise<void>((resolve) => appServer.listen(0, resolve));
    const port = (appServer.address() as AddressInfo).port;

    await fetch(`http://localhost:${port}/checkout`);
    await waitUntil(async () => {
      const lines = await readRecordingLines(filePath);
      return (
        lines.filter((line) => line.type === "event" && line.envelope.payload.correlation).length >=
        2
      );
    });
    await new Promise((resolve) => appServer.close(resolve));
    await runtime.stopRecording();

    const lines = await readRecordingLines(filePath);
    const correlationIds = lines
      .filter((line) => line.type === "event")
      .map((line) => (line.type === "event" ? line.envelope.payload.correlation?.id : undefined));
    expect(correlationIds[0]).toBeDefined();
    expect(new Set(correlationIds).size).toBe(1);
  });

  it("never mixes up event order between concurrent HTTP requests while recording", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const filePath = await makeFilePath();
    await runtime.startRecording(filePath);

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
    // 3 requests x (2 console.log + 1 http.request) = 9 events.
    await waitUntil(async () => {
      const lines = await readRecordingLines(filePath);
      return lines.filter((line) => line.type === "event").length >= 9;
    });
    await new Promise((resolve) => appServer.close(resolve));
    await runtime.stopRecording();

    const lines = await readRecordingLines(filePath);
    const eventLines = lines.filter((line) => line.type === "event");
    expect(eventLines).toHaveLength(9);

    const byCorrelation = new Map<string, number>();
    for (const line of eventLines) {
      if (line.type !== "event") {
        continue;
      }
      const correlationId = line.envelope.payload.correlation?.id;
      expect(correlationId).toBeDefined();
      byCorrelation.set(
        correlationId as string,
        (byCorrelation.get(correlationId as string) ?? 0) + 1,
      );
    }
    expect(byCorrelation.size).toBe(3);
    for (const count of byCorrelation.values()) {
      expect(count).toBe(3);
    }
  });

  it("finalizes the recording (writes the footer) when Runtime itself is stopped mid-recording", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const filePath = await makeFilePath();
    await runtime.startRecording(filePath);
    runtime.publish(makeCapturedEvent("console.log"));

    await runtime.stop();
    runtime = undefined;

    const lines = await readRecordingLines(filePath);
    expect(lines.at(-1)?.type).toBe("footer");
  });

  it("does not create a recording file or change behaviour when recording is never started", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    runtime.publish(makeCapturedEvent("console.log"));

    expect(runtime.isRecording).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not interfere with live event bus subscribers while recording", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const filePath = await makeFilePath();
    await runtime.startRecording(filePath);
    const liveListener = vi.fn();
    runtime.eventBus.subscribe(liveListener);

    runtime.publish(makeCapturedEvent("console.log"));
    await runtime.stopRecording();

    expect(liveListener).toHaveBeenCalledOnce();
  });
});

describe("Runtime plugins", () => {
  let runtime: Runtime | undefined;

  beforeEach(() => {
    // Plugin diagnostics go to console.warn/console.error — silenced here,
    // and restored afterwards so counts never leak between tests.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    await runtime?.stop();
    vi.restoreAllMocks();
  });

  function makePlugin(overrides: Partial<WevnaPlugin> = {}): WevnaPlugin {
    return {
      name: "example",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      setup: () => undefined,
      ...overrides,
    };
  }

  // Looked up by name, never by index: the built-in pg/redis producers are
  // themselves registered plugins (see pg-plugin.ts), so they occupy the
  // first entries of `plugins`.
  function describePlugin(name = "example") {
    return runtime?.plugins.find((plugin) => plugin.name === name);
  }

  it("sets a plugin registered before start() up when the runtime starts", async () => {
    runtime = new Runtime();
    const setup = vi.fn();
    runtime.use(makePlugin({ setup }));

    expect(describePlugin()?.status).toBe("registered");
    expect(setup).not.toHaveBeenCalled();

    await runtime.start({ port: 0 });

    expect(setup).toHaveBeenCalledOnce();
    expect(describePlugin()?.status).toBe("active");
  });

  it("sets a plugin registered after start() up immediately", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });

    runtime.use(makePlugin());
    await runtime.pluginsSettled();

    expect(describePlugin()?.status).toBe("active");
  });

  it("publishes a plugin's events through the runtime, stamped with its source", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    runtime.use(
      makePlugin({
        name: "acme",
        eventKinds: ["acme.thing"],
        setup: (context) => {
          context.publish({ kind: "acme.thing", attributes: { detail: 42 } });
        },
      }),
    );
    await runtime.pluginsSettled();

    expect(listener).toHaveBeenCalledOnce();
    const payload = listener.mock.calls[0]?.[0].payload as CapturedEvent;
    expect(payload.kind).toBe("acme.thing");
    expect(payload.attributes).toEqual({ detail: 42 });
    expect(payload.source).toBe("acme");
    expect(listener.mock.calls[0]?.[0].sequence).toBe(1);
  });

  it("attaches the ambient correlation to a plugin's events, like any built-in producer", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    let publish: (() => void) | undefined;
    runtime.use(
      makePlugin({
        setup: (context) => {
          publish = () => context.publish({ kind: "queue.job", attributes: {} });
        },
      }),
    );
    await runtime.pluginsSettled();

    runtime.startCorrelation(() => publish?.());

    const payload = listener.mock.calls[0]?.[0].payload as CapturedEvent;
    expect(typeof payload.correlation?.id).toBe("string");
  });

  it("lets a plugin open its own correlation scope, so a job's events group like a request's", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    runtime.use(
      makePlugin({
        setup: (context) => {
          context.startCorrelation(() => {
            context.publish({ kind: "queue.job.start", attributes: {} });
            context.publish({ kind: "queue.job.end", attributes: {} });
          });
        },
      }),
    );
    await runtime.pluginsSettled();

    const correlations = listener.mock.calls.map(
      (call) => (call[0].payload as CapturedEvent).correlation?.id,
    );
    expect(correlations[0]).toBeDefined();
    expect(correlations[0]).toBe(correlations[1]);
  });

  it("drops a plugin's events published before start and after stop, without throwing", async () => {
    runtime = new Runtime();
    let publish: (() => void) | undefined;
    runtime.use(
      makePlugin({
        setup: (context) => {
          publish = () => context.publish({ kind: "acme.thing", attributes: {} });
        },
      }),
    );

    await runtime.start({ port: 0 });
    await runtime.pluginsSettled();
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);
    await runtime.stop();
    runtime = undefined;

    expect(() => publish?.()).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it("tears a plugin down when the runtime stops", async () => {
    runtime = new Runtime();
    const teardown = vi.fn();
    runtime.use(makePlugin({ setup: () => teardown }));
    await runtime.start({ port: 0 });

    await runtime.stop();
    runtime = undefined;

    expect(teardown).toHaveBeenCalledOnce();
  });

  it("still starts the runtime when a plugin's setup throws", async () => {
    runtime = new Runtime();
    runtime.use(
      makePlugin({
        setup: () => {
          throw new Error("plugin exploded");
        },
      }),
    );

    await expect(runtime.start({ port: 0 })).resolves.toBeUndefined();

    expect(runtime.isRunning).toBe(true);
    expect(describePlugin()?.status).toBe("failed");
    expect(describePlugin()?.error).toBe("plugin exploded");
  });

  it("keeps built-in instrumentation working alongside a failed plugin", async () => {
    runtime = new Runtime();
    runtime.use(
      makePlugin({
        setup: () => {
          throw new Error("plugin exploded");
        },
      }),
    );
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    const queryable = { query: async () => ({ rowCount: 1 }) };
    runtime.instrumentPg(queryable);
    await queryable.query();

    expect(listener.mock.calls[0]?.[0].payload.kind).toBe("sql.query");
  });

  it("reports a plugin built for a different api version instead of throwing", async () => {
    runtime = new Runtime();

    expect(() => runtime?.use(makePlugin({ apiVersion: 999 }))).not.toThrow();

    expect(describePlugin()?.status).toBe("failed");
    expect(describePlugin()?.error).toContain("999");
  });

  it("does not capture Wevna's own plugin diagnostics as console.log events", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    runtime.use(makePlugin({ apiVersion: 999 }));
    await runtime.pluginsSettled();

    expect(listener).not.toHaveBeenCalled();
  });
});

// The built-in pg/redis producers are themselves plugins, so the plugin api
// is exercised by its own first consumers rather than only by third parties.
// If these regress, the extension points have drifted from what a community
// plugin can actually reach.
describe("Runtime built-in producers as plugins", () => {
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.stop();
  });

  it("registers the pg and redis producers as plugins before anything starts", () => {
    runtime = new Runtime();

    expect(runtime.plugins.map((plugin) => plugin.name)).toEqual(["wevna:pg", "wevna:redis"]);
    expect(runtime.plugins.map((plugin) => plugin.status)).toEqual(["registered", "registered"]);
  });

  it("declares the event kinds each built-in can produce", () => {
    runtime = new Runtime();

    expect(runtime.plugins.find((p) => p.name === "wevna:pg")?.eventKinds).toEqual(["sql.query"]);
    expect(runtime.plugins.find((p) => p.name === "wevna:redis")?.eventKinds).toEqual([
      "redis.command",
    ]);
  });

  it("activates both once the runtime starts", async () => {
    runtime = new Runtime();

    await runtime.start({ port: 0 });

    expect(runtime.plugins.map((plugin) => plugin.status)).toEqual(["active", "active"]);
  });

  it("stamps sql.query events with the pg plugin as their source", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    const queryable = { query: async () => ({ rowCount: 3 }) };
    runtime.instrumentPg(queryable);
    await queryable.query();

    const payload = listener.mock.calls[0]?.[0].payload as CapturedEvent;
    expect(payload.kind).toBe("sql.query");
    expect(payload.source).toBe("wevna:pg");
    // Still stamped with everything Runtime always stamped — the id now comes
    // from context.publish() rather than the instrumentation itself.
    expect(typeof payload.id).toBe("string");
    expect(typeof payload.occurredAt).toBe("number");
    expect(payload.attributes.rows).toBe(3);
  });

  it("stamps redis.command events with the redis plugin as their source", async () => {
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

    const payload = listener.mock.calls[0]?.[0].payload as CapturedEvent;
    expect(payload.kind).toBe("redis.command");
    expect(payload.source).toBe("wevna:redis");
  });

  it("still correlates a built-in producer's events to the active request", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);

    const queryable = { query: async () => ({ rowCount: 1 }) };
    runtime.instrumentPg(queryable);
    await runtime.startCorrelation(async () => {
      await queryable.query();
    });

    const payload = listener.mock.calls[0]?.[0].payload as CapturedEvent;
    expect(typeof payload.correlation?.id).toBe("string");
  });

  it("goes quiet, without throwing, once the runtime has stopped", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const queryable = { query: async () => ({ rowCount: 1 }) };
    runtime.instrumentPg(queryable);
    await runtime.stop();
    const listener = vi.fn();
    runtime.eventBus.subscribe(listener);
    runtime = undefined;

    await expect(queryable.query()).resolves.toEqual({ rowCount: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps an instrumented client working across a stop/start cycle", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const queryable = { query: async () => ({ rowCount: 1 }) };
    runtime.instrumentPg(queryable);

    await runtime.stop();

    // The query() wrapper is deliberately left installed rather than
    // unwrapped, so a pool that outlives one Runtime is not silently
    // un-instrumented — the wrapper simply publishes nothing while stopped.
    await expect(queryable.query()).resolves.toEqual({ rowCount: 1 });
  });
});
