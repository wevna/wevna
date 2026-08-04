import { buildRequestModel, compareEvents, type RequestModel } from "@wevna/intelligence";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { MAX_LIVE_REQUESTS } from "./retention.ts";

export type RequestStoreListener = () => void;

// Keeps one correlation's events in the chronological order compareEvents
// defines. Live events usually arrive already in order, so the scan from
// the end normally stops immediately; it only walks backwards for the
// out-of-order arrivals a WebSocket can genuinely deliver.
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

// Derives a request-oriented view over EventStore's raw events, grouping
// everything sharing a correlation id into one RequestModel. EventStore
// remains the single source of truth for events themselves; this store
// never copies an event, only groups references to the same objects
// EventStore already holds, and rebuilds only the one RequestModel whose
// correlation an incoming event belongs to — every other request's model
// is untouched.
//
// What a request *is* — buildRequestModel, and the chronological order it
// assumes — belongs to @wevna/intelligence, not here: this store owns only
// *when* a model is rebuilt and who gets told about it. That split is what
// lets replay's SnapshotEngine produce byte-identical requests from a
// recording without touching any dashboard code.
//
// getRequests()'s array is rebuilt lazily, on next read after a change,
// rather than on every addEvent — a burst of events (the common case: one
// HTTP request producing several) invalidates the cache once and pays the
// O(request count) rebuild cost once, not per event.
//
// Bounded, oldest-first — see retention.ts. This is what actually releases
// memory: a RequestModel holds references to its own events, so capping the
// event list alone would keep every correlated event alive as long as a
// request still pointed at it.
export class RequestStore {
  #requestsById = new Map<string, RequestModel>();
  #snapshot: readonly RequestModel[] | undefined;
  #listeners = new Set<RequestStoreListener>();
  readonly #maxRequests: number;

  // Injectable only so tests can drive eviction cheaply; production always
  // uses the default.
  constructor(maxRequests: number = MAX_LIVE_REQUESTS) {
    this.#maxRequests = Math.max(1, maxRequests);
  }

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
    this.#evictOldest();

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

  // Map iteration order is insertion order, so the first key is the
  // oldest-seen correlation. An existing request receiving another event does
  // not move in that order, which is what we want: age is when a request
  // started, not when it was last touched.
  #evictOldest(): void {
    while (this.#requestsById.size > this.#maxRequests) {
      const oldest = this.#requestsById.keys().next();
      if (oldest.done) {
        return;
      }
      this.#requestsById.delete(oldest.value);
    }
  }

  #invalidate(): void {
    this.#snapshot = undefined;
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
