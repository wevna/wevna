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

function receiveEvent(sequence: number): void {
  act(() => {
    lastSocket?.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(makeEnvelope(sequence)) }),
    );
  });
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

  it("shows the live event count regardless of pause state", () => {
    render(<App />);

    receiveEvent(1);
    expect(screen.getByText("1 event")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    receiveEvent(2);
    receiveEvent(3);

    expect(screen.getByText("3 events")).toBeInTheDocument();
  });

  it("stops rendering new events while paused, without stopping capture", () => {
    render(<App />);
    receiveEvent(1);

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    receiveEvent(2);

    expect(screen.getByText("message 1")).toBeInTheDocument();
    expect(screen.queryByText("message 2")).not.toBeInTheDocument();
    // The count still reflects the event that arrived while paused.
    expect(screen.getByText("2 events")).toBeInTheDocument();
  });

  it("immediately shows everything accumulated once resumed", () => {
    render(<App />);
    receiveEvent(1);

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    receiveEvent(2);
    receiveEvent(3);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    expect(screen.getByText("message 1")).toBeInTheDocument();
    expect(screen.getByText("message 2")).toBeInTheDocument();
    expect(screen.getByText("message 3")).toBeInTheDocument();
  });

  it("hides existing events on Clear without losing the live count", () => {
    render(<App />);
    receiveEvent(1);
    receiveEvent(2);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(screen.queryByText("message 1")).not.toBeInTheDocument();
    expect(screen.queryByText("message 2")).not.toBeInTheDocument();
    expect(screen.getByText("2 events")).toBeInTheDocument();

    receiveEvent(3);
    expect(screen.getByText("message 3")).toBeInTheDocument();
    expect(screen.getByText("3 events")).toBeInTheDocument();
  });

  it("keeps the selected event's details visible while paused", () => {
    render(<App />);
    receiveEvent(1);
    fireEvent.click(screen.getByText("message 1"));

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    receiveEvent(2);

    expect(screen.getByText("event-1")).toBeInTheDocument();
  });
});
