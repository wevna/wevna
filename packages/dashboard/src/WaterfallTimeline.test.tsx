import { render, screen } from "@testing-library/react";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it } from "vitest";
import type { RequestModel } from "./request-store.ts";
import type { TimelineEntry } from "./timeline.ts";
import { WaterfallTimeline } from "./WaterfallTimeline.tsx";

function makeTimelineEntry(overrides: {
  kind?: string;
  relativeOffsetMs: number;
  durationMs?: number;
  sequence?: number;
  attributes?: Record<string, unknown>;
}): TimelineEntry {
  const sequence = overrides.sequence ?? 1;
  const event: Envelope<CapturedEvent> = {
    version: 1,
    sessionId: "session-1",
    sequence,
    payload: {
      id: `event-${sequence}`,
      kind: overrides.kind ?? "console.log",
      occurredAt: overrides.relativeOffsetMs,
      attributes: overrides.attributes ?? {},
    },
  };
  return {
    event,
    kind: overrides.kind ?? "console.log",
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
    route: "/widgets/:id",
    statusCode: 200,
    startedAt: 0,
    endedAt: 22,
    durationMs: 22,
    status: "complete",
    events: [],
    timeline: [],
    ...overrides,
  };
}

describe("WaterfallTimeline", () => {
  it("renders nothing for a request with no timeline entries", () => {
    const { container } = render(<WaterfallTimeline request={makeRequest({ timeline: [] })} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders one row per timeline entry, in order", () => {
    render(
      <WaterfallTimeline
        request={makeRequest({
          timeline: [
            makeTimelineEntry({ kind: "http.request", relativeOffsetMs: 0, sequence: 1 }),
            makeTimelineEntry({ kind: "console.log", relativeOffsetMs: 4, sequence: 2 }),
            makeTimelineEntry({
              kind: "sql.query",
              relativeOffsetMs: 11,
              durationMs: 5,
              sequence: 3,
            }),
          ],
        })}
      />,
    );

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("http.request"),
      expect.stringContaining("console.log"),
      expect.stringContaining("sql.query"),
    ]);
  });

  it("shows each event's kind as a plain visible text label", () => {
    render(
      <WaterfallTimeline
        request={makeRequest({
          timeline: [makeTimelineEntry({ kind: "redis.command", relativeOffsetMs: 5 })],
        })}
      />,
    );

    expect(screen.getByText("redis.command")).toBeInTheDocument();
  });

  it("renders an instantaneous event (no durationMs) as a marker, not a bar", () => {
    render(
      <WaterfallTimeline
        request={makeRequest({
          timeline: [makeTimelineEntry({ relativeOffsetMs: 5 })],
        })}
      />,
    );

    expect(document.querySelector(".waterfall-row__marker")).not.toBeNull();
    expect(document.querySelector(".waterfall-row__bar")).toBeNull();
  });

  it("renders a durational event as a bar, not a marker", () => {
    render(
      <WaterfallTimeline
        request={makeRequest({
          timeline: [makeTimelineEntry({ relativeOffsetMs: 5, durationMs: 3 })],
        })}
      />,
    );

    expect(document.querySelector(".waterfall-row__bar")).not.toBeNull();
    expect(document.querySelector(".waterfall-row__marker")).toBeNull();
  });

  it("positions a bar's left and width via percentage inline styles", () => {
    render(
      <WaterfallTimeline
        request={makeRequest({
          durationMs: 100,
          // Ran from 15ms (offset - duration) to 25ms (offset).
          timeline: [makeTimelineEntry({ relativeOffsetMs: 25, durationMs: 10 })],
        })}
      />,
    );

    const bar = document.querySelector(".waterfall-row__bar") as HTMLElement;
    expect(bar.style.left).toBe("15%");
    expect(bar.style.width).toBe("10%");
  });

  it("shows the numeric offset and duration as visible text, not just via title/aria", () => {
    render(
      <WaterfallTimeline
        request={makeRequest({
          durationMs: 100,
          timeline: [makeTimelineEntry({ relativeOffsetMs: 25, durationMs: 10 })],
        })}
      />,
    );

    expect(screen.getByText("+25ms · 10ms")).toBeInTheDocument();
  });

  it("shows only the offset, with no duration suffix, for an instantaneous event", () => {
    render(
      <WaterfallTimeline
        request={makeRequest({
          durationMs: 100,
          timeline: [makeTimelineEntry({ relativeOffsetMs: 8 })],
        })}
      />,
    );

    expect(screen.getByText("+8ms")).toBeInTheDocument();
  });

  describe("accessibility", () => {
    it("labels the whole timeline with the request's method and route", () => {
      render(
        <WaterfallTimeline
          request={makeRequest({
            method: "POST",
            route: "/orders",
            timeline: [makeTimelineEntry({ relativeOffsetMs: 0 })],
          })}
        />,
      );

      expect(screen.getByRole("list", { name: "Timeline for POST /orders" })).toBeInTheDocument();
    });

    it("gives every bar and marker an accessible name via role=img + aria-label", () => {
      render(
        <WaterfallTimeline
          request={makeRequest({
            durationMs: 100,
            timeline: [
              makeTimelineEntry({ kind: "sql.query", relativeOffsetMs: 10, durationMs: 5 }),
            ],
          })}
        />,
      );

      expect(
        screen.getByRole("img", { name: /sql\.query starting \+10ms for 5ms/ }),
      ).toBeInTheDocument();
    });

    it("does not rely on colour alone: bars and markers are distinguishable by role/shape and always carry a text label", () => {
      render(
        <WaterfallTimeline
          request={makeRequest({
            durationMs: 100,
            timeline: [
              makeTimelineEntry({ kind: "http.request", relativeOffsetMs: 0 }),
              makeTimelineEntry({ kind: "sql.query", relativeOffsetMs: 10, durationMs: 5 }),
            ],
          })}
        />,
      );

      // Distinct DOM/visual shape (marker vs bar), not just a colour swap.
      expect(document.querySelector(".waterfall-row__marker")).not.toBeNull();
      expect(document.querySelector(".waterfall-row__bar")).not.toBeNull();
      // And the kind name is always present as plain text, independent of
      // either the shape or any colour.
      expect(screen.getByText("http.request")).toBeInTheDocument();
      expect(screen.getByText("sql.query")).toBeInTheDocument();
    });
  });

  describe("timeline axis", () => {
    it("renders a timeline axis above the waterfall list", () => {
      render(
        <WaterfallTimeline
          request={makeRequest({
            durationMs: 100,
            timeline: [makeTimelineEntry({ relativeOffsetMs: 0 })],
          })}
        />,
      );

      expect(document.querySelector(".timeline-axis")).not.toBeNull();
    });

    it("renders no axis when there are no timeline entries", () => {
      render(<WaterfallTimeline request={makeRequest({ timeline: [] })} />);

      expect(document.querySelector(".timeline-axis")).toBeNull();
    });
  });

  describe("event kind styling", () => {
    it("tags http/sql/redis bars and markers with a data-kind-category attribute", () => {
      render(
        <WaterfallTimeline
          request={makeRequest({
            durationMs: 100,
            timeline: [
              makeTimelineEntry({ kind: "http.request", relativeOffsetMs: 100, durationMs: 100 }),
              makeTimelineEntry({
                kind: "sql.query",
                relativeOffsetMs: 50,
                durationMs: 5,
                sequence: 2,
              }),
              makeTimelineEntry({
                kind: "redis.command",
                relativeOffsetMs: 60,
                durationMs: 2,
                sequence: 3,
              }),
              makeTimelineEntry({ kind: "console.log", relativeOffsetMs: 10, sequence: 4 }),
            ],
          })}
        />,
      );

      expect(document.querySelector('[data-kind-category="http"]')).not.toBeNull();
      expect(document.querySelector('[data-kind-category="sql"]')).not.toBeNull();
      expect(document.querySelector('[data-kind-category="redis"]')).not.toBeNull();
      expect(document.querySelector('[data-kind-category="other"]')).not.toBeNull();
    });

    it("still shows the kind as visible text alongside its category, never colour alone", () => {
      render(
        <WaterfallTimeline
          request={makeRequest({
            durationMs: 100,
            timeline: [
              makeTimelineEntry({ kind: "sql.query", relativeOffsetMs: 10, durationMs: 5 }),
            ],
          })}
        />,
      );

      const bar = document.querySelector('[data-kind-category="sql"]');
      expect(bar).not.toBeNull();
      expect(screen.getByText("sql.query")).toBeInTheDocument();
    });
  });

  describe("exception events", () => {
    it("renders an exception.captured entry as a marker tagged with the exception category", () => {
      render(
        <WaterfallTimeline
          request={makeRequest({
            durationMs: 100,
            timeline: [
              makeTimelineEntry({
                kind: "exception.captured",
                relativeOffsetMs: 20,
                attributes: { name: "TypeError", message: "boom" },
              }),
            ],
          })}
        />,
      );

      const marker = document.querySelector(".waterfall-row__marker");
      expect(marker).not.toBeNull();
      expect(marker).toHaveAttribute("data-kind-category", "exception");
      expect(document.querySelector(".waterfall-row__bar")).toBeNull();
    });

    it("includes the exception's message in its accessible name, not just the kind", () => {
      render(
        <WaterfallTimeline
          request={makeRequest({
            durationMs: 100,
            timeline: [
              makeTimelineEntry({
                kind: "exception.captured",
                relativeOffsetMs: 20,
                attributes: { name: "TypeError", message: "cannot read property" },
              }),
            ],
          })}
        />,
      );

      expect(
        screen.getByRole("img", { name: /exception\.captured: cannot read property/ }),
      ).toBeInTheDocument();
    });

    it("still shows the kind as visible text, independent of the marker's colour or shape", () => {
      render(
        <WaterfallTimeline
          request={makeRequest({
            durationMs: 100,
            timeline: [
              makeTimelineEntry({
                kind: "exception.captured",
                relativeOffsetMs: 20,
                attributes: { name: "TypeError", message: "boom" },
              }),
            ],
          })}
        />,
      );

      expect(screen.getByText("exception.captured")).toBeInTheDocument();
    });
  });

  describe("updates", () => {
    it("re-renders with the new row when the request's timeline grows", () => {
      const { rerender } = render(
        <WaterfallTimeline
          request={makeRequest({
            timeline: [makeTimelineEntry({ kind: "http.request", relativeOffsetMs: 0 })],
          })}
        />,
      );
      expect(screen.getAllByRole("listitem")).toHaveLength(1);

      rerender(
        <WaterfallTimeline
          request={makeRequest({
            timeline: [
              makeTimelineEntry({ kind: "http.request", relativeOffsetMs: 0, sequence: 1 }),
              makeTimelineEntry({ kind: "console.log", relativeOffsetMs: 4, sequence: 2 }),
            ],
          })}
        />,
      );

      expect(screen.getAllByRole("listitem")).toHaveLength(2);
    });
  });
});
