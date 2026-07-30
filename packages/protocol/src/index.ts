// Identifies that multiple CapturedEvents originated from the same
// execution flow (e.g. everything that happened while handling one HTTP
// request). Deliberately minimal for now — future metadata (a parentId for
// nested flows, a depth for how far nested) can be added here as
// additional optional fields without touching CapturedEvent's shape again.
export interface Correlation {
  id: string;
}

// A single observation made by the runtime. This is deliberately generic —
// event-specific shapes (HTTP, SQL, Redis, BullMQ, ...) are not modelled
// here; callers narrow `attributes` themselves until those subtypes exist.
//
// `correlation` is optional and omitted entirely (not present as a key)
// when no correlation context was active when the event was published —
// existing consumers that don't know about it are unaffected.
export interface CapturedEvent {
  id: string;
  kind: string;
  occurredAt: number;
  attributes: Record<string, unknown>;
  correlation?: Correlation;
}

export type SessionStatus = "running" | "stopped";

// A single in-memory execution of Wevna. This is not persisted and carries
// no recorded events yet — later milestones (runtime events, transport,
// storage, timeline, replay, graph) all attach to a session by id rather
// than introducing their own identifier scheme.
export interface Session {
  id: string;
  startedAt: number;
  status: SessionStatus;
}

// The wire wrapper around any protocol payload — a CapturedEvent, a Session,
// or a future payload type. Every subsystem that moves data between the
// SDK, runtime, server, and dashboard agrees on this shape rather than
// inventing its own per payload type.
export interface Envelope<T> {
  version: number;
  sessionId: string;
  sequence: number;
  payload: T;
}

// The current protocol version, stamped onto every Envelope. Callers that
// construct envelopes should consume this rather than hardcoding a literal,
// so a future protocol revision only needs to change it in one place.
export const PROTOCOL_VERSION = 1;
