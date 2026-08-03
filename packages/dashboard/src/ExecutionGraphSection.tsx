import { buildExecutionGraph } from "@wevna/intelligence";
import { useMemo } from "react";
import type { RequestModel } from "./request-store.ts";

export interface ExecutionGraphSectionProps {
  request: RequestModel;
}

// A developer-facing validation view, not a graph visualization — no
// layout, no interaction, no SVG/Canvas. Mirrors PerformanceSection's own
// pattern: memoized on the request via useMemo (buildExecutionGraph is a
// pure function of exactly this input, see @wevna/intelligence), and
// purely presentational — this component never derives a node, an edge,
// or a category itself.
export function ExecutionGraphSection({ request }: ExecutionGraphSectionProps) {
  const graph = useMemo(() => buildExecutionGraph(request), [request]);

  if (graph.nodes.length === 0) {
    return <p className="execution-graph__empty">No events to graph yet.</p>;
  }

  return (
    <ol className="execution-graph">
      {graph.nodes.map((node, index) => (
        <li key={node.id} className="execution-graph__node" data-kind-category={node.category}>
          <span className="execution-graph__node-kind">{node.kind}</span>
          {index < graph.nodes.length - 1 ? (
            <span className="execution-graph__connector" aria-hidden="true">
              ↓
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
