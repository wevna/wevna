// A single observation made by the runtime. This is deliberately generic —
// event-specific shapes (HTTP, SQL, Redis, BullMQ, ...) are not modelled
// here; callers narrow `attributes` themselves until those subtypes exist.
export interface CapturedEvent {
  id: string;
  kind: string;
  occurredAt: number;
  attributes: Record<string, unknown>;
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
