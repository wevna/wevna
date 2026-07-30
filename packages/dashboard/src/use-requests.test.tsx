import { act, render } from "@testing-library/react";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { RequestModel } from "./request-store.ts";
import { useRequests } from "./use-requests.ts";

function makeEvent(
  correlationId: string,
  sequence: number,
  kind = "console.log",
): Envelope<CapturedEvent> {
  return {
    version: 1,
    sessionId: "session-1",
    sequence,
    payload: {
      id: `event-${sequence}`,
      kind,
      occurredAt: sequence,
      attributes: {},
      correlation: { id: correlationId },
    },
  };
}

describe("useRequests", () => {
  it("processes events already present on first render", () => {
    const captured: { requests?: readonly RequestModel[] } = {};

    function Wrapper() {
      const [events] = useState(() => [makeEvent("a", 1), makeEvent("a", 2)]);
      const { requests } = useRequests(events);
      captured.requests = requests;
      return null;
    }

    render(<Wrapper />);

    expect(captured.requests).toHaveLength(1);
    expect(captured.requests?.[0]?.events).toHaveLength(2);
  });

  it("processes only newly appended events on each subsequent render, not the whole list again", () => {
    const captured: { requests?: readonly RequestModel[] } = {};
    let setEvents!: (events: Envelope<CapturedEvent>[]) => void;

    function Wrapper() {
      const [events, setEventsState] = useState<Envelope<CapturedEvent>[]>([]);
      setEvents = setEventsState;
      const { requests } = useRequests(events);
      captured.requests = requests;
      return null;
    }

    function eventCount(correlationId: string): number {
      return captured.requests?.find((r) => r.correlationId === correlationId)?.events.length ?? 0;
    }

    render(<Wrapper />);

    act(() => {
      setEvents([makeEvent("a", 1)]);
    });
    expect(eventCount("a")).toBe(1);

    act(() => {
      setEvents([makeEvent("a", 1), makeEvent("a", 2), makeEvent("a", 3)]);
    });
    expect(eventCount("a")).toBe(3);

    act(() => {
      setEvents([makeEvent("a", 1), makeEvent("a", 2), makeEvent("a", 3), makeEvent("b", 4)]);
    });
    expect(captured.requests).toHaveLength(2);
    expect(eventCount("a")).toBe(3);
    expect(eventCount("b")).toBe(1);
  });

  it("clear() empties the assembled requests without affecting the raw events prop", () => {
    const captured: { requests?: readonly RequestModel[]; clear?: () => void } = {};
    let setEvents!: (events: Envelope<CapturedEvent>[]) => void;

    function Wrapper() {
      const [events, setEventsState] = useState<Envelope<CapturedEvent>[]>([]);
      setEvents = setEventsState;
      const { requests, clear } = useRequests(events);
      captured.requests = requests;
      captured.clear = clear;
      return null;
    }

    render(<Wrapper />);
    act(() => {
      setEvents([makeEvent("a", 1)]);
    });
    expect(captured.requests).toHaveLength(1);

    act(() => {
      captured.clear?.();
    });

    expect(captured.requests).toHaveLength(0);
  });
});
