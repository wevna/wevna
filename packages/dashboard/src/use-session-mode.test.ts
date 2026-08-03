import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSessionMode } from "./use-session-mode.ts";

function mockFetchOnce(body: unknown, ok = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })),
  );
}

describe("useSessionMode", () => {
  it("starts in the loading state", () => {
    mockFetchOnce({ mode: "live" });

    const { result } = renderHook(() => useSessionMode());

    expect(result.current.mode).toBe("loading");
  });

  it("resolves to live mode with no metadata", async () => {
    mockFetchOnce({ mode: "live" });

    const { result } = renderHook(() => useSessionMode());

    await waitFor(() => expect(result.current.mode).toBe("live"));
    expect(result.current.metadata).toBeUndefined();
  });

  it("resolves to recording mode with the returned metadata", async () => {
    const metadata = {
      session: { id: "session-1", startedAt: 1000, status: "stopped" },
      formatVersion: 1,
      protocolVersion: 1,
      recordingStartedAt: 1000,
      recordingEndedAt: 2000,
      eventCount: 5,
    };
    mockFetchOnce({ mode: "recording", metadata });

    const { result } = renderHook(() => useSessionMode());

    await waitFor(() => expect(result.current.mode).toBe("recording"));
    expect(result.current.metadata).toEqual(metadata);
  });

  it("falls back to live mode when the request fails outright", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network error");
      }),
    );

    const { result } = renderHook(() => useSessionMode());

    await waitFor(() => expect(result.current.mode).toBe("live"));
  });

  it("fetches /api/session", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ mode: "live" })));
    vi.stubGlobal("fetch", fetchSpy);

    renderHook(() => useSessionMode());

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("/api/session"));
  });
});
