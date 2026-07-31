import { act, fireEvent, render, screen, within } from "@testing-library/react";
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

function receiveEventWithKind(sequence: number, kind: string): void {
  const envelope = makeEnvelope(sequence);
  envelope.payload.kind = kind;
  act(() => {
    lastSocket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(envelope) }));
  });
}

function receiveEvent(sequence: number): void {
  act(() => {
    lastSocket?.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(makeEnvelope(sequence)) }),
    );
  });
}

function receiveHttpEvent(sequence: number, correlationId: string, durationMs = 5): void {
  const envelope = makeEnvelope(sequence);
  envelope.payload.kind = "http.request";
  envelope.payload.attributes = {
    method: "GET",
    url: "/widgets",
    statusCode: 200,
    durationMs,
  };
  envelope.payload.correlation = { id: correlationId };
  act(() => {
    lastSocket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(envelope) }));
  });
}

function receiveSqlEvent(sequence: number, correlationId: string, durationMs: number): void {
  const envelope = makeEnvelope(sequence);
  envelope.payload.kind = "sql.query";
  envelope.payload.attributes = { query: "SELECT 1", durationMs };
  envelope.payload.correlation = { id: correlationId };
  act(() => {
    lastSocket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(envelope) }));
  });
}

function receiveCorrelatedEvent(sequence: number, correlationId: string): void {
  const envelope = makeEnvelope(sequence);
  envelope.payload.correlation = { id: correlationId };
  act(() => {
    lastSocket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(envelope) }));
  });
}

