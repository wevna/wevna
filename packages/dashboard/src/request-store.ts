import type { CapturedEvent, Envelope } from "@wevna/protocol";

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
  // The same Envelope objects EventStore already holds — never copied —
  // in chronological order.
  events: readonly Envelope<CapturedEvent>[];
}

export type RequestStoreListener = () => void;

// Chronological, not arrival order: an event's occurredAt is set
// server-side when Runtime.publish() processed it, so this stays correct
// even if events reach the dashboard out of order over the WebSocket.
// occurredAt can collide (two events in the same millisecond), so sequence
// — strictly increasing per session — breaks the tie deterministically.
function compareEvents(a: Envelope<CapturedEvent>, b: Envelope<CapturedEvent>): number {
  if (a.payload.occurredAt !== b.payload.occurredAt) {
    return a.payload.occurredAt - b.payload.occurredAt;
  }
  return a.sequence - b.sequence;
}

function insertSorted(
  events: readonly Envelope<CapturedEvent>[],
  event: Envelope<CapturedEvent>,
): readonly Envelope<CapturedEvent>[] {
  let index = events.length;
  while (index > 0) {
    const previous = events[index - 1];
    if (!previous || compareEvents(previous, event) <= 0) {
      break;
    }
    index -= 1;
  }
  return [...events.slice(0, index), event, ...events.slice(index)];
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

function buildRequestModel(
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
  };
}

// Derives a request-oriented view over EventStore's raw events, grouping
// everything sharing a correlation id into one RequestModel. EventStore
// remains the single source of truth for events themselves; this store
// never copies an event, only groups references to the same objects
// EventStore already holds, and rebuilds only the one RequestModel whose
// correlation an incoming event belongs to — every other request's model
// is untouched.
//
// getRequests()'s array is rebuilt lazily, on next read after a change,
// rather than on every addEvent — a burst of events (the common case: one
// HTTP request producing several) invalidates the cache once and pays the
// O(request count) rebuild cost once, not per event.
export class RequestStore {
  #requestsById = new Map<string, RequestModel>();
  #snapshot: readonly RequestModel[] | undefined;
  #listeners = new Set<RequestStoreListener>();

  getRequests = (): readonly RequestModel[] => {
    if (!this.#snapshot) {
      this.#snapshot = Array.from(this.#requestsById.values());
    }
    return this.#snapshot;
  };

  getRequest = (correlationId: string): RequestModel | undefined => {
    return this.#requestsById.get(correlationId);
  };

  // Events without a correlation (background work, startup logs — see
  // correlation-context.ts) don't belong to any request and are ignored
  // here; they still live in EventStore untouched.
  addEvent(event: Envelope<CapturedEvent>): void {
    const correlationId = event.payload.correlation?.id;
    if (!correlationId) {
      return;
    }

    const existing = this.#requestsById.get(correlationId);
    const events = insertSorted(existing?.events ?? [], event);
    this.#requestsById.set(correlationId, buildRequestModel(correlationId, events));

    this.#invalidate();
  }

  clear(): void {
    if (this.#requestsById.size === 0) {
      return;
    }
    this.#requestsById = new Map();
    this.#invalidate();
  }

  // Removes every request whose events belong to the given session —
  // e.g. to drop a previous run's requests once Wevna restarts and starts
  // a new session, without needing to know which correlation ids were
  // whose.
  removeSession(sessionId: string): void {
    let changed = false;
    for (const [correlationId, request] of this.#requestsById) {
      if (request.events[0]?.sessionId === sessionId) {
        this.#requestsById.delete(correlationId);
        changed = true;
      }
    }
    if (changed) {
      this.#invalidate();
    }
  }

  subscribe = (listener: RequestStoreListener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #invalidate(): void {
    this.#snapshot = undefined;
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
