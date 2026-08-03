import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it } from "vitest";
import type { AnalyzableRequest, AnalyzableTimelineEntry } from "./analyzable-request.js";
import { buildExecutionGraph } from "./execution-graph.js";

function makeEntry(overrides: {
  kind: string;
  relativeOffsetMs: number;
  durationMs?: number;
  sequence?: number;
}): AnalyzableTimelineEntry {
  const sequence = overrides.sequence ?? 1;
  const event: Envelope<CapturedEvent> = {
    version: 1,
    sessionId: "session-1",
    sequence,
    payload: {
      id: `event-${sequence}`,
      kind: overrides.kind,
      occurredAt: overrides.relativeOffsetMs,
      attributes: {},
    },
  };
  return {
    kind: overrides.kind,
    relativeOffsetMs: overrides.relativeOffsetMs,
    durationMs: overrides.durationMs,
    event,
  };
}

function makeRequest(timeline: readonly AnalyzableTimelineEntry[]): AnalyzableRequest {
  return { durationMs: undefined, timeline };
}

describe("buildExecutionGraph", () => {
  describe("empty requests", () => {
    it("returns an empty graph for a request with no events, without throwing", () => {
      expect(() => buildExecutionGraph(makeRequest([]))).not.toThrow();

      const graph = buildExecutionGraph(makeRequest([]));
      expect(graph.nodes).toEqual([]);
      expect(graph.edges).toEqual([]);
    });
  });

  describe("simple requests", () => {
    it("produces one node per event, in order", () => {
      const graph = buildExecutionGraph(
        makeRequest([
          makeEntry({ kind: "console.log", relativeOffsetMs: 1, sequence: 1 }),
          makeEntry({ kind: "http.request", relativeOffsetMs: 10, durationMs: 10, sequence: 2 }),
        ]),
      );

      expect(graph.nodes).toHaveLength(2);
      expect(graph.nodes.map((n) => n.kind)).toEqual(["console.log", "http.request"]);
    });

    it("a single-event request produces one node and no edges", () => {
      const graph = buildExecutionGraph(
        makeRequest([makeEntry({ kind: "http.request", relativeOffsetMs: 5, durationMs: 5 })]),
      );

      expect(graph.nodes).toHaveLength(1);
      expect(graph.edges).toEqual([]);
    });
  });

  describe("SQL-heavy requests", () => {
    it("produces one node per SQL query, each correctly categorized", () => {
      const graph = buildExecutionGraph(
        makeRequest([
          makeEntry({ kind: "sql.query", relativeOffsetMs: 10, durationMs: 5, sequence: 1 }),
          makeEntry({ kind: "sql.query", relativeOffsetMs: 20, durationMs: 8, sequence: 2 }),
          makeEntry({ kind: "sql.query", relativeOffsetMs: 30, durationMs: 3, sequence: 3 }),
        ]),
      );

      expect(graph.nodes).toHaveLength(3);
      expect(graph.nodes.every((n) => n.category === "sql")).toBe(true);
    });
  });

  describe("Redis-heavy requests", () => {
    it("produces one node per Redis command, each correctly categorized", () => {
      const graph = buildExecutionGraph(
        makeRequest([
          makeEntry({ kind: "redis.command", relativeOffsetMs: 5, durationMs: 2, sequence: 1 }),
          makeEntry({ kind: "redis.command", relativeOffsetMs: 9, durationMs: 1, sequence: 2 }),
        ]),
      );

      expect(graph.nodes).toHaveLength(2);
      expect(graph.nodes.every((n) => n.category === "redis")).toBe(true);
    });
  });

  describe("exception requests", () => {
    it("includes an exception node categorized as exception", () => {
      const graph = buildExecutionGraph(
        makeRequest([
          makeEntry({ kind: "sql.query", relativeOffsetMs: 5, durationMs: 3, sequence: 1 }),
          makeEntry({ kind: "exception.captured", relativeOffsetMs: 8, sequence: 2 }),
        ]),
      );

      const exceptionNode = graph.nodes.find((n) => n.category === "exception");
      expect(exceptionNode).toBeDefined();
      expect(exceptionNode?.kind).toBe("exception.captured");
    });

    it("never invents a duration for an exception node", () => {
      const graph = buildExecutionGraph(
        makeRequest([makeEntry({ kind: "exception.captured", relativeOffsetMs: 3 })]),
      );

      expect(graph.nodes[0]?.durationMs).toBeUndefined();
    });
  });

  describe("console-only requests", () => {
    it("produces console-categorized nodes with no operations mixed in", () => {
      const graph = buildExecutionGraph(
        makeRequest([
          makeEntry({ kind: "console.log", relativeOffsetMs: 1, sequence: 1 }),
          makeEntry({ kind: "console.log", relativeOffsetMs: 2, sequence: 2 }),
          makeEntry({ kind: "console.log", relativeOffsetMs: 3, sequence: 3 }),
        ]),
      );

      expect(graph.nodes).toHaveLength(3);
      expect(graph.nodes.every((n) => n.category === "console")).toBe(true);
      expect(graph.edges).toHaveLength(2);
    });
  });

  describe("graph structure", () => {
    it("gives each node a stable id equal to its underlying event's id", () => {
      const graph = buildExecutionGraph(
        makeRequest([makeEntry({ kind: "http.request", relativeOffsetMs: 5, sequence: 42 })]),
      );

      expect(graph.nodes[0]?.id).toBe("event-42");
      expect(graph.nodes[0]?.event.payload.id).toBe("event-42");
    });

    it("assigns each node its 0-based sequence position", () => {
      const graph = buildExecutionGraph(
        makeRequest([
          makeEntry({ kind: "console.log", relativeOffsetMs: 1, sequence: 1 }),
          makeEntry({ kind: "sql.query", relativeOffsetMs: 5, durationMs: 2, sequence: 2 }),
          makeEntry({ kind: "http.request", relativeOffsetMs: 10, durationMs: 10, sequence: 3 }),
        ]),
      );

      expect(graph.nodes.map((n) => n.sequence)).toEqual([0, 1, 2]);
    });

    it("references the same underlying event object, never a copy", () => {
      const entry = makeEntry({ kind: "http.request", relativeOffsetMs: 5 });

      const graph = buildExecutionGraph(makeRequest([entry]));

      expect(graph.nodes[0]?.event).toBe(entry.event);
    });

    it("carries relativeOffsetMs and durationMs through unchanged", () => {
      const graph = buildExecutionGraph(
        makeRequest([makeEntry({ kind: "sql.query", relativeOffsetMs: 17, durationMs: 9 })]),
      );

      expect(graph.nodes[0]?.relativeOffsetMs).toBe(17);
      expect(graph.nodes[0]?.durationMs).toBe(9);
    });

    it("includes a metadata slot on the graph itself", () => {
      const graph = buildExecutionGraph(makeRequest([]));

      expect(graph.metadata).toEqual({});
    });
  });

  describe("edge construction", () => {
    it("produces exactly n-1 sequential edges for n nodes", () => {
      const graph = buildExecutionGraph(
        makeRequest([
          makeEntry({ kind: "console.log", relativeOffsetMs: 1, sequence: 1 }),
          makeEntry({ kind: "sql.query", relativeOffsetMs: 5, durationMs: 2, sequence: 2 }),
          makeEntry({ kind: "redis.command", relativeOffsetMs: 8, durationMs: 1, sequence: 3 }),
          makeEntry({ kind: "http.request", relativeOffsetMs: 10, durationMs: 10, sequence: 4 }),
        ]),
      );

      expect(graph.edges).toHaveLength(3);
      expect(graph.edges.every((e) => e.type === "sequential")).toBe(true);
    });

    it("connects each edge to the correct consecutive node ids", () => {
      const graph = buildExecutionGraph(
        makeRequest([
          makeEntry({ kind: "console.log", relativeOffsetMs: 1, sequence: 1 }),
          makeEntry({ kind: "sql.query", relativeOffsetMs: 5, durationMs: 2, sequence: 2 }),
          makeEntry({ kind: "http.request", relativeOffsetMs: 10, durationMs: 10, sequence: 3 }),
        ]),
      );

      expect(graph.edges).toEqual([
        { type: "sequential", from: "event-1", to: "event-2", metadata: {} },
        { type: "sequential", from: "event-2", to: "event-3", metadata: {} },
      ]);
    });

    it("includes a metadata slot on every edge", () => {
      const graph = buildExecutionGraph(
        makeRequest([
          makeEntry({ kind: "console.log", relativeOffsetMs: 1, sequence: 1 }),
          makeEntry({ kind: "http.request", relativeOffsetMs: 5, durationMs: 5, sequence: 2 }),
        ]),
      );

      expect(graph.edges[0]?.metadata).toEqual({});
    });
  });

  describe("deterministic ordering", () => {
    it("returns an identical graph for the same request across repeated calls", () => {
      const request = makeRequest([
        makeEntry({ kind: "console.log", relativeOffsetMs: 1, sequence: 1 }),
        makeEntry({ kind: "sql.query", relativeOffsetMs: 5, durationMs: 2, sequence: 2 }),
        makeEntry({ kind: "http.request", relativeOffsetMs: 10, durationMs: 10, sequence: 3 }),
      ]);

      expect(buildExecutionGraph(request)).toEqual(buildExecutionGraph(request));
    });

    it("preserves the timeline's own chronological order rather than reordering by category", () => {
      const graph = buildExecutionGraph(
        makeRequest([
          makeEntry({ kind: "http.request", relativeOffsetMs: 40, durationMs: 40, sequence: 1 }),
          makeEntry({ kind: "console.log", relativeOffsetMs: 5, sequence: 2 }),
          makeEntry({ kind: "sql.query", relativeOffsetMs: 20, durationMs: 10, sequence: 3 }),
        ]),
      );

      // buildExecutionGraph trusts request.timeline's own order (already
      // chronological, per RequestStore) rather than re-sorting — so an
      // out-of-chronological-order input timeline (unrealistic, but not
      // this function's job to fix) is reflected faithfully, not silently
      // corrected.
      expect(graph.nodes.map((n) => n.kind)).toEqual(["http.request", "console.log", "sql.query"]);
    });

    it("does not mutate the input request or its timeline entries", () => {
      const entry = makeEntry({ kind: "sql.query", relativeOffsetMs: 5, durationMs: 2 });
      const request = makeRequest([entry]);
      const before = JSON.parse(JSON.stringify(entry));

      buildExecutionGraph(request);

      expect(JSON.parse(JSON.stringify(entry))).toEqual(before);
    });
  });
});
