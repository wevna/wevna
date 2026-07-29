import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it } from "vitest";
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
