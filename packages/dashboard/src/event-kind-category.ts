// A small, presentational grouping of event kinds — separate from
// timeline-layout.ts on purpose: this is about *identity* (which visual
// category a kind belongs to), not coordinates. Prefix-matched rather than
// an exact-match table so future kinds under an existing instrumentation
// (e.g. a hypothetical "http.upgrade") still classify correctly without an
// update here; a genuinely new instrumentation target (BullMQ, Prisma, ...)
// falls back to "other" and renders with neutral, uncoloured styling until
// this list is deliberately extended.
export type EventKindCategory = "http" | "sql" | "redis" | "other";

const PREFIX_CATEGORIES: readonly (readonly [prefix: string, category: EventKindCategory])[] = [
  ["http.", "http"],
  ["sql.", "sql"],
  ["redis.", "redis"],
];

export function getEventKindCategory(kind: string): EventKindCategory {
  for (const [prefix, category] of PREFIX_CATEGORIES) {
    if (kind.startsWith(prefix)) {
      return category;
    }
  }
  return "other";
}
