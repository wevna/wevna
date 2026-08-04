import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReplayControls } from "./ReplayControls.tsx";
import type { ReplayControls as ReplayControlsApi } from "./replay-event-source.ts";

function makeControls(): ReplayControlsApi {
  return {
    play: vi.fn(),
    pause: vi.fn(),
    restart: vi.fn(),
    stepForward: vi.fn(),
    stepBackward: vi.fn(),
    seek: vi.fn(),
    seekToTime: vi.fn(),
    setSpeed: vi.fn(),
  };
}

describe("ReplayControls", () => {
  it("shows Play when paused, and calls controls.play when clicked", () => {
    const controls = makeControls();
    render(
      <ReplayControls position={1} totalEvents={5} state="paused" speed={1} controls={controls} />,
    );

    const button = screen.getByRole("button", { name: "Play" });
    fireEvent.click(button);

    expect(controls.play).toHaveBeenCalledOnce();
  });

  it("shows Pause when playing, and calls controls.pause when clicked", () => {
    const controls = makeControls();
    render(
      <ReplayControls position={1} totalEvents={5} state="playing" speed={1} controls={controls} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    expect(controls.pause).toHaveBeenCalledOnce();
  });

  it("disables Play at the end of the recording", () => {
    render(
      <ReplayControls
        position={5}
        totalEvents={5}
        state="paused"
        speed={1}
        controls={makeControls()}
      />,
    );

    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
  });

  it("Restart calls controls.restart", () => {
    const controls = makeControls();
    render(
      <ReplayControls position={5} totalEvents={5} state="paused" speed={1} controls={controls} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restart" }));

    expect(controls.restart).toHaveBeenCalledOnce();
  });

  it("Step Back is disabled at position 0, Step Forward disabled at the end", () => {
    const { rerender } = render(
      <ReplayControls
        position={0}
        totalEvents={5}
        state="paused"
        speed={1}
        controls={makeControls()}
      />,
    );
    expect(screen.getByRole("button", { name: "Step Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Step Forward" })).not.toBeDisabled();

    rerender(
      <ReplayControls
        position={5}
        totalEvents={5}
        state="paused"
        speed={1}
        controls={makeControls()}
      />,
    );
    expect(screen.getByRole("button", { name: "Step Forward" })).toBeDisabled();
  });

  it("Step Forward/Step Back call the matching control", () => {
    const controls = makeControls();
    render(
      <ReplayControls position={2} totalEvents={5} state="paused" speed={1} controls={controls} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Step Forward" }));
    fireEvent.click(screen.getByRole("button", { name: "Step Back" }));

    expect(controls.stepForward).toHaveBeenCalledOnce();
    expect(controls.stepBackward).toHaveBeenCalledOnce();
  });

  it("the seek slider reflects position/totalEvents and calls controls.seek on change", () => {
    const controls = makeControls();
    render(
      <ReplayControls position={2} totalEvents={5} state="paused" speed={1} controls={controls} />,
    );

    const slider = screen.getByLabelText("Seek") as HTMLInputElement;
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("5");
    expect(slider.value).toBe("2");

    fireEvent.change(slider, { target: { value: "4" } });

    expect(controls.seek).toHaveBeenCalledWith(4);
  });

  it("shows the current position and total event count", () => {
    render(
      <ReplayControls
        position={3}
        totalEvents={10}
        state="paused"
        speed={1}
        controls={makeControls()}
      />,
    );

    expect(screen.getByText("3 / 10 events")).toBeInTheDocument();
  });

  it("the speed select reflects speed and calls controls.setSpeed on change", () => {
    const controls = makeControls();
    render(
      <ReplayControls position={2} totalEvents={5} state="paused" speed={1} controls={controls} />,
    );

    const select = screen.getByLabelText("Playback speed") as HTMLSelectElement;
    expect(select.value).toBe("1");

    fireEvent.change(select, { target: { value: "4" } });

    expect(controls.setSpeed).toHaveBeenCalledWith(4);
  });

  it("offers every documented speed option", () => {
    render(
      <ReplayControls
        position={2}
        totalEvents={5}
        state="paused"
        speed={1}
        controls={makeControls()}
      />,
    );

    const select = screen.getByLabelText("Playback speed");
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual(["0.25x", "0.5x", "1x", "2x", "4x", "8x"]);
  });

  describe("finished state", () => {
    it("announces the end of the recording once playback finishes on its own", () => {
      render(
        <ReplayControls
          position={5}
          totalEvents={5}
          state="finished"
          speed={1}
          controls={makeControls()}
        />,
      );

      expect(screen.getByRole("status")).toHaveTextContent("End of recording");
    });

    it("stays silent when the developer merely paused on the last event", () => {
      render(
        <ReplayControls
          position={5}
          totalEvents={5}
          state="paused"
          speed={1}
          controls={makeControls()}
        />,
      );

      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("still offers Restart, and no Play, at the end of a finished replay", () => {
      const controls = makeControls();
      render(
        <ReplayControls
          position={5}
          totalEvents={5}
          state="finished"
          speed={1}
          controls={controls}
        />,
      );

      expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();

      fireEvent.click(screen.getByRole("button", { name: "Restart" }));
      expect(controls.restart).toHaveBeenCalledOnce();
    });
  });
});
