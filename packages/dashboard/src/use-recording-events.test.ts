import { renderHook, waitFor } from "@testing-library/react";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it, vi } from "vitest";
import { useRecordingEvents } from "./use-recording-events.ts";

function makeEnvelope(sequence: number): Envelope<CapturedEvent> {
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

describe("useRecordingEvents", () => {
  it("returns an empty array and does not fetch when disabled", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useRecordingEvents(false));

    expect(result.current).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches and returns every event when enabled", async () => {
    const events = [makeEnvelope(1), makeEnvelope(2), makeEnvelope(3)];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ events }))),
    );

    const { result } = renderHook(() => useRecordingEvents(true));

    await waitFor(() => expect(result.current).toHaveLength(3));
    expect(result.current).toEqual(events);
  });

  it("fetches /api/session/events", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ events: [] })));
    vi.stubGlobal("fetch", fetchSpy);

    renderHook(() => useRecordingEvents(true));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("/api/session/events"));
  });

  it("returns an empty array when the fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network error");
      }),
    );

    const { result } = renderHook(() => useRecordingEvents(true));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current).toEqual([]);
  });

  it("re-fetches when enabled transitions from false to true", async () => {
    const events = [makeEnvelope(1)];
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ events })));
    vi.stubGlobal("fetch", fetchSpy);

    const { result, rerender } = renderHook(({ enabled }) => useRecordingEvents(enabled), {
      initialProps: { enabled: false },
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    rerender({ enabled: true });

    await waitFor(() => expect(result.current).toEqual(events));
  });
});
