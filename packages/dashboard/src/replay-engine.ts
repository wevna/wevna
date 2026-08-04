import type { CapturedEvent, Envelope } from "@wevna/protocol";

// "paused" and "finished" are both not-advancing, but they mean different
// things and a UI legitimately wants to tell them apart: "paused" is
// stopped because something asked it to stop (pause, seek, step), while
// "finished" is playback that ran to the end of the recording on its own.
// A position at the end is not enough to distinguish them — a freshly
// opened recording also starts fully played (see load()) without ever
// having played anything.
//
// Deliberately modelled as a third state rather than an onFinished
// callback: this engine already has exactly one way to tell anyone
// anything (subscribe + getSnapshot), and a second, parallel notification
// channel would be one more thing for every consumer to wire up, forget to
// unsubscribe from, and keep consistent with the snapshot it contradicts.
export type PlaybackState = "playing" | "paused" | "finished";

export interface ReplaySnapshot {
  // How many of the loaded recording's events have "happened" so far —
  // the sole source of truth this engine advances. 0 means nothing has
  // played yet; totalEvents means fully played.
  position: number;
  totalEvents: number;
  // occurredAt of the most recently played event, or undefined at
  // position 0 (nothing has played yet).
  timestamp: number | undefined;
  state: PlaybackState;
  speed: number;
}

export type ReplayEngineListener = () => void;

// A pure, timer-driven playback position state machine over an
// already-loaded, chronologically ordered recording. It knows nothing
// about requests, dashboard stores, or React — it only ever answers "how
// many events have played, and are we currently advancing." See
// SnapshotEngine in @wevna/intelligence for turning a position into
// observable state, and
// replay-event-source.ts for where the two are composed.
export class ReplayEngine {
  #events: readonly Envelope<CapturedEvent>[] = [];
  #position = 0;
  #state: PlaybackState = "paused";
  #speed = 1;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #listeners = new Set<ReplayEngineListener>();
  #snapshot: ReplaySnapshot;

  constructor() {
    this.#snapshot = this.#buildSnapshot();
  }

  getSnapshot = (): ReplaySnapshot => {
    return this.#snapshot;
  };

  subscribe = (listener: ReplayEngineListener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  // (Re)initializes the engine with a freshly loaded recording. Starts
  // fully played (position === events.length) — matching the dashboard's
  // pre-existing "offline mode loads the whole recording" behaviour by
  // default, since replay is an additional capability layered on top, not
  // a change to what a freshly opened recording shows. Safe to call more
  // than once; cancels any playback already in progress for whatever was
  // loaded before.
  //
  // Starts "paused" rather than "finished" even though the position is at
  // the end: nothing has played, so nothing has finished. "finished" is
  // reserved for a playback that actually ran out.
  load(events: readonly Envelope<CapturedEvent>[]): void {
    this.#cancelTimer();
    this.#events = events;
    this.#position = events.length;
    this.#state = "paused";
    this.#speed = 1;
    this.#notify();
  }

  play(): void {
    if (this.#state === "playing" || this.#position >= this.#events.length) {
      return;
    }
    this.#state = "playing";
    this.#scheduleNext();
    this.#notify();
  }

  // Only a running playback can be paused. Calling this on an already
  // finished replay would otherwise rewrite "reached the end on its own"
  // into "the user stopped it", losing exactly the distinction
  // PlaybackState exists to preserve.
  pause(): void {
    if (this.#state !== "playing") {
      return;
    }
    this.#cancelTimer();
    this.#state = "paused";
    this.#notify();
  }

  // Jumps to the start and plays from there — the useful default for a
  // "run it again" button, unlike seek(0), which only moves the position
  // and leaves playback state untouched.
  restart(): void {
    this.#cancelTimer();
    this.#position = 0;
    this.#state = this.#events.length > 0 ? "playing" : "paused";
    if (this.#state === "playing") {
      this.#scheduleNext();
    }
    this.#notify();
  }

  // Stepping onto the last event leaves the state "paused", not
  // "finished": the user drove it there one event at a time, which is the
  // "stopped deliberately" case. `position === totalEvents` is what tells a
  // UI it cannot step further; "finished" specifically means playback ran
  // out on its own.
  stepForward(): void {
    this.#cancelTimer();
    this.#state = "paused";
    this.#position = Math.min(this.#position + 1, this.#events.length);
    this.#notify();
  }

  stepBackward(): void {
    this.#cancelTimer();
    this.#state = "paused";
    this.#position = Math.max(this.#position - 1, 0);
    this.#notify();
  }

  // Seeks to an absolute event count: "N events have happened." Always
  // pauses — a seek is a deliberate jump, not a request to keep playing
  // from the new spot.
  seek(position: number): void {
    this.#cancelTimer();
    this.#state = "paused";
    this.#position = Math.max(0, Math.min(Math.trunc(position), this.#events.length));
    this.#notify();
  }

  // Seeks to the position matching a recorded timestamp: the count of
  // events whose occurredAt is <= timestampMs. Requires events sorted
  // ascending by occurredAt, true of anything that reaches here (see
  // SessionLoader / RequestStore's own compareEvents).
  seekToTime(timestampMs: number): void {
    this.seek(this.#indexForTime(timestampMs));
  }

  // Rescales the delay between future ticks; does not retroactively
  // rescale a wait already in flight, so a speed change while playing
  // takes effect starting at the next event rather than instantaneously.
  setSpeed(speed: number): void {
    if (speed <= 0 || speed === this.#speed) {
      return;
    }
    this.#speed = speed;
    this.#notify();
  }

  #indexForTime(timestampMs: number): number {
    let low = 0;
    let high = this.#events.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const midEvent = this.#events[mid];
      if (midEvent && midEvent.payload.occurredAt <= timestampMs) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  #scheduleNext(): void {
    const nextEvent = this.#events[this.#position];
    if (!nextEvent) {
      this.#state = "finished";
      return;
    }
    const previousEvent = this.#position > 0 ? this.#events[this.#position - 1] : undefined;
    const previousTimestamp = previousEvent?.payload.occurredAt ?? nextEvent.payload.occurredAt;
    const delayMs = (nextEvent.payload.occurredAt - previousTimestamp) / this.#speed;

    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        this.#position += 1;
        if (this.#position >= this.#events.length) {
          this.#state = "finished";
        }
        this.#notify();
        if (this.#state === "playing") {
          this.#scheduleNext();
        }
      },
      Math.max(0, delayMs),
    );
  }

  #cancelTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #buildSnapshot(): ReplaySnapshot {
    const lastEvent = this.#position > 0 ? this.#events[this.#position - 1] : undefined;
    return {
      position: this.#position,
      totalEvents: this.#events.length,
      timestamp: lastEvent?.payload.occurredAt,
      state: this.#state,
      speed: this.#speed,
    };
  }

  #notify(): void {
    this.#snapshot = this.#buildSnapshot();
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
