export interface SearchControlsProps {
  query: string;
  kind: string;
  availableKinds: readonly string[];
  onQueryChange: (query: string) => void;
  onKindChange: (kind: string) => void;
}

export function SearchControls({
  query,
  kind,
  availableKinds,
  onQueryChange,
  onKindChange,
}: SearchControlsProps) {
  return (
    <div className="search-controls">
      <input
        type="search"
        className="search-controls__query"
        placeholder="Search kind, summary, attributes..."
        aria-label="Search events"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      <select
        className="search-controls__kind"
        aria-label="Filter by kind"
        value={kind}
        onChange={(event) => onKindChange(event.target.value)}
      >
        <option value="">All kinds</option>
        {availableKinds.map((availableKind) => (
          <option key={availableKind} value={availableKind}>
            {availableKind}
          </option>
        ))}
      </select>
    </div>
  );
}
