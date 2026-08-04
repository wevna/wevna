import type { AnalyzableRequest } from "./analyzable-request.js";
import { attributeRequestTime, type TimeAttribution } from "./attribute-time.js";
import {
  computeRequestPerformanceMetrics,
  type RequestPerformanceMetrics,
} from "./compute-performance-metrics.js";
import { detectRepeatedOperations, type RepeatedOperation } from "./detect-repetition.js";
import {
  generatePerformanceInsights,
  type PerformanceInsight,
} from "./generate-performance-insights.js";
import { DEFAULT_PERFORMANCE_THRESHOLDS, type PerformanceThresholds } from "./thresholds.js";

export interface RequestPerformanceAnalysis {
  metrics: RequestPerformanceMetrics;
  insights: readonly PerformanceInsight[];
  // Exposed alongside the insights, not only folded into them: a consumer
  // may want to show the full breakdown of where a request's time went even
  // when no single category was dominant enough to earn an insight.
  timeAttribution: readonly TimeAttribution[];
  repeatedOperations: readonly RepeatedOperation[];
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
  const timeAttribution = attributeRequestTime(request);
  const repeatedOperations = detectRepeatedOperations(request, thresholds.repeatedOperationCount);
  const insights = generatePerformanceInsights(metrics, thresholds, {
    repeatedOperations,
    timeAttribution,
  });
  return { metrics, insights, timeAttribution, repeatedOperations };
}
