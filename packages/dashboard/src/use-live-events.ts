import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { useEffect, useState, useSyncExternalStore } from "react";
import { EventStore } from "./event-store.ts";
import { connectToLiveEvents } from "./live-events.ts";

// Bridges the WebSocket connection and the event store into React. A
// dropped or closed connection simply stops delivering new events — it
// does not throw, so the UI keeps rendering whatever already arrived.
export function useLiveEvents(): readonly Envelope<CapturedEvent>[] {
  const [store] = useState(() => new EventStore());

  useEffect(() => {
    return connectToLiveEvents(store);
  }, [store]);

  return useSyncExternalStore(store.subscribe, store.getEvents);
}
