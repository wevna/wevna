import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function dispatch(envelope: Envelope<CapturedEvent>): void {
  act(() => {
    lastSocket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(envelope) }));
  });
}

function buildHttpEnvelope(
  sequence: number,
  correlationId: string,
  durationMs = 5,
): Envelope<CapturedEvent> {
  const envelope = makeEnvelope(sequence);
  envelope.payload.kind = "http.request";
  envelope.payload.attributes = { method: "GET", url: "/widgets", statusCode: 200, durationMs };
  envelope.payload.correlation = { id: correlationId };
  return envelope;
}

function buildSqlEnvelope(
  sequence: number,
  correlationId: string,
  durationMs: number,
): Envelope<CapturedEvent> {
  const envelope = makeEnvelope(sequence);
  envelope.payload.kind = "sql.query";
  envelope.payload.attributes = { query: "SELECT 1", durationMs };
  envelope.payload.correlation = { id: correlationId };
  return envelope;
}

function buildRedisEnvelope(
  sequence: number,
  correlationId: string,
  durationMs: number,
): Envelope<CapturedEvent> {
  const envelope = makeEnvelope(sequence);
  envelope.payload.kind = "redis.command";
  envelope.payload.attributes = { command: "GET", durationMs };
  envelope.payload.correlation = { id: correlationId };
  return envelope;
}

function buildCorrelatedEnvelope(sequence: number, correlationId: string): Envelope<CapturedEvent> {
  const envelope = makeEnvelope(sequence);
  envelope.payload.correlation = { id: correlationId };
  return envelope;
}

function buildExceptionEnvelope(sequence: number, correlationId: string): Envelope<CapturedEvent> {
  const envelope = makeEnvelope(sequence);
  envelope.payload.kind = "exception.captured";
  envelope.payload.attributes = {
    name: "TypeError",
    message: "cannot read property of undefined",
    stack: "TypeError: cannot read property of undefined\n    at handler (/app/index.js:1:1)",
  };
  envelope.payload.correlation = { id: correlationId };
  return envelope;
}

function receiveEventWithKind(sequence: number, kind: string): void {
  const envelope = makeEnvelope(sequence);
  envelope.payload.kind = kind;
  dispatch(envelope);
}

function receiveEvent(sequence: number): void {
  dispatch(makeEnvelope(sequence));
}

function receiveHttpEvent(sequence: number, correlationId: string, durationMs = 5): void {
  dispatch(buildHttpEnvelope(sequence, correlationId, durationMs));
}

function receiveSqlEvent(sequence: number, correlationId: string, durationMs: number): void {
  dispatch(buildSqlEnvelope(sequence, correlationId, durationMs));
}

function receiveCorrelatedEvent(sequence: number, correlationId: string): void {
  dispatch(buildCorrelatedEnvelope(sequence, correlationId));
}

function receiveExceptionEvent(sequence: number, correlationId: string): void {
  dispatch(buildExceptionEnvelope(sequence, correlationId));
}

// Mocks fetch to serve a "recording" mode /api/session and the given
// events from /api/session/events, matching @wevna/server's real
// contract closely enough for App-level integration tests.
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
          metadata: {
            session: { id: "recorded-session", startedAt: 1700000000000, status: "stopped" },
            formatVersion: 1,
            protocolVersion: 1,
            recordingStartedAt: 1700000000000,
            recordingEndedAt: 1700000005000,
            eventCount: events.length,
          },
        }),
      );
    }),
  );
}

