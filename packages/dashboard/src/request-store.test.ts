import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it, vi } from "vitest";
import { RequestStore } from "./request-store.ts";

let sequenceCounter = 0;

function makeEvent(overrides: {
  correlationId?: string;
  kind?: string;
  occurredAt?: number;
  attributes?: Record<string, unknown>;
  sequence?: number;
  sessionId?: string;
}): Envelope<CapturedEvent> {
  sequenceCounter += 1;
  return {
    version: 1,
    sessionId: overrides.sessionId ?? "session-1",
    sequence: overrides.sequence ?? sequenceCounter,
    payload: {
      id: `event-${sequenceCounter}`,
      kind: overrides.kind ?? "console.log",
      occurredAt: overrides.occurredAt ?? sequenceCounter,
      attributes: overrides.attributes ?? {},
      correlation: overrides.correlationId ? { id: overrides.correlationId } : undefined,
    },
  };
}

function httpEvent(overrides: {
  correlationId: string;
  occurredAt: number;
  method?: string;
  url?: string;
  route?: string;
  statusCode?: number;
  durationMs?: number;
  sequence?: number;
}): Envelope<CapturedEvent> {
  return makeEvent({
    correlationId: overrides.correlationId,
    kind: "http.request",
    occurredAt: overrides.occurredAt,
    sequence: overrides.sequence,
    attributes: {
      method: overrides.method ?? "GET",
      url: overrides.url ?? "/widgets/1",
      ...(overrides.route ? { route: overrides.route } : {}),
      statusCode: overrides.statusCode ?? 200,
      durationMs: overrides.durationMs ?? 42,
    },
  });
}

