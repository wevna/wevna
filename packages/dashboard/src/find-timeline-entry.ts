import type { RequestModel } from "./request-store.ts";
import type { TimelineEntry } from "./timeline.ts";

// Scans every request's own timeline for the entry belonging to a given
// event id — not scoped to whichever request happens to be selected in the
// inspector, since a developer can select an event (from the raw
// top-level list, or a different request's own scoped event list) without
// having navigated to its owning request first. Used to derive an event's
// "time within request" wherever it's selected, not just inside the
// currently-open inspector.
export function findTimelineEntry(
  requests: readonly RequestModel[],
  eventId: string | undefined,
): TimelineEntry | undefined {
  if (!eventId) {
    return undefined;
  }
  for (const request of requests) {
    const entry = request.timeline.find((candidate) => candidate.event.payload.id === eventId);
    if (entry) {
      return entry;
    }
  }
  return undefined;
}
