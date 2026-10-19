import { useEffect, useRef } from "react";
import { resolveShortcut, type ShortcutAction } from "./keyboard-shortcuts.ts";

export const SEARCH_INPUT_ID = "wevna-search";

// Listens on the document for the lifetime of the app. The handler is held in
// a ref so the listener is attached once, yet always calls the latest closure
// (current selection, current requests) without being re-attached per render.
export function useKeyboardShortcuts(onAction: (action: ShortcutAction) => void): void {
  const handler = useRef(onAction);
  handler.current = onAction;

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      const action = resolveShortcut(event, event.target as HTMLElement | null);
      if (action === undefined) {
        return;
      }
      event.preventDefault();
      handler.current(action);
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);
}
