import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { EventRow } from "./EventRow.tsx";

export interface EventListProps {
  events: readonly Envelope<CapturedEvent>[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}

export function EventList({ events, selectedId, onSelect }: EventListProps) {
  if (events.length === 0) {
    return <p className="event-list__empty">Waiting for events...</p>;
  }

  return (
    <ul className="event-list">
      {events.map((event) => (
        <EventRow
          key={event.payload.id}
          event={event}
          selected={event.payload.id === selectedId}
          onSelect={() => onSelect(event.payload.id)}
        />
      ))}
    </ul>
  );
}
