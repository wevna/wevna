import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it, vi } from "vitest";
import { EventStore } from "./event-store.ts";

function makeEnvelope(sequence = 1): Envelope<CapturedEvent> {
  return {
    version: 1,
    sessionId: "session-1",
    sequence,
    payload: {
      id: `event-${sequence}`,
      kind: "console.log",
      occurredAt: Date.now(),
      attributes: {},
    },
  };
}

describe("EventStore", () => {
  it("starts empty", () => {
    const store = new EventStore();

    expect(store.getEvents()).toEqual([]);
  });

  it("appends events in the order they arrive", () => {
    const store = new EventStore();

    store.append(makeEnvelope(1));
    store.append(makeEnvelope(2));

    expect(store.getEvents().map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("notifies subscribers when a new event is appended", () => {
    const store = new EventStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.append(makeEnvelope(1));

    expect(listener).toHaveBeenCalledOnce();
  });

  it("stops notifying a listener after it unsubscribes", () => {
    const store = new EventStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    unsubscribe();
    store.append(makeEnvelope(1));

    expect(listener).not.toHaveBeenCalled();
  });

  it("preserves correlation metadata on stored events unchanged", () => {
    const store = new EventStore();
    const envelope = makeEnvelope(1);
    envelope.payload.correlation = { id: "correlation-1" };

    store.append(envelope);

    expect(store.getEvents()[0]?.payload.correlation).toEqual({ id: "correlation-1" });
  });

  it("keeps events without correlation metadata working exactly as before", () => {
    const store = new EventStore();

    store.append(makeEnvelope(1));

    expect(store.getEvents()[0]?.payload.correlation).toBeUndefined();
  });
});

// Retention and append cost. Both were genuine production defects: the store
// grew without limit for as long as the dashboard stayed open, and every
// append copied the entire history.
describe("EventStore retention", () => {
  function makeEvent(sequence: number): Envelope<CapturedEvent> {
    return {
      version: 1,
      sessionId: "session-1",
      sequence,
      payload: {
        id: `event-${sequence}`,
        kind: "console.log",
        occurredAt: sequence,
        attributes: {},
      },
    };
  }

  it("keeps every event while under the cap", () => {
    const store = new EventStore(5);

    for (let index = 1; index <= 5; index += 1) {
      store.append(makeEvent(index));
    }

    expect(store.getEvents()).toHaveLength(5);
  });

  it("evicts the oldest events once the cap is exceeded", () => {
    const store = new EventStore(3);

    for (let index = 1; index <= 6; index += 1) {
      store.append(makeEvent(index));
    }

    const events = store.getEvents();
    expect(events).toHaveLength(3);
    // Newest retained, oldest dropped.
    expect(events.map((event) => event.sequence)).toEqual([4, 5, 6]);
  });

  it("never exceeds the cap however many events arrive", () => {
    const store = new EventStore(10);

    for (let index = 1; index <= 500; index += 1) {
      store.append(makeEvent(index));
    }

    expect(store.getEvents()).toHaveLength(10);
  });

  it("treats a nonsensical cap as at least one, rather than dropping everything", () => {
    const store = new EventStore(0);

    store.append(makeEvent(1));

    expect(store.getEvents()).toHaveLength(1);
  });

  it("returns a stable snapshot reference while nothing has changed", () => {
    const store = new EventStore(10);
    store.append(makeEvent(1));

    // useSyncExternalStore compares snapshot identity: a fresh array on every
    // read would re-render the whole list on every unrelated render.
    expect(store.getEvents()).toBe(store.getEvents());
  });

  it("returns a new snapshot reference after an append", () => {
    const store = new EventStore(10);
    store.append(makeEvent(1));
    const before = store.getEvents();

    store.append(makeEvent(2));

    expect(store.getEvents()).not.toBe(before);
  });

  it("does not copy the history on append", () => {
    // The regression this guards: `#events = [...#events, event]` made append
    // O(n), so a session was O(n²) overall. Appending without reading must
    // allocate no snapshot at all — asserted by timing the append-only path
    // against a large store, which would be quadratic under the old code.
    const store = new EventStore(50_000);
    const startedAt = performance.now();
    for (let index = 1; index <= 20_000; index += 1) {
      store.append(makeEvent(index));
    }
    const elapsedMs = performance.now() - startedAt;

    expect(store.getEvents()).toHaveLength(20_000);
    // Generous by design — this is a complexity guard, not a benchmark. The
    // old O(n²) path moved ~200M array slots for this input.
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("keeps the exact same event object references it was given", () => {
    const store = new EventStore(10);
    const event = makeEvent(1);

    store.append(event);

    expect(store.getEvents()[0]).toBe(event);
  });
});
