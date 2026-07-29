import type { CapturedEvent, Envelope } from "@wevna/protocol";

function summarize(event: CapturedEvent): string {
  if (event.kind === "console.log" && typeof event.attributes.message === "string") {
    return event.attributes.message;
  }
  return "";
}

export interface EventRowProps {
  event: Envelope<CapturedEvent>;
}

export function EventRow({ event }: EventRowProps) {
  const { kind, occurredAt } = event.payload;

  return (
    <li className="event-row">
      <span className="event-row__kind">{kind}</span>
      <span className="event-row__time">{new Date(occurredAt).toLocaleTimeString()}</span>
      <span className="event-row__summary">{summarize(event.payload)}</span>
    </li>
  );
}
