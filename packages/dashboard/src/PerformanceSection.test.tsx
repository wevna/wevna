import { render, screen } from "@testing-library/react";
import type { RequestModel, TimelineEntry } from "@wevna/intelligence";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it, vi } from "vitest";
import { PerformanceSection } from "./PerformanceSection.tsx";

function makeTimelineEntry(overrides: {
  kind: string;
  relativeOffsetMs: number;
  durationMs?: number;
  sequence?: number;
  // Repetition detection reads the query text off the event, so a fixture
  // needs to be able to set it.
  attributes?: Record<string, unknown>;
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
      attributes: overrides.attributes ?? {},
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

describe("PerformanceSection", () => {
  it("shows the request's total duration", () => {
    render(<PerformanceSection request={makeRequest({ durationMs: 42.4 })} />);

    expect(screen.getByText("Request Duration")).toBeInTheDocument();
    expect(screen.getByText("42.4ms")).toBeInTheDocument();
  });

  it("shows a placeholder duration for a still-pending request", () => {
    render(<PerformanceSection request={makeRequest({ durationMs: undefined })} />);

    expect(screen.getByText("…")).toBeInTheDocument();
  });

  it("shows the longest operation, excluding the request's own http.request event", () => {
    render(
      <PerformanceSection
        request={makeRequest({
          durationMs: 100,
          timeline: [
            makeTimelineEntry({
              kind: "sql.query",
              relativeOffsetMs: 30,
              durationMs: 20,
              sequence: 1,
            }),
            makeTimelineEntry({
              kind: "redis.command",
              relativeOffsetMs: 60,
              durationMs: 45,
              sequence: 2,
            }),
            makeTimelineEntry({
              kind: "http.request",
              relativeOffsetMs: 100,
              durationMs: 100,
              sequence: 3,
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText("redis.command · 45ms")).toBeInTheDocument();
  });

  it("shows a placeholder when there is no measurable operation yet", () => {
    render(
      <PerformanceSection
        request={makeRequest({
          durationMs: undefined,
          timeline: [makeTimelineEntry({ kind: "console.log", relativeOffsetMs: 1 })],
        })}
      />,
    );

    const dd = screen.getByText("Longest Operation").nextElementSibling;
    expect(dd?.textContent).toBe("—");
  });

  it("shows SQL query count and cumulative time", () => {
    render(
      <PerformanceSection
        request={makeRequest({
          durationMs: 100,
          timeline: [
            makeTimelineEntry({
              kind: "sql.query",
              relativeOffsetMs: 10,
              durationMs: 10,
              sequence: 1,
            }),
            makeTimelineEntry({
              kind: "sql.query",
              relativeOffsetMs: 30,
              durationMs: 15,
              sequence: 2,
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText("2 · 25ms total")).toBeInTheDocument();
  });

  it("shows Redis command count and cumulative time", () => {
    render(
      <PerformanceSection
        request={makeRequest({
          durationMs: 50,
          timeline: [
            makeTimelineEntry({
              kind: "redis.command",
              relativeOffsetMs: 10,
              durationMs: 3,
              sequence: 1,
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText("1 · 3ms total")).toBeInTheDocument();
  });

  it("shows console and exception event counts", () => {
    render(
      <PerformanceSection
        request={makeRequest({
          durationMs: 10,
          timeline: [
            makeTimelineEntry({ kind: "console.log", relativeOffsetMs: 2, sequence: 1 }),
            makeTimelineEntry({ kind: "console.log", relativeOffsetMs: 4, sequence: 2 }),
            makeTimelineEntry({ kind: "exception.captured", relativeOffsetMs: 6, sequence: 3 }),
          ],
        })}
      />,
    );

    const consoleCount = screen.getByText("Console Events").nextElementSibling;
    const exceptionCount = screen.getByText("Exceptions").nextElementSibling;
    expect(consoleCount?.textContent).toBe("2");
    expect(exceptionCount?.textContent).toBe("1");
  });

  describe("insights", () => {
    it("shows a placeholder when there are no insights", () => {
      render(<PerformanceSection request={makeRequest({ durationMs: 5 })} />);

      expect(screen.getByText(/no performance issues detected/i)).toBeInTheDocument();
      expect(document.querySelector(".performance-insight")).toBeNull();
    });

    it("renders a Slow Request insight with its title and message", () => {
      render(<PerformanceSection request={makeRequest({ durationMs: 1500 })} />);

      expect(screen.getByText("Slow Request")).toBeInTheDocument();
      expect(
        screen.getByText("This request took 1500ms, exceeding the 1000ms threshold."),
      ).toBeInTheDocument();
    });

    it("renders an Exception Occurred insight for a request with an exception", () => {
      render(
        <PerformanceSection
          request={makeRequest({
            durationMs: 5,
            timeline: [makeTimelineEntry({ kind: "exception.captured", relativeOffsetMs: 2 })],
          })}
        />,
      );

      expect(screen.getByText("Exception Occurred")).toBeInTheDocument();
    });

    it("renders multiple insights at once for a request with several problems", () => {
      const timeline = Array.from({ length: 6 }, (_, i) =>
        makeTimelineEntry({
          kind: "sql.query",
          relativeOffsetMs: i + 1,
          durationMs: 5,
          sequence: i + 1,
        }),
      );
      render(<PerformanceSection request={makeRequest({ durationMs: 1500, timeline })} />);

      const insights = document.querySelectorAll(".performance-insight");
      expect(insights.length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText("Slow Request")).toBeInTheDocument();
      expect(screen.getByText("Multiple Database Calls")).toBeInTheDocument();
    });
  });

  describe("memoization", () => {
    it("re-renders with updated metrics when the request object changes", () => {
      const { rerender } = render(<PerformanceSection request={makeRequest({ durationMs: 10 })} />);
      expect(screen.getByText("10.0ms")).toBeInTheDocument();

      rerender(<PerformanceSection request={makeRequest({ durationMs: 1200 })} />);

      expect(screen.getByText("1200.0ms")).toBeInTheDocument();
      expect(screen.getByText("Slow Request")).toBeInTheDocument();
    });
  });
});

// The runtime-intelligence additions: repetition detection and time
// attribution, plus the key collision several insights of one type can cause.
describe("PerformanceSection runtime intelligence", () => {
  function sqlEntry(query: string, offset: number, durationMs: number) {
    return makeTimelineEntry({
      kind: "sql.query",
      relativeOffsetMs: offset,
      durationMs,
      sequence: offset,
      attributes: { query },
    });
  }

  it("shows where a request's time went, per category", () => {
    render(
      <PerformanceSection
        request={makeRequest({
          durationMs: 100,
          timeline: [
            makeTimelineEntry({
              kind: "http.request",
              relativeOffsetMs: 100,
              durationMs: 100,
              sequence: 1,
            }),
            sqlEntry("SELECT 1 FROM u", 60, 60),
          ],
        })}
      />,
    );

    expect(document.querySelector(".performance-section__attribution")).not.toBeNull();
    expect(screen.getByText("sql")).toBeInTheDocument();
    expect(screen.getByText("60ms · 60%")).toBeInTheDocument();
  });

  it("excludes the request container from attribution", () => {
    render(
      <PerformanceSection
        request={makeRequest({
          durationMs: 100,
          timeline: [
            makeTimelineEntry({
              kind: "http.request",
              relativeOffsetMs: 100,
              durationMs: 100,
              sequence: 1,
            }),
          ],
        })}
      />,
    );

    // Attributing the request's own duration to "http" would say nothing.
    expect(document.querySelector(".performance-section__attribution")).toBeNull();
  });

  it("calls out a dominant category as an insight", () => {
    render(
      <PerformanceSection
        request={makeRequest({
          durationMs: 100,
          timeline: [
            makeTimelineEntry({
              kind: "http.request",
              relativeOffsetMs: 100,
              durationMs: 100,
              sequence: 1,
            }),
            sqlEntry("SELECT 1 FROM u", 80, 80),
          ],
        })}
      />,
    );

    expect(screen.getByText("Where The Time Went")).toBeInTheDocument();
    expect(
      screen.getByText(/80% of this request \(80ms\) was spent on PostgreSQL/),
    ).toBeInTheDocument();
  });

  it("reports the same query run repeatedly, with its shape and total time", () => {
    render(
      <PerformanceSection
        request={makeRequest({
          durationMs: 100,
          timeline: [
            sqlEntry("SELECT * FROM users WHERE id = 1", 10, 3),
            sqlEntry("SELECT * FROM users WHERE id = 2", 20, 3),
            sqlEntry("SELECT * FROM users WHERE id = 3", 30, 4),
          ],
        })}
      />,
    );

    expect(screen.getByText("Repeated Query")).toBeInTheDocument();
    expect(
      screen.getByText(
        /The same query ran 3 times, taking 10ms in total: select \* from users where id = \?/,
      ),
    ).toBeInTheDocument();
  });

  it("renders several repeated-operation insights without a duplicate React key", () => {
    // key={insight.type} collided once more than one insight of a type could
    // fire; a duplicate key surfaces here as a console error.
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args);
    });

    render(
      <PerformanceSection
        request={makeRequest({
          durationMs: 100,
          timeline: [
            sqlEntry("SELECT a FROM users WHERE id = 1", 10, 1),
            sqlEntry("SELECT a FROM users WHERE id = 2", 12, 1),
            sqlEntry("SELECT a FROM users WHERE id = 3", 14, 1),
            sqlEntry("SELECT b FROM orders WHERE id = 1", 20, 1),
            sqlEntry("SELECT b FROM orders WHERE id = 2", 22, 1),
            sqlEntry("SELECT b FROM orders WHERE id = 3", 24, 1),
          ],
        })}
      />,
    );

    expect(screen.getAllByText("Repeated Query")).toHaveLength(2);
    expect(errors).toEqual([]);
    spy.mockRestore();
  });

  it("does not flag a query that ran only twice", () => {
    render(
      <PerformanceSection
        request={makeRequest({
          durationMs: 100,
          timeline: [sqlEntry("SELECT 1 FROM u", 10, 1), sqlEntry("SELECT 2 FROM u", 20, 1)],
        })}
      />,
    );

    // A pair of identical queries is common and usually deliberate.
    expect(screen.queryByText("Repeated Query")).not.toBeInTheDocument();
  });
});
