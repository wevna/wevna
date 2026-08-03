import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { useEffect, useState } from "react";

// Fetches every event from an already-opened recording in one request —
// see GET /api/session/events in @wevna/server. A recording is finite and
// already fully known, unlike a live stream, so there's nothing to
// subscribe to: this fetches once per mount (while enabled), not on an
// ongoing connection.
export function useRecordingEvents(enabled: boolean): readonly Envelope<CapturedEvent>[] {
  const [events, setEvents] = useState<readonly Envelope<CapturedEvent>[]>([]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;

    fetch("/api/session/events")
      .then((response) => response.json())
      .then((body: { events: Envelope<CapturedEvent>[] }) => {
        if (!cancelled) {
          setEvents(body.events);
        }
      })
      .catch(() => {
        // Nothing to fall back to here — an empty event list is the
        // honest result of a recording that couldn't be fetched.
      });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return events;
}
