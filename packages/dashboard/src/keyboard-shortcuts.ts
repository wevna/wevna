import type { RequestModel } from "@wevna/intelligence";

export type ShortcutAction =
  | "next-request"
  | "previous-request"
  | "clear-selection"
  | "focus-search"
  | "toggle-theme"
  | "toggle-pause"
  | "toggle-help";

export interface ShortcutKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export interface ShortcutTarget {
  tagName?: string;
  isContentEditable?: boolean;
}

export interface ShortcutDescription {
  keys: string;
  description: string;
  action: ShortcutAction;
}

// The one list both the key handler and the help overlay read, so what the
// overlay documents cannot drift from what the keys do.
export const SHORTCUTS: readonly (ShortcutDescription & { key: string })[] = [
  { key: "j", keys: "J", description: "Next request", action: "next-request" },
  { key: "k", keys: "K", description: "Previous request", action: "previous-request" },
  { key: "Escape", keys: "Esc", description: "Clear selection", action: "clear-selection" },
  { key: "/", keys: "/", description: "Search events", action: "focus-search" },
  { key: "t", keys: "T", description: "Toggle light / dark", action: "toggle-theme" },
  { key: "p", keys: "P", description: "Pause or resume capture", action: "toggle-pause" },
  { key: "?", keys: "?", description: "Show this help", action: "toggle-help" },
];

// Chords are handled separately from SHORTCUTS (which never claims a
// modifier combination) but belong in the same help listing.
export const CHORD_SHORTCUTS: readonly { keys: string; description: string }[] = [
  { keys: "Ctrl/⌘ K", description: "Command palette" },
];

const TEXT_ENTRY_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isTextEntry(target: ShortcutTarget | null | undefined): boolean {
  if (!target) {
    return false;
  }
  return Boolean(target.isContentEditable) || TEXT_ENTRY_TAGS.has(target.tagName ?? "");
}

// Resolves a keypress to an action, or undefined to leave it alone.
//
// Two things are deliberately never claimed: any chord with ctrl, meta or alt
// (those belong to the browser and OS — Cmd+T opens a tab, not our theme
// toggle), and any key typed into a text field (typing "j" in the search box
// must type a j). Escape is the exception to the second rule so a field can be
// left from the keyboard.
export function resolveShortcut(
  event: ShortcutKeyEvent,
  target?: ShortcutTarget | null,
): ShortcutAction | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return undefined;
  }
  if (isTextEntry(target) && event.key !== "Escape") {
    return undefined;
  }
  return SHORTCUTS.find((shortcut) => shortcut.key === event.key)?.action;
}

// The request to select after moving one step in the list's displayed order.
// With nothing selected, "next" lands on the first row and "previous" on the
// last, and moving past either end stays put rather than wrapping — wrapping
// from the newest request to the oldest is disorienting in a live list.
export function adjacentRequestId(
  requests: readonly RequestModel[],
  selectedId: string | undefined,
  direction: "next" | "previous",
): string | undefined {
  if (requests.length === 0) {
    return undefined;
  }
  const index = requests.findIndex((request) => request.id === selectedId);
  if (index === -1) {
    return (direction === "next" ? requests[0] : requests[requests.length - 1])?.id;
  }
  const target = direction === "next" ? index + 1 : index - 1;
  return requests[Math.min(Math.max(target, 0), requests.length - 1)]?.id;
}
