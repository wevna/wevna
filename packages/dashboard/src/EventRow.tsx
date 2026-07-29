import type { CapturedEvent, Envelope } from "@wevna/protocol";

function summarize(event: CapturedEvent): string {
  if (event.kind === "console.log" && typeof event.attributes.message === "string") {
    return event.attributes.message;
  }
  return "";
}

export interface EventRowProps {
  event: Envelope<CapturedEvent>;
  selected: boolean;
  onSelect: () => void;
}

export function EventRow({ event, selected, onSelect }: EventRowProps) {
  const { kind, occurredAt } = event.payload;
  const className = selected ? "event-row event-row--selected" : "event-row";

  return (
    <li className={className}>
      <button type="button" className="event-row__button" onClick={onSelect}>
        <span className="event-row__kind">{kind}</span>
        <span className="event-row__time">{new Date(occurredAt).toLocaleTimeString()}</span>
        <span className="event-row__summary">{summarize(event.payload)}</span>
      </button>
    </li>
  );
}
