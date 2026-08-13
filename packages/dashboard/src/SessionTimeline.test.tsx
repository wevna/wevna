import { fireEvent, render, screen } from "@testing-library/react";
import type { RequestModel } from "@wevna/intelligence";
import { describe, expect, it, vi } from "vitest";
import { SessionTimeline } from "./SessionTimeline.tsx";

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

describe("SessionTimeline", () => {
  it("shows a placeholder when there are no requests yet", () => {
    render(
      <SessionTimeline requests={[]} selectedRequestId={undefined} onSelectRequest={vi.fn()} />,
    );

    expect(screen.getByText(/nothing recorded yet/i)).toBeInTheDocument();
  });

  it("renders one row per request, labelled with method and route", () => {
    render(
      <SessionTimeline
        requests={[
          makeRequest({ id: "a", correlationId: "a", route: "/a" }),
          makeRequest({ id: "b", correlationId: "b", route: "/b" }),
        ]}
        selectedRequestId={undefined}
        onSelectRequest={vi.fn()}
      />,
    );

    expect(screen.getByText("GET /a")).toBeInTheDocument();
    expect(screen.getByText("GET /b")).toBeInTheDocument();
  });

  it("calls onSelectRequest with the request's id when a row is clicked", () => {
    const onSelectRequest = vi.fn();
    render(
      <SessionTimeline
        requests={[makeRequest({ id: "corr-1", correlationId: "corr-1" })]}
        selectedRequestId={undefined}
        onSelectRequest={onSelectRequest}
      />,
    );

    fireEvent.click(screen.getByText("GET /widgets/:id"));

    expect(onSelectRequest).toHaveBeenCalledWith("corr-1");
  });

  it("marks the selected request's row distinctly", () => {
    render(
      <SessionTimeline
        requests={[
          makeRequest({ id: "a", correlationId: "a", route: "/a" }),
          makeRequest({ id: "b", correlationId: "b", route: "/b" }),
        ]}
        selectedRequestId="b"
        onSelectRequest={vi.fn()}
      />,
    );

    const rows = document.querySelectorAll(".session-timeline__row");
    expect(rows[0]).toHaveAttribute("data-selected", "false");
    expect(rows[1]).toHaveAttribute("data-selected", "true");
  });

  it("flags a request with an error status code", () => {
    render(
      <SessionTimeline
        requests={[makeRequest({ statusCode: 500 })]}
        selectedRequestId={undefined}
        onSelectRequest={vi.fn()}
      />,
    );

    expect(document.querySelector(".session-timeline__row")).toHaveAttribute("data-error", "true");
  });

  it("dims requests that don't match the active category filter", () => {
    render(
      <SessionTimeline
        requests={[
          makeRequest({ id: "a", correlationId: "a", route: "/a" }),
          makeRequest({ id: "b", correlationId: "b", statusCode: 500, route: "/b" }),
        ]}
        selectedRequestId={undefined}
        onSelectRequest={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Errors" }));

    const rows = document.querySelectorAll(".session-timeline__row");
    expect(rows[0]).toHaveAttribute("data-dimmed", "true");
    expect(rows[1]).toHaveAttribute("data-dimmed", "false");
  });

  it("shows the duration label only in the expanded variant", () => {
    render(
      <SessionTimeline
        requests={[makeRequest({ durationMs: 12.5 })]}
        selectedRequestId={undefined}
        onSelectRequest={vi.fn()}
        variant="expanded"
      />,
    );

    expect(document.querySelector(".session-timeline__duration")?.textContent).toBe("13ms");
  });
});
