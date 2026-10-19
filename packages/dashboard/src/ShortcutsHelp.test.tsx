import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SHORTCUTS } from "./keyboard-shortcuts.ts";
import { ShortcutsHelp } from "./ShortcutsHelp.tsx";

describe("ShortcutsHelp", () => {
  it("lists every shortcut the key handler knows", () => {
    render(<ShortcutsHelp onClose={vi.fn()} />);

    for (const shortcut of SHORTCUTS) {
      expect(screen.getByText(shortcut.description)).toBeTruthy();
    }
  });

  it("is an accessible modal dialog", () => {
    render(<ShortcutsHelp onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("shortcuts-help-title");
  });

  it("closes on Escape, on the close button and on the backdrop", () => {
    const onClose = vi.fn();
    const { container } = render(<ShortcutsHelp onClose={onClose} />);

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(container.querySelector(".shortcuts-help__backdrop") as Element);

    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("stays open when the panel itself is clicked", () => {
    const onClose = vi.fn();
    render(<ShortcutsHelp onClose={onClose} />);

    fireEvent.click(screen.getByRole("dialog"));

    expect(onClose).not.toHaveBeenCalled();
  });
});
