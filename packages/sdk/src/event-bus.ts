import type { CapturedEvent, Envelope } from "@wevna/protocol";

export type EventListener = (event: Envelope<CapturedEvent>) => void;

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// The in-process publish/subscribe mechanism Runtime uses to hand protocol
// events to whichever subsystems consume them (transport, dashboard,
// recorder, storage). It knows nothing about WebSockets, HTTP, or
// persistence.
export class EventBus {
  #listeners = new Set<EventListener>();

  // Never throws, and never lets one listener affect another. This is the
  // single choke point every producer publishes through, which makes it the
  // right place to enforce "Wevna never throws into your code path" once,
  // rather than asking each producer to remember to.
  //
  // The isolation matters as much as the containment. Listeners are
  // independent subsystems that happen to share a subscription order, so a
  // transport that fails to serialize an event must not stop the recorder —
  // subscribed after it — from ever seeing that event. Without the per-
  // listener catch, one bad event silently truncates the recording rather
  // than degrading only the subsystem that could not handle it.
  publish(event: Envelope<CapturedEvent>): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        // console.error, not console.log: ConsoleInstrumentation patches
        // console.log, so reporting there would publish an event from
        // inside a publish and could loop.
        console.error(`[wevna] an event listener threw: ${describeError(error)}`);
      }
    }
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
