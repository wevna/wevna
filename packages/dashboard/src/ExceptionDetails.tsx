import type { CapturedEvent } from "@wevna/protocol";

export interface ExceptionDetailsProps {
  attributes: CapturedEvent["attributes"];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// The dedicated exception view, nested inside EventDetails when the
// selected event is an exception.captured — not a separate navigation
// surface (see App.tsx/EventDetails.tsx: it renders through the exact same
// selected-event panel every other kind already uses). Stack trace is
// rendered exactly as captured — no source mapping or symbolication, both
// out of scope for this milestone.
export function ExceptionDetails({ attributes }: ExceptionDetailsProps) {
  const name = asString(attributes.name) ?? "Error";
  const message = asString(attributes.message);
  const stack = asString(attributes.stack);

  return (
    <div className="exception-details">
      <dl className="exception-details__fields">
        <dt>Error Type</dt>
        <dd>{name}</dd>
        <dt>Message</dt>
        <dd>{message ?? "—"}</dd>
      </dl>
      {stack !== undefined ? (
        <>
          <h2 className="exception-details__stack-heading">Stack Trace</h2>
          <pre className="exception-details__stack">{stack}</pre>
        </>
      ) : null}
    </div>
  );
}
