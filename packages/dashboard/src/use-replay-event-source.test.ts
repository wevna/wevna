import { act, renderHook } from "@testing-library/react";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReplayEventSource } from "./use-replay-event-source.ts";

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

describe("useReplayEventSource", () => {
  it("returns empty state and does not load anything while disabled", () => {
    const { result } = renderHook(() => useReplayEventSource(EVENTS, false));

    expect(result.current.totalEvents).toBe(0);
    expect(result.current.events).toEqual([]);
  });

  it("loads the given events once enabled, starting fully played", () => {
    const { result } = renderHook(() => useReplayEventSource(EVENTS, true));

    expect(result.current.totalEvents).toBe(3);
    expect(result.current.position).toBe(3);
    expect(result.current.events).toEqual(EVENTS);
    expect(result.current.requests.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("does not reload (and so does not reset position) on an unrelated re-render", () => {
    const { result, rerender } = renderHook(
      ({ events, enabled }) => useReplayEventSource(events, enabled),
      { initialProps: { events: EVENTS, enabled: true } },
    );

    act(() => {
      result.current.controls.seek(1);
    });
    expect(result.current.position).toBe(1);

    rerender({ events: EVENTS, enabled: true });

    expect(result.current.position).toBe(1);
  });

  it("controls.restart and play advance state through React re-renders", () => {
    const { result } = renderHook(() => useReplayEventSource(EVENTS, true));

    act(() => {
      result.current.controls.restart();
    });
    expect(result.current.state).toBe("playing");
    expect(result.current.position).toBe(0);

    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(result.current.position).toBe(2);
    expect(result.current.requests.map((r) => r.id)).toEqual(["a"]);

    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(result.current.position).toBe(3);
    expect(result.current.state).toBe("paused");
  });

  it("controls.seek updates events/requests synchronously", () => {
    const { result } = renderHook(() => useReplayEventSource(EVENTS, true));

    act(() => {
      result.current.controls.seek(2);
    });

    expect(result.current.events).toEqual(EVENTS.slice(0, 2));
    expect(result.current.requests.map((r) => r.id)).toEqual(["a"]);
  });

  it("controls.setSpeed is reflected in state", () => {
    const { result } = renderHook(() => useReplayEventSource(EVENTS, true));

    act(() => {
      result.current.controls.setSpeed(4);
    });

    expect(result.current.speed).toBe(4);
  });

  it("cancels an in-flight playback timer on unmount without throwing", () => {
    const { result, unmount } = renderHook(() => useReplayEventSource(EVENTS, true));

    act(() => {
      result.current.controls.restart();
    });

    expect(() => unmount()).not.toThrow();
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
  });
});
