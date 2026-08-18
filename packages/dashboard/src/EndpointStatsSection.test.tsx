import { render, screen } from "@testing-library/react";
import type { RequestModel } from "@wevna/intelligence";
import { describe, expect, it } from "vitest";
import { EndpointStatsSection } from "./EndpointStatsSection.tsx";

function makeRequest(overrides: Partial<RequestModel> = {}): RequestModel {
  return {
    id: "corr-1",
    correlationId: "corr-1",
    method: "GET",
    route: "/widgets/:id",
    statusCode: 200,
    startedAt: 0,
    endedAt: 10,
    durationMs: 10,
    status: "complete",
    events: [],
    timeline: [],
    ...overrides,
  };
}

describe("EndpointStatsSection", () => {
  it("shows a placeholder when there are no completed requests", () => {
    render(<EndpointStatsSection requests={[]} />);

    expect(screen.getByText(/no completed requests yet/i)).toBeInTheDocument();
  });

  it("renders one row per distinct method/route, with request count and duration", () => {
    render(
      <EndpointStatsSection
        requests={[
          makeRequest({ id: "1", correlationId: "1", durationMs: 10 }),
          makeRequest({ id: "2", correlationId: "2", durationMs: 20 }),
        ]}
      />,
    );

    expect(screen.getByText("GET")).toBeInTheDocument();
    expect(screen.getByText("/widgets/:id")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("15.0ms")).toBeInTheDocument();
  });

  it("ranks the slowest endpoint first", () => {
    render(
      <EndpointStatsSection
        requests={[
          makeRequest({ id: "1", correlationId: "1", route: "/fast", durationMs: 5 }),
          makeRequest({ id: "2", correlationId: "2", route: "/slow", durationMs: 500 }),
        ]}
      />,
    );

    const routes = screen.getAllByText(/^\/(fast|slow)$/).map((el) => el.textContent);
    expect(routes).toEqual(["/slow", "/fast"]);
  });
});
