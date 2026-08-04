import type { TimelineEntry } from "@wevna/intelligence";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it } from "vitest";
import { computeTimelineAxisTicks, computeTimelineLayout } from "./timeline-layout.ts";

function makeEntry(overrides: {
  kind?: string;
  relativeOffsetMs: number;
  durationMs?: number;
  sequence?: number;
}): TimelineEntry {
  const event: Envelope<CapturedEvent> = {
    version: 1,
    sessionId: "session-1",
    sequence: overrides.sequence ?? 1,
    payload: {
      id: `event-${overrides.sequence ?? 1}`,
      kind: overrides.kind ?? "console.log",
      occurredAt: overrides.relativeOffsetMs,
      attributes: {},
    },
  };
  return {
    event,
    kind: overrides.kind ?? "console.log",
    sequence: overrides.sequence ?? 1,
    timestamp: overrides.relativeOffsetMs,
    relativeOffsetMs: overrides.relativeOffsetMs,
    durationMs: overrides.durationMs,
  };
}

// Every timed producer (http.request/sql.query/redis.command) publishes
// after its operation finishes, so relativeOffsetMs is always an *end*
// time — a bar has to end there and extend backward by durationMs. These
// tests exercise that directly: an event at offset 50 lasting 40ms ran
// from 10ms to 50ms, not 50ms to 90ms.
describe("computeTimelineLayout", () => {
  describe("layout calculations", () => {
    it("positions an instantaneous entry at its own offset", () => {
      const layout = computeTimelineLayout([makeEntry({ relativeOffsetMs: 25 })], 100);

      expect(layout.entries[0]?.leftPercent).toBe(25);
      expect(layout.entries[0]?.widthPercent).toBe(0);
    });

    it("ends a durational bar at its offset, starting offset - duration", () => {
      const layout = computeTimelineLayout(
        [makeEntry({ relativeOffsetMs: 50, durationMs: 40 })],
        100,
      );

      // Ran from 10ms to 50ms, not 50ms to 90ms.
      expect(layout.entries[0]?.leftPercent).toBe(10);
      expect(layout.entries[0]?.widthPercent).toBe(40);
    });

    it("reports the resolved totalDurationMs", () => {
      const layout = computeTimelineLayout([makeEntry({ relativeOffsetMs: 0 })], 250);

      expect(layout.totalDurationMs).toBe(250);
    });
  });

  describe("proportional scaling", () => {
    it("scales both position and width for a shorter total duration", () => {
      // Ran from 5ms to 15ms.
      const entries = [makeEntry({ relativeOffsetMs: 15, durationMs: 10 })];

      const short = computeTimelineLayout(entries, 20);
      const long = computeTimelineLayout(entries, 100);

      expect(short.entries[0]?.leftPercent).toBe(25);
      expect(short.entries[0]?.widthPercent).toBe(50);
      expect(long.entries[0]?.leftPercent).toBe(5);
      expect(long.entries[0]?.widthPercent).toBe(10);
    });

    it("gives the terminal http.request-style event (ends exactly at the total) 0% left and 100% width", () => {
      // Represents the whole request: ends at the total duration, having
      // lasted the entire thing — this is what makes http.request span
      // the full track rather than collapsing to a marker at the end.
      const layout = computeTimelineLayout(
        [makeEntry({ relativeOffsetMs: 100, durationMs: 100 })],
        100,
      );

      expect(layout.entries[0]?.leftPercent).toBe(0);
      expect(layout.entries[0]?.widthPercent).toBe(100);
    });
  });

  describe("zero-duration events", () => {
    it("marks an event with no durationMs as instantaneous with 0 width", () => {
      const layout = computeTimelineLayout([makeEntry({ relativeOffsetMs: 10 })], 100);

      expect(layout.entries[0]?.isInstantaneous).toBe(true);
      expect(layout.entries[0]?.widthPercent).toBe(0);
    });

    it("marks an event with an explicit durationMs of 0 as instantaneous", () => {
      const layout = computeTimelineLayout(
        [makeEntry({ relativeOffsetMs: 10, durationMs: 0 })],
        100,
      );

      expect(layout.entries[0]?.isInstantaneous).toBe(true);
    });

    it("marks an event with a positive duration as not instantaneous", () => {
      const layout = computeTimelineLayout(
        [makeEntry({ relativeOffsetMs: 10, durationMs: 5 })],
        100,
      );

      expect(layout.entries[0]?.isInstantaneous).toBe(false);
    });

    it("handles an entirely instantaneous timeline (no known request duration) gracefully", () => {
      const layout = computeTimelineLayout([makeEntry({ relativeOffsetMs: 0 })], undefined);

      expect(layout.totalDurationMs).toBe(0);
      expect(layout.entries[0]?.leftPercent).toBe(0);
      expect(layout.entries[0]?.widthPercent).toBe(0);
      expect(layout.entries[0]?.isInstantaneous).toBe(true);
      expect(Number.isNaN(layout.entries[0]?.leftPercent)).toBe(false);
    });

    it("returns an empty layout for an empty timeline without throwing", () => {
      expect(() => computeTimelineLayout([], undefined)).not.toThrow();
      expect(computeTimelineLayout([], undefined)).toEqual({ totalDurationMs: 0, entries: [] });
    });
  });

  describe("long-running requests", () => {
    it("keeps proportions correct for multi-second durations", () => {
      // Ran from 1000ms to 1500ms, out of a 3000ms request.
      const layout = computeTimelineLayout(
        [makeEntry({ relativeOffsetMs: 1500, durationMs: 500 })],
        3000,
      );

      expect(layout.entries[0]?.leftPercent).toBeCloseTo(33.33, 1);
      expect(layout.entries[0]?.widthPercent).toBeCloseTo(16.67, 1);
    });

    it("does not produce Infinity or NaN for very large durations", () => {
      const layout = computeTimelineLayout(
        [makeEntry({ relativeOffsetMs: 500_000, durationMs: 10_000 })],
        1_000_000,
      );

      expect(Number.isFinite(layout.entries[0]?.leftPercent)).toBe(true);
      expect(Number.isFinite(layout.entries[0]?.widthPercent)).toBe(true);
    });
  });

  describe("mixed event durations", () => {
    it("lays out bars and markers side by side correctly", () => {
      const entries = [
        makeEntry({ kind: "console.log", relativeOffsetMs: 4, sequence: 1 }),
        makeEntry({ kind: "sql.query", relativeOffsetMs: 11, durationMs: 5, sequence: 2 }),
        makeEntry({ kind: "redis.command", relativeOffsetMs: 17, durationMs: 2, sequence: 3 }),
        makeEntry({ kind: "http.request", relativeOffsetMs: 22, durationMs: 22, sequence: 4 }),
      ];

      const layout = computeTimelineLayout(entries, 22);

      expect(layout.entries.map((e) => e.isInstantaneous)).toEqual([true, false, false, false]);
      // sql.query ran from 6ms to 11ms.
      expect(layout.entries[1]?.leftPercent).toBeCloseTo((6 / 22) * 100, 5);
      expect(layout.entries[1]?.widthPercent).toBeCloseTo((5 / 22) * 100, 5);
      // http.request spans the entire request.
      expect(layout.entries[3]?.leftPercent).toBe(0);
      expect(layout.entries[3]?.widthPercent).toBe(100);
    });
  });

  describe("layout stability", () => {
    it("is deterministic: identical input produces identical output", () => {
      const entries = [
        makeEntry({ relativeOffsetMs: 10, durationMs: 10 }),
        makeEntry({ relativeOffsetMs: 15, durationMs: 3, sequence: 2 }),
      ];

      expect(computeTimelineLayout(entries, 30)).toEqual(computeTimelineLayout(entries, 30));
    });

    it("does not mutate the input entries", () => {
      const entry = makeEntry({ relativeOffsetMs: 5, durationMs: 2 });
      const before = JSON.parse(JSON.stringify(entry));

      computeTimelineLayout([entry], 20);

      expect(JSON.parse(JSON.stringify(entry))).toEqual(before);
    });

    it("references the same underlying TimelineEntry objects, never copies", () => {
      const entry = makeEntry({ relativeOffsetMs: 0 });

      const layout = computeTimelineLayout([entry], 10);

      expect(layout.entries[0]?.entry).toBe(entry);
    });
  });

  describe("clamping", () => {
    it("clamps a bar's start to 0 when its own duration exceeds its offset", () => {
      // Its own reported duration (50ms) is longer than how far into the
      // request it occurred (10ms) — can happen against the fallback
      // total (no request.durationMs yet) if this event's duration
      // doesn't fit within what's been observed so far.
      const layout = computeTimelineLayout(
        [makeEntry({ relativeOffsetMs: 10, durationMs: 50 })],
        100,
      );

      const entry = layout.entries[0];
      expect(entry?.leftPercent).toBe(0);
      expect((entry?.leftPercent ?? 0) + (entry?.widthPercent ?? 0)).toBeLessThanOrEqual(100);
    });

    it("clamps an offset beyond the total duration to 100%", () => {
      const layout = computeTimelineLayout([makeEntry({ relativeOffsetMs: 150 })], 100);

      expect(layout.entries[0]?.leftPercent).toBe(100);
    });
  });
});

