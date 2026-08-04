import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it } from "vitest";
import { SnapshotEngine } from "./snapshot-engine.js";

let sequenceCounter = 0;

function makeEvent(overrides: {
  correlationId?: string;
  kind?: string;
  occurredAt: number;
  attributes?: Record<string, unknown>;
}): Envelope<CapturedEvent> {
  sequenceCounter += 1;
  return {
    version: 1,
    sessionId: "session-1",
    sequence: sequenceCounter,
    payload: {
      id: `event-${sequenceCounter}`,
      kind: overrides.kind ?? "console.log",
      occurredAt: overrides.occurredAt,
      attributes: overrides.attributes ?? {},
      correlation: overrides.correlationId ? { id: overrides.correlationId } : undefined,
    },
  };
}

function httpEvent(correlationId: string, occurredAt: number, statusCode = 200) {
  return makeEvent({
    correlationId,
    kind: "http.request",
    occurredAt,
    attributes: { method: "GET", url: "/widgets", statusCode, durationMs: 5 },
  });
}

describe("SnapshotEngine", () => {
  it("returns an empty snapshot for position 0 with no events loaded", () => {
    const engine = new SnapshotEngine();
    engine.load([]);

    const snapshot = engine.getSnapshot(0);

    expect(snapshot.events).toEqual([]);
    expect(snapshot.requests).toEqual([]);
  });

  it("includes exactly the first N events for position N", () => {
    const engine = new SnapshotEngine();
    const events = [
      makeEvent({ occurredAt: 1 }),
      makeEvent({ occurredAt: 2 }),
      makeEvent({ occurredAt: 3 }),
    ];
    engine.load(events);

    expect(engine.getSnapshot(2).events).toEqual(events.slice(0, 2));
    expect(engine.getSnapshot(0).events).toEqual([]);
    expect(engine.getSnapshot(3).events).toEqual(events);
  });

  it("clamps a position beyond totalEvents", () => {
    const engine = new SnapshotEngine();
    const events = [makeEvent({ occurredAt: 1 })];
    engine.load(events);

    expect(engine.getSnapshot(999).events).toEqual(events);
  });

  it("clamps a negative position to 0", () => {
    const engine = new SnapshotEngine();
    engine.load([makeEvent({ occurredAt: 1 })]);

    expect(engine.getSnapshot(-5).events).toEqual([]);
  });

  describe("request reconstruction", () => {
    it("only includes requests whose events have occurred by the given position", () => {
      const engine = new SnapshotEngine();
      const events = [
        makeEvent({ correlationId: "a", occurredAt: 1 }),
        makeEvent({ correlationId: "b", occurredAt: 2 }),
      ];
      engine.load(events);

      expect(engine.getSnapshot(1).requests.map((r) => r.id)).toEqual(["a"]);
      expect(engine.getSnapshot(2).requests.map((r) => r.id)).toEqual(["a", "b"]);
    });

    it("a request's fields reflect only events applied so far — pending before its http.request event, complete after", () => {
      const engine = new SnapshotEngine();
      const events = [
        makeEvent({ correlationId: "a", occurredAt: 1, kind: "console.log" }),
        httpEvent("a", 2, 201),
      ];
      engine.load(events);

      expect(engine.getSnapshot(1).requests[0]?.status).toBe("pending");
      expect(engine.getSnapshot(1).requests[0]?.statusCode).toBeUndefined();

      expect(engine.getSnapshot(2).requests[0]?.status).toBe("complete");
      expect(engine.getSnapshot(2).requests[0]?.statusCode).toBe(201);
    });

    it("builds the same request model buildRequestModel produces for the same prefix", () => {
      const engine = new SnapshotEngine();
      const events = [
        makeEvent({ correlationId: "a", occurredAt: 1, kind: "console.log" }),
        makeEvent({ correlationId: "a", occurredAt: 2, kind: "sql.query" }),
        httpEvent("a", 3),
      ];
      engine.load(events);

      const snapshot = engine.getSnapshot(3);
      expect(snapshot.requests[0]?.events).toHaveLength(3);
      expect(snapshot.requests[0]?.timeline).toHaveLength(3);
      expect(snapshot.requests[0]?.durationMs).toBe(5);
    });

    it("ignores events without a correlation id", () => {
      const engine = new SnapshotEngine();
      const events = [makeEvent({ occurredAt: 1 })];
      engine.load(events);

      expect(engine.getSnapshot(1).requests).toEqual([]);
    });
  });

  describe("determinism", () => {
    it("the same position always produces an equal snapshot", () => {
      const engine = new SnapshotEngine();
      const events = Array.from({ length: 25 }, (_, i) =>
        makeEvent({ correlationId: `c-${i % 5}`, occurredAt: i }),
      );
      engine.load(events);

      const first = engine.getSnapshot(17);
      const second = engine.getSnapshot(3);
      const third = engine.getSnapshot(17);

      expect(third).toEqual(first);
      expect(second).not.toEqual(first);
    });

    it("returns a reference-equal snapshot for a repeated identical position", () => {
      const engine = new SnapshotEngine();
      engine.load([makeEvent({ correlationId: "a", occurredAt: 1 })]);

      const first = engine.getSnapshot(1);
      const second = engine.getSnapshot(1);

      expect(second).toBe(first);
    });

    it("is deterministic across many repeated seeks in arbitrary order", () => {
      const engine = new SnapshotEngine();
      const events = Array.from({ length: 120 }, (_, i) =>
        makeEvent({ correlationId: `c-${i % 7}`, occurredAt: i }),
      );
      engine.load(events);

      const positions = [80, 3, 119, 0, 45, 80, 12, 45];
      const results = positions.map((p) => engine.getSnapshot(p));
      const rerun = positions.map((p) => engine.getSnapshot(p));

      expect(rerun).toEqual(results);
    });
  });

  describe("checkpoint restoration and incremental replay", () => {
    it("produces identical requests whether reached via a checkpoint or a full incremental walk", () => {
      // 300 events forces multiple checkpoint boundaries (interval is
      // sqrt(300) ~ 18, floored by the 50-event minimum -> interval 50).
      const engineA = new SnapshotEngine();
      const engineB = new SnapshotEngine();
      const events = Array.from({ length: 300 }, (_, i) =>
        i % 10 === 9
          ? httpEvent(`c-${Math.floor(i / 10)}`, i)
          : makeEvent({
              correlationId: `c-${Math.floor(i / 10)}`,
              occurredAt: i,
              kind: "sql.query",
            }),
      );
      engineA.load(events);
      engineB.load(events);

      // engineA seeks directly to a position that lands between
      // checkpoints; engineB walks there one event at a time first,
      // priming its own cache differently — both must agree regardless.
      const direct = engineA.getSnapshot(217);
      for (let i = 0; i <= 217; i += 1) {
        engineB.getSnapshot(i);
      }
      const walked = engineB.getSnapshot(217);

      expect(walked).toEqual(direct);
    });

    it("handles recordings much larger than the checkpoint interval efficiently and correctly", () => {
      const engine = new SnapshotEngine();
      const events = Array.from({ length: 20_000 }, (_, i) =>
        makeEvent({ correlationId: `c-${i % 500}`, occurredAt: i }),
      );
      engine.load(events);

      const start = performance.now();
      // Scatter seeks across the whole range, including repeats.
      for (const position of [20_000, 1, 19_999, 10_000, 500, 15_000, 10_000, 0]) {
        engine.getSnapshot(position);
      }
      const elapsedMs = performance.now() - start;

      expect(engine.getSnapshot(20_000).requests).toHaveLength(500);
      expect(engine.getSnapshot(1).requests).toHaveLength(1);
      // Not a strict perf assertion (CI machines vary), just a guard
      // against an accidental reintroduction of O(n) or worse per seek.
      expect(elapsedMs).toBeLessThan(2000);
    });
  });

  describe("reload", () => {
    it("load() rebuilds checkpoints and invalidates the position cache", () => {
      const engine = new SnapshotEngine();
      engine.load([makeEvent({ correlationId: "a", occurredAt: 1 })]);
      expect(engine.getSnapshot(1).requests).toHaveLength(1);

      engine.load([
        makeEvent({ correlationId: "x", occurredAt: 1 }),
        makeEvent({ correlationId: "y", occurredAt: 2 }),
      ]);

      const snapshot = engine.getSnapshot(2);
      expect(snapshot.requests.map((r) => r.id)).toEqual(["x", "y"]);
    });
  });
});
