import { buildExecutionGraph, type TimelineEntry } from "@wevna/intelligence";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it } from "vitest";
import { computeExecutionGraphLayout } from "./execution-graph-layout.ts";

function makeEntry(overrides: {
  kind: string;
  relativeOffsetMs: number;
  durationMs?: number;
  sequence: number;
}): TimelineEntry {
  const event: Envelope<CapturedEvent> = {
    version: 1,
    sessionId: "session-1",
    sequence: overrides.sequence,
    payload: {
      id: `event-${overrides.sequence}`,
      kind: overrides.kind,
      occurredAt: overrides.relativeOffsetMs,
      attributes: {},
    },
  };
  return {
    event,
    kind: overrides.kind,
    sequence: overrides.sequence,
    timestamp: overrides.relativeOffsetMs,
    relativeOffsetMs: overrides.relativeOffsetMs,
    durationMs: overrides.durationMs,
  };
}

function layoutOf(timeline: readonly TimelineEntry[], requestDurationMs?: number) {
  return computeExecutionGraphLayout(
    buildExecutionGraph({ durationMs: requestDurationMs, timeline }),
    requestDurationMs,
  );
}

// http.request spans the whole request; a query and a redis call ran inside
// it, and a log happened inside the query.
const NESTED: readonly TimelineEntry[] = [
  makeEntry({ kind: "console.log", relativeOffsetMs: 8, sequence: 1 }),
  makeEntry({ kind: "sql.query", relativeOffsetMs: 12, durationMs: 8, sequence: 2 }),
  makeEntry({ kind: "redis.command", relativeOffsetMs: 22, durationMs: 3, sequence: 3 }),
  makeEntry({ kind: "http.request", relativeOffsetMs: 40, durationMs: 40, sequence: 4 }),
];

describe("computeExecutionGraphLayout", () => {
  it("returns no rows for an empty graph", () => {
    expect(layoutOf([]).rows).toEqual([]);
  });

  it("orders rows depth-first, so a child sits directly beneath its parent", () => {
    const rows = layoutOf(NESTED, 40).rows;

    // Chronological order would have put console.log first; the tree has to
    // start at the root and descend.
    expect(rows.map((row) => row.node.kind)).toEqual([
      "http.request",
      "sql.query",
      "console.log",
      "redis.command",
    ]);
  });

  it("keeps siblings in chronological order rather than sorting by duration", () => {
    const rows = layoutOf(
      [
        makeEntry({ kind: "redis.command", relativeOffsetMs: 5, durationMs: 1, sequence: 1 }),
        makeEntry({ kind: "sql.query", relativeOffsetMs: 20, durationMs: 10, sequence: 2 }),
        makeEntry({ kind: "http.request", relativeOffsetMs: 30, durationMs: 30, sequence: 3 }),
      ],
      30,
    ).rows;

    // Re-sorting by duration would make this view disagree with the
    // waterfall beside it.
    expect(rows.map((row) => row.node.kind)).toEqual([
      "http.request",
      "redis.command",
      "sql.query",
    ]);
  });

  it("positions a bar by when the operation started, not when it was published", () => {
    const sql = layoutOf(NESTED, 40).rows.find((row) => row.node.kind === "sql.query");

    // Ran +4ms..+12ms of a 40ms request.
    expect(sql?.leftPercent).toBeCloseTo(10);
    expect(sql?.widthPercent).toBeCloseTo(20);
  });

  it("spans the full track for the request's own container bar", () => {
    const http = layoutOf(NESTED, 40).rows.find((row) => row.node.kind === "http.request");

    expect(http?.leftPercent).toBe(0);
    expect(http?.widthPercent).toBeCloseTo(100);
  });

  it("marks a zero-duration event as instantaneous, positioned at its moment", () => {
    const log = layoutOf(NESTED, 40).rows.find((row) => row.node.kind === "console.log");

    expect(log?.isInstantaneous).toBe(true);
    expect(log?.leftPercent).toBeCloseTo(20);
    expect(log?.widthPercent).toBe(0);
  });

  it("never lets a bar extend past the end of the track", () => {
    const rows = layoutOf(
      [makeEntry({ kind: "sql.query", relativeOffsetMs: 100, durationMs: 500, sequence: 1 })],
      100,
    ).rows;

    const row = rows[0];
    expect((row?.leftPercent ?? 0) + (row?.widthPercent ?? 0)).toBeLessThanOrEqual(100);
  });

  it("falls back to the latest offset when the request has no measured duration", () => {
    // A still-in-flight request must not collapse to a zero-width layout.
    const layout = layoutOf([
      makeEntry({ kind: "sql.query", relativeOffsetMs: 12, durationMs: 8, sequence: 1 }),
    ]);

    expect(layout.totalDurationMs).toBe(12);
    expect(layout.rows[0]?.widthPercent).toBeGreaterThan(0);
  });

  it("degrades every row to a marker when no span can be determined", () => {
    const layout = layoutOf([makeEntry({ kind: "console.log", relativeOffsetMs: 0, sequence: 1 })]);

    expect(layout.totalDurationMs).toBe(0);
    expect(layout.rows[0]).toMatchObject({
      leftPercent: 0,
      widthPercent: 0,
      isInstantaneous: true,
    });
  });

  it("flags the last child of each parent so a renderer can pick its connector", () => {
    const rows = layoutOf(NESTED, 40).rows;
    const byKind = new Map(rows.map((row) => [row.node.kind, row]));

    expect(byKind.get("redis.command")?.isLastChild).toBe(true);
    expect(byKind.get("sql.query")?.isLastChild).toBe(false);
    // Only child of the query.
    expect(byKind.get("console.log")?.isLastChild).toBe(true);
  });

  it("reports the graph's max depth for indentation budgeting", () => {
    expect(layoutOf(NESTED, 40).maxDepth).toBe(2);
  });

  it("emits every node exactly once, even for a graph with several roots", () => {
    const rows = layoutOf([
      makeEntry({ kind: "sql.query", relativeOffsetMs: 5, durationMs: 2, sequence: 1 }),
      makeEntry({ kind: "redis.command", relativeOffsetMs: 20, durationMs: 2, sequence: 2 }),
    ]).rows;

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.node.id)).size).toBe(2);
  });

  it("is deterministic for the same input", () => {
    expect(layoutOf(NESTED, 40)).toEqual(layoutOf(NESTED, 40));
  });

  it("stays within its own row count on a deeply nested graph", () => {
    // Concentric spans: each one contains the next, 400 deep. Guards the
    // iterative traversal against the stack overflow a recursive one would
    // risk inside a render.
    const timeline = Array.from({ length: 400 }, (_, index) =>
      makeEntry({
        kind: "sql.query",
        relativeOffsetMs: 1000 - index,
        durationMs: 1000 - index * 2,
        sequence: index + 1,
      }),
    );

    const layout = layoutOf(timeline, 1000);

    expect(layout.rows).toHaveLength(400);
    expect(layout.maxDepth).toBe(399);
  });
});