// The execution graph renders nested rows with a duration column and hidden
// parent references, so its content is read from the kind labels themselves
// rather than from whole-row text.
function graphKinds(): (string | null)[] {
  return Array.from(document.querySelectorAll(".execution-graph__kind")).map(
    (label) => label.textContent,
  );
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
      // Scoped to the summary dl — "corr-1" also shows up in the
      // Attributes tab's own EventDetails view (always mounted, see
      // RequestInspector.tsx), so it's no longer unique across the whole
      // inspector.
      const summary = inspector.querySelector(".request-inspector__summary") as HTMLElement;
      expect(within(summary).getByText("corr-1")).toBeInTheDocument();
      expect(within(summary).getByText("200")).toBeInTheDocument();
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
      const summary = inspector.querySelector(".request-inspector__summary") as HTMLElement;
      expect(within(summary).getByText("corr-1")).toBeInTheDocument();
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

      // Scoped to the inspector — the same event's ExceptionDetails also
      // renders in the top-level EventDetails panel (always mounted, see
      // App.tsx), so this content is no longer unique across the page.
      const inspector = document.querySelector(".request-inspector") as HTMLElement;
      expect(inspector.querySelector(".exception-details")).not.toBeNull();
      expect(within(inspector).getByText("TypeError")).toBeInTheDocument();
      expect(within(inspector).getByText("cannot read property of undefined")).toBeInTheDocument();
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

  describe("Execution Graph", () => {
    it("shows the Execution Graph section with one node per event, in order", () => {
      render(<App />);
      receiveCorrelatedEvent(1, "corr-1");
      receiveSqlEvent(2, "corr-1", 5);
      receiveHttpEvent(3, "corr-1", 20);
      fireEvent.click(
        document
          .querySelector(".request-list")
          ?.querySelector(".request-row__button") as HTMLElement,
      );

      expect(document.querySelector(".execution-graph")).not.toBeNull();
      // Asserted as a set, not a sequence. This fixture's offsets come from
      // real elapsed time, so whether the console.log falls inside
      // http.request's measured span — and therefore where depth-first
      // ordering puts it — varies between runs. Exact nesting is pinned in
      // ExecutionGraphSection.test.tsx against fixed offsets; what matters
      // here is that the graph is wired in and renders every event once.
      expect(graphKinds().sort()).toEqual(["console.log", "http.request", "sql.query"]);
    });

    it("updates the graph automatically as new events arrive for the selected request", () => {
      render(<App />);
      receiveCorrelatedEvent(1, "corr-1");
      fireEvent.click(
        document
          .querySelector(".request-list")
          ?.querySelector(".request-row__button") as HTMLElement,
      );
      expect(document.querySelector(".request-inspector")).not.toBeNull();
      expect(document.querySelectorAll(".execution-graph__row")).toHaveLength(1);

      receiveHttpEvent(2, "corr-1", 10);

      expect(document.querySelectorAll(".execution-graph__row")).toHaveLength(2);
    });

    it("includes an exception node for a request that captured one", () => {
      render(<App />);
      receiveCorrelatedEvent(1, "corr-1");
      receiveExceptionEvent(2, "corr-1");
      receiveHttpEvent(3, "corr-1", 10);
      fireEvent.click(
        document
          .querySelector(".request-list")
          ?.querySelector(".request-row__button") as HTMLElement,
      );

      expect(
        document.querySelector('.execution-graph__row[data-kind-category="exception"]'),
      ).not.toBeNull();
    });

    it("keeps existing dashboard functionality intact alongside the Execution Graph", () => {
      render(<App />);
      receiveCorrelatedEvent(1, "corr-1");
      receiveHttpEvent(2, "corr-1", 10);
      fireEvent.click(
        document
          .querySelector(".request-list")
          ?.querySelector(".request-row__button") as HTMLElement,
      );

      const inspector = document.querySelector(".request-inspector") as HTMLElement;
      expect(inspector.querySelector(".waterfall")).not.toBeNull();
      expect(inspector.querySelector(".performance-section")).not.toBeNull();
      expect(inspector.querySelector(".execution-graph")).not.toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      receiveEvent(3);
      expect(screen.queryByText("message 3")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Resume" }));
      expect(screen.getByText("message 3")).toBeInTheDocument();
    });
  });
});

