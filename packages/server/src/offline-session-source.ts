import type { CapturedEvent, Envelope, Session } from "@wevna/protocol";

export interface OfflineSessionMetadata {
  session: Session;
  formatVersion: number;
  protocolVersion: number;
  recordingStartedAt: number;
  recordingEndedAt: number | undefined;
  eventCount: number | undefined;
}

// Structural, exactly like EventSource in websocket-transport.ts and for
// the same reason: @wevna/server must not depend on @wevna/sdk (sdk
// already depends on server), so this describes only what the server
// needs to serve the offline session routes, rather than importing
// SessionLoader directly. A SDK-side loader-backed object satisfies this
// without either package importing the other.
export interface OfflineSessionSource {
  getMetadata(): OfflineSessionMetadata;
  getEvents(): AsyncIterable<Envelope<CapturedEvent>>;
}
