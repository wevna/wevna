import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { MAX_LIVE_EVENTS } from "./retention.ts";

export type EventStoreListener = () => void;

// Maintains the ordered list of received protocol events and notifies
// subscribers on every append, independent of React — networking
// (live-events.ts) writes into it, the UI (useLiveEvents) reads from it via
// useSyncExternalStore. No filtering, persistence, or replay: just an
// ordered, append-only list with a bound on how much history it keeps.
//
// Two things this deliberately does not do, both of which it used to:
//
// It does not copy the whole history on every append. `#events = [...#events,
// event]` allocates an array the size of everything seen so far, per event —
// O(n) per append and O(n²) over a session, so a burst of traffic made the
// dashboard quadratically slower exactly when it mattered most. The array is
// mutated instead, and the immutable snapshot useSyncExternalStore needs is
// rebuilt lazily on the next read after a change. That is the same pattern
// RequestStore already used, for the same reason: reads happen once per
// render, not once per event.
//
// It does not grow without limit. See retention.ts.
export class EventStore {
  #events: Envelope<CapturedEvent>[] = [];
  #snapshot: readonly Envelope<CapturedEvent>[] | undefined;
  #listeners = new Set<EventStoreListener>();
  readonly #maxEvents: number;

  // Injectable purely so tests can drive eviction without building ten
  // thousand events; production always uses the default.
  constructor(maxEvents: number = MAX_LIVE_EVENTS) {
    this.#maxEvents = Math.max(1, maxEvents);
  }

  getEvents = (): readonly Envelope<CapturedEvent>[] => {
    if (!this.#snapshot) {
      this.#snapshot = [...this.#events];
    }
    return this.#snapshot;
  };

  append(event: Envelope<CapturedEvent>): void {
    this.#events.push(event);
    if (this.#events.length > this.#maxEvents) {
      // splice, not shift-in-a-loop: a single burst can overshoot the cap by
      // more than one, and trimming the excess in one operation keeps append
      // amortized O(1) rather than O(overshoot) per event.
      this.#events.splice(0, this.#events.length - this.#maxEvents);
    }

    this.#snapshot = undefined;
    for (const listener of this.#listeners) {
      listener();
    }
  }

  subscribe = (listener: EventStoreListener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
}
