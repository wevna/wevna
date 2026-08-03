import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapturedEvent, Envelope, RecordingLine, Session } from "@wevna/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "./event-bus.js";
import { SessionRecorder } from "./session-recorder.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return { id: "session-1", startedAt: Date.now(), status: "running", ...overrides };
}

function makeEnvelope(sequence: number, kind = "console.log"): Envelope<CapturedEvent> {
  return {
    version: 1,
    sessionId: "session-1",
    sequence,
    payload: {
      id: `event-${sequence}`,
      kind,
      occurredAt: Date.now(),
      attributes: { sequence },
    },
  };
}

async function readLines(filePath: string): Promise<RecordingLine[]> {
  const contents = await readFile(filePath, "utf8");
  return contents
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RecordingLine);
}

describe("SessionRecorder", () => {
  let dir: string;
  let filePath: string;
  let eventBus: EventBus;
  let recorder: SessionRecorder;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wevna-recorder-test-"));
    filePath = join(dir, "session.jsonl");
    eventBus = new EventBus();
    recorder = new SessionRecorder();
  });

  afterEach(async () => {
    await recorder.stop();
    await rm(dir, { recursive: true, force: true });
  });

  describe("recording lifecycle", () => {
    it("is not recording before start() is called", () => {
      expect(recorder.isRecording).toBe(false);
    });

    it("is recording once start() resolves", async () => {
      await recorder.start(eventBus, makeSession(), filePath);

      expect(recorder.isRecording).toBe(true);
    });

    it("creates the recording file", async () => {
      await recorder.start(eventBus, makeSession(), filePath);

      expect(existsSync(filePath)).toBe(true);
    });

    it("creates parent directories that don't exist yet", async () => {
      const nestedPath = join(dir, "nested", "deeper", "session.jsonl");

      await recorder.start(eventBus, makeSession(), nestedPath);

      expect(existsSync(nestedPath)).toBe(true);
    });

    it("is idempotent: calling start() again while already recording is a no-op", async () => {
      await recorder.start(eventBus, makeSession(), filePath);
      eventBus.publish(makeEnvelope(1));

      await recorder.start(eventBus, makeSession({ id: "session-2" }), filePath);
      await recorder.stop();

      // Only session-1's header — a second start() never reopened the
      // stream or wrote a second header.
      const lines = await readLines(filePath);
      const header = lines.find((line) => line.type === "header");
      expect(header?.type === "header" && header.session.id).toBe("session-1");
    });

    it("is not recording after stop()", async () => {
      await recorder.start(eventBus, makeSession(), filePath);

      await recorder.stop();

      expect(recorder.isRecording).toBe(false);
    });

    it("stop() is a safe no-op when never started", async () => {
      await expect(recorder.stop()).resolves.toBeUndefined();
    });

    it("stop() is a safe no-op when called more than once", async () => {
      await recorder.start(eventBus, makeSession(), filePath);

      await recorder.stop();

      await expect(recorder.stop()).resolves.toBeUndefined();
    });

    it("stops recording further events once stopped", async () => {
      await recorder.start(eventBus, makeSession(), filePath);
      await recorder.stop();

      eventBus.publish(makeEnvelope(1));

      const lines = await readLines(filePath);
      expect(lines.some((line) => line.type === "event")).toBe(false);
    });
  });

  describe("event ordering", () => {
    it("preserves the exact order events were published in", async () => {
      await recorder.start(eventBus, makeSession(), filePath);

      eventBus.publish(makeEnvelope(1, "console.log"));
      eventBus.publish(makeEnvelope(2, "sql.query"));
      eventBus.publish(makeEnvelope(3, "http.request"));
      await recorder.stop();

      const lines = await readLines(filePath);
      const eventLines = lines.filter((line) => line.type === "event");
      expect(
        eventLines.map((line) => (line.type === "event" ? line.envelope.sequence : -1)),
      ).toEqual([1, 2, 3]);
    });

    it("interleaves correctly across many rapid, synchronous publishes", async () => {
      await recorder.start(eventBus, makeSession(), filePath);

      for (let i = 1; i <= 200; i += 1) {
        eventBus.publish(makeEnvelope(i));
      }
      await recorder.stop();

      const lines = await readLines(filePath);
      const sequences = lines
        .filter((line) => line.type === "event")
        .map((line) => (line.type === "event" ? line.envelope.sequence : -1));
      expect(sequences).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    });
  });

  describe("concurrent recording", () => {
    it("captures every event correctly when publishes are interleaved across concurrent async flows", async () => {
      await recorder.start(eventBus, makeSession(), filePath);

      // Simulates concurrent request handling: several "flows" each
      // publishing multiple events, interleaved via microtask scheduling
      // rather than one flow finishing before the next starts.
      async function flow(id: number): Promise<void> {
        eventBus.publish(makeEnvelope(id * 10 + 1));
        await Promise.resolve();
        eventBus.publish(makeEnvelope(id * 10 + 2));
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
        eventBus.publish(makeEnvelope(id * 10 + 3));
      }

      await Promise.all([flow(1), flow(2), flow(3), flow(4), flow(5)]);
      await recorder.stop();

      const lines = await readLines(filePath);
      const eventLines = lines.filter((line) => line.type === "event");
      expect(eventLines).toHaveLength(15);
      // No corruption: every line parsed as valid JSON already (readLines
      // would have thrown on JSON.parse otherwise), and every expected
      // sequence shows up exactly once.
      const sequences = eventLines
        .map((line) => (line.type === "event" ? line.envelope.sequence : -1))
        .sort((a, b) => a - b);
      const expected = [1, 2, 3, 4, 5]
        .flatMap((id) => [id * 10 + 1, id * 10 + 2, id * 10 + 3])
        .sort((a, b) => a - b);
      expect(sequences).toEqual(expected);
    });
  });

  describe("large recordings", () => {
    it("records every event in a large session without loss", async () => {
      await recorder.start(eventBus, makeSession(), filePath);

      const total = 5000;
      for (let i = 1; i <= total; i += 1) {
        eventBus.publish(makeEnvelope(i));
      }
      await recorder.stop();

      const lines = await readLines(filePath);
      const eventLines = lines.filter((line) => line.type === "event");
      expect(eventLines).toHaveLength(total);
      expect(recorder.eventCount).toBe(total);
    });
  });

  describe("protocol serialization", () => {
    it("writes a well-formed header as the first line", async () => {
      const session = makeSession({ id: "session-xyz" });

      await recorder.start(eventBus, session, filePath);
      await recorder.stop();

      const lines = await readLines(filePath);
      expect(lines[0]?.type).toBe("header");
      const header = lines[0];
      if (header?.type !== "header") {
        throw new Error("expected header");
      }
      expect(header.formatVersion).toBeTypeOf("number");
      expect(header.protocolVersion).toBeTypeOf("number");
      expect(header.session).toEqual(session);
      expect(header.recordingStartedAt).toBeTypeOf("number");
    });

    it("wraps each published envelope unchanged in an event line", async () => {
      await recorder.start(eventBus, makeSession(), filePath);
      const envelope = makeEnvelope(1, "redis.command");

      eventBus.publish(envelope);
      await recorder.stop();

      const lines = await readLines(filePath);
      const eventLine = lines.find((line) => line.type === "event");
      expect(eventLine?.type === "event" && eventLine.envelope).toEqual(envelope);
    });

    it("writes a well-formed footer as the last line on a clean stop", async () => {
      await recorder.start(eventBus, makeSession(), filePath);
      eventBus.publish(makeEnvelope(1));
      eventBus.publish(makeEnvelope(2));

      await recorder.stop();

      const lines = await readLines(filePath);
      const last = lines.at(-1);
      expect(last?.type).toBe("footer");
      if (last?.type !== "footer") {
        throw new Error("expected footer");
      }
      expect(last.eventCount).toBe(2);
      expect(last.recordingEndedAt).toBeTypeOf("number");
    });

    it("has no footer if the recording was never stopped (still valid up to its last line)", async () => {
      await recorder.start(eventBus, makeSession(), filePath);
      eventBus.publish(makeEnvelope(1));

      // Deliberately not calling stop() here — afterEach will, but we read
      // the file before that happens.
      const lines = await readLines(filePath);

      expect(lines.some((line) => line.type === "footer")).toBe(false);
      expect(lines.every((line) => line.type === "header" || line.type === "event")).toBe(true);
    });
  });

  describe("metadata", () => {
    it("captures the exact session passed to start()", async () => {
      const session = makeSession({ id: "corr-session", startedAt: 12345, status: "running" });

      await recorder.start(eventBus, session, filePath);
      await recorder.stop();

      const lines = await readLines(filePath);
      const header = lines[0];
      expect(header?.type === "header" && header.session).toEqual(session);
    });

    it("reports an accurate eventCount on both the recorder and the footer", async () => {
      await recorder.start(eventBus, makeSession(), filePath);
      eventBus.publish(makeEnvelope(1));
      eventBus.publish(makeEnvelope(2));
      eventBus.publish(makeEnvelope(3));

      expect(recorder.eventCount).toBe(3);

      await recorder.stop();
      const lines = await readLines(filePath);
      const footer = lines.at(-1);
      expect(footer?.type === "footer" && footer.eventCount).toBe(3);
    });
  });

  describe("file integrity", () => {
    it("produces a file where every line is valid JSON after a clean stop", async () => {
      await recorder.start(eventBus, makeSession(), filePath);
      for (let i = 1; i <= 50; i += 1) {
        eventBus.publish(makeEnvelope(i));
      }

      await recorder.stop();

      const lines = await readLines(filePath);
      expect(lines).toHaveLength(52); // header + 50 events + footer
    });

    it("ends the file with a trailing newline after the footer", async () => {
      await recorder.start(eventBus, makeSession(), filePath);

      await recorder.stop();

      const contents = await readFile(filePath, "utf8");
      expect(contents.endsWith("\n")).toBe(true);
    });

    it("fully closes the file descriptor by the time stop() resolves", async () => {
      await recorder.start(eventBus, makeSession(), filePath);
      eventBus.publish(makeEnvelope(1));

      await recorder.stop();

      // A second recorder can immediately open the same path for writing
      // (append mode) without an EBUSY/EPERM — the previous stream is
      // genuinely closed, not just logically "stopped."
      const second = new SessionRecorder();
      await expect(second.start(new EventBus(), makeSession(), filePath)).resolves.toBeUndefined();
      await second.stop();
    });
  });
});
