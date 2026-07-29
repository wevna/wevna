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
});