// These tests source events from a mocked /api/session + /api/session/events
// (see use-event-source.ts) instead of dispatching over a WebSocket, proving
// the dashboard's existing features work unchanged when viewing a recording
// rather than a live runtime — the acceptance criterion at the heart of the
// Session Loader PR. WebSocket is still mocked here (App itself always
// starts connecting live, before /api/session resolves — see
// use-event-source.test.ts) purely so it doesn't attempt a real connection;
// what matters is that it ends up closed once recording mode is confirmed.
describe("Offline session viewing", () => {
  const OriginalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    lastSocket = undefined;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
    vi.unstubAllGlobals();
  });

  it("closes the live WebSocket connection once recording mode is confirmed", async () => {
    mockRecordingFetch([]);
    render(<App />);

    await waitFor(() => expect(lastSocket?.readyState).toBe(3));
  });

  it("shows the recording banner with the session's start time and event count", async () => {
    const events = [buildCorrelatedEnvelope(1, "corr-1")];
    mockRecordingFetch(events);

    render(<App />);

    const banner = await screen.findByText(/viewing a recorded session/i);
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/1 events/);
  });

  // Request assembly runs in a useEffect one tick after the events arrive
  // (see use-requests.ts), so waiting for the first event's text on screen
  // isn't quite enough to guarantee the request row already exists too.
  async function selectFirstRequest(): Promise<void> {
    await waitFor(() => {
      expect(document.querySelector(".request-list .request-row__button")).not.toBeNull();
    });
    fireEvent.click(document.querySelector(".request-list .request-row__button") as HTMLElement);
  }

  it("renders events fetched from the recording, and search/filter work against them", async () => {
    const events = [buildCorrelatedEnvelope(1, "corr-1"), buildHttpEnvelope(2, "corr-1")];
    mockRecordingFetch(events);

    render(<App />);

    expect(await screen.findByText("message 1")).toBeInTheDocument();
    const eventList = document.querySelector(".event-list") as HTMLElement;
    expect(within(eventList).getByText("http.request")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search events"), { target: { value: "message 1" } });
    expect(screen.getByText("message 1")).toBeInTheDocument();
    expect(within(eventList).queryByText("http.request")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search events"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Filter by kind"), {
      target: { value: "http.request" },
    });
    expect(screen.queryByText("message 1")).not.toBeInTheDocument();
    expect(within(eventList).getByText("http.request")).toBeInTheDocument();
  });

  it("assembles a request row from correlated recorded events and supports selection", async () => {
    const events = [buildCorrelatedEnvelope(1, "corr-1"), buildHttpEnvelope(2, "corr-1")];
    mockRecordingFetch(events);

    render(<App />);
    await screen.findByText("message 1");

    const requestList = document.querySelector(".request-list") as HTMLElement;
    await waitFor(() => expect(within(requestList).getByText("/widgets")).toBeInTheDocument());
    expect(within(requestList).getByText("2 events")).toBeInTheDocument();

    await selectFirstRequest();

    const inspector = document.querySelector(".request-inspector") as HTMLElement;
    const summary = inspector.querySelector(".request-inspector__summary") as HTMLElement;
    expect(within(summary).getByText("corr-1")).toBeInTheDocument();
    expect(inspector.querySelector(".waterfall")).not.toBeNull();
    expect(inspector.querySelectorAll(".event-row")).toHaveLength(2);
  });

  it("shows exception details for a recorded exception event", async () => {
    const events = [
      buildCorrelatedEnvelope(1, "corr-1"),
      buildExceptionEnvelope(2, "corr-1"),
      buildHttpEnvelope(3, "corr-1"),
    ];
    mockRecordingFetch(events);

    render(<App />);
    await screen.findByText("message 1");
    await selectFirstRequest();

    const inspectorEventList = document.querySelector(
      ".request-inspector .event-list",
    ) as HTMLElement;
    fireEvent.click(within(inspectorEventList).getByText("exception.captured"));

    const eventDetails = document.querySelector(".event-details") as HTMLElement;
    expect(within(eventDetails).getByText("TypeError")).toBeInTheDocument();
    expect(within(eventDetails).getByText("cannot read property of undefined")).toBeInTheDocument();
  });

  it("shows Performance insights for a recorded request", async () => {
    const events = [buildCorrelatedEnvelope(1, "corr-1"), buildHttpEnvelope(2, "corr-1", 1500)];
    mockRecordingFetch(events);

    render(<App />);
    await screen.findByText("message 1");
    await selectFirstRequest();

    const inspector = document.querySelector(".request-inspector") as HTMLElement;
    expect(within(inspector).getByText("Performance")).toBeInTheDocument();
    expect(within(inspector).getByText("Slow Request")).toBeInTheDocument();
  });

  it("shows the Execution Graph for a recorded request", async () => {
    const events = [
      buildCorrelatedEnvelope(1, "corr-1"),
      buildSqlEnvelope(2, "corr-1", 5),
      buildRedisEnvelope(3, "corr-1", 2),
      buildHttpEnvelope(4, "corr-1", 20),
    ];
    mockRecordingFetch(events);

    render(<App />);
    await screen.findByText("message 1");
    await selectFirstRequest();

    expect(document.querySelector(".execution-graph")).not.toBeNull();
    // Depth-first from the request container: the query and redis call ran
    // inside it, and this recording's console.log falls inside the redis
    // call's window, so it is emitted last rather than first.
    expect(graphKinds()).toEqual(["http.request", "sql.query", "redis.command", "console.log"]);
  });

  it("does not register a live event listener that duplicates recorded events", async () => {
    const events = [buildCorrelatedEnvelope(1, "corr-1")];
    mockRecordingFetch(events);

    render(<App />);
    await screen.findByText("message 1");

    // A stray message on the (now-closed) socket should not add a second
    // event — recorded events come only from /api/session/events.
    act(() => {
      lastSocket?.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(buildCorrelatedEnvelope(2, "corr-2")) }),
      );
    });

    expect(document.querySelector(".timeline-controls__count")?.textContent).toBe("1 event");
  });
});

