import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TimelineAxis } from "./TimelineAxis.tsx";

describe("TimelineAxis", () => {
  it("renders one tick label per computed tick", () => {
    const { container } = render(<TimelineAxis totalDurationMs={100} />);

    const ticks = container.querySelectorAll(".timeline-axis__tick");
    expect(ticks).toHaveLength(5);
    expect(Array.from(ticks).map((tick) => tick.textContent)).toEqual([
      "0ms",
      "25ms",
      "50ms",
      "75ms",
      "100ms",
    ]);
  });

  it("positions ticks via percentage inline left styles", () => {
    const { container } = render(<TimelineAxis totalDurationMs={40} />);

    const ticks = container.querySelectorAll(".timeline-axis__tick") as NodeListOf<HTMLElement>;
    expect(ticks[0]?.style.left).toBe("0%");
    expect(ticks[2]?.style.left).toBe("50%");
    expect(ticks[4]?.style.left).toBe("100%");
  });

  it("renders a single 0ms tick for a zero total duration", () => {
    const { container } = render(<TimelineAxis totalDurationMs={0} />);

    const ticks = container.querySelectorAll(".timeline-axis__tick");
    expect(ticks).toHaveLength(1);
    expect(ticks[0]?.textContent).toBe("0ms");
  });

  it("is decorative: hidden from the accessibility tree", () => {
    const { container } = render(<TimelineAxis totalDurationMs={100} />);

    expect(container.querySelector(".timeline-axis")).toHaveAttribute("aria-hidden", "true");
  });

  it("re-renders its ticks when totalDurationMs changes", () => {
    const { container, rerender } = render(<TimelineAxis totalDurationMs={100} />);
    expect(
      Array.from(container.querySelectorAll(".timeline-axis__tick")).map((t) => t.textContent),
    ).toEqual(["0ms", "25ms", "50ms", "75ms", "100ms"]);

    rerender(<TimelineAxis totalDurationMs={200} />);

    expect(
      Array.from(container.querySelectorAll(".timeline-axis__tick")).map((t) => t.textContent),
    ).toEqual(["0ms", "50ms", "100ms", "150ms", "200ms"]);
  });
});
