import type { CapturedEvent, Envelope } from "@wevna/protocol";

export type EventStoreListener = () => void;

// Maintains the ordered list of received protocol events and notifies
// subscribers on every append, independent of React — networking
// (live-events.ts) writes into it, the UI (useLiveEvents) reads from it via
// useSyncExternalStore. No filtering, persistence, or replay: just an
// ordered, append-only list.
export class EventStore {
  #events: Envelope<CapturedEvent>[] = [];
  #listeners = new Set<EventStoreListener>();

  getEvents = (): readonly Envelope<CapturedEvent>[] => {
    return this.#events;
  };

  append(event: Envelope<CapturedEvent>): void {
    this.#events = [...this.#events, event];
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
