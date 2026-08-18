// Shared by pg-instrumentation.ts and redis-instrumentation.ts: how a
// failed operation's error is safely turned into an event attribute.
//
// Neither producer ever records query parameter values or command
// arguments — see their own file comments. A driver's error message can
// undo that on its own: Postgres, for one, echoes the offending literal
// back verbatim for some failures (e.g. `invalid input syntax for type
// integer: "abc"` reproduces a bad parameter value), even though the
// query itself was fully parameterized.
//
// Both node-postgres's DatabaseError and Node's own system errors expose a
// stable `code` (a SQLSTATE like "23505", or a system code like
// "ECONNREFUSED") that never contains data. When one is present, it is
// used instead of the free-text message. Only errors with no such code —
// generic JS errors thrown before ever reaching a driver — fall back to
// `.message`.
export function describeInstrumentationError(error: unknown): { error: string } {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      return { error: code };
    }
  }
  return { error: error instanceof Error ? error.message : String(error) };
}
