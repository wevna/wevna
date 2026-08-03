import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { buildRequestModel, type RequestModel } from "./request-store.ts";

export interface DashboardSnapshot {
  events: readonly Envelope<CapturedEvent>[];
  requests: readonly RequestModel[];
}

interface Checkpoint {
  // Number of events already applied to reach requestsById.
  index: number;
  requestsById: ReadonlyMap<string, RequestModel>;
}

// sqrt(n) checkpoints balances the two costs a seek pays: cloning a
// checkpoint's request map (cost grows with how many requests exist by
// that point) and replaying the events between the checkpoint and the
// target position (cost grows with the interval). Neither grows
// unboundedly as recordings get larger. A floor keeps small recordings
// from bothering with checkpoints they'll never need.
function checkpointInterval(totalEvents: number): number {
  return Math.max(50, Math.ceil(Math.sqrt(totalEvents)));
}

// Events are always applied in the same chronological order the whole
// recording is already sorted in (see SessionLoader / RequestStore's own
// compareEvents), so a plain append preserves each correlation's order
// without needing RequestStore's insertSorted — a correlation's own
// events are always a subsequence of that global order.
function applyEvent(requestsById: Map<string, RequestModel>, event: Envelope<CapturedEvent>): void {
  const correlationId = event.payload.correlation?.id;
  if (!correlationId) {
    return;
  }
  const existing = requestsById.get(correlationId);
  const events = existing ? [...existing.events, event] : [event];
  requestsById.set(correlationId, buildRequestModel(correlationId, events));
}

function buildCheckpoints(events: readonly Envelope<CapturedEvent>[]): readonly Checkpoint[] {
  const interval = checkpointInterval(events.length);
  const checkpoints: Checkpoint[] = [{ index: 0, requestsById: new Map() }];

  const requestsById = new Map<string, RequestModel>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event) {
      applyEvent(requestsById, event);
    }
    if ((index + 1) % interval === 0) {
      // Frozen in time: a clone here, so later mutations of the shared
      // working map never retroactively change an earlier checkpoint.
      // Requests that don't change between checkpoints keep the exact
      // same RequestModel object reference across them — only requests
      // still actively receiving events pay for a new array each time,
      // the same cost RequestStore itself already accepts for live mode.
      checkpoints.push({ index: index + 1, requestsById: new Map(requestsById) });
    }
  }

  return checkpoints;
}

// Reconstructs dashboard state — currently the event list and the
// derived request list — at any position in an already-loaded recording.
// Everything else the dashboard shows (performance insights, the
// execution graph, exception details) is computed from a RequestModel's
// own timeline by @wevna/intelligence, purely and on demand, so there is
// nothing further to reconstruct here: producing a correct, deterministic
// `requests` array is the whole job.
//
// Deliberately not a full snapshot per event: for a recording with N
// events, that would make every seek cost O(N) to rebuild every request
// from scratch. Instead this precomputes periodic checkpoints once — a
// single O(N) pass at load time, no worse than loading the recording
// already costs — and answers each seek by replaying forward from the
// nearest checkpoint at or before the target position, bounded by the
// checkpoint interval rather than by how far into the recording the
// target is. Checkpoints only ever need to be walked forward: they exist
// at every interval boundary including 0, so seeking backward just means
// picking an earlier checkpoint, never "undoing" work.
export class SnapshotEngine {
  #events: readonly Envelope<CapturedEvent>[] = [];
  #checkpoints: readonly Checkpoint[] = [{ index: 0, requestsById: new Map() }];
  #lastPosition: number | undefined;
  #lastSnapshot: DashboardSnapshot | undefined;

  // (Re)initializes the engine with a freshly loaded recording, rebuilding
  // its checkpoints. Safe to call more than once.
  load(events: readonly Envelope<CapturedEvent>[]): void {
    this.#events = events;
    this.#checkpoints = buildCheckpoints(events);
    this.#lastPosition = undefined;
    this.#lastSnapshot = undefined;
  }

  // Deterministic: the same position always yields an equal — and, while
  // nothing else has changed, reference-equal, see the cache below —
  // snapshot, regardless of how many times or in what order it's called.
  getSnapshot(position: number): DashboardSnapshot {
    const clamped = Math.max(0, Math.min(Math.trunc(position), this.#events.length));
    if (clamped === this.#lastPosition && this.#lastSnapshot) {
      return this.#lastSnapshot;
    }

    const checkpoint = this.#nearestCheckpoint(clamped);
    const requestsById = new Map(checkpoint.requestsById);
    for (let index = checkpoint.index; index < clamped; index += 1) {
      const event = this.#events[index];
      if (event) {
        applyEvent(requestsById, event);
      }
    }

    const snapshot: DashboardSnapshot = {
      events: this.#events.slice(0, clamped),
      requests: Array.from(requestsById.values()),
    };
    this.#lastPosition = clamped;
    this.#lastSnapshot = snapshot;
    return snapshot;
  }

  // Largest checkpoint index <= position — checkpoints[0] (index 0)
  // guarantees a match always exists.
  #nearestCheckpoint(position: number): Checkpoint {
    let low = 0;
    let high = this.#checkpoints.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      const candidate = this.#checkpoints[mid];
      if (candidate && candidate.index <= position) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return this.#checkpoints[low] as Checkpoint;
  }
}
