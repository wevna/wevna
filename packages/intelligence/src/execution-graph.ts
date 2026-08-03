import type { CapturedEvent, Envelope } from "@wevna/protocol";
import type { AnalyzableRequest } from "./analyzable-request.js";
import { categorizeEvent, type EventCategory } from "./event-category.js";

// One node per captured event, in the order it occurred — never
// aggregated, deduplicated, or invented. A node is what a timeline entry
// looks like from the graph's point of view: same event reference,
// duration, and offset, plus the two things a graph specifically needs
// (a stable id to be an edge endpoint, and its position in the sequence).
export interface ExecutionGraphNode {
  // The underlying event's own id — already unique and stable, so reused
  // directly rather than minting a second identifier for the same thing.
  id: string;
  category: EventCategory;
  kind: string;
  // 0-based position in the graph's own ordering — see ExecutionGraph's
  // own doc comment for why this is redundant with array order today but
  // kept explicit anyway.
  sequence: number;
  relativeOffsetMs: number;
  durationMs: number | undefined;
  // Direct reference, never a copy — mirrors AnalyzableTimelineEntry.
  event: Envelope<CapturedEvent>;
}

// "sequential" is the only relationship this PR derives — a later phase
// can add "parallel" | "parent-child" | "async-branch" etc. without
// touching ExecutionGraphNode or this field's existing values; a consumer
// that only understands "sequential" can keep ignoring edge types it
// doesn't recognize.
export type ExecutionGraphEdgeType = "sequential";

export interface ExecutionGraphEdge {
  type: ExecutionGraphEdgeType;
  // Node ids, not indices or object references — stable across whatever a
  // future consumer does with the nodes array (filtering, reordering for
  // layout, ...).
  from: string;
  to: string;
  // Deliberately untyped and empty today — a forward-compatible slot for
  // whatever a future edge type needs (e.g. a "parallel" edge's branch
  // count) without growing ExecutionGraphEdge's own shape per edge kind.
  metadata: Record<string, unknown>;
}

export interface ExecutionGraph {
  // Chronological — nodes[i].sequence === i for every i. Array order is
  // itself already the ordering; `sequence` is kept on the node too so a
  // future consumer that slices, filters, or reorders this array for
  // layout still has each node's original position.
  nodes: readonly ExecutionGraphNode[];
  edges: readonly ExecutionGraphEdge[];
  // Same rationale as ExecutionGraphEdge.metadata, at the graph's own
  // level — e.g. future layout hints for a real renderer.
  metadata: Record<string, unknown>;
}

// Raw Events → Request Model → Execution Graph Model → (future) Graph
// Renderer — the same layered shape as timeline-layout.ts in the
// dashboard package, one level up: this derives a structural model from
// an already-assembled request, and renders nothing itself.
//
// Pure and deterministic: request.timeline is already chronologically
// ordered (see RequestStore), so a single forward pass over it — one node
// per entry, one "sequential" edge between each consecutive pair — is
// enough to produce the same graph every time for the same request, with
// no event ever invented, merged, or dropped.
export function buildExecutionGraph(request: AnalyzableRequest): ExecutionGraph {
  const nodes: ExecutionGraphNode[] = [];
  const edges: ExecutionGraphEdge[] = [];
  let previous: ExecutionGraphNode | undefined;

  for (let index = 0; index < request.timeline.length; index += 1) {
    const entry = request.timeline[index];
    if (!entry) {
      continue;
    }

    const node: ExecutionGraphNode = {
      id: entry.event.payload.id,
      category: categorizeEvent(entry.kind),
      kind: entry.kind,
      sequence: index,
      relativeOffsetMs: entry.relativeOffsetMs,
      durationMs: entry.durationMs,
      event: entry.event,
    };
    nodes.push(node);

    if (previous) {
      edges.push({ type: "sequential", from: previous.id, to: node.id, metadata: {} });
    }
    previous = node;
  }

  return { nodes, edges, metadata: {} };
}
