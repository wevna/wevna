export interface Command {
  id: string;
  label: string;
  // Extra text matched but not shown prominently, e.g. a request's status.
  hint?: string;
  run: () => void;
}

// Subsequence match: every character of the query appears in the text, in
// order ("gor" matches "GET /orders"). Returns undefined for no match,
// otherwise a score where lower is better — earlier first match, and tighter
// grouping, win. Case-insensitive.
export function matchScore(query: string, text: string): number | undefined {
  const needle = query.toLowerCase().replaceAll(/\s+/g, "");
  if (needle.length === 0) {
    return 0;
  }
  const haystack = text.toLowerCase();
  let position = -1;
  let first = -1;
  let gaps = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, position + 1);
    if (found === -1) {
      return undefined;
    }
    if (first === -1) {
      first = found;
    } else {
      gaps += found - position - 1;
    }
    position = found;
  }
  return first + gaps;
}

// Commands matching the query, best first. Ties keep their original order so
// the palette is stable as you type. With an empty query everything is shown
// in the order given.
export function filterCommands(commands: readonly Command[], query: string): readonly Command[] {
  const scored: { command: Command; score: number; index: number }[] = [];
  for (const [index, command] of commands.entries()) {
    const score = matchScore(query, `${command.label} ${command.hint ?? ""}`);
    if (score !== undefined) {
      scored.push({ command, score, index });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.map((entry) => entry.command);
}