describe("RequestStore", () => {
  it("starts with no requests", () => {
    const store = new RequestStore();

    expect(store.getRequests()).toEqual([]);
  });

  it("ignores events with no correlation id", () => {
    const store = new RequestStore();

    store.addEvent(makeEvent({}));

    expect(store.getRequests()).toEqual([]);
  });

  describe("single request assembly", () => {
    it("assembles one request from all events sharing a correlation id", () => {
      const store = new RequestStore();
      const c = "corr-1";

      store.addEvent(makeEvent({ correlationId: c, kind: "console.log", occurredAt: 1 }));
      store.addEvent(makeEvent({ correlationId: c, kind: "sql.query", occurredAt: 2 }));
      store.addEvent(httpEvent({ correlationId: c, occurredAt: 3 }));

      const requests = store.getRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.correlationId).toBe(c);
      expect(requests[0]?.events).toHaveLength(3);
    });

    it("exposes id equal to the correlation id", () => {
      const store = new RequestStore();
      store.addEvent(makeEvent({ correlationId: "corr-1" }));

      expect(store.getRequests()[0]?.id).toBe("corr-1");
    });

    it("is retrievable by correlation id via getRequest", () => {
      const store = new RequestStore();
      store.addEvent(makeEvent({ correlationId: "corr-1" }));

      expect(store.getRequest("corr-1")?.correlationId).toBe("corr-1");
      expect(store.getRequest("nonexistent")).toBeUndefined();
    });
  });

  describe("concurrent requests", () => {
    it("keeps interleaved events from two correlations in separate requests", () => {
      const store = new RequestStore();

      store.addEvent(makeEvent({ correlationId: "a", kind: "console.log", occurredAt: 1 }));
      store.addEvent(makeEvent({ correlationId: "b", kind: "console.log", occurredAt: 2 }));
      store.addEvent(makeEvent({ correlationId: "a", kind: "sql.query", occurredAt: 3 }));
      store.addEvent(makeEvent({ correlationId: "b", kind: "sql.query", occurredAt: 4 }));

      const requests = store.getRequests();
      expect(requests).toHaveLength(2);
      const a = store.getRequest("a");
      const b = store.getRequest("b");
      expect(a?.events).toHaveLength(2);
      expect(b?.events).toHaveLength(2);
      expect(a?.events.every((e) => e.payload.correlation?.id === "a")).toBe(true);
      expect(b?.events.every((e) => e.payload.correlation?.id === "b")).toBe(true);
    });

    it("updating one request does not touch another request's model", () => {
      const store = new RequestStore();
      store.addEvent(makeEvent({ correlationId: "a" }));
      store.addEvent(makeEvent({ correlationId: "b" }));
      const bBefore = store.getRequest("b");

      store.addEvent(makeEvent({ correlationId: "a", kind: "sql.query" }));

      expect(store.getRequest("b")).toBe(bBefore);
    });
  });

  describe("events arriving out of order", () => {
    it("orders events chronologically by occurredAt regardless of arrival order", () => {
      const store = new RequestStore();
      const c = "corr-1";

      store.addEvent(makeEvent({ correlationId: c, kind: "third", occurredAt: 30 }));
      store.addEvent(makeEvent({ correlationId: c, kind: "first", occurredAt: 10 }));
      store.addEvent(makeEvent({ correlationId: c, kind: "second", occurredAt: 20 }));

      const kinds = store.getRequest(c)?.events.map((e) => e.payload.kind);
      expect(kinds).toEqual(["first", "second", "third"]);
    });

    it("breaks ties on identical occurredAt using sequence", () => {
      const store = new RequestStore();
      const c = "corr-1";

      store.addEvent(
        makeEvent({ correlationId: c, kind: "later-sequence", occurredAt: 10, sequence: 5 }),
      );
      store.addEvent(
        makeEvent({ correlationId: c, kind: "earlier-sequence", occurredAt: 10, sequence: 2 }),
      );

      const kinds = store.getRequest(c)?.events.map((e) => e.payload.kind);
      expect(kinds).toEqual(["earlier-sequence", "later-sequence"]);
    });

    it("recomputes startedAt correctly when an earlier event arrives after a later one", () => {
      const store = new RequestStore();
      const c = "corr-1";

      store.addEvent(makeEvent({ correlationId: c, occurredAt: 100 }));
      store.addEvent(makeEvent({ correlationId: c, occurredAt: 50 }));

      expect(store.getRequest(c)?.startedAt).toBe(50);
    });
  });

  describe("incremental updates", () => {
    it("fills in method/route/statusCode only once the http.request event arrives", () => {
      const store = new RequestStore();
      const c = "corr-1";

      store.addEvent(makeEvent({ correlationId: c, kind: "console.log", occurredAt: 1 }));
      let request = store.getRequest(c);
      expect(request?.method).toBeUndefined();
      expect(request?.route).toBeUndefined();
      expect(request?.statusCode).toBeUndefined();
      expect(request?.status).toBe("pending");

      store.addEvent(
        httpEvent({ correlationId: c, occurredAt: 2, method: "POST", statusCode: 201 }),
      );
      request = store.getRequest(c);
      expect(request?.method).toBe("POST");
      expect(request?.statusCode).toBe(201);
      expect(request?.status).toBe("complete");
    });

    it("notifies subscribers on every addEvent affecting a request", () => {
      const store = new RequestStore();
      const listener = vi.fn();
      store.subscribe(listener);

      store.addEvent(makeEvent({ correlationId: "corr-1" }));
      store.addEvent(makeEvent({ correlationId: "corr-1" }));

      expect(listener).toHaveBeenCalledTimes(2);
    });

    it("prefers an explicit route over the raw url once both are known", () => {
      const store = new RequestStore();
      const c = "corr-1";

      store.addEvent(
        httpEvent({ correlationId: c, occurredAt: 1, url: "/widgets/42", route: "/widgets/:id" }),
      );

      expect(store.getRequest(c)?.route).toBe("/widgets/:id");
    });

    it("falls back to the raw url when no route was enriched", () => {
      const store = new RequestStore();
      const c = "corr-1";

      store.addEvent(httpEvent({ correlationId: c, occurredAt: 1, url: "/widgets/42" }));

      expect(store.getRequest(c)?.route).toBe("/widgets/42");
    });
  });

  describe("duration calculation", () => {
    it("uses the http.request event's own durationMs attribute when present", () => {
      const store = new RequestStore();
      const c = "corr-1";

      store.addEvent(makeEvent({ correlationId: c, occurredAt: 0 }));
      store.addEvent(httpEvent({ correlationId: c, occurredAt: 1000, durationMs: 12.5 }));

      expect(store.getRequest(c)?.durationMs).toBe(12.5);
    });

    it("falls back to endedAt - startedAt when durationMs is unavailable", () => {
      const store = new RequestStore();
      const c = "corr-1";

      store.addEvent(makeEvent({ correlationId: c, occurredAt: 100 }));
      store.addEvent(
        makeEvent({
          correlationId: c,
          kind: "http.request",
          occurredAt: 175,
          attributes: { method: "GET", url: "/x", statusCode: 200 },
        }),
      );

      expect(store.getRequest(c)?.durationMs).toBe(75);
    });

    it("stays correct even if a still-earlier event arrives after the http.request event", () => {
      const store = new RequestStore();
      const c = "corr-1";

      store.addEvent(makeEvent({ correlationId: c, occurredAt: 100 }));
      store.addEvent(httpEvent({ correlationId: c, occurredAt: 150, durationMs: 50 }));
      store.addEvent(makeEvent({ correlationId: c, occurredAt: 90 }));

      // durationMs comes from the http.request attribute, unaffected by
      // startedAt moving earlier.
      expect(store.getRequest(c)?.durationMs).toBe(50);
      expect(store.getRequest(c)?.startedAt).toBe(90);
    });

    it("has no duration for a request with no http.request event yet", () => {
      const store = new RequestStore();
      store.addEvent(makeEvent({ correlationId: "corr-1" }));

      expect(store.getRequest("corr-1")?.durationMs).toBeUndefined();
      expect(store.getRequest("corr-1")?.endedAt).toBeUndefined();
    });
  });

  describe("incomplete requests", () => {
    it("stays pending indefinitely without an http.request event", () => {
      const store = new RequestStore();
      const c = "corr-1";

      store.addEvent(makeEvent({ correlationId: c, kind: "console.log" }));
      store.addEvent(makeEvent({ correlationId: c, kind: "sql.query" }));

      expect(store.getRequest(c)?.status).toBe("pending");
    });

    it("becomes complete exactly when the http.request event arrives", () => {
      const store = new RequestStore();
      const c = "corr-1";

      store.addEvent(makeEvent({ correlationId: c }));
      expect(store.getRequest(c)?.status).toBe("pending");

      store.addEvent(httpEvent({ correlationId: c, occurredAt: 2 }));
      expect(store.getRequest(c)?.status).toBe("complete");
    });
  });

  describe("clear/reset behaviour", () => {
    it("removes all requests", () => {
      const store = new RequestStore();
      store.addEvent(makeEvent({ correlationId: "a" }));
      store.addEvent(makeEvent({ correlationId: "b" }));

      store.clear();

      expect(store.getRequests()).toEqual([]);
      expect(store.getRequest("a")).toBeUndefined();
    });

    it("notifies subscribers when clearing a non-empty store", () => {
      const store = new RequestStore();
      store.addEvent(makeEvent({ correlationId: "a" }));
      const listener = vi.fn();
      store.subscribe(listener);

      store.clear();

      expect(listener).toHaveBeenCalledOnce();
    });

    it("does not notify subscribers when clearing an already-empty store", () => {
      const store = new RequestStore();
      const listener = vi.fn();
      store.subscribe(listener);

      store.clear();

      expect(listener).not.toHaveBeenCalled();
    });

    it("starts fresh groups for new events after a clear", () => {
      const store = new RequestStore();
      store.addEvent(makeEvent({ correlationId: "a", kind: "console.log" }));
      store.clear();

      store.addEvent(makeEvent({ correlationId: "a", kind: "sql.query" }));

      expect(store.getRequest("a")?.events).toHaveLength(1);
      expect(store.getRequest("a")?.events[0]?.payload.kind).toBe("sql.query");
    });

    it("removeSession removes only requests from that session", () => {
      const store = new RequestStore();
      store.addEvent(makeEvent({ correlationId: "a", sessionId: "session-1" }));
      store.addEvent(makeEvent({ correlationId: "b", sessionId: "session-2" }));

      store.removeSession("session-1");

      expect(store.getRequest("a")).toBeUndefined();
      expect(store.getRequest("b")).toBeDefined();
    });

    it("removeSession is a no-op, without notifying, when no request matches", () => {
      const store = new RequestStore();
      store.addEvent(makeEvent({ correlationId: "a", sessionId: "session-1" }));
      const listener = vi.fn();
      store.subscribe(listener);

      store.removeSession("nonexistent-session");

      expect(listener).not.toHaveBeenCalled();
      expect(store.getRequest("a")).toBeDefined();
    });
  });

  describe("ordering guarantees", () => {
    it("preserves first-seen order of requests across getRequests()", () => {
      const store = new RequestStore();

      store.addEvent(makeEvent({ correlationId: "b" }));
      store.addEvent(makeEvent({ correlationId: "a" }));
      store.addEvent(makeEvent({ correlationId: "b", kind: "sql.query" }));

      expect(store.getRequests().map((r) => r.correlationId)).toEqual(["b", "a"]);
    });

    it("is deterministic across repeated identical event sequences", () => {
      function run(): string[] {
        const store = new RequestStore();
        store.addEvent(makeEvent({ correlationId: "a", occurredAt: 5, sequence: 10 }));
        store.addEvent(makeEvent({ correlationId: "a", occurredAt: 1, sequence: 1 }));
        store.addEvent(makeEvent({ correlationId: "a", occurredAt: 5, sequence: 8 }));
        return (
          store.getRequest("a")?.events.map((e) => `${e.payload.occurredAt}:${e.sequence}`) ?? []
        );
      }

      expect(run()).toEqual(run());
    });
  });

  describe("memory behaviour", () => {
    it("stores the exact same event object references, never copies", () => {
      const store = new RequestStore();
      const event = makeEvent({ correlationId: "a" });

      store.addEvent(event);

      expect(store.getRequest("a")?.events[0]).toBe(event);
    });

    it("returns a stable getRequests() reference when nothing has changed", () => {
      const store = new RequestStore();
      store.addEvent(makeEvent({ correlationId: "a" }));

      const first = store.getRequests();
      const second = store.getRequests();

      expect(first).toBe(second);
    });

    it("returns a new getRequests() reference only after a real change", () => {
      const store = new RequestStore();
      store.addEvent(makeEvent({ correlationId: "a" }));
      const before = store.getRequests();

      store.addEvent(makeEvent({ correlationId: "a" }));

      expect(store.getRequests()).not.toBe(before);
    });

    it("does not recreate other requests' model objects when an unrelated request updates", () => {
      const store = new RequestStore();
      store.addEvent(makeEvent({ correlationId: "a" }));
      store.addEvent(makeEvent({ correlationId: "b" }));
      const aModel = store.getRequest("a");

      store.addEvent(makeEvent({ correlationId: "b", kind: "sql.query" }));

      expect(store.getRequest("a")).toBe(aModel);
    });
  });

  describe("timeline", () => {
    it("reflects each event with a relative offset from the request start", () => {
      const store = new RequestStore();
      const c = "corr-1";

      store.addEvent(httpEvent({ correlationId: c, occurredAt: 100 }));
      store.addEvent(makeEvent({ correlationId: c, kind: "console.log", occurredAt: 103 }));
      store.addEvent(makeEvent({ correlationId: c, kind: "sql.query", occurredAt: 111 }));

      const offsets = store.getRequest(c)?.timeline.map((entry) => entry.relativeOffsetMs);
      expect(offsets).toEqual([0, 3, 11]);
    });

    it("updates incrementally as new events arrive, in the same order as events", () => {
      const store = new RequestStore();
      const c = "corr-1";

      store.addEvent(makeEvent({ correlationId: c, kind: "console.log", occurredAt: 1 }));
      expect(store.getRequest(c)?.timeline).toHaveLength(1);

      store.addEvent(makeEvent({ correlationId: c, kind: "sql.query", occurredAt: 2 }));
      const timeline = store.getRequest(c)?.timeline;
      expect(timeline).toHaveLength(2);
      expect(timeline?.map((entry) => entry.kind)).toEqual(
        store.getRequest(c)?.events.map((e) => e.payload.kind),
      );
    });

    it("exists for a pending request with no http.request event", () => {
      const store = new RequestStore();
      store.addEvent(makeEvent({ correlationId: "corr-1", kind: "console.log" }));

      const timeline = store.getRequest("corr-1")?.timeline;
      expect(timeline).toHaveLength(1);
      expect(timeline?.[0]?.kind).toBe("console.log");
    });

    it("keeps concurrent requests' timelines independent", () => {
      const store = new RequestStore();

      store.addEvent(makeEvent({ correlationId: "a", kind: "console.log", occurredAt: 1 }));
      store.addEvent(makeEvent({ correlationId: "b", kind: "sql.query", occurredAt: 2 }));
      store.addEvent(makeEvent({ correlationId: "a", kind: "redis.command", occurredAt: 3 }));

      expect(store.getRequest("a")?.timeline.map((e) => e.kind)).toEqual([
        "console.log",
        "redis.command",
      ]);
      expect(store.getRequest("b")?.timeline.map((e) => e.kind)).toEqual(["sql.query"]);
    });

    it("references the exact same event objects as request.events", () => {
      const store = new RequestStore();
      const event = makeEvent({ correlationId: "corr-1" });

      store.addEvent(event);

      expect(store.getRequest("corr-1")?.timeline[0]?.event).toBe(event);
    });

    it("is cleared along with everything else on clear()", () => {
      const store = new RequestStore();
      store.addEvent(makeEvent({ correlationId: "corr-1" }));

      store.clear();

      expect(store.getRequest("corr-1")).toBeUndefined();
    });
  });
});

