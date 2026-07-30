import type { CapturedEvent } from "@wevna/protocol";

// Shared by EventRow (what's displayed) and filter-events (what free-text
// search matches against), so search results never disagree with what's
// on screen.
export function summarizeEvent(event: CapturedEvent): string {
  if (event.kind === "console.log" && typeof event.attributes.message === "string") {
    return event.attributes.message;
  }
  if (event.kind === "exception.captured" && typeof event.attributes.message === "string") {
    const name = typeof event.attributes.name === "string" ? event.attributes.name : "Error";
    return `${name}: ${event.attributes.message}`;
  }
  return "";
}
