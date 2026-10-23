import { useEffect } from "react";
import { CHORD_SHORTCUTS, SHORTCUTS } from "./keyboard-shortcuts.ts";

export interface ShortcutsHelpProps {
  onClose: () => void;
}

// A modal list of the keyboard shortcuts, generated from the same SHORTCUTS
// table the key handler reads. Closes on Escape, on the backdrop, and on the
// close button; a click inside the panel does not close it.
export function ShortcutsHelp({ onClose }: ShortcutsHelpProps) {
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (event.key === "Escape" || event.key === "?") {
        event.stopPropagation();
        onClose();
      }
    };
    // Capture phase, so Escape closes the overlay *before* the global handler
    // would also clear the request selection behind it.
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, [onClose]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop's click-to-dismiss is a pointer convenience; keyboard users close with Escape or the button.
    <div className="shortcuts-help__backdrop" onClick={onClose} onKeyDown={undefined}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: only stops the click reaching the backdrop. */}
      <div
        className="shortcuts-help"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-help-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="shortcuts-help-title" className="shortcuts-help__title">
          Keyboard shortcuts
        </h2>
        <dl className="shortcuts-help__list">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.action} className="shortcuts-help__row">
              <dt>
                <kbd>{shortcut.keys}</kbd>
              </dt>
              <dd>{shortcut.description}</dd>
            </div>
          ))}
          {CHORD_SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys} className="shortcuts-help__row">
              <dt>
                <kbd>{shortcut.keys}</kbd>
              </dt>
              <dd>{shortcut.description}</dd>
            </div>
          ))}
        </dl>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
