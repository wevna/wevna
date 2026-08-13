import { SearchControls, type SearchControlsProps } from "./SearchControls.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";
import { TimelineControls, type TimelineControlsProps } from "./TimelineControls.tsx";
import type { SessionModeInfo } from "./use-session-mode.ts";
import type { Theme } from "./use-theme.ts";

export interface DashboardHeaderProps {
  sessionMode: SessionModeInfo;
  search: SearchControlsProps;
  timeline: TimelineControlsProps;
  theme: Theme;
  onToggleTheme: () => void;
}

function statusLabel(sessionMode: SessionModeInfo): string {
  if (sessionMode.mode === "recording") {
    return "viewing recording";
  }
  if (sessionMode.mode === "loading") {
    return "connecting";
  }
  return "recording session";
}

// Composes the header bar the whole redesign hangs off of: brand + a
// live/recording status dot, the existing SearchControls and
// TimelineControls (unchanged components, just restyled — see App.css),
// and the theme toggle. Purely compositional: every piece of state and
// every handler still lives where it already did (App.tsx), so this adds
// a layout, not a new source of truth.
export function DashboardHeader({
  sessionMode,
  search,
  timeline,
  theme,
  onToggleTheme,
}: DashboardHeaderProps) {
  return (
    <header className="dashboard-header">
      <div className="dashboard-header__brand">
        <span className="dashboard-header__wordmark">Wevna</span>
        <span className="dashboard-header__status" data-mode={sessionMode.mode}>
          <span className="dashboard-header__status-dot" aria-hidden="true" />
          {statusLabel(sessionMode)}
        </span>
      </div>

      <div className="dashboard-header__search">
        <SearchControls {...search} />
      </div>

      <div className="dashboard-header__actions">
        <TimelineControls {...timeline} />
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>
    </header>
  );
}
