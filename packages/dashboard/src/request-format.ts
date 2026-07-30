// Shared between RequestList (navigation rows) and RequestInspector
// (workspace summary) so the two views of the same RequestModel field
// never drift out of sync with each other.
export function formatRequestDuration(durationMs: number | undefined): string {
  return durationMs === undefined ? "…" : `${durationMs.toFixed(1)}ms`;
}

export function formatEventCount(count: number): string {
  return `${count} event${count === 1 ? "" : "s"}`;
}
