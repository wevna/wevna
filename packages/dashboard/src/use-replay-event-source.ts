import type { RequestModel } from "@wevna/intelligence";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PlaybackState } from "./replay-engine.ts";
import { type ReplayControls, ReplayEventSource } from "./replay-event-source.ts";

export interface UseReplayEventSourceResult {
  events: readonly Envelope<CapturedEvent>[];
  requests: readonly RequestModel[];
  position: number;
  totalEvents: number;
  timestamp: number | undefined;
  state: PlaybackState;
  speed: number;
  controls: ReplayControls;
}

// Bridges ReplayEventSource into React, mirroring useLiveEvents/
// useRequests: the source instance itself is created once and never
// replaced (see EventStore/RequestStore precedent), and an effect feeds
// it the recording's events once they've actually been fetched (see
// use-recording-events.ts) rather than on every render — a ref, not
// state, tracks which array was last loaded, since re-loading the same
// array reference would reset playback position back to "fully played."
export function useReplayEventSource(
  events: readonly Envelope<CapturedEvent>[],
  enabled: boolean,
): UseReplayEventSourceResult {
  const [source] = useState(() => new ReplayEventSource());
  const loadedEvents = useRef<readonly Envelope<CapturedEvent>[] | undefined>(undefined);

  useEffect(() => {
    if (!enabled || events.length === 0 || loadedEvents.current === events) {
      return;
    }
    loadedEvents.current = events;
    source.load(events);
  }, [source, enabled, events]);

  // Not tied to `enabled`: even once a component stops requesting replay
  // events (e.g. the dashboard switches back to live), any playback timer
  // already in flight must still be cancelled, and dispose() only ever
  // runs on unmount.
  useEffect(() => {
    return () => {
      source.dispose();
    };
  }, [source]);

  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot);

  return { ...snapshot, controls: source.controls };
}
