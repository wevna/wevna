import { render, screen } from "@testing-library/react";
import type { RequestModel, TimelineEntry } from "@wevna/intelligence";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it } from "vitest";
import { ExecutionGraphSection } from "./ExecutionGraphSection.tsx";

function makeTimelineEntry(overrides: {
  kind: string;
  relativeOffsetMs: number;
  durationMs?: number;
  sequence?: number;
}): TimelineEntry {
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
    event,
    kind: overrides.kind,
    sequence,
    timestamp: overrides.relativeOffsetMs,
    relativeOffsetMs: overrides.relativeOffsetMs,
    durationMs: overrides.durationMs,
  };
}

function makeRequest(overrides: Partial<RequestModel> = {}): RequestModel {
  return {
    id: "corr-1",
    correlationId: "corr-1",
    method: "GET",
    route: "/widgets",
    statusCode: 200,
    startedAt: 0,
    endedAt: 40,
    durationMs: 40,
    status: "complete",
    events: [],
    timeline: [],
    ...overrides,
  };
}

describe("ExecutionGraphSection", () => {
  it("shows a placeholder when the request has no events yet", () => {
    render(<ExecutionGraphSection request={makeRequest({ timeline: [] })} />);

    expect(screen.getByText(/no events to graph yet/i)).toBeInTheDocument();
    expect(document.querySelector(".execution-graph")).toBeNull();
  });

  it("renders rows depth-first, root before the operations nested inside it", () => {
    render(
      <ExecutionGraphSection
        request={makeRequest({
          timeline: [
            makeTimelineEntry({ kind: "console.log", relativeOffsetMs: 1, sequence: 1 }),
            makeTimelineEntry({
              kind: "sql.query",
              relativeOffsetMs: 10,
              durationMs: 5,
              sequence: 2,
            }),
            makeTimelineEntry({
              kind: "http.request",
              relativeOffsetMs: 20,
              durationMs: 20,
              sequence: 3,
            }),
          ],
        })}
      />,
    );

    // Chronological order would start at console.log; a tree has to start
    // at the root and descend into it.
    const kinds = Array.from(document.querySelectorAll(".execution-graph__kind")).map(
      (node) => node.textContent,
    );
    expect(kinds).toEqual(["http.request", "console.log", "sql.query"]);
  });

  it("tags each node with its event category", () => {
    render(
      <ExecutionGraphSection
        request={makeRequest({
          timeline: [makeTimelineEntry({ kind: "sql.query", relativeOffsetMs: 5, durationMs: 2 })],
        })}
      />,
    );

    expect(document.querySelector('[data-kind-category="sql"]')).not.toBeNull();
  });

  it("renders no connector for a row at the root level", () => {
    render(
      <ExecutionGraphSection
        request={makeRequest({
          timeline: [
            makeTimelineEntry({ kind: "http.request", relativeOffsetMs: 5, durationMs: 5 }),
          ],
        })}
      />,
    );

    expect(document.querySelectorAll(".execution-graph__connector")).toHaveLength(0);
  });

  it("renders a connector for every nested row", () => {
    render(
      <ExecutionGraphSection
        request={makeRequest({
          timeline: [
            makeTimelineEntry({ kind: "console.log", relativeOffsetMs: 1, sequence: 1 }),
            makeTimelineEntry({
              kind: "sql.query",
              relativeOffsetMs: 5,
              durationMs: 2,
              sequence: 2,
            }),
            makeTimelineEntry({
              kind: "http.request",
              relativeOffsetMs: 10,
              durationMs: 10,
              sequence: 3,
            }),
          ],
        })}
      />,
    );

    expect(document.querySelectorAll(".execution-graph__connector")).toHaveLength(2);
  });

  it("shows every SQL query as its own node for a SQL-heavy request", () => {
    render(
      <ExecutionGraphSection
        request={makeRequest({
          timeline: [
            makeTimelineEntry({
              kind: "sql.query",
              relativeOffsetMs: 5,
              durationMs: 2,
              sequence: 1,
            }),
            makeTimelineEntry({
              kind: "sql.query",
              relativeOffsetMs: 10,
              durationMs: 3,
              sequence: 2,
            }),
            makeTimelineEntry({
              kind: "sql.query",
              relativeOffsetMs: 15,
              durationMs: 1,
              sequence: 3,
            }),
          ],
        })}
      />,
    );

    expect(document.querySelectorAll('[data-kind-category="sql"]')).toHaveLength(3);
  });

  it("includes an exception node for a request with a captured exception", () => {
    render(
      <ExecutionGraphSection
        request={makeRequest({
          timeline: [
            makeTimelineEntry({
              kind: "sql.query",
              relativeOffsetMs: 5,
              durationMs: 2,
              sequence: 1,
            }),
            makeTimelineEntry({ kind: "exception.captured", relativeOffsetMs: 8, sequence: 2 }),
          ],
        })}
      />,
    );

    expect(document.querySelector('[data-kind-category="exception"]')).not.toBeNull();
    expect(screen.getByText("exception.captured")).toBeInTheDocument();
  });

  describe("memoization", () => {
    it("re-renders with updated nodes when the request object changes", () => {
      const { rerender } = render(
        <ExecutionGraphSection
          request={makeRequest({
            timeline: [makeTimelineEntry({ kind: "console.log", relativeOffsetMs: 1 })],
          })}
        />,
      );
      expect(screen.getAllByRole("listitem")).toHaveLength(1);

      rerender(
        <ExecutionGraphSection
          request={makeRequest({
            timeline: [
              makeTimelineEntry({ kind: "console.log", relativeOffsetMs: 1, sequence: 1 }),
              makeTimelineEntry({
                kind: "http.request",
                relativeOffsetMs: 5,
                durationMs: 5,
                sequence: 2,
              }),
            ],
          })}
        />,
      );

      expect(screen.getAllByRole("listitem")).toHaveLength(2);
    });
  });
});

