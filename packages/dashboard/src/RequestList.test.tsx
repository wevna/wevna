import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RequestList } from "./RequestList.tsx";
import type { RequestModel } from "./request-store.ts";

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

describe("RequestList", () => {
  it("shows a placeholder when there are no requests yet", () => {
    render(<RequestList requests={[]} />);

    expect(screen.getByText(/no requests yet/i)).toBeInTheDocument();
  });

  it("renders method, route, status code, and duration for a complete request", () => {
    render(<RequestList requests={[makeRequest()]} />);

    expect(screen.getByText("GET")).toBeInTheDocument();
    expect(screen.getByText("/widgets/:id")).toBeInTheDocument();
    expect(screen.getByText("200")).toBeInTheDocument();
    expect(screen.getByText("42.0ms")).toBeInTheDocument();
  });

  it("shows placeholders for fields not yet known on a pending request", () => {
    render(
      <RequestList
        requests={[
          makeRequest({
            method: undefined,
            route: undefined,
            statusCode: undefined,
            durationMs: undefined,
            status: "pending",
          }),
        ]}
      />,
    );

    expect(screen.getByText("pending")).toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(3);
    expect(screen.getByText("…")).toBeInTheDocument();
  });

  it("renders one row per request, in the given order", () => {
    render(
      <RequestList
        requests={[
          makeRequest({ id: "a", correlationId: "a", route: "/a" }),
          makeRequest({ id: "b", correlationId: "b", route: "/b" }),
        ]}
      />,
    );

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("/a");
    expect(rows[1]?.textContent).toContain("/b");
  });

  it("shows the event count, singular and plural", () => {
    render(
      <RequestList
        requests={[
          makeRequest({ id: "a", correlationId: "a", events: [{} as never] }),
          makeRequest({ id: "b", correlationId: "b", events: [{} as never, {} as never] }),
        ]}
      />,
    );

    expect(screen.getByText("1 event")).toBeInTheDocument();
    expect(screen.getByText("2 events")).toBeInTheDocument();
  });

  it("does not render a waterfall for a request with an empty timeline", () => {
    render(<RequestList requests={[makeRequest({ timeline: [] })]} />);

    expect(document.querySelector(".waterfall")).toBeNull();
  });

  // WaterfallTimeline.test.tsx covers the waterfall's own rendering
  // (bars, markers, labels, accessibility) in detail — this just confirms
  // RequestList actually delegates to it per request.
  it("renders a waterfall for a request with timeline entries", () => {
    render(
      <RequestList
        requests={[
          makeRequest({
            timeline: [
              {
                event: {
                  version: 1,
                  sessionId: "s",
                  sequence: 1,
                  payload: { id: "e1", kind: "http.request", occurredAt: 0, attributes: {} },
                },
                kind: "http.request",
                sequence: 1,
                timestamp: 0,
                relativeOffsetMs: 0,
                durationMs: undefined,
              },
            ],
          }),
        ]}
      />,
    );

    expect(document.querySelector(".waterfall")).not.toBeNull();
  });
});
