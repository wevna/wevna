import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it, vi } from "vitest";
import { EventBus } from "./event-bus.js";

function makeEnvelope(sequence: number): Envelope<CapturedEvent> {
  return {
    version: 1,
    sessionId: "session-1",
    sequence,
    payload: {
      id: `event-${sequence}`,
      kind: "test",
      occurredAt: Date.now(),
      attributes: {},
    },
  };
}

describe("EventBus", () => {
  it("delivers a published event to a subscriber", () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.subscribe(listener);

    const event = makeEnvelope(1);
    bus.publish(event);

    expect(listener).toHaveBeenCalledExactlyOnceWith(event);
  });

  it("delivers events to multiple subscribers", () => {
    const bus = new EventBus();
    const first = vi.fn();
    const second = vi.fn();
    bus.subscribe(first);
    bus.subscribe(second);

    const event = makeEnvelope(1);
    bus.publish(event);

    expect(first).toHaveBeenCalledExactlyOnceWith(event);
    expect(second).toHaveBeenCalledExactlyOnceWith(event);
  });

  it("does not notify listeners after they unsubscribe", () => {
    const bus = new EventBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);

    unsubscribe();
    bus.publish(makeEnvelope(1));

    expect(listener).not.toHaveBeenCalled();
  });

  it("does not throw when publishing with no subscribers", () => {
    const bus = new EventBus();

    expect(() => bus.publish(makeEnvelope(1))).not.toThrow();
  });

  it("only unsubscribes the listener tied to the returned function", () => {
    const bus = new EventBus();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = bus.subscribe(first);
    bus.subscribe(second);

    unsubscribeFirst();
    bus.publish(makeEnvelope(1));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
