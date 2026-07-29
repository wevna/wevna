import { describe, expect, it, vi } from "vitest";
import { SelectionStore } from "./selection-store.ts";

describe("SelectionStore", () => {
  it("starts with no selection", () => {
    const store = new SelectionStore();

    expect(store.getSelectedId()).toBeUndefined();
  });

  it("updates the selected id", () => {
    const store = new SelectionStore();

    store.select("event-1");

    expect(store.getSelectedId()).toBe("event-1");
  });

  it("notifies subscribers when the selection changes", () => {
    const store = new SelectionStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.select("event-1");

    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not notify subscribers when selecting the already-selected id", () => {
    const store = new SelectionStore();
    store.select("event-1");
    const listener = vi.fn();
    store.subscribe(listener);

    store.select("event-1");

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying a listener after it unsubscribes", () => {
    const store = new SelectionStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    unsubscribe();
    store.select("event-1");

    expect(listener).not.toHaveBeenCalled();
  });
});
