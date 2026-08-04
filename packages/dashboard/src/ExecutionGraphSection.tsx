import { buildExecutionGraph, type RequestModel } from "@wevna/intelligence";
import { useMemo } from "react";
import { computeExecutionGraphLayout } from "./execution-graph-layout.ts";

export interface ExecutionGraphSectionProps {
  request: RequestModel;
}

// Indentation per nesting level. Applied as padding inside the label rather
// than a margin on the row, so the proportional track stays aligned across
// every depth — a bar's position means "when it ran", and it would stop
// meaning that if nesting shifted the track itself.
const INDENT_REM_PER_DEPTH = 0.875;

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) {
    return "—";
  }
  return durationMs >= 10 ? `${Math.round(durationMs)}ms` : `${durationMs.toFixed(1)}ms`;
}

// A real renderer for the execution graph, replacing the flat sequential
// list that stood in for one until now: a flame-chart-shaped view where
// nesting shows what ran *inside* what, and each row's bar shows when it ran
// and for how long.
//
// Built from DOM rather than SVG or canvas, so the nesting reaches assistive
// technology as structure instead of as a picture — something a drawn
// node-link diagram cannot do without a parallel text representation. It also
// keeps the view testable through the DOM, like every other panel here.
//
// A plain list, deliberately *not* role="tree": the ARIA tree pattern is an
// interactive widget and carries obligations this view does not meet
// (focusable items, roving tabindex, arrow-key navigation). Claiming the role
// without the behaviour is worse than not claiming it, because it promises
// keyboard users something that isn't there. If this view later gains real
// keyboard navigation, role="tree" becomes the correct choice.
//
// Nesting reaches a screen reader by *naming the containing operation* rather
// than as an aria-level number — "inside sql.query" says what a developer
// actually wants to know, where "level 3" would leave them counting rows. The
// connector glyphs stay aria-hidden, since they encode the same thing
// visually.
//
// Purely presentational, mirroring PerformanceSection: memoized on the
// request via useMemo (both functions are pure functions of exactly this
// input), and this component never derives a node, an edge, a parent, or a
// position itself.
export function ExecutionGraphSection({ request }: ExecutionGraphSectionProps) {
  const layout = useMemo(
    () => computeExecutionGraphLayout(buildExecutionGraph(request), request.durationMs),
    [request],
  );

  if (layout.rows.length === 0) {
    return <p className="execution-graph__empty">No events to graph yet.</p>;
  }

  return (
    <ul className="execution-graph" aria-label="Execution graph">
      {layout.rows.map((row) => (
        <li
          key={row.node.id}
          className="execution-graph__row"
          data-kind-category={row.node.category}
          data-depth={row.node.depth}
          data-last-child={row.isLastChild ? "true" : undefined}
        >
          <span
            className="execution-graph__label"
            style={{ paddingInlineStart: `${row.node.depth * INDENT_REM_PER_DEPTH}rem` }}
          >
            {/* Decorative only: nesting already reaches assistive technology
                through aria-level, so announcing these glyphs would just add
                noise. */}
            {row.node.depth > 0 ? (
              <span className="execution-graph__connector" aria-hidden="true">
                {row.isLastChild ? "└" : "├"}
              </span>
            ) : null}
            <span className="execution-graph__kind">{row.node.kind}</span>
            {row.parentKind ? (
              <span className="visually-hidden">{` inside ${row.parentKind}`}</span>
            ) : null}
          </span>

          <span className="execution-graph__track">
            <span
              className={row.isInstantaneous ? "execution-graph__marker" : "execution-graph__bar"}
              style={{
                insetInlineStart: `${row.leftPercent}%`,
                ...(row.isInstantaneous ? {} : { inlineSize: `${row.widthPercent}%` }),
              }}
            />
          </span>

          <span className="execution-graph__duration">{formatDuration(row.node.durationMs)}</span>
        </li>
      ))}
    </ul>
  );
}
