import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { EventRow } from "./EventRow.tsx";

export interface EventListProps {
  events: readonly Envelope<CapturedEvent>[];
}

export function EventList({ events }: EventListProps) {
  if (events.length === 0) {
    return <p className="event-list__empty">Waiting for events...</p>;
  }

  return (
    <ul className="event-list">
      {events.map((event) => (
        <EventRow key={event.payload.id} event={event} />
      ))}
    </ul>
  );
}
