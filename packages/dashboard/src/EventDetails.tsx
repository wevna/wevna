import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { ExceptionDetails } from "./ExceptionDetails.tsx";

export interface EventDetailsProps {
  event: Envelope<CapturedEvent> | undefined;
  // Only known when the caller has request/timeline context to derive it
  // from (see App.tsx, which looks it up across every request's own
  // timeline) — omitted elsewhere, in which case "Time Within Request"
  // simply doesn't render rather than showing something misleading.
  relativeOffsetMs?: number;
}

function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

export function EventDetails({ event, relativeOffsetMs }: EventDetailsProps) {
  if (!event) {
    return <p className="event-details__empty">Select an event to see its details.</p>;
  }

  const { id, kind, occurredAt, attributes, correlation, source } = event.payload;

  return (
    <div className="event-details">
      <dl className="event-details__fields">
        <dt>Event ID</dt>
        <dd>{id}</dd>
        <dt>Kind</dt>
        <dd>{kind}</dd>
        {/* Present for any plugin-produced event, which now includes the
            built-in pg/redis producers (they are registered plugins named
            wevna:pg / wevna:redis). Absent for the always-on producers that
            have no plugin to attribute to — console, HTTP, exceptions.
            Shown because "which plugin emitted this" is the first question
            when an event looks wrong, and two plugins may legitimately emit
            the same kind. */}
        {source ? (
          <>
            <dt>Source Plugin</dt>
            <dd>{source}</dd>
          </>
        ) : null}
        <dt>Occurred At</dt>
        <dd>{new Date(occurredAt).toLocaleString()}</dd>
        {relativeOffsetMs !== undefined ? (
          <>
            <dt>Time Within Request</dt>
            <dd>+{formatMs(relativeOffsetMs)}</dd>
          </>
        ) : null}
        {correlation ? (
          <>
            <dt>Correlation ID</dt>
            <dd>{correlation.id}</dd>
          </>
        ) : null}
      </dl>

      {/* Not a separate navigation surface — the same selected-event panel
          every other kind renders through, just with a richer view for
          this one kind. */}
      {kind === "exception.captured" ? <ExceptionDetails attributes={attributes} /> : null}

      <h2 className="event-details__attributes-heading">Attributes</h2>
      <pre className="event-details__attributes">{JSON.stringify(attributes, null, 2)}</pre>
    </div>
  );
}
