import type { CapturedEvent, Envelope } from "@wevna/protocol";

export interface TimelineEntry {
  // Reference, not a copy — the same Envelope object whichever store fed
  // this timeline already holds (EventStore/RequestStore in the dashboard,
  // SnapshotEngine's own working map during replay).
  event: Envelope<CapturedEvent>;
  kind: string;
  sequence: number;
  timestamp: number;
  // Milliseconds since the request started — see getRelativeOffset(). Can
  // be negative for a request still missing its true earliest event (see
  // request-model.ts: startedAt is the minimum occurredAt seen *so far*,
  // and updates if a still-earlier event arrives later).
  relativeOffsetMs: number;
  // This entry's own measured duration, when its event represents a timed
  // operation (http.request, sql.query, redis.command all carry a
  // durationMs attribute; console.log does not, so this is undefined for
  // it).
  durationMs: number | undefined;
}

// A pure, presentation-agnostic building block: how far after the request
// started (in ms) a given timestamp falls. Exposed on its own, not just
// baked into buildTimeline(), so future UI can recompute an offset for an
// arbitrary timestamp without needing a full timeline entry.
export function getRelativeOffset(startedAt: number, timestamp: number): number {
  return timestamp - startedAt;
}

function extractDurationMs(event: Envelope<CapturedEvent>): number | undefined {
  const durationMs = event.payload.attributes.durationMs;
  return typeof durationMs === "number" ? durationMs : undefined;
}

// Derives a request's timeline from its events. Assumes `events` is
// already in chronological order — `compareEvents` in request-model.ts is
// the single definition of that order, and every caller maintains the
// invariant with it (RequestStore's insertSorted for live arrival,
// SnapshotEngine's append for an already-sorted recording) — so this stays
// a single O(k) pass over that one request's own events, not a sort, and
// never touches any other request. Never mutates or copies an event: each
// entry only wraps a reference to it alongside derived, read-only fields.
export function buildTimeline(
  events: readonly Envelope<CapturedEvent>[],
  startedAt: number,
): readonly TimelineEntry[] {
  return events.map((event) => ({
    event,
    kind: event.payload.kind,
    sequence: event.sequence,
    timestamp: event.payload.occurredAt,
    relativeOffsetMs: getRelativeOffset(startedAt, event.payload.occurredAt),
    durationMs: extractDurationMs(event),
  }));
}
