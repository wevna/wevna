import type { CapturedEvent } from "@wevna/protocol";

// Shared by EventRow (what's displayed) and filter-events (what free-text
// search matches against), so search results never disagree with what's
// on screen.
export function summarizeEvent(event: CapturedEvent): string {
  if (event.kind === "console.log" && typeof event.attributes.message === "string") {
    return event.attributes.message;
  }
  return "";
}
