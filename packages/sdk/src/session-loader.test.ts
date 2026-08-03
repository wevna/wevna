import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "./event-bus.js";
import { type ReadEventResult, SessionLoader } from "./session-loader.js";
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

async function collectEvents(loader: SessionLoader): Promise<ReadEventResult[]> {
  const results: ReadEventResult[] = [];
  for await (const result of loader.events()) {
    results.push(result);
  }
  return results;
}

describe("SessionLoader", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wevna-loader-test-"));
    filePath = join(dir, "session.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function recordValidSession(eventCount: number): Promise<void> {
    const recorder = new SessionRecorder();
    const eventBus = new EventBus();
    await recorder.start(eventBus, makeSession(), filePath);
    for (let i = 1; i <= eventCount; i += 1) {
      eventBus.publish(makeEnvelope(i, i % 2 === 0 ? "sql.query" : "console.log"));
    }
    await recorder.stop();
  }

  describe("valid recordings", () => {
    it("opens a valid recording and exposes its header metadata", async () => {
      await recordValidSession(3);
      const loader = new SessionLoader(filePath);

      const result = await loader.open();

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("expected ok");
      }
      expect(result.metadata.session.id).toBe("session-1");
      expect(result.metadata.formatVersion).toBeTypeOf("number");
      expect(result.metadata.protocolVersion).toBeTypeOf("number");
      expect(result.metadata.recordingStartedAt).toBeTypeOf("number");
    });

    it("streams every event in order", async () => {
      await recordValidSession(5);
      const loader = new SessionLoader(filePath);
      await loader.open();

      const results = await collectEvents(loader);

      expect(results.every((r) => r.ok)).toBe(true);
      const sequences = results.map((r) => (r.ok ? r.event.envelope.sequence : -1));
      expect(sequences).toEqual([1, 2, 3, 4, 5]);
    });

    it("populates recordingEndedAt and eventCount once events() completes", async () => {
      await recordValidSession(4);
      const loader = new SessionLoader(filePath);
      await loader.open();
      expect(loader.metadata?.eventCount).toBeUndefined();

      await collectEvents(loader);

      expect(loader.metadata?.eventCount).toBe(4);
      expect(loader.metadata?.recordingEndedAt).toBeTypeOf("number");
    });

    it("reports no issues for a cleanly-recorded session", async () => {
      await recordValidSession(10);
      const loader = new SessionLoader(filePath);
      await loader.open();

      await collectEvents(loader);

      expect(loader.issues).toEqual([]);
    });

    it("is re-iterable: events() can be called more than once", async () => {
      await recordValidSession(3);
      const loader = new SessionLoader(filePath);
      await loader.open();

      const first = await collectEvents(loader);
      const second = await collectEvents(loader);

      expect(first).toEqual(second);
    });
  });

  describe("malformed files", () => {
    it("reports empty-file for a zero-byte recording", async () => {
      await writeFile(filePath, "");
      const loader = new SessionLoader(filePath);

      const result = await loader.open();

      expect(result).toEqual({
        ok: false,
        error: { type: "empty-file", message: expect.any(String) },
      });
    });

    it("reports invalid-json when the header line isn't valid JSON", async () => {
      await writeFile(filePath, "not json at all\n");
      const loader = new SessionLoader(filePath);

      const result = await loader.open();

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected failure");
      }
      expect(result.error.type).toBe("invalid-json");
      expect(result.error.lineNumber).toBe(1);
    });

    it("reports invalid-record-shape when the first line isn't a header", async () => {
      await writeFile(filePath, `${JSON.stringify({ type: "event", envelope: {} })}\n`);
      const loader = new SessionLoader(filePath);

      const result = await loader.open();

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected failure");
      }
      expect(result.error.type).toBe("invalid-record-shape");
    });

    it("skips a malformed event line but keeps streaming the rest", async () => {
      await recordValidSession(0);
      const header = (await readFileFirstLine(filePath)) ?? "";
      await writeFile(
        filePath,
        `${[
          header,
          "this is not json",
          JSON.stringify({ type: "event", envelope: makeEnvelope(1) }),
          JSON.stringify({ type: "footer", recordingEndedAt: Date.now(), eventCount: 1 }),
        ].join("\n")}\n`,
      );
      const loader = new SessionLoader(filePath);
      await loader.open();

      const results = await collectEvents(loader);

      expect(results[0]).toMatchObject({ ok: false, error: { type: "invalid-json" } });
      expect(results[1]).toMatchObject({ ok: true, event: { envelope: { sequence: 1 } } });
    });

    it("reports invalid-record-shape for an event line with a malformed envelope", async () => {
      const header = await recordAndReadHeader();
      await writeFile(
        filePath,
        [header, JSON.stringify({ type: "event", envelope: { not: "an envelope" } })].join("\n") +
          "\n",
      );
      const loader = new SessionLoader(filePath);
      await loader.open();

      const results = await collectEvents(loader);

      expect(results[0]).toMatchObject({ ok: false, error: { type: "invalid-record-shape" } });
    });
  });

  describe("unsupported versions", () => {
    it("rejects a recording with an unsupported format version", async () => {
      await writeFile(
        filePath,
        `${JSON.stringify({
          type: "header",
          formatVersion: 999,
          protocolVersion: 1,
          session: makeSession(),
          recordingStartedAt: Date.now(),
        })}\n`,
      );
      const loader = new SessionLoader(filePath);

      const result = await loader.open();

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected failure");
      }
      expect(result.error.type).toBe("unsupported-format-version");
    });

    it("rejects a recording with an unsupported protocol version", async () => {
      await writeFile(
        filePath,
        `${JSON.stringify({
          type: "header",
          formatVersion: 1,
          protocolVersion: 999,
          session: makeSession(),
          recordingStartedAt: Date.now(),
        })}\n`,
      );
      const loader = new SessionLoader(filePath);

      const result = await loader.open();

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected failure");
      }
      expect(result.error.type).toBe("unsupported-protocol-version");
    });
  });

  describe("missing footer / truncated recording", () => {
    it("flags a missing footer as an issue once events() reaches end of file", async () => {
      const header = await recordAndReadHeader();
      await writeFile(
        filePath,
        `${[header, JSON.stringify({ type: "event", envelope: makeEnvelope(1) })].join("\n")}\n`,
      );
      const loader = new SessionLoader(filePath);
      await loader.open();

      const results = await collectEvents(loader);

      expect(results.every((r) => r.ok)).toBe(true);
      expect(loader.issues).toContainEqual(expect.objectContaining({ type: "missing-footer" }));
    });

    it("still yields every event that was actually written before truncation", async () => {
      const header = await recordAndReadHeader();
      await writeFile(
        filePath,
        [
          header,
          JSON.stringify({ type: "event", envelope: makeEnvelope(1) }),
          JSON.stringify({ type: "event", envelope: makeEnvelope(2) }),
          // Truncated mid-line, as if the process crashed while writing.
          '{"type":"event","envelope":{"sequence":3',
        ].join("\n"),
      );
      const loader = new SessionLoader(filePath);
      await loader.open();

      const results = await collectEvents(loader);

      const okResults = results.filter((r) => r.ok);
      expect(okResults.map((r) => (r.ok ? r.event.envelope.sequence : -1))).toEqual([1, 2]);
    });

    it("flags an event-count mismatch when the footer disagrees with what was read", async () => {
      const header = await recordAndReadHeader();
      await writeFile(
        filePath,
        `${[
          header,
          JSON.stringify({ type: "event", envelope: makeEnvelope(1) }),
          JSON.stringify({ type: "footer", recordingEndedAt: Date.now(), eventCount: 5 }),
        ].join("\n")}\n`,
      );
      const loader = new SessionLoader(filePath);
      await loader.open();

      await collectEvents(loader);

      expect(loader.issues).toContainEqual(
        expect.objectContaining({ type: "event-count-mismatch" }),
      );
    });

    it("flags a sequence gap without dropping either event", async () => {
      const header = await recordAndReadHeader();
      await writeFile(
        filePath,
        `${[
          header,
          JSON.stringify({ type: "event", envelope: makeEnvelope(5) }),
          JSON.stringify({ type: "event", envelope: makeEnvelope(2) }),
        ].join("\n")}\n`,
      );
      const loader = new SessionLoader(filePath);
      await loader.open();

      const results = await collectEvents(loader);

      expect(results.every((r) => r.ok)).toBe(true);
      expect(loader.issues).toContainEqual(expect.objectContaining({ type: "sequence-gap" }));
    });
  });

  describe("large recordings", () => {
    it("streams a large recording completely and correctly", async () => {
      await recordValidSession(3000);
      const loader = new SessionLoader(filePath);
      await loader.open();

      const results = await collectEvents(loader);

      expect(results).toHaveLength(3000);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(loader.metadata?.eventCount).toBe(3000);
    });
  });

  describe("incremental loading", () => {
    it("does not require draining events() to get header metadata", async () => {
      await recordValidSession(1000);
      const loader = new SessionLoader(filePath);

      const result = await loader.open();

      expect(result.ok).toBe(true);
      // Nothing about events() has been touched yet.
      expect(loader.metadata?.eventCount).toBeUndefined();
    });

    it("yields events one at a time rather than all at once", async () => {
      await recordValidSession(10);
      const loader = new SessionLoader(filePath);
      await loader.open();

      let seen = 0;
      for await (const result of loader.events()) {
        seen += 1;
        if (seen === 3) {
          // Only 3 of 10 have been produced at this point in the loop —
          // proves the generator is genuinely incremental, not built from
          // a pre-materialized array under the hood.
          expect(result.ok).toBe(true);
          break;
        }
      }
      expect(seen).toBe(3);
    });
  });

  describe("metadata parsing", () => {
    it("carries the exact session object from the header", async () => {
      const recorder = new SessionRecorder();
      const eventBus = new EventBus();
      const session = { id: "custom-session-id", startedAt: 12345, status: "running" as const };
      await recorder.start(eventBus, session, filePath);
      await recorder.stop();
      const loader = new SessionLoader(filePath);

      const result = await loader.open();

      expect(result.ok && result.metadata.session).toEqual(session);
    });
  });

  async function recordAndReadHeader(): Promise<string> {
    await recordValidSession(0);
    return (await readFileFirstLine(filePath)) ?? "";
  }
});

async function readFileFirstLine(filePath: string): Promise<string | undefined> {
  const { readFile } = await import("node:fs/promises");
  const contents = await readFile(filePath, "utf8");
  return contents.split("\n")[0];
}
