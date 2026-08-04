import type { ExecutionGraph, ExecutionGraphNode } from "@wevna/intelligence";

export interface ExecutionGraphRow {
  node: ExecutionGraphNode;
  // Position and width as percentages of the graph's own span, both within
  // [0, 100] — dimensionless, exactly like timeline-layout.ts. A consuming
  // component decides how these become CSS.
  leftPercent: number;
  widthPercent: number;
  // True when the node has no measurable duration and should be drawn as a
  // marker rather than a bar.
  isInstantaneous: boolean;
  // True when this row is the last child of its parent, so a renderer can
  // draw an "└" style connector instead of a "├" without looking ahead.
  isLastChild: boolean;
  // The kind of this row's parent, or undefined for a root. Resolved here so
  // a renderer can name the containing operation — which is what makes the
  // nesting legible to a screen reader — without doing its own id lookups.
  parentKind: string | undefined;
}

export interface ExecutionGraphLayout {
  rows: readonly ExecutionGraphRow[];
  totalDurationMs: number;
  maxDepth: number;
}

// Depth-first over parentId, so a child always appears directly beneath its
// parent — the ordering a nested view has to be read in. Within one parent,
// children stay in chronological order, because that is the order they
// actually happened in and re-sorting them by duration would make the view
// disagree with the waterfall next to it.
function orderDepthFirst(graph: ExecutionGraph): ExecutionGraphNode[] {
  const childrenByParent = new Map<string | undefined, ExecutionGraphNode[]>();
  for (const node of graph.nodes) {
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }

  const ordered: ExecutionGraphNode[] = [];
  // Iterative rather than recursive: a pathological request (thousands of
  // events nested by timing) would otherwise be able to blow the stack
  // inside a render.
  const stack: ExecutionGraphNode[] = [...(childrenByParent.get(undefined) ?? [])].reverse();
  const visited = new Set<string>();

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || visited.has(node.id)) {
      continue;
    }
    visited.add(node.id);
    ordered.push(node);
    const children = childrenByParent.get(node.id) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) {
        stack.push(child);
      }
    }
  }

  return ordered;
}

function lastChildIds(graph: ExecutionGraph): Set<string> {
  const lastByParent = new Map<string | undefined, string>();
  for (const node of graph.nodes) {
    lastByParent.set(node.parentId, node.id);
  }
  return new Set(lastByParent.values());
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

// Turns an ExecutionGraph into flat, ordered, proportional rows a nested
// view can render directly — no DOM, no pixels, no React, and no knowledge
// of the graph's construction. Mirrors computeTimelineLayout: pure, so a
// component can memoize on its inputs.
//
// The scale is shared with the waterfall on purpose. Both views are showing
// the same request over the same span, and using each view's own local
// maximum would make a query look like a different size depending on which
// panel you read it in.
export function computeExecutionGraphLayout(
  graph: ExecutionGraph,
  requestDurationMs: number | undefined,
): ExecutionGraphLayout {
  const ordered = orderDepthFirst(graph);
  const lasts = lastChildIds(graph);
  const kindById = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  const parentKindOf = (parentId: string | undefined): string | undefined =>
    parentId === undefined ? undefined : kindById.get(parentId);

  const totalDurationMs =
    requestDurationMs !== undefined && requestDurationMs > 0
      ? requestDurationMs
      : ordered.reduce((max, node) => Math.max(max, node.relativeOffsetMs), 0);

  return {
    totalDurationMs,
    maxDepth: graph.maxDepth,
    rows: ordered.map((node) => {
      if (totalDurationMs <= 0) {
        return {
          node,
          leftPercent: 0,
          widthPercent: 0,
          isInstantaneous: true,
          isLastChild: lasts.has(node.id),
          parentKind: parentKindOf(node.parentId),
        };
      }

      const leftPercent = clampPercent((node.startedAtMs / totalDurationMs) * 100);
      const durationMs = node.durationMs && node.durationMs > 0 ? node.durationMs : 0;
      const widthPercent = clampPercent(
        Math.min((durationMs / totalDurationMs) * 100, 100 - leftPercent),
      );

      return {
        node,
        leftPercent,
        widthPercent,
        isInstantaneous: widthPercent <= 0,
        isLastChild: lasts.has(node.id),
        parentKind: parentKindOf(node.parentId),
      };
    }),
  };
}
