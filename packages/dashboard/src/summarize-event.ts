import type { CapturedEvent } from "@wevna/protocol";

// Levels worth putting in front of the message. A log list is scanned rather
// than read, and at INFO or below the level carries no information the reader
// is looking for — it is the default. At WARNING and above it is the reason
// the line matters, so it goes where the eye already is instead of only in the
// detail panel.
const NOTABLE_LOG_LEVELS = new Set(["WARNING", "WARN", "ERROR", "CRITICAL", "FATAL"]);

// Shared by EventRow (what's displayed) and filter-events (what free-text
// search matches against), so search results never disagree with what's
// on screen.
export function summarizeEvent(event: CapturedEvent): string {
  const message = typeof event.attributes.message === "string" ? event.attributes.message : "";

  // console.log from the Node SDK and log.record from the Python SDK are the
  // same thing wearing the name its language actually uses. They are kept as
  // separate kinds rather than normalised to one because Python's carries a
  // level and a logger name that console.log has no equivalent for, and
  // flattening them would throw that away at the producer.
  if (event.kind === "console.log" && message) {
    return message;
  }

  if (event.kind === "log.record" && message) {
    const level = typeof event.attributes.level === "string" ? event.attributes.level : "";
    return NOTABLE_LOG_LEVELS.has(level.toUpperCase()) ? `${level}: ${message}` : message;
  }

  if (event.kind === "exception.captured" && message) {
    const name = typeof event.attributes.name === "string" ? event.attributes.name : "Error";
    return `${name}: ${message}`;
  }

  return "";
}
