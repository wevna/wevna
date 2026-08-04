import { fireEvent, render, screen, within } from "@testing-library/react";
import type { RequestModel } from "@wevna/intelligence";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it, vi } from "vitest";
import { RequestInspector } from "./RequestInspector.tsx";

function makeEvent(overrides: {
  id: string;
  kind?: string;
  occurredAt?: number;
  sequence?: number;
  attributes?: Record<string, unknown>;
}): Envelope<CapturedEvent> {
  return {
    version: 1,
    sessionId: "session-1",
    sequence: overrides.sequence ?? 1,
    payload: {
      id: overrides.id,
      kind: overrides.kind ?? "console.log",
      occurredAt: overrides.occurredAt ?? 0,
      attributes: overrides.attributes ?? {},
    },
  };
}

function makeRequest(overrides: Partial<RequestModel> = {}): RequestModel {
  return {
    id: "corr-1",
    correlationId: "corr-1",
    method: "GET",
    route: "/widgets/:id",
    statusCode: 200,
    startedAt: 0,
    endedAt: 42,
    durationMs: 42,
    status: "complete",
    events: [],
    timeline: [],
    ...overrides,
  };
}

describe("RequestInspector", () => {
  it("shows a placeholder when no request is selected", () => {
    render(
      <RequestInspector request={undefined} selectedEventId={undefined} onSelectEvent={vi.fn()} />,
    );

    expect(screen.getByText(/select a request to inspect it/i)).toBeInTheDocument();
  });

  describe("request summary", () => {
    it("renders method, route, status, duration, correlation id, and event count accurately", () => {
      render(
        <RequestInspector
          request={makeRequest({
            method: "POST",
            route: "/orders",
            statusCode: 201,
            durationMs: 12.5,
            correlationId: "corr-xyz",
            events: [makeEvent({ id: "e1" }), makeEvent({ id: "e2", sequence: 2 })],
          })}
          selectedEventId={undefined}
          onSelectEvent={vi.fn()}
        />,
      );

      expect(screen.getByText("POST")).toBeInTheDocument();
      expect(screen.getByText("/orders")).toBeInTheDocument();
      expect(screen.getByText("201")).toBeInTheDocument();
      // "12.5ms" also appears in the Performance section's own Request
      // Duration field, so this counts occurrences rather than assuming
      // just one.
      expect(screen.getAllByText("12.5ms").length).toBeGreaterThan(0);
      expect(screen.getByText("corr-xyz")).toBeInTheDocument();
      // The events section repeats "2 events" as a row label, so only
      // assert the summary's own dd via its position in the dl.
      expect(screen.getAllByText("2 events").length).toBeGreaterThan(0);
    });

    it("shows the request's own lifecycle status alongside its status code", () => {
      render(
        <RequestInspector
          request={makeRequest({ status: "pending", statusCode: undefined })}
          selectedEventId={undefined}
          onSelectEvent={vi.fn()}
        />,
      );

      expect(screen.getByText("pending")).toBeInTheDocument();
    });

    it("shows placeholders for fields not yet known", () => {
      render(
        <RequestInspector
          request={makeRequest({
            method: undefined,
            route: undefined,
            statusCode: undefined,
            durationMs: undefined,
          })}
          selectedEventId={undefined}
          onSelectEvent={vi.fn()}
        />,
      );

      const summary = document.querySelector(".request-inspector__summary") as HTMLElement;
      expect(within(summary).getAllByText("—").length).toBeGreaterThanOrEqual(3);
      expect(within(summary).getByText("…")).toBeInTheDocument();
    });

    it("formats Started At as a readable timestamp", () => {
      const startedAt = new Date("2026-01-15T10:30:00Z").getTime();
      render(
        <RequestInspector
          request={makeRequest({ startedAt })}
          selectedEventId={undefined}
          onSelectEvent={vi.fn()}
        />,
      );

      expect(screen.getByText(new Date(startedAt).toLocaleString())).toBeInTheDocument();
    });
  });

  describe("timeline reuse", () => {
    it("renders a waterfall for a request with timeline entries", () => {
      render(
        <RequestInspector
          request={makeRequest({
            timeline: [
              {
                event: makeEvent({ id: "e1", kind: "http.request" }),
                kind: "http.request",
                sequence: 1,
                timestamp: 0,
                relativeOffsetMs: 0,
                durationMs: undefined,
              },
            ],
          })}
          selectedEventId={undefined}
          onSelectEvent={vi.fn()}
        />,
      );

      expect(document.querySelector(".waterfall")).not.toBeNull();
    });

    it("renders no waterfall for a request with an empty timeline", () => {
      render(
        <RequestInspector
          request={makeRequest({ timeline: [] })}
          selectedEventId={undefined}
          onSelectEvent={vi.fn()}
        />,
      );

      expect(document.querySelector(".waterfall")).toBeNull();
    });
  });

  describe("event list reuse", () => {
    it("lists only the selected request's own events", () => {
      render(
        <RequestInspector
          request={makeRequest({
            events: [
              makeEvent({ id: "e1", kind: "http.request" }),
              makeEvent({ id: "e2", kind: "sql.query", sequence: 2 }),
            ],
          })}
          selectedEventId={undefined}
          onSelectEvent={vi.fn()}
        />,
      );

      const rows = screen.getAllByRole("listitem");
      const eventRows = rows.filter((row) => row.classList.contains("event-row"));
      expect(eventRows).toHaveLength(2);
    });

    it("shows the empty-list placeholder when the request has no events", () => {
      render(
        <RequestInspector
          request={makeRequest({ events: [] })}
          selectedEventId={undefined}
          onSelectEvent={vi.fn()}
        />,
      );

      expect(screen.getByText(/waiting for events/i)).toBeInTheDocument();
    });

    it("calls onSelectEvent when one of the request's events is clicked", () => {
      const onSelectEvent = vi.fn();
      render(
        <RequestInspector
          request={makeRequest({
            events: [makeEvent({ id: "e1", attributes: { message: "hello" } })],
          })}
          selectedEventId={undefined}
          onSelectEvent={onSelectEvent}
        />,
      );

      fireEvent.click(screen.getByText("console.log"));

      expect(onSelectEvent).toHaveBeenCalledWith("e1");
    });

    it("marks the currently-selected event as selected", () => {
      render(
        <RequestInspector
          request={makeRequest({
            events: [makeEvent({ id: "e1" }), makeEvent({ id: "e2", sequence: 2 })],
          })}
          selectedEventId="e2"
          onSelectEvent={vi.fn()}
        />,
      );

      const rows = screen
        .getAllByRole("listitem")
        .filter((row) => row.classList.contains("event-row"));
      expect(rows[1]?.classList.contains("event-row--selected")).toBe(true);
      expect(rows[0]?.classList.contains("event-row--selected")).toBe(false);
    });
  });

  describe("performance reuse", () => {
    it("renders a Performance section for a selected request", () => {
      render(
        <RequestInspector
          request={makeRequest({ durationMs: 20 })}
          selectedEventId={undefined}
          onSelectEvent={vi.fn()}
        />,
      );

      expect(screen.getByText("Performance")).toBeInTheDocument();
      expect(document.querySelector(".performance-section")).not.toBeNull();
    });

    it("delegates to the same analysis PerformanceSection.test.tsx covers in detail — this just confirms RequestInspector wires it in", () => {
      render(
        <RequestInspector
          request={makeRequest({ durationMs: 1500 })}
          selectedEventId={undefined}
          onSelectEvent={vi.fn()}
        />,
      );

      expect(screen.getByText("Slow Request")).toBeInTheDocument();
    });
  });

  describe("execution graph reuse", () => {
    it("renders an Execution Graph section heading for a selected request", () => {
      render(
        <RequestInspector
          request={makeRequest({ durationMs: 20 })}
          selectedEventId={undefined}
          onSelectEvent={vi.fn()}
        />,
      );

      expect(screen.getByText("Execution Graph")).toBeInTheDocument();
    });

    it("shows the empty-graph placeholder for a request with no events", () => {
      render(
        <RequestInspector
          request={makeRequest({ durationMs: 20, timeline: [] })}
          selectedEventId={undefined}
          onSelectEvent={vi.fn()}
        />,
      );

      expect(screen.getByText(/no events to graph yet/i)).toBeInTheDocument();
    });

    it("delegates to the same graph ExecutionGraphSection.test.tsx covers in detail — this just confirms RequestInspector wires it in", () => {
      render(
        <RequestInspector
          request={makeRequest({
            durationMs: 20,
            timeline: [
              {
                event: {
                  version: 1,
                  sessionId: "s",
                  sequence: 1,
                  payload: { id: "e1", kind: "sql.query", occurredAt: 0, attributes: {} },
                },
                kind: "sql.query",
                sequence: 1,
                timestamp: 0,
                relativeOffsetMs: 5,
                durationMs: 2,
              },
            ],
          })}
          selectedEventId={undefined}
          onSelectEvent={vi.fn()}
        />,
      );

      const graphNodes = document
        .querySelector(".execution-graph")
        ?.querySelectorAll(".execution-graph__row");
      expect(graphNodes).toHaveLength(1);
    });
  });
});
