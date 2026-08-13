import type { RequestModel } from "@wevna/intelligence";
import { useMemo, useState } from "react";
import { getEventKindCategory } from "./event-kind-category.ts";
import { computeSessionTimelineLayout, isErrorRequest } from "./session-timeline-layout.ts";
import { computeTimelineAxisTicks } from "./timeline-layout.ts";

export interface SessionTimelineProps {
  requests: readonly RequestModel[];
  selectedRequestId: string | undefined;
  onSelectRequest: (id: string) => void;
  // "ribbon" is the compact header strip (axis + thin bars); "expanded" is
  // the taller, labelled middle-pane view. Both read the same layout data
  // — only row height/typography and whether the axis renders differ.
  variant?: "ribbon" | "expanded";
}

type CategoryFilter = "all" | "sql" | "redis" | "errors";

const FILTERS: readonly { value: CategoryFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "sql", label: "SQL" },
  { value: "redis", label: "Redis" },
  { value: "errors", label: "Errors" },
];

function requestMatchesFilter(request: RequestModel, filter: CategoryFilter): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "errors") {
    return isErrorRequest(request);
  }
  return request.events.some((event) => getEventKindCategory(event.payload.kind) === filter);
}

function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

function requestLabel(request: RequestModel): string {
  return [request.method, request.route].filter(Boolean).join(" ") || request.correlationId;
}

// The session-wide counterpart to WaterfallTimeline: instead of one
// request's own internal events, every row here *is* a request, positioned
// across the whole session's timespan (see session-timeline-layout.ts).
// Purely presentational — the ALL/SQL/REDIS/ERRORS control is local state
// that dims non-matching rows rather than removing them, so row identity
// and the selection wired through onSelectRequest never shifts under a
// filter change.
export function SessionTimeline({
  requests,
  selectedRequestId,
  onSelectRequest,
  variant = "ribbon",
}: SessionTimelineProps) {
  const [filter, setFilter] = useState<CategoryFilter>("all");
  const layout = useMemo(() => computeSessionTimelineLayout(requests), [requests]);
  const ticks = useMemo(
    () => computeTimelineAxisTicks(layout.totalDurationMs),
    [layout.totalDurationMs],
  );

  const heading = variant === "ribbon" ? "Session Timeline" : "Timeline (per event)";

  return (
    <section className={`session-timeline session-timeline--${variant}`}>
      <div className="session-timeline__header">
        <h2 className="session-timeline__title">{heading}</h2>
        <fieldset className="seg session-timeline__filter">
          <legend className="visually-hidden">Filter by category</legend>
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="seg-opt"
              data-active={filter === option.value}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </fieldset>
      </div>

      {layout.rows.length === 0 ? (
        <p className="session-timeline__empty">Nothing recorded yet.</p>
      ) : (
        <>
          <div className="session-timeline__axis" aria-hidden="true">
            {ticks.map((tick) => (
              <span
                key={tick.leftPercent}
                className="session-timeline__tick"
                style={{ left: `${tick.leftPercent}%` }}
              >
                {tick.label}
              </span>
            ))}
          </div>
          <ul className="session-timeline__rows">
            {layout.rows.map((row) => {
              const selected = row.request.id === selectedRequestId;
              const dimmed = !requestMatchesFilter(row.request, filter);
              const label = requestLabel(row.request);

              return (
                <li
                  key={row.request.id}
                  className="session-timeline__row"
                  data-selected={selected}
                  data-dimmed={dimmed}
                  data-error={row.isError}
                >
                  <button
                    type="button"
                    className="session-timeline__row-button"
                    onClick={() => onSelectRequest(row.request.id)}
                  >
                    <span className="session-timeline__label">{label}</span>
                    <span className="session-timeline__track">
                      {row.isInstantaneous ? (
                        <span
                          className="session-timeline__marker"
                          style={{ left: `${row.leftPercent}%` }}
                        />
                      ) : (
                        <span
                          className="session-timeline__bar"
                          style={{ left: `${row.leftPercent}%`, width: `${row.widthPercent}%` }}
                        />
                      )}
                    </span>
                    {variant === "expanded" ? (
                      <span className="session-timeline__duration">
                        {row.request.durationMs !== undefined
                          ? formatMs(row.request.durationMs)
                          : "…"}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
