import type { CapturedEvent, Envelope } from "@wevna/protocol";

export type EventListener = (event: Envelope<CapturedEvent>) => void;

// The in-process publish/subscribe mechanism Runtime uses to hand protocol
// events to whichever subsystems eventually consume them (transport,
// dashboard, recorder, storage). It knows nothing about WebSockets, HTTP,
// or persistence, and nothing publishes real events through it yet — this
// is dependency wiring for future milestones, not a transport of its own.
export class EventBus {
  #listeners = new Set<EventListener>();

  publish(event: Envelope<CapturedEvent>): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
