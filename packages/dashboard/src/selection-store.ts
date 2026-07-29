export type SelectionStoreListener = () => void;

// Tracks which event id (if any) the developer has selected. Kept separate
// from EventStore on purpose: selection is UI state (what's being looked
// at), not runtime data (what the app produced) — EventStore stays
// append-only and knows nothing about it. Appending a new event never
// touches this store, so selection survives incoming live events.
export class SelectionStore {
  #selectedId: string | undefined;
  #listeners = new Set<SelectionStoreListener>();

  getSelectedId = (): string | undefined => {
    return this.#selectedId;
  };

  select = (id: string): void => {
    if (this.#selectedId === id) {
      return;
    }
    this.#selectedId = id;
    for (const listener of this.#listeners) {
      listener();
    }
  };

  subscribe = (listener: SelectionStoreListener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
}
