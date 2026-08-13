import type { CapturedEvent, Envelope } from "@wevna/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type EventListener, WebSocketTransport } from "./websocket-transport.js";

function makeEnvelope(sequence = 1): Envelope<CapturedEvent> {
  return {
    version: 1,
    sessionId: "session-1",
    sequence,
    payload: { id: "event-1", kind: "test", occurredAt: Date.now(), attributes: {} },
  };
}

function createTestEventSource() {
  const listeners = new Set<EventListener>();
  return {
    subscribe(listener: EventListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: Envelope<CapturedEvent>): void {
      for (const listener of listeners) {
        listener(event);
      }
    },
    get listenerCount(): number {
      return listeners.size;
    },
  };
}

async function nextMessage(ws: { on(event: "message", listener: (data: unknown) => void): void }) {
  return new Promise<string>((resolve) => {
    ws.on("message", (data: unknown) => resolve((data as { toString(): string }).toString()));
  });
}

describe("WebSocketTransport", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("subscribes to the event source when registered", async () => {
    app = Fastify();
    const eventSource = createTestEventSource();

    await new WebSocketTransport().register(app, eventSource);

    expect(eventSource.listenerCount).toBe(1);
  });

  it("broadcasts a published event to a connected client", async () => {
    app = Fastify();
    const eventSource = createTestEventSource();
    await new WebSocketTransport().register(app, eventSource);
    await app.ready();

    const ws = await app.injectWS("/ws");
    const received = nextMessage(ws);

    const envelope = makeEnvelope();
    eventSource.emit(envelope);

    expect(JSON.parse(await received)).toEqual(envelope);
    ws.terminate();
  });

  // `attributes` is Record<string, unknown> by design, so a plugin can hand
  // the transport a value JSON cannot represent. Emitting runs on the call
  // stack of the work being observed, so this has to degrade rather than
  // throw.
  it("drops an unserializable event instead of throwing at the emit site", async () => {
    app = Fastify();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const eventSource = createTestEventSource();
    await new WebSocketTransport().register(app, eventSource);
    await app.ready();

    const ws = await app.injectWS("/ws");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const envelope = makeEnvelope();
    envelope.payload.attributes = { circular };

    expect(() => eventSource.emit(envelope)).not.toThrow();
    expect(errors).toHaveBeenCalledOnce();
    expect(errors.mock.calls[0]?.[0]).toContain('dropped a "test" event');

    ws.terminate();
    errors.mockRestore();
  });

  it("keeps broadcasting after an unserializable event is dropped", async () => {
    app = Fastify();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const eventSource = createTestEventSource();
    await new WebSocketTransport().register(app, eventSource);
    await app.ready();

    const ws = await app.injectWS("/ws");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const bad = makeEnvelope(1);
    bad.payload.attributes = { circular };
    eventSource.emit(bad);

    const received = nextMessage(ws);
    const good = makeEnvelope(2);
    eventSource.emit(good);

    expect(JSON.parse(await received)).toEqual(good);
    ws.terminate();
    errors.mockRestore();
  });

  it("broadcasts the same event to multiple connected clients", async () => {
    app = Fastify();
    const eventSource = createTestEventSource();
    await new WebSocketTransport().register(app, eventSource);
    await app.ready();

    const first = await app.injectWS("/ws");
    const second = await app.injectWS("/ws");
    const firstReceived = nextMessage(first);
    const secondReceived = nextMessage(second);

    const envelope = makeEnvelope();
    eventSource.emit(envelope);

    expect(JSON.parse(await firstReceived)).toEqual(envelope);
    expect(JSON.parse(await secondReceived)).toEqual(envelope);
    first.terminate();
    second.terminate();
  });

  it("keeps broadcasting to remaining clients after another disconnects", async () => {
    app = Fastify();
    const eventSource = createTestEventSource();
    await new WebSocketTransport().register(app, eventSource);
    await app.ready();

    const leaving = await app.injectWS("/ws");
    const staying = await app.injectWS("/ws");

    const leavingClosed = new Promise<void>((resolve) => {
      leaving.on("close", () => resolve());
    });
    leaving.terminate();
    await leavingClosed;

    const stayingReceived = nextMessage(staying);
    const envelope = makeEnvelope();
    expect(() => eventSource.emit(envelope)).not.toThrow();

    expect(JSON.parse(await stayingReceived)).toEqual(envelope);
    staying.terminate();
  });

  it("closes client connections when the server shuts down", async () => {
    app = Fastify();
    const eventSource = createTestEventSource();
    await new WebSocketTransport().register(app, eventSource);
    await app.ready();

    const ws = await app.injectWS("/ws");
    const closed = new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
    });

    await app.close();
    app = undefined;

    await closed;
  });

  it("unsubscribes from the event source when the server shuts down", async () => {
    app = Fastify();
    const eventSource = createTestEventSource();
    await new WebSocketTransport().register(app, eventSource);
    await app.ready();

    expect(eventSource.listenerCount).toBe(1);

    await app.close();
    app = undefined;

    expect(eventSource.listenerCount).toBe(0);
  });

  it("calls the underlying subscribe function exactly once per registration", async () => {
    app = Fastify();
    const eventSource = createTestEventSource();
    const subscribe = vi.spyOn(eventSource, "subscribe");

    await new WebSocketTransport().register(app, eventSource);

    expect(subscribe).toHaveBeenCalledOnce();
  });
});
