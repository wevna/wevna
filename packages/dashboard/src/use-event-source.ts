import type { CapturedEvent, Envelope } from "@wevna/protocol";
import type { ReplayControls } from "./replay-event-source.ts";
import type { RequestModel } from "./request-store.ts";
import { useLiveEvents } from "./use-live-events.ts";
import { useRecordingEvents } from "./use-recording-events.ts";
import { useReplayEventSource } from "./use-replay-event-source.ts";
import { useRequests } from "./use-requests.ts";
import { type SessionModeInfo, useSessionMode } from "./use-session-mode.ts";

export interface ReplayInfo {
  position: number;
  totalEvents: number;
  timestamp: number | undefined;
  state: "playing" | "paused";
  speed: number;
  controls: ReplayControls;
}

export interface EventSourceResult {
  events: readonly Envelope<CapturedEvent>[];
  requests: readonly RequestModel[];
  // undefined in recording mode: a replay's request list is entirely
  // derived from its current position (see snapshot-engine.ts) — there is
  // nothing meaningful to "clear" that seeking wouldn't just recompute
  // right back. Only live mode's requests are independent, removable
  // state.
  clearRequests: (() => void) | undefined;
  sessionMode: SessionModeInfo;
  // undefined in live mode: there's nothing to play/pause/seek on a
  // stream with no fixed end. Present in recording mode once the
  // recording's events have loaded — see use-replay-event-source.ts.
  replay: ReplayInfo | undefined;
}

// The one place the dashboard decides whether it's looking at a live
// runtime or a recorded session (see use-session-mode.ts) — everything
// downstream of the returned `events`/`requests` (EventStore/RequestStore
// equivalents, timeline, performance, execution graph, filtering, search)
// only ever sees a plain, ordered event list and a plain request list,
// and genuinely does not care whether a live runtime, a fully-loaded
// recording, or an in-progress replay produced them.
//
// useLiveEvents, useRecordingEvents, and useReplayEventSource are always
// called (React's rules of hooks — a hook can't be called conditionally),
// each gated by its own `enabled` flag instead: exactly one event source
// is ever actually connecting/fetching/playing at a time.
export function useEventSource(): EventSourceResult {
  const sessionMode = useSessionMode();
  const isRecording = sessionMode.mode === "recording";

  const liveEvents = useLiveEvents(!isRecording);
  const liveRequests = useRequests(liveEvents);

  const recordingEvents = useRecordingEvents(isRecording);
  const replay = useReplayEventSource(recordingEvents, isRecording);

  if (isRecording) {
    return {
      events: replay.events,
      requests: replay.requests,
      clearRequests: undefined,
      sessionMode,
      replay: {
        position: replay.position,
        totalEvents: replay.totalEvents,
        timestamp: replay.timestamp,
        state: replay.state,
        speed: replay.speed,
        controls: replay.controls,
      },
    };
  }

  return {
    events: liveEvents,
    requests: liveRequests.requests,
    clearRequests: liveRequests.clear,
    sessionMode,
    replay: undefined,
  };
}
