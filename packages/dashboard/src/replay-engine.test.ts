import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayEngine } from "./replay-engine.ts";

function makeEvent(occurredAt: number, sequence: number): Envelope<CapturedEvent> {
  return {
    version: 1,
    sessionId: "session-1",
    sequence,
    payload: {
      id: `event-${sequence}`,
      kind: "console.log",
      occurredAt,
      attributes: {},
    },
  };
}

// 0ms, 14ms, 27ms, 102ms — the exact example from the PR spec.
const TIMED_EVENTS = [makeEvent(0, 1), makeEvent(14, 2), makeEvent(27, 3), makeEvent(102, 4)];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ReplayEngine", () => {
  describe("initial state", () => {
    it("starts fully played (position === totalEvents), paused", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);

      const snapshot = engine.getSnapshot();
      expect(snapshot.position).toBe(4);
      expect(snapshot.totalEvents).toBe(4);
      expect(snapshot.state).toBe("paused");
      expect(snapshot.speed).toBe(1);
      expect(snapshot.timestamp).toBe(102);
    });

    it("handles an empty recording without error", () => {
      const engine = new ReplayEngine();
      engine.load([]);

      const snapshot = engine.getSnapshot();
      expect(snapshot.position).toBe(0);
      expect(snapshot.totalEvents).toBe(0);
      expect(snapshot.timestamp).toBeUndefined();
      expect(snapshot.state).toBe("paused");
    });
  });

  describe("restart", () => {
    it("resets to position 0 and starts playing", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);

      engine.restart();

      const snapshot = engine.getSnapshot();
      expect(snapshot.position).toBe(0);
      expect(snapshot.state).toBe("playing");
    });

    it("does not start playing for an empty recording", () => {
      const engine = new ReplayEngine();
      engine.load([]);

      engine.restart();

      expect(engine.getSnapshot().state).toBe("paused");
    });
  });

  describe("play / pause", () => {
    it("advances position over time, preserving recorded relative timing", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);
      engine.restart();

      expect(engine.getSnapshot().position).toBe(0);

      vi.advanceTimersByTime(14);
      expect(engine.getSnapshot().position).toBe(2);
      expect(engine.getSnapshot().timestamp).toBe(14);

      vi.advanceTimersByTime(13);
      expect(engine.getSnapshot().position).toBe(3);

      vi.advanceTimersByTime(75);
      expect(engine.getSnapshot().position).toBe(4);
      expect(engine.getSnapshot().state).toBe("paused");
    });

    it("pause stops advancing and cancels the pending timer", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);
      engine.restart();

      vi.advanceTimersByTime(14);
      engine.pause();
      const positionAtPause = engine.getSnapshot().position;

      vi.advanceTimersByTime(1000);

      expect(engine.getSnapshot().position).toBe(positionAtPause);
      expect(engine.getSnapshot().state).toBe("paused");
    });

    it("play is a no-op while already playing", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);
      engine.restart();

      engine.play();
      vi.advanceTimersByTime(14);

      expect(engine.getSnapshot().position).toBe(2);
    });

    it("play resumes from the current position, not from the start", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);
      engine.seek(2);

      engine.play();
      // (27 - 14) + (102 - 27) = 88ms to cover positions 2 -> 4 from here.
      vi.advanceTimersByTime(88);

      expect(engine.getSnapshot().position).toBe(4);
    });

    it("play at the end of the recording is a no-op", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);

      engine.play();

      expect(engine.getSnapshot().state).toBe("paused");
    });
  });

  describe("stepping", () => {
    it("stepForward advances by exactly one event and pauses", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);
      engine.seek(0);

      engine.stepForward();

      expect(engine.getSnapshot().position).toBe(1);
      expect(engine.getSnapshot().state).toBe("paused");
    });

    it("stepForward does not advance past the end", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);

      engine.stepForward();

      expect(engine.getSnapshot().position).toBe(4);
    });

    it("stepBackward retreats by exactly one event", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);

      engine.stepBackward();

      expect(engine.getSnapshot().position).toBe(3);
    });

    it("stepBackward does not retreat past the start", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);
      engine.seek(0);

      engine.stepBackward();

      expect(engine.getSnapshot().position).toBe(0);
    });

    it("stepping while playing cancels playback", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);
      engine.restart();

      engine.stepForward();
      const position = engine.getSnapshot().position;
      vi.advanceTimersByTime(1000);

      expect(engine.getSnapshot().state).toBe("paused");
      expect(engine.getSnapshot().position).toBe(position);
    });
  });

  describe("seek by index", () => {
    it("jumps directly to the given position", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);

      engine.seek(2);

      expect(engine.getSnapshot().position).toBe(2);
      expect(engine.getSnapshot().timestamp).toBe(14);
    });

    it("clamps below 0", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);

      engine.seek(-5);

      expect(engine.getSnapshot().position).toBe(0);
    });

    it("clamps above totalEvents", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);

      engine.seek(999);

      expect(engine.getSnapshot().position).toBe(4);
    });

    it("pauses playback", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);
      engine.restart();

      engine.seek(3);

      expect(engine.getSnapshot().state).toBe("paused");
      vi.advanceTimersByTime(1000);
      expect(engine.getSnapshot().position).toBe(3);
    });
  });

  describe("seek by timestamp", () => {
    it("resolves to the count of events at or before the given time", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);

      engine.seekToTime(20);

      // Events at 0ms and 14ms are <= 20ms; 27ms and 102ms are not.
      expect(engine.getSnapshot().position).toBe(2);
    });

    it("resolves to 0 for a time before the first event", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);

      engine.seekToTime(-1);

      expect(engine.getSnapshot().position).toBe(0);
    });

    it("resolves to totalEvents for a time after the last event", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);

      engine.seekToTime(999999);

      expect(engine.getSnapshot().position).toBe(4);
    });

    it("resolves exactly on an event's own timestamp (inclusive)", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);

      engine.seekToTime(27);

      expect(engine.getSnapshot().position).toBe(3);
    });
  });

  describe("playback speed", () => {
    it("halves the wait at 2x speed", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);
      // Position 2 means events[0] and events[1] (0ms, 14ms) have
      // already played — the recorded gap to the next event (27ms) is
      // 13ms, so at 2x speed it should take 6.5ms.
      engine.seek(2);
      engine.setSpeed(2);

      engine.play();
      vi.advanceTimersByTime(7);

      expect(engine.getSnapshot().position).toBe(3);
    });

    it("doubles the wait at 0.5x speed", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);
      engine.seek(2);
      engine.setSpeed(0.5);

      engine.play();
      vi.advanceTimersByTime(27);

      expect(engine.getSnapshot().position).toBe(3);
    });

    it("supports every documented speed multiplier without changing recorded timestamps", () => {
      for (const speed of [0.25, 0.5, 1, 2, 4, 8]) {
        const engine = new ReplayEngine();
        engine.load(TIMED_EVENTS);
        engine.setSpeed(speed);
        engine.restart();

        vi.advanceTimersByTime((102 / speed) * 2);

        expect(engine.getSnapshot().position).toBe(4);
        expect(engine.getSnapshot().timestamp).toBe(102);
      }
    });

    it("ignores a non-positive speed", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);

      engine.setSpeed(0);
      engine.setSpeed(-1);

      expect(engine.getSnapshot().speed).toBe(1);
    });

    it("reports the current speed in the snapshot", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);

      engine.setSpeed(4);

      expect(engine.getSnapshot().speed).toBe(4);
    });
  });

  describe("end-of-recording behaviour", () => {
    it("auto-pauses exactly at the last event, without overshooting", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);
      engine.restart();

      vi.advanceTimersByTime(1_000_000);

      expect(engine.getSnapshot().position).toBe(4);
      expect(engine.getSnapshot().state).toBe("paused");
    });

    it("play() does nothing further once at the end", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);
      engine.restart();
      vi.advanceTimersByTime(1_000_000);

      engine.play();
      vi.advanceTimersByTime(1_000_000);

      expect(engine.getSnapshot().position).toBe(4);
      expect(engine.getSnapshot().state).toBe("paused");
    });

    it("seeking back from the end and playing again reaches the end once more", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);
      engine.restart();
      vi.advanceTimersByTime(1_000_000);

      engine.seek(1);
      engine.play();
      vi.advanceTimersByTime(1_000_000);

      expect(engine.getSnapshot().position).toBe(4);
      expect(engine.getSnapshot().state).toBe("paused");
    });
  });

  describe("subscribe", () => {
    it("notifies listeners on every state change", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);
      const listener = vi.fn();
      engine.subscribe(listener);

      engine.seek(1);
      engine.seek(2);

      expect(listener).toHaveBeenCalledTimes(2);
    });

    it("stops notifying after unsubscribe", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);
      const listener = vi.fn();
      const unsubscribe = engine.subscribe(listener);

      unsubscribe();
      engine.seek(1);

      expect(listener).not.toHaveBeenCalled();
    });

    it("notifies on every tick while playing", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);
      engine.seek(0);
      const listener = vi.fn();
      engine.subscribe(listener);

      engine.play();
      vi.advanceTimersByTime(1_000_000);

      // One notify for play() itself, then one per event advanced (4).
      expect(listener).toHaveBeenCalledTimes(5);
    });
  });

  describe("reload", () => {
    it("load() is safe to call more than once and resets to fully played", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);
      engine.seek(1);

      engine.load(TIMED_EVENTS.slice(0, 2));

      expect(engine.getSnapshot().position).toBe(2);
      expect(engine.getSnapshot().totalEvents).toBe(2);
    });

    it("load() cancels any in-flight playback from the previous recording", () => {
      const engine = new ReplayEngine();
      engine.load(TIMED_EVENTS);
      engine.restart();
      vi.advanceTimersByTime(14);

      engine.load(TIMED_EVENTS);
      vi.advanceTimersByTime(1000);

      expect(engine.getSnapshot().position).toBe(4);
      expect(engine.getSnapshot().state).toBe("paused");
    });
  });
});
