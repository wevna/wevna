import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { summarizeEvent } from "./summarize-event.ts";

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
        <span className="event-row__summary">{summarizeEvent(event.payload)}</span>
      </button>
    </li>
  );
}
