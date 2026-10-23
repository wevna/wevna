import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type OpenedRecording, openRecording } from "./open-recording.js";
import { SessionLoader } from "./session-loader.js";

// A recording written by the Python SDK must be readable by this SDK's loader and
// replayable through this SDK's server, exactly as one written here is. The
// fixtures are committed in @wevna/protocol; the Python suite regenerates its own
// from its recorder and fails if the bytes change, so this file and that one
// cannot drift apart.
const recordings = path.resolve(import.meta.dirname, "../../protocol/fixtures/recordings");

describe.each(["python-basic.jsonl", "node-basic.jsonl"])("recording %s", (file) => {
  const filePath = path.join(recordings, file);
  let opened: OpenedRecording | undefined;

  afterEach(async () => {
    await opened?.close();
    opened = undefined;
  });

  it("loads through SessionLoader with no issues", async () => {
    const loader = new SessionLoader(filePath);
    const result = await loader.open();
    expect(result.ok).toBe(true);

    const events = [];
    for await (const item of loader.events()) {
      expect(item.ok, JSON.stringify(item)).toBe(true);
      if (item.ok) {
        events.push(item.event.envelope);
      }
    }

    expect(events).toHaveLength(4);
    expect(loader.issues).toEqual([]);
    expect(loader.metadata?.eventCount).toBe(4);
    expect(events.map((e) => e.payload.kind)).toContain("sql.query");
    // Sequence increases, which is all the loader (and replay) requires.
    const sequences = events.map((e) => e.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  it("replays through openRecording: the dashboard's two requests are answered", async () => {
    const result = await openRecording(filePath, { port: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    opened = result.recording;

    const info = (await (await fetch(`${opened.url}/api/session`)).json()) as {
      mode: string;
    };
    const body = (await (await fetch(`${opened.url}/api/session/events`)).json()) as {
      events: { payload: { kind: string; correlation?: { id: string } } }[];
    };

    expect(info.mode).toBe("recording");
    expect(body.events).toHaveLength(4);
    // The request's three events share one correlation id, which is what the
    // dashboard groups a request by.
    const correlated = body.events.filter((e) => e.payload.correlation);
    expect(correlated).toHaveLength(3);
    expect(new Set(correlated.map((e) => e.payload.correlation?.id)).size).toBe(1);
  });
});
