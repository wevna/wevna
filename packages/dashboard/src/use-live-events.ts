import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { useEffect, useState, useSyncExternalStore } from "react";
import { EventStore } from "./event-store.ts";
import { connectToLiveEvents } from "./live-events.ts";

// Bridges the WebSocket connection and the event store into React. A
// dropped or closed connection simply stops delivering new events — it
// does not throw, so the UI keeps rendering whatever already arrived.
//
// enabled defaults to true (every existing call site is unaffected) —
// false skips connecting entirely, and disconnects if it was already
// connected. See use-event-source.ts, which sets this to false while
// viewing a recorded session (no live runtime to connect to).
export function useLiveEvents(enabled = true): readonly Envelope<CapturedEvent>[] {
  const [store] = useState(() => new EventStore());

  useEffect(() => {
    if (!enabled) {
      return;
    }
    return connectToLiveEvents(store);
  }, [store, enabled]);

  return useSyncExternalStore(store.subscribe, store.getEvents);
}
