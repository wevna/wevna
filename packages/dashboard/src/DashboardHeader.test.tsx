import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DashboardHeader } from "./DashboardHeader.tsx";

function baseSearch() {
  return {
    query: "",
    kind: "",
    availableKinds: [],
    onQueryChange: vi.fn(),
    onKindChange: vi.fn(),
  };
}

function baseTimeline() {
  return {
    paused: false,
    liveCount: 3,
    onPause: vi.fn(),
    onResume: vi.fn(),
    onClear: vi.fn(),
  };
}

describe("DashboardHeader", () => {
  it("shows the brand wordmark", () => {
    render(
      <DashboardHeader
        sessionMode={{ mode: "live", metadata: undefined }}
        search={baseSearch()}
        timeline={baseTimeline()}
        theme="light"
        onToggleTheme={vi.fn()}
      />,
    );

    expect(screen.getByText("Wevna")).toBeInTheDocument();
  });

  it("shows a live-recording status while connected", () => {
    render(
      <DashboardHeader
        sessionMode={{ mode: "live", metadata: undefined }}
        search={baseSearch()}
        timeline={baseTimeline()}
        theme="light"
        onToggleTheme={vi.fn()}
      />,
    );

    expect(screen.getByText(/recording session/i)).toBeInTheDocument();
  });

  it("shows a viewing-recording status while replaying", () => {
    render(
      <DashboardHeader
        sessionMode={{ mode: "recording", metadata: undefined }}
        search={baseSearch()}
        timeline={baseTimeline()}
        theme="light"
        onToggleTheme={vi.fn()}
      />,
    );

    expect(screen.getByText(/viewing recording/i)).toBeInTheDocument();
  });

  it("renders the search input and pause/clear controls", () => {
    render(
      <DashboardHeader
        sessionMode={{ mode: "live", metadata: undefined }}
        search={baseSearch()}
        timeline={baseTimeline()}
        theme="light"
        onToggleTheme={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Search events")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /clear/i })).toBeInTheDocument();
  });

  it("renders a theme toggle reflecting the current theme", () => {
    render(
      <DashboardHeader
        sessionMode={{ mode: "live", metadata: undefined }}
        search={baseSearch()}
        timeline={baseTimeline()}
        theme="dark"
        onToggleTheme={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /switch to light mode/i })).toBeInTheDocument();
  });
});
