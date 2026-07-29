export type TimelineStoreListener = () => void;

export interface TimelineSnapshot {
  paused: boolean;
  // Number of leading events (from the full, still-growing live list) to
  // hide from the rendered view. Set by clear() — never touches EventStore.
  clearedCount: number;
  // The live count at the moment pause() was called. While paused, only
  // events up to this count are shown; undefined means "not paused, show
  // everything."
  pausedAtCount: number | undefined;
}

const INITIAL_SNAPSHOT: TimelineSnapshot = {
  paused: false,
  clearedCount: 0,
  pausedAtCount: undefined,
};

// Controls what the timeline *shows*, never what EventStore *holds*.
// WebSocket traffic and EventStore keep accumulating regardless of this
// store's state — pausing freezes the rendered slice, clearing moves the
// visible window's start, and neither ever deletes or reorders an event.
export class TimelineStore {
  #snapshot: TimelineSnapshot = INITIAL_SNAPSHOT;
  #listeners = new Set<TimelineStoreListener>();

  getSnapshot = (): TimelineSnapshot => {
    return this.#snapshot;
  };

  // liveCount is the current total from EventStore, supplied by the
  // caller — this store has no reference to EventStore itself.
  pause(liveCount: number): void {
    if (this.#snapshot.paused) {
      return;
    }
    this.#set({ ...this.#snapshot, paused: true, pausedAtCount: liveCount });
  }

  resume(): void {
    if (!this.#snapshot.paused) {
      return;
    }
    this.#set({ ...this.#snapshot, paused: false, pausedAtCount: undefined });
  }

  clear(liveCount: number): void {
    this.#set({ ...this.#snapshot, clearedCount: liveCount });
  }

  subscribe = (listener: TimelineStoreListener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #set(next: TimelineSnapshot): void {
    this.#snapshot = next;
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
