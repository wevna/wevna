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

// The recording *file* format — versioned separately from PROTOCOL_VERSION
// (which only versions Envelope/CapturedEvent's own shape) because the two
// can evolve independently: a future recording format revision (e.g. an
// added compression field) doesn't imply a new protocol version, and vice
// versa. Lives here, next to the types it wraps, for the same reason
// Envelope/CapturedEvent/Session do: any future consumer of a recording
// file (a reader, a replay tool, ...) needs to agree on this shape the same
// way any live consumer already agrees on Envelope's.
export const RECORDING_FORMAT_VERSION = 1;

// A session recording file is a JSON Lines (JSONL/NDJSON) stream: one
// RecordingLine per line, in write order — never one big JSON document.
// That makes appending a single, cheap write with nothing to rewrite or
// keep balanced as the file grows, lets a future reader stream it
// line-by-line instead of loading the whole file into memory, and means a
// recording that stopped abruptly (process crash, disk full) is still
// valid up to its last complete line rather than corrupt as a whole.
//
// Exactly one RecordingHeader (first line), any number of
// RecordingEventRecords in publish order, and — only on a clean stop —
// exactly one RecordingFooter (last line). A reader should treat a missing
// footer as "recording ended abnormally," not as an invalid file.
export interface RecordingHeader {
  type: "header";
  formatVersion: number;
  // The PROTOCOL_VERSION in effect when this recording started, so a
  // reader always knows how to interpret the envelopes that follow even if
  // read by a future version of this package.
  protocolVersion: number;
  session: Session;
  recordingStartedAt: number;
}

export interface RecordingEventRecord {
  type: "event";
  envelope: Envelope<CapturedEvent>;
}

export interface RecordingFooter {
  type: "footer";
  recordingEndedAt: number;
  eventCount: number;
}

export type RecordingLine = RecordingHeader | RecordingEventRecord | RecordingFooter;
