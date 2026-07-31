import type { AnalyzableRequest } from "./analyzable-request.js";
import {
  computeRequestPerformanceMetrics,
  type RequestPerformanceMetrics,
} from "./compute-performance-metrics.js";
import {
  generatePerformanceInsights,
  type PerformanceInsight,
} from "./generate-performance-insights.js";
import { DEFAULT_PERFORMANCE_THRESHOLDS, type PerformanceThresholds } from "./thresholds.js";

export interface RequestPerformanceAnalysis {
  metrics: RequestPerformanceMetrics;
  insights: readonly PerformanceInsight[];
}

// The one public entry point this package expects dashboard (and future,
// non-dashboard) consumers to call — metric computation and insight
// generation are kept as separate, independently-testable functions
// internally, composed here so callers don't need to know that's how it's
// built. Pure and deterministic throughout: the same request and
// thresholds always produce the same analysis.
export function analyzeRequestPerformance(
  request: AnalyzableRequest,
  thresholds: PerformanceThresholds = DEFAULT_PERFORMANCE_THRESHOLDS,
): RequestPerformanceAnalysis {
  const metrics = computeRequestPerformanceMetrics(request);
  const insights = generatePerformanceInsights(metrics, thresholds);
  return { metrics, insights };
}
