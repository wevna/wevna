import { useEffect, useState } from "react";

export interface OfflineSessionMetadataView {
  session: { id: string; startedAt: number; status: string };
  formatVersion: number;
  protocolVersion: number;
  recordingStartedAt: number;
  recordingEndedAt: number | undefined;
  eventCount: number | undefined;
}

export type SessionMode = "loading" | "live" | "recording";

export interface SessionModeInfo {
  mode: SessionMode;
  metadata: OfflineSessionMetadataView | undefined;
}

// Asks the server, once on mount, whether this instance is serving a live
// runtime or a previously recorded session — see GET /api/session in
// @wevna/server. "loading" only lasts until that first response; the
// dashboard treats it the same as "live" for connecting purposes (see
// use-event-source.ts), so there's no added latency for the common live
// case — the WebSocket opens immediately and is simply told to disconnect
// if this later resolves to "recording".
export function useSessionMode(): SessionModeInfo {
  const [state, setState] = useState<SessionModeInfo>({ mode: "loading", metadata: undefined });

  useEffect(() => {
    let cancelled = false;

    fetch("/api/session")
      .then((response) => response.json())
      .then(
        (body: { mode: "live" } | { mode: "recording"; metadata: OfflineSessionMetadataView }) => {
          if (cancelled) {
            return;
          }
          setState(
            body.mode === "recording"
              ? { mode: "recording", metadata: body.metadata }
              : { mode: "live", metadata: undefined },
          );
        },
      )
      .catch(() => {
        // Can't reach the server at all — fall back to "live" rather than
        // getting stuck on "loading" forever. useLiveEvents' own
        // WebSocket connection fails on its own terms from there, and the
        // rest of the dashboard already handles a dropped/failed
        // connection gracefully.
        if (!cancelled) {
          setState({ mode: "live", metadata: undefined });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
