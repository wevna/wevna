import { describe, expect, it } from "vitest";
import { aggregateEndpointStats } from "./aggregate-endpoint-stats.js";
import type { RequestModel } from "./request-model.js";

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

describe("aggregateEndpointStats", () => {
  it("returns nothing for an empty request list", () => {
    expect(aggregateEndpointStats([])).toEqual([]);
  });

  it("groups requests by method and route", () => {
    const stats = aggregateEndpointStats([
      makeRequest({ id: "1", correlationId: "1", durationMs: 10 }),
      makeRequest({ id: "2", correlationId: "2", durationMs: 20 }),
      makeRequest({ id: "3", correlationId: "3", method: "POST", route: "/orders", durationMs: 5 }),
    ]);

    expect(stats).toHaveLength(2);
    const widgets = stats.find((s) => s.route === "/widgets/:id");
    expect(widgets?.method).toBe("GET");
    expect(widgets?.requestCount).toBe(2);
    expect(widgets?.averageDurationMs).toBe(15);
  });

  it("excludes a request missing a method, route, or measured duration", () => {
    const stats = aggregateEndpointStats([
      makeRequest({ id: "1", correlationId: "1", method: undefined }),
      makeRequest({ id: "2", correlationId: "2", route: undefined }),
      makeRequest({ id: "3", correlationId: "3", durationMs: undefined, status: "pending" }),
    ]);

    expect(stats).toEqual([]);
  });

  it("counts only 5xx responses as errors, not 4xx", () => {
    const stats = aggregateEndpointStats([
      makeRequest({ id: "1", correlationId: "1", statusCode: 500 }),
      makeRequest({ id: "2", correlationId: "2", statusCode: 404 }),
      makeRequest({ id: "3", correlationId: "3", statusCode: 200 }),
    ]);

    expect(stats[0]?.errorCount).toBe(1);
    expect(stats[0]?.requestCount).toBe(3);
  });

  it("computes p95 and the slowest duration using nearest-rank, not interpolation", () => {
    const durations = [10, 20, 30, 40, 100];
    const stats = aggregateEndpointStats(
      durations.map((durationMs, index) =>
        makeRequest({ id: String(index), correlationId: String(index), durationMs }),
      ),
    );

    // 5 samples: ceil(5 * 0.95) - 1 = 4 -> the largest sample itself.
    expect(stats[0]?.p95DurationMs).toBe(100);
    expect(stats[0]?.slowestDurationMs).toBe(100);
  });

  it("ranks endpoints by average duration descending", () => {
    const stats = aggregateEndpointStats([
      makeRequest({
        id: "1",
        correlationId: "1",
        method: "GET",
        route: "/fast",
        durationMs: 5,
      }),
      makeRequest({
        id: "2",
        correlationId: "2",
        method: "GET",
        route: "/slow",
        durationMs: 500,
      }),
    ]);

    expect(stats.map((s) => s.route)).toEqual(["/slow", "/fast"]);
  });

  it("breaks a tie in average duration by route name, for a deterministic order", () => {
    const stats = aggregateEndpointStats([
      makeRequest({ id: "1", correlationId: "1", route: "/b", durationMs: 10 }),
      makeRequest({ id: "2", correlationId: "2", route: "/a", durationMs: 10 }),
    ]);

    expect(stats.map((s) => s.route)).toEqual(["/a", "/b"]);
  });
});
