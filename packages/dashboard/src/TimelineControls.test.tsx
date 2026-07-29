import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TimelineControls } from "./TimelineControls.tsx";

describe("TimelineControls", () => {
  it("shows the live event count", () => {
    render(
      <TimelineControls
        paused={false}
        liveCount={5}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    expect(screen.getByText("5 events")).toBeInTheDocument();
  });

  it("uses the singular form for exactly one event", () => {
    render(
      <TimelineControls
        paused={false}
        liveCount={1}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    expect(screen.getByText("1 event")).toBeInTheDocument();
  });

  it("shows a Pause button when not paused, and calls onPause when clicked", () => {
    const onPause = vi.fn();
    render(
      <TimelineControls
        paused={false}
        liveCount={0}
        onPause={onPause}
        onResume={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    expect(onPause).toHaveBeenCalledOnce();
  });

  it("shows a Resume button when paused, and calls onResume when clicked", () => {
    const onResume = vi.fn();
    render(
      <TimelineControls
        paused={true}
        liveCount={0}
        onPause={vi.fn()}
        onResume={onResume}
        onClear={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    expect(onResume).toHaveBeenCalledOnce();
  });

  it("calls onClear when the Clear button is clicked", () => {
    const onClear = vi.fn();
    render(
      <TimelineControls
        paused={false}
        liveCount={0}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onClear={onClear}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(onClear).toHaveBeenCalledOnce();
  });
});
