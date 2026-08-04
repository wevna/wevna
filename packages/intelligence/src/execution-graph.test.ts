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

      // Filtered by type: the graph also carries parent-child edges now,
      // so a bare edges.length would conflate the two relations.
      expect(graph.edges.filter((e) => e.type === "sequential")).toHaveLength(3);
    });

    it("connects each edge to the correct consecutive node ids", () => {
      const graph = buildExecutionGraph(
        makeRequest([
          makeEntry({ kind: "console.log", relativeOffsetMs: 1, sequence: 1 }),
          makeEntry({ kind: "sql.query", relativeOffsetMs: 5, durationMs: 2, sequence: 2 }),
          makeEntry({ kind: "http.request", relativeOffsetMs: 10, durationMs: 10, sequence: 3 }),
        ]),
      );

      expect(graph.edges.filter((e) => e.type === "sequential")).toEqual([
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

// The dependency DAG. Nesting is derived from timing alone via interval
// containment — Wevna observes when operations started and finished, never
// who called whom — so these tests pin exactly what that can and cannot
// claim.
describe("buildExecutionGraph nesting", () => {
  // A realistic request: http.request spans the whole thing and, like every
  // timed producer, is published when it *finishes*, so its offset is the
  // end and its span runs backward by durationMs.
  function request() {
    return makeRequest([
      makeEntry({ kind: "sql.query", relativeOffsetMs: 12, durationMs: 8, sequence: 1 }),
      makeEntry({ kind: "console.log", relativeOffsetMs: 15, sequence: 2 }),
      makeEntry({ kind: "redis.command", relativeOffsetMs: 22, durationMs: 3, sequence: 3 }),
      makeEntry({ kind: "http.request", relativeOffsetMs: 30, durationMs: 30, sequence: 4 }),
    ]);
  }

  it("computes a span that ends at relativeOffsetMs and runs backward by durationMs", () => {
    const graph = buildExecutionGraph(request());
    const sql = graph.nodes.find((node) => node.kind === "sql.query");

    // Published at +12ms having taken 8ms, so it ran from +4ms to +12ms.
    expect(sql?.startedAtMs).toBe(4);
    expect(sql?.relativeOffsetMs).toBe(12);
  });

  it("treats a zero-duration event as a point in time, not as having no span", () => {
    const graph = buildExecutionGraph(request());
    const log = graph.nodes.find((node) => node.kind === "console.log");

    expect(log?.startedAtMs).toBe(15);
  });

  it("makes http.request the single root, since its span covers the request", () => {
    const graph = buildExecutionGraph(request());

    expect(graph.rootIds).toHaveLength(1);
    expect(graph.nodes.find((node) => node.id === graph.rootIds[0])?.kind).toBe("http.request");
  });

  it("nests every operation that ran inside the request under it", () => {
    const graph = buildExecutionGraph(request());
    const http = graph.nodes.find((node) => node.kind === "http.request");

    for (const kind of ["sql.query", "console.log", "redis.command"]) {
      const node = graph.nodes.find((n) => n.kind === kind);
      expect(node?.parentId).toBe(http?.id);
      expect(node?.depth).toBe(1);
    }
    expect(graph.maxDepth).toBe(1);
  });

  it("nests an operation inside another operation's window, not just the request's", () => {
    const graph = buildExecutionGraph(
      makeRequest([
        // A redis lookup that happened while the query was still running.
        makeEntry({ kind: "redis.command", relativeOffsetMs: 10, durationMs: 2, sequence: 1 }),
        makeEntry({ kind: "sql.query", relativeOffsetMs: 12, durationMs: 8, sequence: 2 }),
        makeEntry({ kind: "http.request", relativeOffsetMs: 30, durationMs: 30, sequence: 3 }),
      ]),
    );

    const sql = graph.nodes.find((node) => node.kind === "sql.query");
    const redis = graph.nodes.find((node) => node.kind === "redis.command");

    expect(redis?.parentId).toBe(sql?.id);
    expect(redis?.depth).toBe(2);
    expect(graph.maxDepth).toBe(2);
  });

  it("attaches a console.log to the operation it was logged during", () => {
    const graph = buildExecutionGraph(
      makeRequest([
        makeEntry({ kind: "console.log", relativeOffsetMs: 8, sequence: 1 }),
        makeEntry({ kind: "sql.query", relativeOffsetMs: 12, durationMs: 8, sequence: 2 }),
        makeEntry({ kind: "http.request", relativeOffsetMs: 30, durationMs: 30, sequence: 3 }),
      ]),
    );

    const sql = graph.nodes.find((node) => node.kind === "sql.query");
    // Logged at +8ms, inside the query's +4ms..+12ms window.
    expect(graph.nodes.find((node) => node.kind === "console.log")?.parentId).toBe(sql?.id);
  });

  it("keeps sibling operations flat rather than chaining them", () => {
    const graph = buildExecutionGraph(
      makeRequest([
        makeEntry({ kind: "sql.query", relativeOffsetMs: 5, durationMs: 2, sequence: 1 }),
        makeEntry({ kind: "sql.query", relativeOffsetMs: 9, durationMs: 2, sequence: 2 }),
        makeEntry({ kind: "http.request", relativeOffsetMs: 20, durationMs: 20, sequence: 3 }),
      ]),
    );

    expect(graph.nodes.filter((node) => node.kind === "sql.query").map((n) => n.depth)).toEqual([
      1, 1,
    ]);
  });

  it("treats identical spans as siblings, never nesting one inside the other", () => {
    const graph = buildExecutionGraph(
      makeRequest([
        makeEntry({ kind: "sql.query", relativeOffsetMs: 10, durationMs: 5, sequence: 1 }),
        makeEntry({ kind: "redis.command", relativeOffsetMs: 10, durationMs: 5, sequence: 2 }),
      ]),
    );

    // Mutual containment would otherwise make whichever the sort visited
    // first adopt the other as a child.
    expect(graph.nodes.map((node) => node.depth)).toEqual([0, 0]);
    expect(graph.nodes.map((node) => node.parentId)).toEqual([undefined, undefined]);
    expect(graph.rootIds).toHaveLength(2);
  });

  it("leaves an operation that overlaps without containing as a sibling", () => {
    const graph = buildExecutionGraph(
      makeRequest([
        // 0..10 and 5..15 overlap, but neither contains the other.
        makeEntry({ kind: "sql.query", relativeOffsetMs: 10, durationMs: 10, sequence: 1 }),
        makeEntry({ kind: "redis.command", relativeOffsetMs: 15, durationMs: 10, sequence: 2 }),
      ]),
    );

    expect(graph.nodes.map((node) => node.parentId)).toEqual([undefined, undefined]);
  });

  it("gives every event with no container a root slot, including a pending request", () => {
    // No http.request yet — the request is still in flight, so there is no
    // single container and each operation stands alone.
    const graph = buildExecutionGraph(
      makeRequest([
        makeEntry({ kind: "sql.query", relativeOffsetMs: 5, durationMs: 2, sequence: 1 }),
        makeEntry({ kind: "console.log", relativeOffsetMs: 7, sequence: 2 }),
      ]),
    );

    expect(graph.rootIds).toHaveLength(2);
    expect(graph.maxDepth).toBe(0);
  });
});

describe("buildExecutionGraph edges", () => {
  function nested() {
    return buildExecutionGraph(
      makeRequest([
        makeEntry({ kind: "sql.query", relativeOffsetMs: 12, durationMs: 8, sequence: 1 }),
        makeEntry({ kind: "http.request", relativeOffsetMs: 30, durationMs: 30, sequence: 2 }),
      ]),
    );
  }

  it("keeps the sequential chain intact alongside the nesting", () => {
    const sequential = nested().edges.filter((edge) => edge.type === "sequential");

    // "What happened next" is still a real, independently useful relation.
    expect(sequential).toHaveLength(1);
  });

  it("emits one parent-child edge per nested node, pointing parent to child", () => {
    const graph = nested();
    const parentChild = graph.edges.filter((edge) => edge.type === "parent-child");
    const sql = graph.nodes.find((node) => node.kind === "sql.query");
    const http = graph.nodes.find((node) => node.kind === "http.request");

    expect(parentChild).toHaveLength(1);
    expect(parentChild[0]).toMatchObject({ from: http?.id, to: sql?.id });
  });

  it("emits no parent-child edge for a root", () => {
    const graph = buildExecutionGraph(
      makeRequest([makeEntry({ kind: "console.log", relativeOffsetMs: 1, sequence: 1 })]),
    );

    expect(graph.edges.filter((edge) => edge.type === "parent-child")).toEqual([]);
  });

  it("is deterministic across repeated builds of the same request", () => {
    expect(nested()).toEqual(nested());
  });
});
