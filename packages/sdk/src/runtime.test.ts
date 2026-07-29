import http from "node:http";
import type { AddressInfo } from "node:net";
import type { CapturedEvent } from "@wevna/protocol";
import { PROTOCOL_VERSION } from "@wevna/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Runtime } from "./runtime.js";

function makeCapturedEvent(kind = "test"): CapturedEvent {
  return { id: "event-1", kind, occurredAt: Date.now(), attributes: {} };
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
