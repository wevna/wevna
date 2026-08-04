// packages/intelligence: reusable, deterministic runtime interpretation.
// No dependency on React, Fastify, or dashboard components — only on
// @wevna/protocol's wire types.
//
// Two related responsibilities live here, both pure functions of protocol
// events and neither aware of presentation:
//
//   1. Construction — turning raw events into the models every higher
//      layer reasons about: the request itself (buildRequestModel), its
//      timeline (buildTimeline), and its reconstruction at an arbitrary
//      replay position (SnapshotEngine).
//   2. Analysis — deriving meaning from an already-constructed request:
//      performance metrics, insights, and the execution graph.
//
// Construction used to be split across the dashboard package, which made
// the dashboard the de-facto owner of what a "request" is. Keeping both
// halves here is what lets a CLI, a regression test asserting over a
// recording, or an alternative UI reach the same models without importing
// React or reimplementing the grouping.
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
export {
  buildRequestModel,
  compareEvents,
  type RequestModel,
  type RequestStatus,
} from "./request-model.js";
export {
  buildTimeline,
  getRelativeOffset,
  type TimelineEntry,
} from "./request-timeline.js";
export { type RuntimeSnapshot, SnapshotEngine } from "./snapshot-engine.js";
export { DEFAULT_PERFORMANCE_THRESHOLDS, type PerformanceThresholds } from "./thresholds.js";
