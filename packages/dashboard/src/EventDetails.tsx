import type { CapturedEvent, Envelope } from "@wevna/protocol";

export interface EventDetailsProps {
  event: Envelope<CapturedEvent> | undefined;
}

export function EventDetails({ event }: EventDetailsProps) {
  if (!event) {
    return <p className="event-details__empty">Select an event to see its details.</p>;
  }

  const { id, kind, occurredAt, attributes } = event.payload;

  return (
    <div className="event-details">
      <dl className="event-details__fields">
        <dt>Event ID</dt>
        <dd>{id}</dd>
        <dt>Kind</dt>
        <dd>{kind}</dd>
        <dt>Occurred At</dt>
        <dd>{new Date(occurredAt).toLocaleString()}</dd>
      </dl>
      <h2 className="event-details__attributes-heading">Attributes</h2>
      <pre className="event-details__attributes">{JSON.stringify(attributes, null, 2)}</pre>
    </div>
  );
}
