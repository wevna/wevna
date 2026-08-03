import { renderHook, waitFor } from "@testing-library/react";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEventSource } from "./use-event-source.ts";

let lastSocket: MockWebSocket | undefined;

class MockWebSocket extends EventTarget {
  readyState = 1;
  url: string;
  closed = false;

  constructor(url: string) {
    super();
    this.url = url;
    lastSocket = this;
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  send(): void {}
}

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

function mockFetch(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body))),
  );
}

describe("useEventSource", () => {
  const OriginalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    lastSocket = undefined;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
  });

  it("connects live immediately, before /api/session resolves (no added latency for the common case)", () => {
    mockFetch({ mode: "live" });

    renderHook(() => useEventSource());

    expect(lastSocket).toBeDefined();
  });

  it("stays on live events (and keeps the connection open) once /api/session resolves to live", async () => {
    mockFetch({ mode: "live" });

    const { result } = renderHook(() => useEventSource());

    await waitFor(() => expect(result.current.sessionMode.mode).toBe("live"));
    expect(lastSocket?.closed).toBe(false);
  });

  function mockRecordingFetch(events: Envelope<CapturedEvent>[]): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/session/events")) {
          return new Response(JSON.stringify({ events }));
        }
        return new Response(
          JSON.stringify({
            mode: "recording",
            metadata: { session: { id: "s1" }, eventCount: events.length },
          }),
        );
      }),
    );
  }

  it("disconnects the WebSocket once /api/session resolves to recording", async () => {
    mockRecordingFetch([]);

    renderHook(() => useEventSource());

    await waitFor(() => expect(lastSocket?.closed).toBe(true));
  });

  it("returns recording events (not live events) once in recording mode", async () => {
    const events = [makeEnvelope(1), makeEnvelope(2)];
    mockRecordingFetch(events);

    const { result } = renderHook(() => useEventSource());

    await waitFor(() => expect(result.current.events).toEqual(events));
    expect(result.current.sessionMode.mode).toBe("recording");
  });

  it("live-published events still reach the store while in live mode", async () => {
    mockFetch({ mode: "live" });

    const { result } = renderHook(() => useEventSource());
    await waitFor(() => expect(lastSocket).toBeDefined());

    lastSocket?.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(makeEnvelope(1)) }),
    );

    await waitFor(() => expect(result.current.events).toHaveLength(1));
  });

  describe("requests / clearRequests / replay", () => {
    it("live mode: has no replay info, and clearRequests is a real, working function", async () => {
      mockFetch({ mode: "live" });
      const { result } = renderHook(() => useEventSource());
      await waitFor(() => expect(result.current.sessionMode.mode).toBe("live"));

      expect(result.current.replay).toBeUndefined();
      expect(typeof result.current.clearRequests).toBe("function");
    });

    it("recording mode: exposes replay info and controls, with no clearRequests", async () => {
      const events = [makeEnvelope(1)];
      mockRecordingFetch(events);

      const { result } = renderHook(() => useEventSource());

      await waitFor(() => expect(result.current.replay).toBeDefined());
      expect(result.current.clearRequests).toBeUndefined();
      expect(result.current.replay?.totalEvents).toBe(1);
      expect(typeof result.current.replay?.controls.play).toBe("function");
    });

    it("recording mode: requests reflect the replay's current position", async () => {
      const events = [
        { ...makeEnvelope(1), payload: { ...makeEnvelope(1).payload, correlation: { id: "a" } } },
      ];
      mockRecordingFetch(events);

      const { result } = renderHook(() => useEventSource());

      await waitFor(() => expect(result.current.requests).toHaveLength(1));
      expect(result.current.requests[0]?.id).toBe("a");
    });
  });
});
