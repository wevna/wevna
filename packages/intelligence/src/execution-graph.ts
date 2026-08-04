import type { CapturedEvent, Envelope } from "@wevna/protocol";
import type { AnalyzableRequest } from "./analyzable-request.js";
import { categorizeEvent, type EventCategory } from "./event-category.js";

// One node per captured event, in the order it occurred — never
// aggregated, deduplicated, or invented. A node is what a timeline entry
// looks like from the graph's point of view: same event reference,
// duration, and offset, plus what a graph specifically needs (a stable id
// to be an edge endpoint, its position in the sequence, and where it sits
// in the nesting).
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
  // Milliseconds since the request started at which this operation *began*.
  //
  // Not the same as relativeOffsetMs: every timed producer publishes once
  // its operation finishes, so relativeOffsetMs is an end time (see
  // timeline-layout.ts in the dashboard, which has always had to account
  // for this when positioning waterfall bars). A span is therefore
  // [startedAtMs, relativeOffsetMs], and precomputing the start here means
  // nesting and rendering can't each rediscover — or forget — that.
  startedAtMs: number;
  // The innermost operation whose span fully contains this one, or
  // undefined for a node at the top level. `http.request` is normally the
  // only root, since its span covers the whole request.
  parentId: string | undefined;
  // How many ancestors this node has. 0 for a root. Redundant with walking
  // parentId, but a renderer needs it per-row to indent without traversing
  // upward for every node it draws.
  depth: number;
  // Direct reference, never a copy — mirrors AnalyzableTimelineEntry.
  event: Envelope<CapturedEvent>;
}

// "sequential" answers "what happened next"; "parent-child" answers "what
// happened inside". Both are real, independently useful relations over the
// same nodes — Chrome DevTools shows the first as a network waterfall and
// the second as a flame chart — so the graph carries both rather than
// forcing a consumer to pick one interpretation. A renderer filters by
// `type`, which is what this field has always been for.
//
// Still open for "parallel" | "async-branch" etc. later, without touching
// ExecutionGraphNode or either existing value's meaning.
export type ExecutionGraphEdgeType = "sequential" | "parent-child";

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
  // Ids of nodes with no parent, in chronological order. Derivable by
  // filtering nodes, but a renderer needs the entry points before it can
  // draw anything, and asking for them explicitly keeps "where does the
  // tree start" from being every consumer's first puzzle.
  rootIds: readonly string[];
  // The deepest nesting level present, i.e. max(depth). 0 for a flat graph
  // or an empty one — lets a renderer size its indentation budget once
  // instead of measuring every row.
  maxDepth: number;
  // Same rationale as ExecutionGraphEdge.metadata, at the graph's own
  // level — e.g. future layout hints.
  metadata: Record<string, unknown>;
}

interface Span {
  index: number;
  start: number;
  end: number;
}

// Strict containment: `outer` must enclose `inner` *and* be genuinely
// longer. Without the duration comparison, two operations sharing identical
// start and end times would each "contain" the other, and whichever the
// sort happened to visit first would silently adopt the other as a child.
// Equal spans are siblings — the honest answer when timing alone cannot
// distinguish them.
function contains(outer: Span, inner: Span): boolean {
  return (
    outer.start <= inner.start &&
    inner.end <= outer.end &&
    outer.end - outer.start > inner.end - inner.start
  );
}

// Derives each node's parent from timing alone, using interval nesting —
// the same containment technique a flame graph uses, and the only
// information actually available: Wevna observes when operations started
// and finished, not who called whom. An operation that ran entirely inside
// another's window is reported as nested; nothing is inferred beyond that.
//
// Deliberately not guessing at causality. A SQL query running inside the
// request's window is genuinely "during the request", which is what the
// nesting claims; it does not claim the request *caused* it, because
// nothing observed here could establish that.
function assignParents(nodes: ExecutionGraphNode[]): void {
  const spans: Span[] = nodes.map((node, index) => ({
    index,
    start: node.startedAtMs,
    end: node.relativeOffsetMs,
  }));

  // Outermost-first at any shared start time, so a container is always
  // visited before what it contains. The sequence tie-break keeps the
  // result deterministic for spans that are identical in both bounds.
  const ordered = [...spans].sort((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    if (a.end !== b.end) {
      return b.end - a.end;
    }
    return a.index - b.index;
  });

  const stack: Span[] = [];
  for (const span of ordered) {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top && contains(top, span)) {
        break;
      }
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    const node = nodes[span.index];
    if (node) {
      node.parentId = parent ? nodes[parent.index]?.id : undefined;
      node.depth = stack.length;
    }
    stack.push(span);
  }
}

// Raw Events → Request Model → Execution Graph Model → Graph Renderer —
// the same layered shape as timeline-layout.ts in the dashboard, one level
// up: this derives a structural model from an already-assembled request,
// and renders nothing itself.
//
// Pure and deterministic: request.timeline is already chronologically
// ordered (see request-model.ts), and the nesting pass sorts by a total
// order with an index tie-break, so the same request always produces the
// same graph — with no event invented, merged, or dropped.
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
      // An event with no measured duration is a point in time, so its span
      // is zero-width rather than absent — that way it nests by *where* it
      // happened, which is exactly what makes a console.log land inside the
      // query it was logged during.
      startedAtMs: entry.relativeOffsetMs - (entry.durationMs ?? 0),
      parentId: undefined,
      depth: 0,
      event: entry.event,
    };
    nodes.push(node);

    if (previous) {
      edges.push({ type: "sequential", from: previous.id, to: node.id, metadata: {} });
    }
    previous = node;
  }

  assignParents(nodes);

  for (const node of nodes) {
    if (node.parentId !== undefined) {
      edges.push({ type: "parent-child", from: node.parentId, to: node.id, metadata: {} });
    }
  }

  return {
    nodes,
    edges,
    rootIds: nodes.filter((node) => node.parentId === undefined).map((node) => node.id),
    maxDepth: nodes.reduce((max, node) => Math.max(max, node.depth), 0),
    metadata: {},
  };
}
