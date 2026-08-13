import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  // The console spies below would otherwise leak into later tests: this
  // config does not set restoreMocks.
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  // Wevna publishes on the call stack of the developer's own code, so a
  // throwing listener must never reach that call site — "Wevna never throws
  // into your code path" is enforced here, at the one point every producer
  // goes through.
  it("does not propagate a listener's error to the publisher", () => {
    const bus = new EventBus();
    vi.spyOn(console, "error").mockImplementation(() => {});
    bus.subscribe(() => {
      throw new Error("listener exploded");
    });

    expect(() => bus.publish(makeEnvelope(1))).not.toThrow();
  });

  // The regression behind the silently-incomplete recording: the recorder
  // subscribes after the WebSocket transport, so a transport that threw on
  // one event stopped the recorder from ever seeing it.
  it("still delivers to later listeners when an earlier one throws", () => {
    const bus = new EventBus();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const recorder = vi.fn();
    bus.subscribe(() => {
      throw new Error("transport exploded");
    });
    bus.subscribe(recorder);

    const event = makeEnvelope(1);
    bus.publish(event);

    expect(recorder).toHaveBeenCalledExactlyOnceWith(event);
  });

  it("reports a throwing listener on console.error", () => {
    const bus = new EventBus();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    bus.subscribe(() => {
      throw new Error("listener exploded");
    });

    bus.publish(makeEnvelope(1));

    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toContain("listener exploded");
  });

  // console.log is patched by ConsoleInstrumentation, so diagnosing a failed
  // publish there would publish an event from inside a publish.
  it("does not report through console.log", () => {
    const bus = new EventBus();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    bus.subscribe(() => {
      throw new Error("listener exploded");
    });

    bus.publish(makeEnvelope(1));

    expect(log).not.toHaveBeenCalled();
  });

  it("keeps delivering later events after a listener throws", () => {
    const bus = new EventBus();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const listener = vi.fn().mockImplementationOnce(() => {
      throw new Error("transient");
    });
    bus.subscribe(listener);

    bus.publish(makeEnvelope(1));
    bus.publish(makeEnvelope(2));

    expect(listener).toHaveBeenCalledTimes(2);
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
