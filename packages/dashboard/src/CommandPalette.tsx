import { useEffect, useId, useMemo, useRef, useState } from "react";
import { type Command, filterCommands } from "./command-palette.ts";

export interface CommandPaletteProps {
  commands: readonly Command[];
  onClose: () => void;
}

// A keyboard-first launcher: type to filter, arrows to move, Enter to run,
// Escape to dismiss. Follows the ARIA combobox/listbox pattern so a screen
// reader hears the active result as the arrows move through them — focus
// stays in the input and aria-activedescendant points at the highlighted row.
export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  const activeIndex = Math.min(active, Math.max(results.length - 1, 0));

  useEffect(() => {
    input.current?.focus();
  }, []);

  function run(command: Command | undefined): void {
    if (!command) {
      return;
    }
    onClose();
    command.run();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive(Math.min(activeIndex + 1, results.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive(Math.max(activeIndex - 1, 0));
        break;
      case "Enter":
        event.preventDefault();
        run(results[activeIndex]);
        break;
      case "Escape":
        event.preventDefault();
        // Handled here, not left to bubble to the global shortcuts, which
        // would also clear the selection behind the palette.
        event.stopPropagation();
        onClose();
        break;
      default:
        break;
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only dismiss; keyboard users press Escape.
    <div className="command-palette__backdrop" onClick={onClose} onKeyDown={undefined}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: only stops the click reaching the backdrop. */}
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={input}
          className="command-palette__input input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={results[activeIndex] ? `${listId}-${activeIndex}` : undefined}
          aria-label="Search commands and requests"
          placeholder="Jump to a request or run a command…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={handleKeyDown}
        />
        {/* The listbox/option roles are the ARIA combobox pattern: focus stays in
            the input and aria-activedescendant names the highlighted option, so
            the options are deliberately not focusable themselves. */}
        {/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA combobox pattern, see above. */}
        <ul id={listId} className="command-palette__list" role="listbox">
          {results.length === 0 ? (
            <li className="command-palette__empty">No matches.</li>
          ) : (
            results.map((command, index) => (
              // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the input; aria-activedescendant points here.
              <li
                key={command.id}
                id={`${listId}-${index}`}
                // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA combobox pattern, see above.
                role="option"
                aria-selected={index === activeIndex}
                className="command-palette__item"
                data-active={index === activeIndex}
                onMouseEnter={() => setActive(index)}
                onClick={() => run(command)}
                onKeyDown={undefined}
              >
                <span>{command.label}</span>
                {command.hint ? (
                  <span className="command-palette__hint">{command.hint}</span>
                ) : null}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
