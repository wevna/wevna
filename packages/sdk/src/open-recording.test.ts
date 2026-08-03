import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "./event-bus.js";
import { openRecording } from "./open-recording.js";
import { SessionRecorder } from "./session-recorder.js";

function makeSession() {
  return { id: "session-1", startedAt: Date.now(), status: "running" as const };
}

function makeEnvelope(sequence: number, kind = "console.log"): Envelope<CapturedEvent> {
  return {
    version: 1,
    sessionId: "session-1",
    sequence,
    payload: { id: `event-${sequence}`, kind, occurredAt: Date.now(), attributes: {} },
  };
}

async function recordSession(filePath: string, eventCount: number): Promise<void> {
  const recorder = new SessionRecorder();
  const eventBus = new EventBus();
  await recorder.start(eventBus, makeSession(), filePath);
  for (let i = 1; i <= eventCount; i += 1) {
    eventBus.publish(makeEnvelope(i, i % 3 === 0 ? "sql.query" : "console.log"));
  }
  await recorder.stop();
}

describe("openRecording", () => {
  let dir: string;
  let filePath: string;
  let close: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wevna-open-recording-test-"));
    filePath = join(dir, "session.jsonl");
  });

  afterEach(async () => {
    await close?.();
    close = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("opens a valid recording and starts a server for it", async () => {
    await recordSession(filePath, 3);

    const result = await openRecording(filePath, { port: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    close = result.recording.close;
    expect(result.recording.url).toMatch(/^http:\/\/localhost:\d+$/);
    expect(result.recording.metadata.session.id).toBe("session-1");
  });

  it("returns a structured error for a malformed recording, without starting a server", async () => {
    await writeFile(filePath, "not a valid recording\n");

    const result = await openRecording(filePath, { port: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.error.type).toBe("invalid-json");
  });

  it("serves /api/session reporting recording mode and metadata", async () => {
    await recordSession(filePath, 2);
    const result = await openRecording(filePath, { port: 0 });
    if (!result.ok) {
      throw new Error("expected ok");
    }
    close = result.recording.close;

    const response = await fetch(`${result.recording.url}/api/session`);
    const body = (await response.json()) as { mode: string; metadata: { session: { id: string } } };

    expect(body.mode).toBe("recording");
    expect(body.metadata.session.id).toBe("session-1");
  });

  it("serves /api/session/events with every recorded event, in order", async () => {
    await recordSession(filePath, 5);
    const result = await openRecording(filePath, { port: 0 });
    if (!result.ok) {
      throw new Error("expected ok");
    }
    close = result.recording.close;

    const response = await fetch(`${result.recording.url}/api/session/events`);
    const body = (await response.json()) as { events: Envelope<CapturedEvent>[] };

    expect(body.events).toHaveLength(5);
    expect(body.events.map((e: Envelope<CapturedEvent>) => e.payload.id)).toEqual([
      "event-1",
      "event-2",
      "event-3",
      "event-4",
      "event-5",
    ]);
  });

  it("does not expose a /ws route (no live event source in offline mode)", async () => {
    await recordSession(filePath, 1);
    const result = await openRecording(filePath, { port: 0 });
    if (!result.ok) {
      throw new Error("expected ok");
    }
    close = result.recording.close;

    const response = await fetch(`${result.recording.url}/health`);
    expect(response.status).toBe(200);
  });

  it("close() stops the server", async () => {
    await recordSession(filePath, 1);
    const result = await openRecording(filePath, { port: 0 });
    if (!result.ok) {
      throw new Error("expected ok");
    }
    const { url, close: stop } = result.recording;

    await stop();
    close = undefined;

    await expect(fetch(`${url}/health`)).rejects.toThrow();
  });

  it("serves the same events on a second fetch of /api/session/events", async () => {
    await recordSession(filePath, 3);
    const result = await openRecording(filePath, { port: 0 });
    if (!result.ok) {
      throw new Error("expected ok");
    }
    close = result.recording.close;

    const first = await (await fetch(`${result.recording.url}/api/session/events`)).json();
    const second = await (await fetch(`${result.recording.url}/api/session/events`)).json();

    expect(first).toEqual(second);
  });
});
