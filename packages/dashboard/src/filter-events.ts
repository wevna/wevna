import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { summarizeEvent } from "./summarize-event.ts";

export interface EventFilter {
  // Empty string means "all kinds."
  kind: string;
  // Empty string means "no text filter." Matched against kind, summary,
  // and the JSON-stringified attributes, case-insensitively.
  query: string;
}

export const ALL_KINDS = "";

// Pure and synchronous: never touches EventStore, never queries a server,
// never talks to the WebSocket. Just derives a narrower view over whatever
// array it's given.
export function filterEvents(
  events: readonly Envelope<CapturedEvent>[],
  filter: EventFilter,
): readonly Envelope<CapturedEvent>[] {
  const kind = filter.kind.trim();
  const query = filter.query.trim().toLowerCase();

  if (!kind && !query) {
    return events;
  }

  return events.filter((event) => {
    if (kind && event.payload.kind !== kind) {
      return false;
    }
    return !query || matchesQuery(event.payload, query);
  });
}

function matchesQuery(event: CapturedEvent, query: string): boolean {
  if (event.kind.toLowerCase().includes(query)) {
    return true;
  }
  if (summarizeEvent(event).toLowerCase().includes(query)) {
    return true;
  }
  return JSON.stringify(event.attributes).toLowerCase().includes(query);
}
