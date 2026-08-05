import type { RequestModel } from "@wevna/intelligence";
import { getEventKindCategory } from "./event-kind-category.ts";

export interface SessionTimelineRow {
  request: RequestModel;
  leftPercent: number;
  widthPercent: number;
  isInstantaneous: boolean;
  isError: boolean;
}

export interface SessionTimelineLayout {
  // 0 when it couldn't be determined (no requests, or every request
  // started at the same instant with no measured duration) — every row
  // then degrades to a zero-width marker at the start, same convention
  // as computeTimelineLayout in timeline-layout.ts.
  totalDurationMs: number;
  rows: readonly SessionTimelineRow[];
}

function clampPercent(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

// A request counts as an error for the ribbon's colouring independently
// of its lifecycle `status` (which only ever says pending/complete, see
// RequestModel) — either the HTTP layer reported one (statusCode >= 400)
// or something inside the request threw, even if the response itself
// looked fine (e.g. an error logged after the response was already sent).
export function isErrorRequest(request: RequestModel): boolean {
  if (request.statusCode !== undefined && request.statusCode >= 400) {
    return true;
  }
  return request.events.some((event) => getEventKindCategory(event.payload.kind) === "exception");
}

// Converts every request in a session into dimensionless, proportional
// layout data positioned across the *whole session's* timespan — the
// session-wide counterpart to computeTimelineLayout (timeline-layout.ts),
// which only ever lays out one request's own timeline. A request is
// positioned by its absolute startedAt relative to the session's
// earliest request, sized by its own durationMs; a still-pending request
// (no durationMs yet) renders as a marker at its start instead of a
// zero-width bar collapsing the layout.
export function computeSessionTimelineLayout(
  requests: readonly RequestModel[],
): SessionTimelineLayout {
  if (requests.length === 0) {
    return { totalDurationMs: 0, rows: [] };
  }

  const sessionStartMs = requests.reduce(
    (min, r) => Math.min(min, r.startedAt),
    Number.POSITIVE_INFINITY,
  );
  const sessionEndMs = requests.reduce((max, r) => {
    const end = r.startedAt + (r.durationMs && r.durationMs > 0 ? r.durationMs : 0);
    return Math.max(max, end);
  }, sessionStartMs);

  const totalDurationMs = sessionEndMs - sessionStartMs;

  if (totalDurationMs <= 0) {
    return {
      totalDurationMs: 0,
      rows: requests.map((request) => ({
        request,
        leftPercent: 0,
        widthPercent: 0,
        isInstantaneous: true,
        isError: isErrorRequest(request),
      })),
    };
  }

  return {
    totalDurationMs,
    rows: requests.map((request) => {
      const durationMs = request.durationMs && request.durationMs > 0 ? request.durationMs : 0;
      const leftPercent = clampPercent(
        ((request.startedAt - sessionStartMs) / totalDurationMs) * 100,
      );
      const rawWidthPercent = (durationMs / totalDurationMs) * 100;
      const widthPercent = clampPercent(Math.min(rawWidthPercent, 100 - leftPercent));

      return {
        request,
        leftPercent,
        widthPercent,
        isInstantaneous: widthPercent <= 0,
        isError: isErrorRequest(request),
      };
    }),
  };
}