// Capping requests is what makes the event cap real: a RequestModel holds
// references to its own events, so evicting from the event list alone would
// keep every correlated event alive as long as a request still pointed at it.
describe("RequestStore retention", () => {
  it("keeps every request while under the cap", () => {
    const store = new RequestStore(5);

    for (let index = 1; index <= 5; index += 1) {
      store.addEvent(makeEvent({ correlationId: `corr-${index}` }));
    }

    expect(store.getRequests()).toHaveLength(5);
  });

  it("evicts the oldest requests once the cap is exceeded", () => {
    const store = new RequestStore(3);

    for (let index = 1; index <= 6; index += 1) {
      store.addEvent(makeEvent({ correlationId: `corr-${index}` }));
    }

    expect(store.getRequests().map((request) => request.correlationId)).toEqual([
      "corr-4",
      "corr-5",
      "corr-6",
    ]);
    expect(store.getRequest("corr-1")).toBeUndefined();
  });

  it("ages a request by when it started, not when it was last touched", () => {
    const store = new RequestStore(2);
    store.addEvent(makeEvent({ correlationId: "first" }));
    store.addEvent(makeEvent({ correlationId: "second" }));

    // A further event on the oldest request must not renew its lease — a
    // long-lived request would otherwise pin history indefinitely.
    store.addEvent(makeEvent({ correlationId: "first", kind: "sql.query" }));
    store.addEvent(makeEvent({ correlationId: "third" }));

    expect(store.getRequest("first")).toBeUndefined();
    expect(store.getRequest("third")).toBeDefined();
  });

  it("never exceeds the cap however many requests arrive", () => {
    const store = new RequestStore(10);

    for (let index = 1; index <= 500; index += 1) {
      store.addEvent(makeEvent({ correlationId: `corr-${index}` }));
    }

    expect(store.getRequests()).toHaveLength(10);
  });

  it("treats a nonsensical cap as at least one", () => {
    const store = new RequestStore(0);

    store.addEvent(makeEvent({ correlationId: "only" }));

    expect(store.getRequests()).toHaveLength(1);
  });

  it("releases the evicted request's event references", () => {
    const store = new RequestStore(1);
    const first = makeEvent({ correlationId: "first" });
    store.addEvent(first);

    store.addEvent(makeEvent({ correlationId: "second" }));

    // Nothing in the store still points at the evicted request's events,
    // which is the entire reason this cap exists.
    const retained = store.getRequests().flatMap((request) => request.events);
    expect(retained).not.toContain(first);
  });
});
