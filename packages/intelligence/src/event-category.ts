// This package's own event-kind classification — deliberately separate
// from the dashboard's event-kind-category.ts (a presentation concern:
// which CSS treatment a kind gets) rather than shared across the package
// boundary this package isn't allowed to cross. "console" is its own
// category here (unlike the dashboard's, which folds it into "other")
// because the analyzer reports an explicit console event count as one of
// its metrics, so it needs its own bucket in the same breakdown every
// other category goes through.
// "httpClient" (outgoing requests this application made) is deliberately
// separate from "http" (the incoming request being served). They are not
// variations on one thing: http.request's duration *contains* the whole
// request, while an http.client call is one operation inside it. Summing
// both into one bucket would make categoryBreakdown's http total exceed the
// request's own duration, which is nonsense rather than merely imprecise.
//
// This is also why "http" cannot simply be prefix-matched anymore — see the
// ordering note below.
export type EventCategory =
  | "http"
  | "httpClient"
  | "sql"
  | "redis"
  | "exception"
  | "console"
  | "other";

// Scanned in order, first match wins, so more specific prefixes must come
// before the general ones they'd otherwise be swallowed by: "http.client."
// and the exact "http.client" both have to be tested before "http.".
const PREFIX_CATEGORIES: readonly (readonly [prefix: string, category: EventCategory])[] = [
  ["http.client", "httpClient"],
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
