import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { useMemo, useState } from "react";
import { ALL_KINDS, filterEvents } from "./filter-events.ts";

export interface UseEventFilterResult {
  query: string;
  kind: string;
  availableKinds: readonly string[];
  filteredEvents: readonly Envelope<CapturedEvent>[];
  setQuery: (query: string) => void;
  setKind: (kind: string) => void;
}

// Filtering is plain UI input state — unlike EventStore/TimelineStore,
// there's no outside data source to bridge into React, so useState is
// enough; no dedicated store class needed. filterEvents itself stays a
// pure function so it's testable without React at all.
export function useEventFilter(events: readonly Envelope<CapturedEvent>[]): UseEventFilterResult {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState(ALL_KINDS);

  const availableKinds = useMemo(() => {
    return [...new Set(events.map((event) => event.payload.kind))].sort();
  }, [events]);

  const filteredEvents = useMemo(
    () => filterEvents(events, { kind, query }),
    [events, kind, query],
  );

  return { query, kind, availableKinds, filteredEvents, setQuery, setKind };
}