function receiveExceptionEvent(sequence: number, correlationId: string): void {
  const envelope = makeEnvelope(sequence);
  envelope.payload.kind = "exception.captured";
  envelope.payload.attributes = {
    name: "TypeError",
    message: "cannot read property of undefined",
    stack: "TypeError: cannot read property of undefined\n    at handler (/app/index.js:1:1)",
  };
  envelope.payload.correlation = { id: correlationId };
  act(() => {
    lastSocket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(envelope) }));
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

  it("filters the visible list by free-text query without changing the live count", () => {
    render(<App />);
    receiveEvent(1);
    receiveEvent(2);

    fireEvent.change(screen.getByLabelText("Search events"), { target: { value: "message 1" } });

    expect(screen.getByText("message 1")).toBeInTheDocument();
    expect(screen.queryByText("message 2")).not.toBeInTheDocument();
    expect(screen.getByText("2 events")).toBeInTheDocument();
  });

  it("filters the visible list by kind", () => {
    render(<App />);
    receiveEventWithKind(1, "console.log");
    receiveEventWithKind(2, "http.request");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("Filter by kind"), {
      target: { value: "http.request" },
    });

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("http.request");
  });

  it("reveals every event again once the filter is cleared, proving EventStore was never touched", () => {
    render(<App />);
    receiveEvent(1);
    receiveEvent(2);

    fireEvent.change(screen.getByLabelText("Search events"), { target: { value: "nonexistent" } });
    expect(screen.queryByText("message 1")).not.toBeInTheDocument();
    expect(screen.queryByText("message 2")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search events"), { target: { value: "" } });

    expect(screen.getByText("message 1")).toBeInTheDocument();
    expect(screen.getByText("message 2")).toBeInTheDocument();
  });

  it("assembles correlated events into one request row", () => {
    render(<App />);

    receiveCorrelatedEvent(1, "corr-1");
    receiveHttpEvent(2, "corr-1");

    const requestList = document.querySelector(".request-list");
    expect(requestList).not.toBeNull();
    const requestScope = within(requestList as HTMLElement);
    expect(requestScope.getByText("GET")).toBeInTheDocument();
    expect(requestScope.getByText("/widgets")).toBeInTheDocument();
    expect(requestScope.getByText("200")).toBeInTheDocument();
    expect(requestScope.getByText("2 events")).toBeInTheDocument();
  });

  it("keeps concurrent requests as separate rows", () => {
    render(<App />);

    receiveCorrelatedEvent(1, "corr-a");
    receiveCorrelatedEvent(2, "corr-b");

    // Both the event list and the request list render <li> rows (and each
    // request row can itself contain nested timeline-entry <li>s); filter
    // down to top-level request rows specifically, by exact class.
    const requestRows = screen
      .getAllByRole("listitem")
      .filter((row) => row.classList.contains("request-row"));
    expect(requestRows).toHaveLength(2);
  });

  it("Clear requests empties the request list without touching the event list", () => {
    render(<App />);
    receiveCorrelatedEvent(1, "corr-1");

    fireEvent.click(screen.getByRole("button", { name: "Clear requests" }));

    expect(screen.getByText(/no requests yet/i)).toBeInTheDocument();
    expect(screen.getByText("message 1")).toBeInTheDocument();
  });

  it("keeps assembling requests while the timeline is paused", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    receiveCorrelatedEvent(1, "corr-1");
    receiveHttpEvent(2, "corr-1");

    const requestList = document.querySelector(".request-list");
    expect(requestList).not.toBeNull();
    expect(within(requestList as HTMLElement).getByText("2 events")).toBeInTheDocument();
  });

  describe("Request Inspector", () => {
    it("shows a placeholder in the inspector until a request is selected", () => {
      render(<App />);

      expect(screen.getByText(/select a request to inspect it/i)).toBeInTheDocument();
    });

    it("shows the selected request's summary, timeline, and events in the inspector", () => {
      render(<App />);
      receiveCorrelatedEvent(1, "corr-1");
      receiveHttpEvent(2, "corr-1");

      fireEvent.click(
        within(document.querySelector(".request-list") as HTMLElement).getByText("/widgets"),
      );

      const inspector = document.querySelector(".request-inspector") as HTMLElement;
      expect(inspector).not.toBeNull();
      expect(within(inspector).getByText("corr-1")).toBeInTheDocument();
      expect(within(inspector).getByText("200")).toBeInTheDocument();
      expect(inspector.querySelector(".waterfall")).not.toBeNull();
      // Both events belonging to corr-1 show up in the inspector's own
      // event list.
      expect(inspector.querySelectorAll(".event-row")).toHaveLength(2);
    });

    it("highlights the selected request's row in the request list", () => {
      render(<App />);
      receiveCorrelatedEvent(1, "corr-1");

      fireEvent.click(screen.getByText("message 1"));
      const requestRow = document.querySelector(".request-list")?.querySelector(".request-row");
      fireEvent.click(requestRow?.querySelector(".request-row__button") as HTMLElement);

      expect(requestRow?.classList.contains("request-row--selected")).toBe(true);
    });

    it("keeps the inspector showing the same request after a new event arrives for it", () => {
      render(<App />);
      receiveCorrelatedEvent(1, "corr-1");
      const requestButton = document
        .querySelector(".request-list")
        ?.querySelector(".request-row__button") as HTMLElement;
      fireEvent.click(requestButton);

      receiveHttpEvent(2, "corr-1");

      const inspector = document.querySelector(".request-inspector") as HTMLElement;
      expect(within(inspector).getByText("corr-1")).toBeInTheDocument();
      expect(inspector.querySelectorAll(".event-row")).toHaveLength(2);
    });

    it("keeps selection stable while a different, unselected request updates", () => {
      render(<App />);
      receiveCorrelatedEvent(1, "corr-a");
      receiveCorrelatedEvent(2, "corr-b");
      const requestList = document.querySelector(".request-list") as HTMLElement;
      const firstRow = requestList.querySelectorAll(".request-row")[0];
      fireEvent.click(firstRow?.querySelector(".request-row__button") as HTMLElement);

      receiveHttpEvent(3, "corr-b");

      expect(firstRow?.classList.contains("request-row--selected")).toBe(true);
    });

    it("clears the request selection when Clear requests is clicked", () => {
      render(<App />);
      receiveCorrelatedEvent(1, "corr-1");
      const requestButton = document
        .querySelector(".request-list")
        ?.querySelector(".request-row__button") as HTMLElement;
      fireEvent.click(requestButton);
      expect(screen.queryByText(/select a request to inspect it/i)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Clear requests" }));

      expect(screen.getByText(/select a request to inspect it/i)).toBeInTheDocument();
    });
  });

  describe("Exception capture", () => {
    it("shows a captured exception in the raw event list, tagged with the exception category", () => {
      render(<App />);

      receiveExceptionEvent(1, "corr-1");

      const row = document.querySelector(".event-list")?.querySelector(".event-row");
      expect(row).toHaveAttribute("data-kind-category", "exception");
      expect(screen.getByText("TypeError: cannot read property of undefined")).toBeInTheDocument();
    });

    it("groups a captured exception into its correlated request", () => {
      render(<App />);
      receiveExceptionEvent(1, "corr-1");
      receiveHttpEvent(2, "corr-1");

      const requestList = document.querySelector(".request-list") as HTMLElement;
      expect(within(requestList).getByText("2 events")).toBeInTheDocument();
    });

    it("renders the exception as a diamond marker in the request's waterfall", () => {
      render(<App />);
      receiveExceptionEvent(1, "corr-1");
      receiveHttpEvent(2, "corr-1");
      fireEvent.click(
        document
          .querySelector(".request-list")
          ?.querySelector(".request-row__button") as HTMLElement,
      );

      const inspector = document.querySelector(".request-inspector") as HTMLElement;
      expect(
        inspector.querySelector('.waterfall-row__marker[data-kind-category="exception"]'),
      ).not.toBeNull();
    });

    it("shows the dedicated exception details panel when the exception event is selected from the inspector", () => {
      render(<App />);
      receiveExceptionEvent(1, "corr-1");
      receiveHttpEvent(2, "corr-1");
      fireEvent.click(
        document
          .querySelector(".request-list")
          ?.querySelector(".request-row__button") as HTMLElement,
      );
      const inspectorEventList = document
        .querySelector(".request-inspector")
        ?.querySelector(".event-list") as HTMLElement;

      fireEvent.click(within(inspectorEventList).getByText("exception.captured"));

      expect(document.querySelector(".exception-details")).not.toBeNull();
      expect(screen.getByText("TypeError")).toBeInTheDocument();
      expect(screen.getByText("cannot read property of undefined")).toBeInTheDocument();
    });

    it("shows Time Within Request and Correlation ID for a selected exception", () => {
      render(<App />);
      receiveExceptionEvent(1, "corr-1");
      receiveHttpEvent(2, "corr-1");
      fireEvent.click(
        document
          .querySelector(".request-list")
          ?.querySelector(".request-row__button") as HTMLElement,
      );
      const inspectorEventList = document
        .querySelector(".request-inspector")
        ?.querySelector(".event-list") as HTMLElement;

      fireEvent.click(within(inspectorEventList).getByText("exception.captured"));

      // Scoped to the top-level EventDetails panel specifically —
      // RequestInspector's own summary also has a "Correlation ID" field.
      const eventDetails = document.querySelector(".event-details") as HTMLElement;
      expect(within(eventDetails).getByText("Time Within Request")).toBeInTheDocument();
      expect(within(eventDetails).getByText("Correlation ID")).toBeInTheDocument();
      expect(within(eventDetails).getByText("corr-1")).toBeInTheDocument();
    });

    it("shows the stack trace exactly as captured", () => {
      render(<App />);
      receiveExceptionEvent(1, "corr-1");
      fireEvent.click(screen.getByText("TypeError: cannot read property of undefined"));

      const stack = document.querySelector(".exception-details__stack");
      expect(stack?.textContent).toBe(
        "TypeError: cannot read property of undefined\n    at handler (/app/index.js:1:1)",
      );
    });

    it("does not affect existing dashboard functionality: search, filter, pause, and clear still work", () => {
      render(<App />);
      receiveExceptionEvent(1, "corr-1");
      receiveEvent(2);

      fireEvent.change(screen.getByLabelText("Search events"), { target: { value: "TypeError" } });
      expect(screen.getByText("TypeError: cannot read property of undefined")).toBeInTheDocument();
      expect(screen.queryByText("message 2")).not.toBeInTheDocument();

      fireEvent.change(screen.getByLabelText("Search events"), { target: { value: "" } });
      fireEvent.change(screen.getByLabelText("Filter by kind"), {
        target: { value: "exception.captured" },
      });
      const eventListRows = (document.querySelector(".event-list") as HTMLElement).querySelectorAll(
        ".event-row",
      );
      expect(eventListRows).toHaveLength(1);

      fireEvent.change(screen.getByLabelText("Filter by kind"), { target: { value: "" } });
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      receiveEvent(3);
      expect(screen.queryByText("message 3")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Resume" }));
      expect(screen.getByText("message 3")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
      expect(
        screen.queryByText("TypeError: cannot read property of undefined"),
      ).not.toBeInTheDocument();
    });
  });

  describe("Performance Intelligence", () => {
    it("shows the Performance section with a healthy request's metrics and no insights", () => {
      render(<App />);
      receiveCorrelatedEvent(1, "corr-1");
      receiveHttpEvent(2, "corr-1", 20);
      fireEvent.click(
        document
          .querySelector(".request-list")
          ?.querySelector(".request-row__button") as HTMLElement,
      );

      const inspector = document.querySelector(".request-inspector") as HTMLElement;
      expect(within(inspector).getByText("Performance")).toBeInTheDocument();
      expect(within(inspector).getByText(/no performance issues detected/i)).toBeInTheDocument();
    });

    it("surfaces a Slow Request insight once the request's http.request event arrives", () => {
      render(<App />);
      receiveCorrelatedEvent(1, "corr-1");
      fireEvent.click(
        document
          .querySelector(".request-list")
          ?.querySelector(".request-row__button") as HTMLElement,
      );
      const inspector = document.querySelector(".request-inspector") as HTMLElement;
      expect(within(inspector).queryByText("Slow Request")).not.toBeInTheDocument();

      // Performance analysis updates automatically as the request evolves
      // — no re-selection needed.
      receiveHttpEvent(2, "corr-1", 1500);

      expect(within(inspector).getByText("Slow Request")).toBeInTheDocument();
    });

    it("surfaces a Multiple Database Calls insight for a SQL-heavy request", () => {
      render(<App />);
      receiveCorrelatedEvent(1, "corr-1");
      for (let i = 0; i < 6; i += 1) {
        receiveSqlEvent(2 + i, "corr-1", 5);
      }
      receiveHttpEvent(8, "corr-1", 50);
      fireEvent.click(
        document
          .querySelector(".request-list")
          ?.querySelector(".request-row__button") as HTMLElement,
      );

      const inspector = document.querySelector(".request-inspector") as HTMLElement;
      expect(within(inspector).getByText("Multiple Database Calls")).toBeInTheDocument();
      expect(within(inspector).getByText("6 · 30ms total")).toBeInTheDocument();
    });

    it("keeps existing dashboard functionality intact alongside the Performance section", () => {
      render(<App />);
      receiveCorrelatedEvent(1, "corr-1");
      receiveHttpEvent(2, "corr-1", 1500);
      fireEvent.click(
        document
          .querySelector(".request-list")
          ?.querySelector(".request-row__button") as HTMLElement,
      );

      const inspector = document.querySelector(".request-inspector") as HTMLElement;
      // Waterfall, events, and performance all render side by side.
      expect(inspector.querySelector(".waterfall")).not.toBeNull();
      expect(inspector.querySelector(".event-list")).not.toBeNull();
      expect(inspector.querySelector(".performance-section")).not.toBeNull();

      // Pause/resume and search still work unaffected.
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      receiveEvent(3);
      expect(screen.queryByText("message 3")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Resume" }));
      expect(screen.getByText("message 3")).toBeInTheDocument();
    });
  });
});
