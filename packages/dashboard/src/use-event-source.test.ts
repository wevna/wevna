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

  it("disconnects the WebSocket once /api/session resolves to recording", async () => {
    mockFetch({ mode: "recording", metadata: { session: { id: "s1" }, eventCount: 0 } });

    renderHook(() => useEventSource());

    await waitFor(() => expect(lastSocket?.closed).toBe(true));
  });

  it("returns recording events (not live events) once in recording mode", async () => {
    const events = [makeEnvelope(1), makeEnvelope(2)];
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
            metadata: { session: { id: "s1" }, eventCount: 2 },
          }),
        );
      }),
    );

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
});
