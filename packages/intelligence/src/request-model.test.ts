import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it } from "vitest";
import { buildRequestModel, compareEvents } from "./request-model.js";

let sequenceCounter = 0;

function makeEvent(overrides: {
  kind?: string;
  occurredAt?: number;
  attributes?: Record<string, unknown>;
  sequence?: number;
}): Envelope<CapturedEvent> {
  sequenceCounter += 1;
  return {
    version: 1,
    sessionId: "session-1",
    sequence: overrides.sequence ?? sequenceCounter,
    payload: {
      id: `event-${sequenceCounter}`,
      kind: overrides.kind ?? "console.log",
      occurredAt: overrides.occurredAt ?? sequenceCounter,
      attributes: overrides.attributes ?? {},
      correlation: { id: "corr-1" },
    },
  };
}

function httpEvent(overrides: {
  occurredAt: number;
  method?: string;
  url?: string;
  route?: string;
  statusCode?: number;
  durationMs?: number;
}): Envelope<CapturedEvent> {
  return makeEvent({
    kind: "http.request",
    occurredAt: overrides.occurredAt,
    attributes: {
      method: overrides.method ?? "GET",
      url: overrides.url ?? "/widgets/1",
      ...(overrides.route ? { route: overrides.route } : {}),
      statusCode: overrides.statusCode ?? 200,
      ...(overrides.durationMs === undefined ? {} : { durationMs: overrides.durationMs }),
    },
  });
}

// Direct unit coverage of the construction logic this package now owns.
// RequestStore's own suite in @wevna/dashboard exercises the same function
// through the store (incremental arrival, out-of-order events,
// notification); these tests pin the pure input → output contract that
// replay, a CLI, or a regression test would rely on without any store.
describe("buildRequestModel", () => {
  it("uses the correlation id as both id and correlationId", () => {
    const model = buildRequestModel("corr-1", [makeEvent({})]);

    expect(model.id).toBe("corr-1");
    expect(model.correlationId).toBe("corr-1");
  });

  it("takes startedAt from the earliest event, regardless of array position", () => {
    const model = buildRequestModel("corr-1", [
      makeEvent({ occurredAt: 100 }),
      makeEvent({ occurredAt: 50 }),
    ]);

    expect(model.startedAt).toBe(50);
  });

  it("extracts method, route and statusCode from the http.request event", () => {
    const model = buildRequestModel("corr-1", [
      makeEvent({ kind: "console.log", occurredAt: 1 }),
      httpEvent({ occurredAt: 2, method: "POST", route: "/widgets/:id", statusCode: 201 }),
    ]);

    expect(model.method).toBe("POST");
    expect(model.route).toBe("/widgets/:id");
    expect(model.statusCode).toBe(201);
  });

  it("prefers an enriched route over the raw url", () => {
    const model = buildRequestModel("corr-1", [
      httpEvent({ occurredAt: 1, url: "/widgets/42", route: "/widgets/:id" }),
    ]);

    expect(model.route).toBe("/widgets/:id");
  });

  it("falls back to the raw url when no route was enriched", () => {
    const model = buildRequestModel("corr-1", [httpEvent({ occurredAt: 1, url: "/widgets/42" })]);

    expect(model.route).toBe("/widgets/42");
  });

  it("prefers the measured durationMs attribute over recomputing from timestamps", () => {
    const model = buildRequestModel("corr-1", [
      makeEvent({ occurredAt: 0 }),
      httpEvent({ occurredAt: 1000, durationMs: 12.5 }),
    ]);

    expect(model.durationMs).toBe(12.5);
  });

  it("falls back to endedAt - startedAt when no durationMs attribute exists", () => {
    const model = buildRequestModel("corr-1", [
      makeEvent({ occurredAt: 100 }),
      httpEvent({ occurredAt: 175 }),
    ]);

    expect(model.durationMs).toBe(75);
  });

  it("is pending, with no duration or end, until an http.request event exists", () => {
    const model = buildRequestModel("corr-1", [
      makeEvent({ kind: "console.log" }),
      makeEvent({ kind: "sql.query" }),
    ]);

    expect(model.status).toBe("pending");
    expect(model.method).toBeUndefined();
    expect(model.route).toBeUndefined();
    expect(model.statusCode).toBeUndefined();
    expect(model.endedAt).toBeUndefined();
    expect(model.durationMs).toBeUndefined();
  });

  it("is complete as soon as an http.request event is present", () => {
    const model = buildRequestModel("corr-1", [httpEvent({ occurredAt: 1 })]);

    expect(model.status).toBe("complete");
    expect(model.endedAt).toBe(1);
  });

  it("derives a timeline entry per event, offset from startedAt", () => {
    const model = buildRequestModel("corr-1", [
      makeEvent({ kind: "console.log", occurredAt: 100 }),
      makeEvent({ kind: "sql.query", occurredAt: 111 }),
    ]);

    expect(model.timeline.map((entry) => entry.relativeOffsetMs)).toEqual([0, 11]);
    expect(model.timeline.map((entry) => entry.kind)).toEqual(["console.log", "sql.query"]);
  });

  it("references the exact same event objects it was given, never copies", () => {
    const event = makeEvent({});

    const model = buildRequestModel("corr-1", [event]);

    expect(model.events[0]).toBe(event);
    expect(model.timeline[0]?.event).toBe(event);
  });

  it("is deterministic — equal inputs always produce an equal model", () => {
    const events = [makeEvent({ occurredAt: 1 }), httpEvent({ occurredAt: 5, durationMs: 4 })];

    expect(buildRequestModel("corr-1", events)).toEqual(buildRequestModel("corr-1", events));
  });

  // Guards the AnalyzableRequest boundary: analyzers accept the narrow
  // shape, so a RequestModel must keep satisfying it structurally without
  // an adapter (see analyzable-request.ts).
  it("satisfies the AnalyzableRequest shape analyzers consume", () => {
    const model = buildRequestModel("corr-1", [httpEvent({ occurredAt: 1, durationMs: 9 })]);

    expect(model).toMatchObject({ durationMs: 9 });
    expect(model.timeline[0]).toMatchObject({
      kind: "http.request",
      relativeOffsetMs: 0,
      durationMs: 9,
    });
  });
});

describe("compareEvents", () => {
  it("orders by occurredAt ascending", () => {
    const earlier = makeEvent({ occurredAt: 10 });
    const later = makeEvent({ occurredAt: 20 });

    expect(compareEvents(earlier, later)).toBeLessThan(0);
    expect(compareEvents(later, earlier)).toBeGreaterThan(0);
  });

  it("breaks occurredAt ties with the session-monotonic sequence", () => {
    const first = makeEvent({ occurredAt: 10, sequence: 2 });
    const second = makeEvent({ occurredAt: 10, sequence: 5 });

    expect(compareEvents(first, second)).toBeLessThan(0);
    expect(compareEvents(second, first)).toBeGreaterThan(0);
  });

  it("treats an event as equal to itself", () => {
    const event = makeEvent({ occurredAt: 10, sequence: 3 });

    expect(compareEvents(event, event)).toBe(0);
  });

  it("works as an Array.prototype.sort comparator", () => {
    const events = [
      makeEvent({ kind: "third", occurredAt: 30, sequence: 1 }),
      makeEvent({ kind: "first", occurredAt: 10, sequence: 2 }),
      makeEvent({ kind: "second", occurredAt: 10, sequence: 9 }),
    ];

    const sorted = [...events].sort(compareEvents);

    expect(sorted.map((event) => event.payload.kind)).toEqual(["first", "second", "third"]);
  });
});
