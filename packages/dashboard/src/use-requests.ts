import type { RequestModel } from "@wevna/intelligence";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RequestStore } from "./request-store.ts";

export interface UseRequestsResult {
  requests: readonly RequestModel[];
  clear: () => void;
}

// Bridges RequestStore into React, mirroring useLiveEvents/useTimeline.
// Takes the *full* live event list (not the paused/filtered view — see
// use-timeline.ts/use-event-filter.ts) so request assembly keeps working
// exactly like EventStore itself: independent of pause, filter, and
// search, all of which are presentation concerns layered on top.
//
// EventStore is strictly append-only, so new events only ever appear at
// the end of `events`; a ref tracks how many have already been fed into
// the store, and each render only processes the slice added since the
// last one — addEvent() is a side effect (it mutates the store and
// notifies subscribers), so it runs in an effect rather than during
// render itself.
export function useRequests(events: readonly Envelope<CapturedEvent>[]): UseRequestsResult {
  const [store] = useState(() => new RequestStore());
  const processedCount = useRef(0);

  useEffect(() => {
    for (let index = processedCount.current; index < events.length; index += 1) {
      const event = events[index];
      if (event) {
        store.addEvent(event);
      }
    }
    processedCount.current = events.length;
  }, [events, store]);

  const requests = useSyncExternalStore(store.subscribe, store.getRequests);

  return { requests, clear: () => store.clear() };
}
