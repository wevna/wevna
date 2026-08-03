import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { type PlaybackState, ReplayEngine } from "./replay-engine.ts";
import type { RequestModel } from "./request-store.ts";
import { SnapshotEngine } from "./snapshot-engine.ts";

export interface ReplaySourceSnapshot {
  events: readonly Envelope<CapturedEvent>[];
  requests: readonly RequestModel[];
  position: number;
  totalEvents: number;
  timestamp: number | undefined;
  state: PlaybackState;
  speed: number;
}

export interface ReplayControls {
  play(): void;
  pause(): void;
  restart(): void;
  stepForward(): void;
  stepBackward(): void;
  seek(position: number): void;
  seekToTime(timestampMs: number): void;
  setSpeed(speed: number): void;
}

export type ReplayEventSourceListener = () => void;

// The dashboard-facing seam a recording plugs into: composes the two
// independent engines — ReplayEngine owns *when*/*how fast*, SnapshotEngine
// owns *what the dashboard should show* at a given position — into one
// subscribe/getSnapshot surface, matching every other store in this
// package (EventStore, RequestStore, TimelineStore, SelectionStore) so
// use-replay-event-source.ts can bridge it into React the same way they
// already are. Neither ReplayEngine nor SnapshotEngine needs to know the
// other exists; this is the only thing that does.
export class ReplayEventSource {
  #replay = new ReplayEngine();
  #snapshotEngine = new SnapshotEngine();
  #listeners = new Set<ReplayEventSourceListener>();
  #snapshot: ReplaySourceSnapshot;
  #unsubscribeReplay: () => void;

  controls: ReplayControls = {
    play: () => this.#replay.play(),
    pause: () => this.#replay.pause(),
    restart: () => this.#replay.restart(),
    stepForward: () => this.#replay.stepForward(),
    stepBackward: () => this.#replay.stepBackward(),
    seek: (position: number) => this.#replay.seek(position),
    seekToTime: (timestampMs: number) => this.#replay.seekToTime(timestampMs),
    setSpeed: (speed: number) => this.#replay.setSpeed(speed),
  };

  constructor() {
    this.#snapshot = this.#buildSnapshot();
    this.#unsubscribeReplay = this.#replay.subscribe(() => this.#notify());
  }

  // (Re)initializes both engines with a freshly loaded recording. Order
  // matters: the snapshot engine's checkpoints must exist *before* the
  // replay engine's own load() fires its subscriber (this class's
  // #notify), or the very first snapshot built would ask the snapshot
  // engine for a position it hasn't rebuilt checkpoints for yet.
  load(events: readonly Envelope<CapturedEvent>[]): void {
    this.#snapshotEngine.load(events);
    this.#replay.load(events);
  }

  getSnapshot = (): ReplaySourceSnapshot => {
    return this.#snapshot;
  };

  subscribe = (listener: ReplayEventSourceListener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  // Cancels any in-flight playback timer — call on unmount so a
  // component going away doesn't leave a setTimeout advancing a replay
  // nobody's watching.
  dispose(): void {
    this.#replay.pause();
    this.#unsubscribeReplay();
  }

  #buildSnapshot(): ReplaySourceSnapshot {
    const replaySnapshot = this.#replay.getSnapshot();
    const dashboardSnapshot = this.#snapshotEngine.getSnapshot(replaySnapshot.position);
    return { ...replaySnapshot, ...dashboardSnapshot };
  }

  #notify(): void {
    this.#snapshot = this.#buildSnapshot();
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
