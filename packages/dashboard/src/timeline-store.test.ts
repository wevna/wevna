import { describe, expect, it, vi } from "vitest";
import { TimelineStore } from "./timeline-store.ts";

describe("TimelineStore", () => {
  it("starts unpaused with nothing cleared", () => {
    const store = new TimelineStore();

    expect(store.getSnapshot()).toEqual({
      paused: false,
      clearedCount: 0,
      pausedAtCount: undefined,
    });
  });

  it("records the live count at the moment it is paused", () => {
    const store = new TimelineStore();

    store.pause(5);

    expect(store.getSnapshot().paused).toBe(true);
    expect(store.getSnapshot().pausedAtCount).toBe(5);
  });

  it("clears the paused watermark on resume", () => {
    const store = new TimelineStore();
    store.pause(5);

    store.resume();

    expect(store.getSnapshot().paused).toBe(false);
    expect(store.getSnapshot().pausedAtCount).toBeUndefined();
  });

  it("records the live count at the moment it is cleared", () => {
    const store = new TimelineStore();

    store.clear(7);

    expect(store.getSnapshot().clearedCount).toBe(7);
  });

  it("notifies subscribers on pause, resume, and clear", () => {
    const store = new TimelineStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.pause(1);
    store.resume();
    store.clear(2);

    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("does not notify subscribers when pausing while already paused", () => {
    const store = new TimelineStore();
    store.pause(1);
    const listener = vi.fn();
    store.subscribe(listener);

    store.pause(2);

    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot().pausedAtCount).toBe(1);
  });

  it("does not notify subscribers when resuming while not paused", () => {
    const store = new TimelineStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.resume();

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying a listener after it unsubscribes", () => {
    const store = new TimelineStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    unsubscribe();
    store.pause(1);

    expect(listener).not.toHaveBeenCalled();
  });
});
