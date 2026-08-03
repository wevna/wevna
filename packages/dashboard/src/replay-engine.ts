import type { CapturedEvent, Envelope } from "@wevna/protocol";

export type PlaybackState = "playing" | "paused";

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
// snapshot-engine.ts for turning a position into dashboard state, and
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
      this.#state = "paused";
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
          this.#state = "paused";
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
