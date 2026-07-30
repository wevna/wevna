import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
    render(<RequestList requests={[]} selectedRequestId={undefined} onSelectRequest={vi.fn()} />);

    expect(screen.getByText(/no requests yet/i)).toBeInTheDocument();
  });

  it("renders method, route, status code, and duration for a complete request", () => {
    render(
      <RequestList
        requests={[makeRequest()]}
        selectedRequestId={undefined}
        onSelectRequest={vi.fn()}
      />,
    );

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
        selectedRequestId={undefined}
        onSelectRequest={vi.fn()}
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
        selectedRequestId={undefined}
        onSelectRequest={vi.fn()}
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
        selectedRequestId={undefined}
        onSelectRequest={vi.fn()}
      />,
    );

    expect(screen.getByText("1 event")).toBeInTheDocument();
    expect(screen.getByText("2 events")).toBeInTheDocument();
  });

  it("does not render a waterfall — that's RequestInspector's job now", () => {
    render(
      <RequestList
        requests={[makeRequest()]}
        selectedRequestId={undefined}
        onSelectRequest={vi.fn()}
      />,
    );

    expect(document.querySelector(".waterfall")).toBeNull();
  });

  describe("selection", () => {
    it("calls onSelectRequest with the request's id when a row is clicked", () => {
      const onSelectRequest = vi.fn();
      render(
        <RequestList
          requests={[makeRequest({ id: "corr-1", correlationId: "corr-1" })]}
          selectedRequestId={undefined}
          onSelectRequest={onSelectRequest}
        />,
      );

      fireEvent.click(screen.getByText("/widgets/:id"));

      expect(onSelectRequest).toHaveBeenCalledWith("corr-1");
    });

    it("marks the selected request's row distinctly from the rest", () => {
      render(
        <RequestList
          requests={[
            makeRequest({ id: "a", correlationId: "a", route: "/a" }),
            makeRequest({ id: "b", correlationId: "b", route: "/b" }),
          ]}
          selectedRequestId="b"
          onSelectRequest={vi.fn()}
        />,
      );

      const rows = screen.getAllByRole("listitem");
      expect(rows[0]?.classList.contains("request-row--selected")).toBe(false);
      expect(rows[1]?.classList.contains("request-row--selected")).toBe(true);
    });

    it("renders each row as a button, so selection is keyboard-accessible", () => {
      render(
        <RequestList
          requests={[makeRequest()]}
          selectedRequestId={undefined}
          onSelectRequest={vi.fn()}
        />,
      );

      expect(screen.getByRole("button", { name: /GET/ })).toBeInTheDocument();
    });
  });
});
