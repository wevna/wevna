import { render, screen } from "@testing-library/react";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it } from "vitest";
import { ExecutionGraphSection } from "./ExecutionGraphSection.tsx";
import type { RequestModel } from "./request-store.ts";
import type { TimelineEntry } from "./timeline.ts";

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

  it("renders one node per event, in order", () => {
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

    const nodes = screen.getAllByRole("listitem");
    expect(nodes.map((n) => n.textContent?.replace("↓", ""))).toEqual([
      "console.log",
      "sql.query",
      "http.request",
    ]);
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

  it("does not render a connector after the last node", () => {
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

  it("renders a connector between every pair of nodes", () => {
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
