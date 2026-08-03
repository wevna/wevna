import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayEventSource } from "./replay-event-source.ts";

function makeEvent(occurredAt: number, correlationId?: string): Envelope<CapturedEvent> {
  return {
    version: 1,
    sessionId: "session-1",
    sequence: occurredAt,
    payload: {
      id: `event-${occurredAt}`,
      kind: "console.log",
      occurredAt,
      attributes: {},
      correlation: correlationId ? { id: correlationId } : undefined,
    },
  };
}

const EVENTS = [makeEvent(0, "a"), makeEvent(10, "a"), makeEvent(20, "b")];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ReplayEventSource", () => {
  it("starts fully played, with events and requests matching the whole recording", () => {
    const source = new ReplayEventSource();
    source.load(EVENTS);

    const snapshot = source.getSnapshot();
    expect(snapshot.events).toEqual(EVENTS);
    expect(snapshot.requests.map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(snapshot.position).toBe(3);
    expect(snapshot.state).toBe("paused");
  });

  it("seeking updates both the position and the derived events/requests together", () => {
    const source = new ReplayEventSource();
    source.load(EVENTS);

    source.controls.seek(1);

    const snapshot = source.getSnapshot();
    expect(snapshot.position).toBe(1);
    expect(snapshot.events).toEqual([EVENTS[0]]);
    expect(snapshot.requests.map((r) => r.id)).toEqual(["a"]);
  });

  it("a request that has not started yet at the current position is absent", () => {
    const source = new ReplayEventSource();
    source.load(EVENTS);

    source.controls.seek(2);

    expect(source.getSnapshot().requests.map((r) => r.id)).toEqual(["a"]);
  });

  it("playing advances the snapshot's events/requests in step with position", () => {
    const source = new ReplayEventSource();
    source.load(EVENTS);
    source.controls.restart();

    expect(source.getSnapshot().requests).toEqual([]);

    vi.advanceTimersByTime(10);
    expect(source.getSnapshot().requests.map((r) => r.id)).toEqual(["a"]);

    vi.advanceTimersByTime(10);
    expect(
      source
        .getSnapshot()
        .requests.map((r) => r.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("notifies subscribers on every change, including timer-driven ticks", () => {
    const source = new ReplayEventSource();
    source.load(EVENTS);
    source.controls.restart();
    const listener = vi.fn();
    source.subscribe(listener);

    vi.advanceTimersByTime(1000);

    expect(listener).toHaveBeenCalled();
  });

  it("dispose cancels an in-flight playback timer", () => {
    const source = new ReplayEventSource();
    source.load(EVENTS);
    source.controls.restart();
    vi.advanceTimersByTime(5);

    source.dispose();
    vi.advanceTimersByTime(1000);

    // Nothing further should have advanced past whatever had already
    // happened when dispose() was called.
    expect(source.getSnapshot().position).toBe(1);
  });

  it("load() is safe to call before any control has been used", () => {
    const source = new ReplayEventSource();

    expect(() => source.load(EVENTS)).not.toThrow();
    expect(source.getSnapshot().totalEvents).toBe(3);
  });
});
