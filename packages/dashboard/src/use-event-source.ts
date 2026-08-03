import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { useLiveEvents } from "./use-live-events.ts";
import { useRecordingEvents } from "./use-recording-events.ts";
import { type SessionModeInfo, useSessionMode } from "./use-session-mode.ts";

export interface EventSourceResult {
  events: readonly Envelope<CapturedEvent>[];
  sessionMode: SessionModeInfo;
}

// The one place the dashboard decides whether it's looking at a live
// runtime or a recorded session (see use-session-mode.ts) — everything
// downstream of the returned `events` array (EventStore, RequestStore,
// timeline, performance, execution graph, filtering, search) only ever
// sees a plain, ordered event list and genuinely does not care which kind
// of source produced it.
//
// Both useLiveEvents and useRecordingEvents are always called (React's
// rules of hooks — a hook can't be called conditionally), each gated by
// its own `enabled` flag instead: exactly one of the two is ever actually
// connecting/fetching at a time.
export function useEventSource(): EventSourceResult {
  const sessionMode = useSessionMode();
  const liveEvents = useLiveEvents(sessionMode.mode !== "recording");
  const recordingEvents = useRecordingEvents(sessionMode.mode === "recording");

  return {
    events: sessionMode.mode === "recording" ? recordingEvents : liveEvents,
    sessionMode,
  };
}
