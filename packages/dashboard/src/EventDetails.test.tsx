import { render, screen } from "@testing-library/react";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it } from "vitest";
import { EventDetails } from "./EventDetails.tsx";

function makeEnvelope(): Envelope<CapturedEvent> {
  return {
    version: 1,
    sessionId: "session-1",
    sequence: 1,
    payload: {
      id: "event-1",
      kind: "console.log",
      occurredAt: Date.UTC(2026, 0, 1, 12, 0, 0),
      attributes: { message: "hello", requestId: 42 },
    },
  };
}

describe("EventDetails", () => {
  it("shows an empty state when no event is selected", () => {
    render(<EventDetails event={undefined} />);

    expect(screen.getByText(/select an event/i)).toBeInTheDocument();
  });

  it("displays the selected event's id, kind, and occurredAt", () => {
    render(<EventDetails event={makeEnvelope()} />);

    expect(screen.getByText("event-1")).toBeInTheDocument();
    expect(screen.getByText("console.log")).toBeInTheDocument();
    expect(
      screen.getByText(new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toLocaleString()),
    ).toBeInTheDocument();
  });

  it("displays a pretty-printed JSON representation of attributes", () => {
    const { container } = render(<EventDetails event={makeEnvelope()} />);

    const attributes = container.querySelector(".event-details__attributes");
    expect(attributes?.textContent).toBe(
      JSON.stringify({ message: "hello", requestId: 42 }, null, 2),
    );
  });

  it("does not show Time Within Request when no relativeOffsetMs is given", () => {
    render(<EventDetails event={makeEnvelope()} />);

    expect(screen.queryByText("Time Within Request")).not.toBeInTheDocument();
  });

  it("shows Time Within Request when relativeOffsetMs is given", () => {
    render(<EventDetails event={makeEnvelope()} relativeOffsetMs={42.4} />);

    expect(screen.getByText("Time Within Request")).toBeInTheDocument();
    expect(screen.getByText("+42ms")).toBeInTheDocument();
  });

  it("does not show a Correlation ID when the event has none", () => {
    render(<EventDetails event={makeEnvelope()} />);

    expect(screen.queryByText("Correlation ID")).not.toBeInTheDocument();
  });

  it("shows the Correlation ID when the event has one", () => {
    const envelope = makeEnvelope();
    envelope.payload.correlation = { id: "corr-abc" };

    render(<EventDetails event={envelope} />);

    expect(screen.getByText("Correlation ID")).toBeInTheDocument();
    expect(screen.getByText("corr-abc")).toBeInTheDocument();
  });

  describe("exception.captured events", () => {
    function makeExceptionEnvelope(): Envelope<CapturedEvent> {
      const envelope = makeEnvelope();
      envelope.payload.kind = "exception.captured";
      envelope.payload.attributes = {
        name: "TypeError",
        message: "cannot read property of undefined",
        stack: "TypeError: cannot read property of undefined\n    at handler (/app/index.js:1:1)",
      };
      return envelope;
    }

    it("renders the dedicated exception view for an exception.captured event", () => {
      render(<EventDetails event={makeExceptionEnvelope()} />);

      expect(document.querySelector(".exception-details")).not.toBeNull();
      expect(screen.getByText("TypeError")).toBeInTheDocument();
      expect(screen.getByText("cannot read property of undefined")).toBeInTheDocument();
    });

    it("still shows Event ID/Kind/Attributes alongside the exception view", () => {
      render(<EventDetails event={makeExceptionEnvelope()} />);

      expect(screen.getByText("event-1")).toBeInTheDocument();
      expect(screen.getByText("exception.captured")).toBeInTheDocument();
      expect(document.querySelector(".event-details__attributes")).not.toBeNull();
    });

    it("renders no exception view for a non-exception event", () => {
      render(<EventDetails event={makeEnvelope()} />);

      expect(document.querySelector(".exception-details")).toBeNull();
    });
  });
});
