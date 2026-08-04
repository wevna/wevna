import type { AnalyzableRequest } from "./analyzable-request.js";
import { categorizeEvent, type EventCategory } from "./event-category.js";

export interface TimeAttribution {
  category: EventCategory;
  totalDurationMs: number;
  // Share of the request's own duration, 0–100. Rounded to one decimal so a
  // consumer can display it directly without deciding on precision.
  sharePercent: number;
}

// http.request's duration *is* the request — including it would attribute
// 100% of the time to "http" and say nothing. It is the denominator, never a
// term in the numerator.
const CONTAINER_KIND = "http.request";

// Answers "what was this request actually waiting on" — the question a
// duration alone can't. "842ms" tells a developer nothing about where to
// look; "601ms of it was PostgreSQL" tells them exactly where.
//
// Attribution is over wall-clock durations of the operations Wevna observed,
// which deliberately is not a claim about the critical path. Two queries that
// overlapped both count in full, so shares can legitimately sum past 100% for
// a request doing concurrent work. That is honest — the alternative is
// inventing a serialization the runtime never had — and it is why this
// reports per-category totals rather than a single "% of time" pie.
//
// Deterministic: sorted by descending duration, then by category name so
// equal totals never reorder between runs.
export function attributeRequestTime(request: AnalyzableRequest): readonly TimeAttribution[] {
  const totals = new Map<EventCategory, number>();

  for (const entry of request.timeline) {
    if (entry.kind === CONTAINER_KIND || entry.durationMs === undefined) {
      continue;
    }
    const category = categorizeEvent(entry.kind);
    totals.set(category, (totals.get(category) ?? 0) + entry.durationMs);
  }

  const requestDurationMs = request.durationMs;

  return [...totals.entries()]
    .map(([category, totalDurationMs]) => ({
      category,
      totalDurationMs,
      sharePercent:
        requestDurationMs !== undefined && requestDurationMs > 0
          ? Math.round((totalDurationMs / requestDurationMs) * 1000) / 10
          : 0,
    }))
    .sort((a, b) => {
      if (a.totalDurationMs !== b.totalDurationMs) {
        return b.totalDurationMs - a.totalDurationMs;
      }
      return a.category.localeCompare(b.category);
    });
}
