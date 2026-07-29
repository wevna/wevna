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
});