// The renderer proper: nesting, proportional bars, and the accessible tree
// semantics that carry the structure to assistive technology.
describe("ExecutionGraphSection nesting and bars", () => {
  // A row mentions its parent's kind in hidden text ("inside sql.query"), so
  // matching on row text would pick children as well — identify a row by its
  // own kind label instead.
  function rowFor(kind: string): HTMLElement | null | undefined {
    return Array.from(document.querySelectorAll(".execution-graph__kind"))
      .find((label) => label.textContent === kind)
      ?.closest<HTMLElement>(".execution-graph__row");
  }

  function nestedRequest() {
    return makeRequest({
      durationMs: 40,
      timeline: [
        makeTimelineEntry({ kind: "console.log", relativeOffsetMs: 8, sequence: 1 }),
        makeTimelineEntry({ kind: "sql.query", relativeOffsetMs: 12, durationMs: 8, sequence: 2 }),
        makeTimelineEntry({
          kind: "redis.command",
          relativeOffsetMs: 22,
          durationMs: 3,
          sequence: 3,
        }),
        makeTimelineEntry({
          kind: "http.request",
          relativeOffsetMs: 40,
          durationMs: 40,
          sequence: 4,
        }),
      ],
    });
  }

  it("exposes the graph as a labelled list of rows", () => {
    render(<ExecutionGraphSection request={nestedRequest()} />);

    expect(screen.getByRole("list", { name: "Execution graph" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  it("records each row's nesting depth for styling and layout", () => {
    render(<ExecutionGraphSection request={nestedRequest()} />);

    const depths = screen.getAllByRole("listitem").map((row) => row.getAttribute("data-depth"));
    // http.request root, its query, the log nested in that query, then redis.
    expect(depths).toEqual(["0", "1", "2", "1"]);
  });

  it("names the containing operation for screen readers instead of a level number", () => {
    render(<ExecutionGraphSection request={nestedRequest()} />);

    const log = rowFor("console.log");
    const root = rowFor("http.request");

    // "inside sql.query" is what a developer wants to know; "level 3" would
    // leave them counting rows.
    expect(log?.textContent).toContain("inside sql.query");
    expect(root?.textContent).not.toContain("inside");
  });

  it("reads each row as its kind followed by its duration", () => {
    render(<ExecutionGraphSection request={nestedRequest()} />);

    const text = screen.getAllByRole("listitem").map((row) => row.textContent);
    expect(text.some((row) => row?.includes("sql.query") && row.includes("8.0ms"))).toBe(true);
    // A zero-duration event has no duration to report.
    expect(text.some((row) => row?.includes("console.log") && row.includes("—"))).toBe(true);
  });

  it("indents by depth without shifting the proportional track", () => {
    render(<ExecutionGraphSection request={nestedRequest()} />);

    const rows = screen.getAllByRole("listitem");
    // A bar's position means "when it ran"; nesting must not move the track.
    expect(rows.every((row) => row.querySelector(".execution-graph__track") !== null)).toBe(true);
    const deepest = rows.find((row) => row.getAttribute("data-depth") === "2");
    expect(
      deepest?.querySelector<HTMLElement>(".execution-graph__label")?.style.paddingInlineStart,
    ).toBe("1.75rem");
  });

  it("positions a bar by when the operation started, not when it was published", () => {
    render(<ExecutionGraphSection request={nestedRequest()} />);

    const sqlRow = rowFor("sql.query");
    const bar = sqlRow?.querySelector<HTMLElement>(".execution-graph__bar");

    // Published at +12ms after 8ms of work, so +4ms..+12ms of a 40ms request.
    expect(bar?.style.insetInlineStart).toBe("10%");
    expect(bar?.style.inlineSize).toBe("20%");
  });

  it("draws a zero-duration event as a marker rather than a bar", () => {
    render(<ExecutionGraphSection request={nestedRequest()} />);

    const logRow = rowFor("console.log");

    expect(logRow?.querySelector(".execution-graph__marker")).not.toBeNull();
    expect(logRow?.querySelector(".execution-graph__bar")).toBeNull();
  });

  it("shows each row's own duration, and a dash when it has none", () => {
    render(<ExecutionGraphSection request={nestedRequest()} />);

    const durations = Array.from(document.querySelectorAll(".execution-graph__duration")).map(
      (node) => node.textContent,
    );
    expect(durations).toEqual(["40ms", "8.0ms", "—", "3.0ms"]);
  });

  it("distinguishes the last child of a parent for connector shape", () => {
    render(<ExecutionGraphSection request={nestedRequest()} />);

    const redis = rowFor("redis.command");
    const sql = rowFor("sql.query");

    expect(redis?.getAttribute("data-last-child")).toBe("true");
    expect(sql?.getAttribute("data-last-child")).toBeNull();
  });

  it("tags an outgoing HTTP call with its own category, not the request's", () => {
    render(
      <ExecutionGraphSection
        request={makeRequest({
          durationMs: 30,
          timeline: [
            makeTimelineEntry({
              kind: "http.client",
              relativeOffsetMs: 20,
              durationMs: 10,
              sequence: 1,
            }),
            makeTimelineEntry({
              kind: "http.request",
              relativeOffsetMs: 30,
              durationMs: 30,
              sequence: 2,
            }),
          ],
        })}
      />,
    );

    expect(document.querySelector('[data-kind-category="httpClient"]')).not.toBeNull();
    expect(document.querySelector('[data-kind-category="http"]')).not.toBeNull();
  });
});
