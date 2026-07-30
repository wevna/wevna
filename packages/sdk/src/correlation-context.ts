import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Correlation } from "@wevna/protocol";

// A single, module-level store: correlation tracks the active async
// execution flow, not per-Runtime-instance state, so one shared
// AsyncLocalStorage is the correct scope — mirroring how Runtime itself is
// a per-process singleton (see index.ts).
//
// This is the only file in the SDK that touches AsyncLocalStorage directly.
// Everything else (Runtime, instrumentation) goes through the three
// functions below, so nothing needs to understand async_hooks to
// participate in correlation.
const storage = new AsyncLocalStorage<Correlation>();

// The correlation active for the currently-executing async flow, if any.
// Runtime.publish() calls this for every event so producers never need to
// pass a correlation id around themselves.
export function currentCorrelation(): Correlation | undefined {
  return storage.getStore();
}

// Starts a brand-new correlation and runs fn inside it. The correlation
// stays active for fn's entire execution, including any asynchronous work
// fn kicks off — awaited calls, promises, timers, and event listeners
// registered while fn is running all correctly see it later, even after
// fn itself has returned. This is what lets an incoming HTTP request
// establish one correlation that every event during that request's
// handling automatically inherits, with no manual id-passing.
export function startCorrelation<T>(fn: () => T): T {
  return storage.run({ id: randomUUID() }, fn);
}

// Runs fn inside a specific, already-known correlation rather than
// starting a new one — for deliberately continuing an existing flow (e.g.
// a background task explicitly picking up its trigger's correlation).
// Not used by anything in this milestone, but the composition point future
// producers (queues, workers) will need without requiring a redesign here.
export function runWithCorrelation<T>(correlation: Correlation, fn: () => T): T {
  return storage.run(correlation, fn);
}
