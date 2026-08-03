// packages/intelligence: reusable, deterministic runtime analysis logic.
// No dependency on React, Fastify, or dashboard components — only on
// @wevna/protocol's wire types. Consumes an AnalyzableRequest (a
// RequestModel, or anything structurally compatible with it) and produces
// derived analysis models; it never touches presentation.
export type { AnalyzableRequest, AnalyzableTimelineEntry } from "./analyzable-request.js";
export {
  analyzeRequestPerformance,
  type RequestPerformanceAnalysis,
} from "./analyze-request-performance.js";
export {
  type CategoryBreakdown,
  computeRequestPerformanceMetrics,
  type RequestPerformanceMetrics,
  type SlowestOperation,
} from "./compute-performance-metrics.js";
export { categorizeEvent, type EventCategory } from "./event-category.js";
export {
  buildExecutionGraph,
  type ExecutionGraph,
  type ExecutionGraphEdge,
  type ExecutionGraphEdgeType,
  type ExecutionGraphNode,
} from "./execution-graph.js";
export {
  generatePerformanceInsights,
  type PerformanceInsight,
  type PerformanceInsightType,
} from "./generate-performance-insights.js";
export { DEFAULT_PERFORMANCE_THRESHOLDS, type PerformanceThresholds } from "./thresholds.js";
