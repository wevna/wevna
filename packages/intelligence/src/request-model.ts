import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { buildTimeline, type TimelineEntry } from "./request-timeline.js";

export type RequestStatus = "pending" | "complete";

export interface RequestModel {
  // Currently always equal to correlationId — kept as its own field since
  // a request and the correlation that assembled it are conceptually
  // different things, even though nothing distinguishes them yet.
  id: string;
  correlationId: string;
  method: string | undefined;
  route: string | undefined;
  statusCode: number | undefined;
  startedAt: number;
  endedAt: number | undefined;
  durationMs: number | undefined;
  status: RequestStatus;
  // The same Envelope objects the calling store already holds — never
  // copied — in chronological order.
  events: readonly Envelope<CapturedEvent>[];
  // events expressed relative to startedAt — see request-timeline.ts.
  // Purely derived from `events` and `startedAt`; carries no information
  // they don't already have.
  timeline: readonly TimelineEntry[];
}

// Chronological, not arrival order: an event's occurredAt is set
// server-side when Runtime.publish() processed it, so this stays correct
// even if events reach a consumer out of order over the WebSocket.
// occurredAt can collide (two events in the same millisecond), so sequence
// — strictly increasing per session — breaks the tie deterministically.
//
// Exported because this ordering *is* domain logic, and more than one
// consumer needs to agree on it: RequestStore sorts live arrivals with it,
// and SnapshotEngine relies on a recording already satisfying it. Two
// independent copies of this comparison would be two chances to disagree
// about what "chronological" means, and a replay that ordered events even
// slightly differently from live mode would silently stop being a faithful
// reconstruction.
export function compareEvents(a: Envelope<CapturedEvent>, b: Envelope<CapturedEvent>): number {
  if (a.payload.occurredAt !== b.payload.occurredAt) {
    return a.payload.occurredAt - b.payload.occurredAt;
  }
  return a.sequence - b.sequence;
}

// http.request is the one event kind carrying method/url/route/statusCode
// (see http-instrumentation.ts / *-enrichment.ts) and, since
// HttpInstrumentation publishes it once the response finishes, is also
// what marks a request complete. Everything else about a request
// (console.log, sql.query, redis.command, ...) only ever contributes
// itself to the events list.
function findHttpRequestEvent(
  events: readonly Envelope<CapturedEvent>[],
): Envelope<CapturedEvent> | undefined {
  return events.find((event) => event.payload.kind === "http.request");
}

// Assembles one correlation's events into the request every higher layer
// reasons about. Pure and deterministic: the same events in the same order
// always produce an equal model, with no event invented, merged, or
// dropped.
//
// This lives in @wevna/intelligence rather than in the dashboard's
// RequestStore because it is domain construction, not UI state: a store
// owns *when* a model is rebuilt and who gets notified, but not *what a
// request is*. Keeping the definition here is what lets the replay
// SnapshotEngine, and later a CLI or a regression test asserting over a
// recording, build the exact same request without importing React or
// reimplementing this grouping a second time.
export function buildRequestModel(
  correlationId: string,
  events: readonly Envelope<CapturedEvent>[],
): RequestModel {
  const startedAt = events.reduce(
    (min, event) => Math.min(min, event.payload.occurredAt),
    Number.POSITIVE_INFINITY,
  );
  const httpEvent = findHttpRequestEvent(events);
  const attributes = httpEvent?.payload.attributes;

  const method = typeof attributes?.method === "string" ? attributes.method : undefined;
  const url = typeof attributes?.url === "string" ? attributes.url : undefined;
  const route = typeof attributes?.route === "string" ? attributes.route : url;
  const statusCode = typeof attributes?.statusCode === "number" ? attributes.statusCode : undefined;
  const endedAt = httpEvent?.payload.occurredAt;

  // The attribute is already an accurately measured duration (see
  // HttpInstrumentation) — prefer it over recomputing from timestamps,
  // which stays correct even if an earlier-occurring event happens to
  // arrive after the http.request event itself.
  const attributeDurationMs = attributes?.durationMs;
  const durationMs =
    typeof attributeDurationMs === "number"
      ? attributeDurationMs
      : endedAt !== undefined
        ? endedAt - startedAt
        : undefined;

  return {
    id: correlationId,
    correlationId,
    method,
    route,
    statusCode,
    startedAt,
    endedAt,
    durationMs,
    status: httpEvent ? "complete" : "pending",
    events,
    timeline: buildTimeline(events, startedAt),
  };
}
