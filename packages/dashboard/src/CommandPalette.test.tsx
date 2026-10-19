import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette.tsx";
import type { Command } from "./command-palette.ts";

function setup() {
  const runA = vi.fn();
  const runB = vi.fn();
  const onClose = vi.fn();
  const commands: Command[] = [
    { id: "a", label: "Toggle theme", run: runA },
    { id: "b", label: "GET /orders", hint: "200", run: runB },
  ];
  render(<CommandPalette commands={commands} onClose={onClose} />);
  return { runA, runB, onClose, input: screen.getByRole("combobox") };
}

describe("CommandPalette", () => {
  it("focuses the input and lists every command", () => {
    const { input } = setup();

    expect(document.activeElement).toBe(input);
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("filters as you type", () => {
    const { input } = setup();

    fireEvent.change(input, { target: { value: "ord" } });

    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["GET /orders200"]);
  });

  it("runs the highlighted command on Enter, closing first", () => {
    const { input, runA, runB, onClose } = setup();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onClose).toHaveBeenCalled();
    expect(runB).toHaveBeenCalled();
    expect(runA).not.toHaveBeenCalled();
  });

  it("does not move past either end of the list", () => {
    const { input, runA } = setup();

    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(runA).toHaveBeenCalled();
  });

  it("runs a command on click", () => {
    const { runB } = setup();

    fireEvent.click(screen.getByText("GET /orders"));

    expect(runB).toHaveBeenCalled();
  });

  it("closes on Escape without running anything", () => {
    const { input, onClose, runA, runB } = setup();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
    expect(runA).not.toHaveBeenCalled();
    expect(runB).not.toHaveBeenCalled();
  });

  it("says so when nothing matches, and Enter does nothing", () => {
    const { input, onClose } = setup();

    fireEvent.change(input, { target: { value: "zzz" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText("No matches.")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("exposes the active result to assistive tech", () => {
    const { input } = setup();

    const activeId = input.getAttribute("aria-activedescendant");

    expect(activeId).toBeTruthy();
    expect(document.getElementById(activeId as string)?.getAttribute("aria-selected")).toBe("true");
  });
});
