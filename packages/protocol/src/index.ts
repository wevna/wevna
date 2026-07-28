// TODO: Define the real shape of a captured runtime event (source, kind,
// timestamp, payload, correlation ids) once the capture pipeline is designed.
// biome-ignore lint/suspicious/noEmptyInterface: placeholder until the shape is designed
export interface CapturedEvent {}

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

// TODO: Define the wire envelope used to transport captured events from the
// SDK to the local server once the transport layer is implemented.
// biome-ignore lint/suspicious/noEmptyInterface: placeholder until the shape is designed
export interface Envelope {}
