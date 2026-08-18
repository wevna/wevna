import type { RequestModel } from "./request-model.js";

export interface EndpointStats {
  method: string;
  route: string;
  requestCount: number;
  // statusCode >= 500 — a 4xx is the caller's fault, not the endpoint
  // misbehaving, so it isn't counted here. Matches nothing else in the
  // repo (there's no prior "what counts as failed" definition to stay
  // consistent with) — a judgement call, not a derived fact.
  errorCount: number;
  averageDurationMs: number;
  // Nearest-rank method over this endpoint's own completed requests, not
  // interpolated — with few samples (the common case early in a session)
  // interpolating between two arbitrary requests would imply more
  // precision than the data has.
  p95DurationMs: number;
  slowestDurationMs: number;
}

// The first cross-request view: every other function in this package
// answers "what happened in this one request" — this answers "which
// endpoint should I actually go look at." A pure aggregation over models
// that already exist; no new event data or architecture required.
//
// Only requests with a method, a route, and a measured duration
// contribute — an endpoint's slowness can't be judged from one still in
// flight, and there's nothing to group a request under without knowing
// which endpoint it hit.
export function aggregateEndpointStats(
  requests: readonly RequestModel[],
): readonly EndpointStats[] {
  const byEndpoint = new Map<
    string,
    { method: string; route: string; durationsMs: number[]; errorCount: number }
  >();

  for (const request of requests) {
    if (
      request.method === undefined ||
      request.route === undefined ||
      request.durationMs === undefined
    ) {
      continue;
    }

    const key = `${request.method} ${request.route}`;
    const bucket = byEndpoint.get(key) ?? {
      method: request.method,
      route: request.route,
      durationsMs: [],
      errorCount: 0,
    };
    bucket.durationsMs.push(request.durationMs);
    if (request.statusCode !== undefined && request.statusCode >= 500) {
      bucket.errorCount += 1;
    }
    byEndpoint.set(key, bucket);
  }

  const stats: EndpointStats[] = Array.from(byEndpoint.values()).map((bucket) => {
    const sorted = [...bucket.durationsMs].sort((a, b) => a - b);
    const sum = sorted.reduce((total, value) => total + value, 0);
    const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);

    return {
      method: bucket.method,
      route: bucket.route,
      requestCount: sorted.length,
      errorCount: bucket.errorCount,
      averageDurationMs: sum / sorted.length,
      p95DurationMs: sorted[p95Index] ?? 0,
      slowestDurationMs: sorted[sorted.length - 1] ?? 0,
    };
  });

  // Slowest average first — the ranking's whole point — falling back to
  // route name for a deterministic order between endpoints that happen to
  // tie exactly (most often two endpoints seen only once each so far).
  return stats.sort(
    (a, b) => b.averageDurationMs - a.averageDurationMs || a.route.localeCompare(b.route),
  );
}
