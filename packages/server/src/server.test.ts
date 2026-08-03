import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it } from "vitest";
import type { OfflineSessionMetadata } from "./offline-session-source.js";
import { createServer } from "./server.js";
import type { EventListener } from "./websocket-transport.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureDashboardDir = path.join(currentDir, "__fixtures__/dashboard");
const missingDashboardDir = path.join(currentDir, "__fixtures__/does-not-exist");

describe("createServer", () => {
  it("responds to GET /health with a running status payload", async () => {
    const app = await createServer();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "running", product: "wevna" });
  });

  it("serves the dashboard's index.html at the root", async () => {
    const app = await createServer({ dashboardDir: fixtureDashboardDir });

    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("fixture dashboard");
  });

  it("still serves /health when the dashboard has not been built", async () => {
    const app = await createServer({ dashboardDir: missingDashboardDir });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
  });

  it("does not expose /ws when no event source is given", async () => {
    const app = await createServer();

    const response = await app.inject({ method: "GET", url: "/ws" });

    expect(response.statusCode).toBe(404);
  });

  it("reports live mode from /api/session when no session source is given", async () => {
    const app = await createServer();

    const response = await app.inject({ method: "GET", url: "/api/session" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ mode: "live" });
  });

  it("does not expose /api/session/events when no session source is given", async () => {
    const app = await createServer();

    const response = await app.inject({ method: "GET", url: "/api/session/events" });

    expect(response.statusCode).toBe(404);
  });
});

function createTestSessionSource(events: Envelope<CapturedEvent>[]) {
  const metadata: OfflineSessionMetadata = {
    session: { id: "session-1", startedAt: Date.now(), status: "stopped" },
    formatVersion: 1,
    protocolVersion: 1,
    recordingStartedAt: Date.now() - 1000,
    recordingEndedAt: Date.now(),
    eventCount: events.length,
  };
  return {
    getMetadata: () => metadata,
    async *getEvents(): AsyncGenerator<Envelope<CapturedEvent>> {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe("createServer with an offline session source", () => {
  it("reports recording mode and metadata from /api/session", async () => {
    const source = createTestSessionSource([]);
    const app = await createServer({ session: source });

    const response = await app.inject({ method: "GET", url: "/api/session" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mode).toBe("recording");
    expect(body.metadata.session.id).toBe("session-1");
    expect(body.metadata.eventCount).toBe(0);
  });

  it("returns every event from /api/session/events, in order", async () => {
    const events = [makeEnvelope(1), makeEnvelope(2), makeEnvelope(3)];
    const source = createTestSessionSource(events);
    const app = await createServer({ session: source });

    const response = await app.inject({ method: "GET", url: "/api/session/events" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ events });
  });

  it("returns an empty events array for a session with no events", async () => {
    const source = createTestSessionSource([]);
    const app = await createServer({ session: source });

    const response = await app.inject({ method: "GET", url: "/api/session/events" });

    expect(response.json()).toEqual({ events: [] });
  });

  it("does not register /ws when only a session source is given, no live event source", async () => {
    const source = createTestSessionSource([]);
    const app = await createServer({ session: source });

    const response = await app.inject({ method: "GET", url: "/ws" });

    expect(response.statusCode).toBe(404);
  });
});

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
  };
}

describe("createServer with an event source", () => {
  it("streams published envelopes to a connected WebSocket client", async () => {
    const eventSource = createTestEventSource();
    const app = await createServer({ eventSource });
    await app.ready();

    const ws = await app.injectWS("/ws");
    const received = new Promise<string>((resolve) => {
      ws.on("message", (data) => resolve(data.toString()));
    });

    const envelope = makeEnvelope();
    eventSource.emit(envelope);

    expect(JSON.parse(await received)).toEqual(envelope);

    ws.terminate();
    await app.close();
  });
});
