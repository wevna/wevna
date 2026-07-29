import { fireEvent, render, screen } from "@testing-library/react";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it, vi } from "vitest";
import { EventList } from "./EventList.tsx";

function makeEnvelope(
  overrides: Partial<CapturedEvent> = {},
  sequence = 1,
): Envelope<CapturedEvent> {
  return {
    version: 1,
    sessionId: "session-1",
    sequence,
    payload: {
      id: `event-${sequence}`,
      kind: "console.log",
      occurredAt: Date.now(),
      attributes: { message: `message ${sequence}` },
      ...overrides,
    },
  };
}

describe("EventList", () => {
  it("shows a placeholder when there are no events yet", () => {
    render(<EventList events={[]} selectedId={undefined} onSelect={vi.fn()} />);

    expect(screen.getByText(/waiting for events/i)).toBeInTheDocument();
  });

  it("renders received events in the order they were given", () => {
    const events = [makeEnvelope({}, 1), makeEnvelope({}, 2), makeEnvelope({}, 3)];

    render(<EventList events={events} selectedId={undefined} onSelect={vi.fn()} />);

    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("message 1"),
      expect.stringContaining("message 2"),
      expect.stringContaining("message 3"),
    ]);
  });

  it("renders every received event", () => {
    const events = [
      makeEnvelope({}, 1),
      makeEnvelope({}, 2),
      makeEnvelope({}, 3),
      makeEnvelope({}, 4),
    ];

    render(<EventList events={events} selectedId={undefined} onSelect={vi.fn()} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("message 1")).toBeInTheDocument();
    expect(screen.getByText("message 4")).toBeInTheDocument();
  });

  it("uses each event's id as its React key", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const duplicateId = { id: "duplicate-id" };
    const events = [makeEnvelope(duplicateId, 1), makeEnvelope(duplicateId, 2)];

    render(<EventList events={events} selectedId={undefined} onSelect={vi.fn()} />);

    const warnedAboutDuplicateKeys = consoleError.mock.calls.some(
      (call) => typeof call[0] === "string" && call[0].includes("same key"),
    );
    expect(warnedAboutDuplicateKeys).toBe(true);

    consoleError.mockRestore();
  });

  it("calls onSelect with the clicked event's id", () => {
    const events = [makeEnvelope({}, 1), makeEnvelope({}, 2)];
    const onSelect = vi.fn();

    render(<EventList events={events} selectedId={undefined} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("message 2"));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith("event-2");
  });

  it("marks the selected row and leaves the others unmarked", () => {
    const events = [makeEnvelope({}, 1), makeEnvelope({}, 2)];

    render(<EventList events={events} selectedId="event-2" onSelect={vi.fn()} />);
    const rows = screen.getAllByRole("listitem");

    expect(rows[0]?.className).not.toContain("event-row--selected");
    expect(rows[1]?.className).toContain("event-row--selected");
  });
});
