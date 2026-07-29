import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { useState, useSyncExternalStore } from "react";
import { TimelineStore } from "./timeline-store.ts";

export interface UseTimelineResult {
  visibleEvents: readonly Envelope<CapturedEvent>[];
  paused: boolean;
  liveCount: number;
  pause: () => void;
  resume: () => void;
  clear: () => void;
}

// Bridges the timeline store into React, deriving what to render from the
// live event list plus pause/clear state — mirrors useLiveEvents and
// useSelection. liveCount always reflects the full live list, regardless of
// pause state, so it's visible proof that capture keeps running while
// paused.
export function useTimeline(events: readonly Envelope<CapturedEvent>[]): UseTimelineResult {
  const [store] = useState(() => new TimelineStore());
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const liveCount = events.length;
  const visibleEnd = snapshot.paused ? (snapshot.pausedAtCount ?? liveCount) : liveCount;
  const visibleEvents = events.slice(snapshot.clearedCount, visibleEnd);

  return {
    visibleEvents,
    paused: snapshot.paused,
    liveCount,
    pause: () => store.pause(liveCount),
    resume: () => store.resume(),
    clear: () => store.clear(liveCount),
  };
}
