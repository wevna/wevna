import { render, screen } from "@testing-library/react";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it } from "vitest";
import { PerformanceSection } from "./PerformanceSection.tsx";
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