describe("computeTimelineAxisTicks", () => {
  it("defaults to 5 evenly-spaced ticks spanning 0% to 100%", () => {
    const ticks = computeTimelineAxisTicks(100);

    expect(ticks).toHaveLength(5);
    expect(ticks.map((t) => t.leftPercent)).toEqual([0, 25, 50, 75, 100]);
    expect(ticks.map((t) => t.ms)).toEqual([0, 25, 50, 75, 100]);
  });

  it("labels each tick with its millisecond value", () => {
    const ticks = computeTimelineAxisTicks(40);

    expect(ticks.map((t) => t.label)).toEqual(["0ms", "10ms", "20ms", "30ms", "40ms"]);
  });

  it("honors a custom tick count", () => {
    const ticks = computeTimelineAxisTicks(100, 3);

    expect(ticks.map((t) => t.leftPercent)).toEqual([0, 50, 100]);
    expect(ticks.map((t) => t.ms)).toEqual([0, 50, 100]);
  });

  it("clamps a tick count below 2 up to the minimum of 2", () => {
    const ticks = computeTimelineAxisTicks(100, 1);

    expect(ticks.map((t) => t.leftPercent)).toEqual([0, 100]);
  });

  it("scales correctly for long-running requests", () => {
    const ticks = computeTimelineAxisTicks(3000);

    expect(ticks.map((t) => t.ms)).toEqual([0, 750, 1500, 2250, 3000]);
  });

  it("rounds fractional millisecond values to one decimal place", () => {
    const ticks = computeTimelineAxisTicks(10, 3);

    // Midpoint of a 10ms span split into 2 segments is 5ms exactly, but a
    // duration that doesn't divide evenly should still round cleanly.
    const oddTicks = computeTimelineAxisTicks(33, 4);
    expect(oddTicks.map((t) => t.label)).toEqual(["0ms", "11ms", "22ms", "33ms"]);
    expect(ticks.map((t) => t.label)).toEqual(["0ms", "5ms", "10ms"]);
  });

  it("returns a single 0ms tick for a zero total duration", () => {
    const ticks = computeTimelineAxisTicks(0);

    expect(ticks).toEqual([{ ms: 0, leftPercent: 0, label: "0ms" }]);
  });

  it("returns a single 0ms tick for a negative total duration", () => {
    const ticks = computeTimelineAxisTicks(-10);

    expect(ticks).toEqual([{ ms: 0, leftPercent: 0, label: "0ms" }]);
  });

  it("is deterministic: identical input produces identical output", () => {
    expect(computeTimelineAxisTicks(250)).toEqual(computeTimelineAxisTicks(250));
  });

  it("never produces NaN or Infinity for very large durations", () => {
    const ticks = computeTimelineAxisTicks(1_000_000);

    for (const tick of ticks) {
      expect(Number.isFinite(tick.ms)).toBe(true);
      expect(Number.isFinite(tick.leftPercent)).toBe(true);
    }
  });
});
