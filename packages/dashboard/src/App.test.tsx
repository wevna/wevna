import { act, fireEvent, render, screen } from "@testing-library/react";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "./App.tsx";

let lastSocket: MockWebSocket | undefined;

class MockWebSocket extends EventTarget {
  readyState = 1;
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
    lastSocket = this;
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  send(): void {}
}

function makeEnvelope(sequence = 1): Envelope<CapturedEvent> {
  return {
    version: 1,
    sessionId: "session-1",
    sequence,
    payload: {
      id: `event-${sequence}`,
      kind: "console.log",
      occurredAt: Date.now(),
      attributes: { message: `message ${sequence}` },
    },
  };
}

describe("App", () => {
  const OriginalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    lastSocket = undefined;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
  });

  it("renders events received over the WebSocket connection", () => {
    render(<App />);

    act(() => {
      lastSocket?.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(makeEnvelope(1)) }),
      );
    });

    expect(screen.getByText("message 1")).toBeInTheDocument();
  });

  it("keeps rendering already-received events after the socket disconnects", () => {
    render(<App />);

    act(() => {
      lastSocket?.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(makeEnvelope(1)) }),
      );
    });

    expect(() => {
      act(() => {
        lastSocket?.close();
      });
    }).not.toThrow();

    expect(screen.getByText("Wevna")).toBeInTheDocument();
    expect(screen.getByText("message 1")).toBeInTheDocument();
  });

  it("shows the clicked event's details in the details panel", () => {
    render(<App />);

    act(() => {
      lastSocket?.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(makeEnvelope(1)) }),
      );
      lastSocket?.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(makeEnvelope(2)) }),
      );
    });

    expect(screen.queryByText("event-2")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("message 2"));

    expect(screen.getByText("event-2")).toBeInTheDocument();
  });

  it("keeps the selected event's details after a new live event arrives", () => {
    render(<App />);

    act(() => {
      lastSocket?.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(makeEnvelope(1)) }),
      );
    });
    fireEvent.click(screen.getByText("message 1"));

    act(() => {
      lastSocket?.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(makeEnvelope(2)) }),
      );
    });

    expect(screen.getByText("event-1")).toBeInTheDocument();
  });
});