// A recording with several correlated requests, spread across recorded
// timestamps far enough apart that fake-timer advances in the tests below
// land unambiguously on one event at a time. Built once per test via a
// fresh array (see buildReplayEvents) so no test can leak position state
// into another by mutating a shared one.
function buildReplayEvents(): Envelope<CapturedEvent>[] {
  const base = 1_700_000_000_000;
  const withTime = (envelope: Envelope<CapturedEvent>, occurredAt: number) => ({
    ...envelope,
    payload: { ...envelope.payload, occurredAt: base + occurredAt },
  });

  return [
    withTime(buildCorrelatedEnvelope(1, "corr-1"), 0),
    withTime(buildSqlEnvelope(2, "corr-1", 5), 100),
    withTime(buildHttpEnvelope(3, "corr-1", 1500), 1_000),
    withTime(buildCorrelatedEnvelope(4, "corr-2"), 2_000),
    withTime(buildExceptionEnvelope(5, "corr-2"), 2_100),
    withTime(buildHttpEnvelope(6, "corr-2", 10), 3_000),
  ];
}

describe("Replay", () => {
  const OriginalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    lastSocket = undefined;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not render replay controls in live mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ mode: "live" }))),
    );
    render(<App />);

    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(document.querySelector(".replay-controls")).toBeNull();
  });

  it("renders replay controls, starting fully played, when viewing a recording", async () => {
    mockRecordingFetch(buildReplayEvents());
    render(<App />);

    await screen.findByText("message 1");

    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
    expect(screen.getByText("6 / 6 events")).toBeInTheDocument();
  });

  it("hides the Clear requests button while viewing a recording", async () => {
    mockRecordingFetch(buildReplayEvents());
    render(<App />);

    await screen.findByText("message 1");

    expect(screen.queryByRole("button", { name: "Clear requests" })).not.toBeInTheDocument();
  });

  it("Restart jumps to the start; the dashboard shows nothing yet", async () => {
    mockRecordingFetch(buildReplayEvents());
    render(<App />);
    await screen.findByText("message 1");

    fireEvent.click(screen.getByRole("button", { name: "Restart" }));

    expect(screen.getByText("0 / 6 events")).toBeInTheDocument();
    expect(document.querySelectorAll(".request-row")).toHaveLength(0);
  });

  it("Step Forward reveals events one at a time, request assembly included", async () => {
    mockRecordingFetch(buildReplayEvents());
    render(<App />);
    await screen.findByText("message 1");
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));

    fireEvent.click(screen.getByRole("button", { name: "Step Forward" }));
    expect(screen.getByText("1 / 6 events")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll(".request-row")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Step Back" }));
    expect(screen.getByText("0 / 6 events")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll(".request-row")).toHaveLength(0));
  });

  it("the seek slider jumps directly to a position and updates the requests shown", async () => {
    mockRecordingFetch(buildReplayEvents());
    render(<App />);
    await screen.findByText("message 1");

    fireEvent.change(screen.getByLabelText("Seek"), { target: { value: "3" } });

    expect(screen.getByText("3 / 6 events")).toBeInTheDocument();
    // Only corr-1 (events 0-2) has happened by position 3; corr-2 hasn't
    // started yet.
    await waitFor(() => expect(document.querySelectorAll(".request-row")).toHaveLength(1));
  });

  describe("timed playback", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it("Play advances position over recorded time, and Pause stops it", async () => {
      mockRecordingFetch(buildReplayEvents());
      render(<App />);
      await screen.findByText("message 1");

      fireEvent.click(screen.getByRole("button", { name: "Restart" }));
      expect(screen.getByText("0 / 6 events")).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(screen.getByText("2 / 6 events")).toBeInTheDocument();

      const replayControls = document.querySelector(".replay-controls") as HTMLElement;
      fireEvent.click(within(replayControls).getByRole("button", { name: "Pause" }));
      const label = screen.getByText(/\/ 6 events/).textContent;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(screen.getByText(label as string)).toBeInTheDocument();
    });

    it("changing playback speed is reflected in the speed selector", async () => {
      mockRecordingFetch(buildReplayEvents());
      render(<App />);
      await screen.findByText("message 1");

      const speedSelect = screen.getByLabelText("Playback speed") as HTMLSelectElement;
      fireEvent.change(speedSelect, { target: { value: "8" } });

      expect(speedSelect.value).toBe("8");
    });

    it("reaches the end of the recording and auto-pauses there", async () => {
      mockRecordingFetch(buildReplayEvents());
      render(<App />);
      await screen.findByText("message 1");

      fireEvent.click(screen.getByRole("button", { name: "Restart" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(screen.getByText("6 / 6 events")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
    });
  });

  describe("dashboard feature parity at a specific replay position", () => {
    async function seekToEnd(): Promise<void> {
      fireEvent.change(screen.getByLabelText("Seek"), { target: { value: "6" } });
      await waitFor(() => expect(document.querySelectorAll(".request-row")).toHaveLength(2));
    }

    it("request inspection, waterfall, and events work the same as fully-loaded offline mode", async () => {
      mockRecordingFetch(buildReplayEvents());
      render(<App />);
      await screen.findByText("message 1");
      await seekToEnd();

      fireEvent.click(document.querySelector(".request-list .request-row__button") as HTMLElement);

      const inspector = document.querySelector(".request-inspector") as HTMLElement;
      const summary = inspector.querySelector(".request-inspector__summary") as HTMLElement;
      expect(within(summary).getByText("corr-1")).toBeInTheDocument();
      expect(inspector.querySelector(".waterfall")).not.toBeNull();
      expect(inspector.querySelectorAll(".event-row")).toHaveLength(3);
    });

    it("performance insights reflect the request as reconstructed at that position", async () => {
      mockRecordingFetch(buildReplayEvents());
      render(<App />);
      await screen.findByText("message 1");
      await seekToEnd();

      fireEvent.click(document.querySelector(".request-list .request-row__button") as HTMLElement);

      const inspector = document.querySelector(".request-inspector") as HTMLElement;
      expect(within(inspector).getByText("Performance")).toBeInTheDocument();
      expect(within(inspector).getByText("Slow Request")).toBeInTheDocument();
    });

    it("the execution graph reflects the request as reconstructed at that position", async () => {
      mockRecordingFetch(buildReplayEvents());
      render(<App />);
      await screen.findByText("message 1");
      await seekToEnd();

      fireEvent.click(document.querySelector(".request-list .request-row__button") as HTMLElement);

      expect(graphKinds()).toEqual(["http.request", "console.log", "sql.query"]);
    });

    it("exception inspection works for a request reconstructed via replay", async () => {
      mockRecordingFetch(buildReplayEvents());
      render(<App />);
      await screen.findByText("message 1");
      await seekToEnd();

      const requestRows = document.querySelectorAll(".request-list .request-row__button");
      fireEvent.click(requestRows[1] as HTMLElement);

      const inspectorEventList = document.querySelector(
        ".request-inspector .event-list",
      ) as HTMLElement;
      fireEvent.click(within(inspectorEventList).getByText("exception.captured"));

      const eventDetails = document.querySelector(".event-details") as HTMLElement;
      expect(within(eventDetails).getByText("TypeError")).toBeInTheDocument();
    });

    it("search and filter operate on the replay's current event window", async () => {
      mockRecordingFetch(buildReplayEvents());
      render(<App />);
      await screen.findByText("message 1");

      // Only the first 3 events (corr-1) have happened at position 3.
      fireEvent.change(screen.getByLabelText("Seek"), { target: { value: "3" } });
      await waitFor(() => expect(document.querySelectorAll(".request-row")).toHaveLength(1));

      const eventList = document.querySelector(".event-list") as HTMLElement;
      expect(within(eventList).queryByText("exception.captured")).not.toBeInTheDocument();

      fireEvent.change(screen.getByLabelText("Filter by kind"), {
        target: { value: "sql.query" },
      });
      expect(within(eventList).getByText("sql.query")).toBeInTheDocument();
      expect(within(eventList).queryByText("message 1")).not.toBeInTheDocument();
    });

    it("clearing the request selection when replay seeks before it existed leaves no stale reference", async () => {
      mockRecordingFetch(buildReplayEvents());
      render(<App />);
      await screen.findByText("message 1");
      await seekToEnd();

      const requestRows = document.querySelectorAll(".request-list .request-row__button");
      fireEvent.click(requestRows[1] as HTMLElement);
      expect((document.querySelector(".request-inspector") as HTMLElement).textContent).toContain(
        "corr-2",
      );

      // Seek back to before corr-2's first event (position 4).
      fireEvent.change(screen.getByLabelText("Seek"), { target: { value: "3" } });
      await waitFor(() => expect(document.querySelectorAll(".request-row")).toHaveLength(1));

      expect(screen.getByText(/select a request to inspect it/i)).toBeInTheDocument();
    });
  });
});
