import { randomUUID } from "node:crypto";
import type { Session } from "@wevna/protocol";

// Session transition logic lives here, next to Runtime, since Runtime is
// the only thing allowed to own a session's lifecycle. The Session shape
// itself lives in @wevna/protocol, since later milestones (server routes,
// dashboard display) will need to agree on that shape too.
//
// Sessions are treated as immutable values: each transition returns a new
// object rather than mutating the one passed in.

export function createSession(): Session {
  return {
    id: randomUUID(),
    startedAt: Date.now(),
    status: "running",
  };
}

export function stopSession(session: Session): Session {
  return {
    ...session,
    status: "stopped",
  };
}
