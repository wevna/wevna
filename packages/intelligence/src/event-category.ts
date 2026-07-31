// This package's own event-kind classification — deliberately separate
// from the dashboard's event-kind-category.ts (a presentation concern:
// which CSS treatment a kind gets) rather than shared across the package
// boundary this package isn't allowed to cross. "console" is its own
// category here (unlike the dashboard's, which folds it into "other")
// because the analyzer reports an explicit console event count as one of
// its metrics, so it needs its own bucket in the same breakdown every
// other category goes through.
export type EventCategory = "http" | "sql" | "redis" | "exception" | "console" | "other";

const PREFIX_CATEGORIES: readonly (readonly [prefix: string, category: EventCategory])[] = [
  ["http.", "http"],
  ["sql.", "sql"],
  ["redis.", "redis"],
  ["exception.", "exception"],
  ["console.", "console"],
];

export function categorizeEvent(kind: string): EventCategory {
  for (const [prefix, category] of PREFIX_CATEGORIES) {
    if (kind.startsWith(prefix)) {
      return category;
    }
  }
  return "other";
}
