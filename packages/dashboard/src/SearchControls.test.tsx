import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchControls } from "./SearchControls.tsx";

describe("SearchControls", () => {
  it("shows the current query in the search input", () => {
    render(
      <SearchControls
        query="hello"
        kind=""
        availableKinds={[]}
        onQueryChange={vi.fn()}
        onKindChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Search events")).toHaveValue("hello");
  });

  it("calls onQueryChange as the developer types", () => {
    const onQueryChange = vi.fn();
    render(
      <SearchControls
        query=""
        kind=""
        availableKinds={[]}
        onQueryChange={onQueryChange}
        onKindChange={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Search events"), { target: { value: "abc" } });

    expect(onQueryChange).toHaveBeenCalledExactlyOnceWith("abc");
  });

  it("lists an 'All kinds' option plus every available kind", () => {
    render(
      <SearchControls
        query=""
        kind=""
        availableKinds={["console.log", "http.request"]}
        onQueryChange={vi.fn()}
        onKindChange={vi.fn()}
      />,
    );

    const select = screen.getByLabelText("Filter by kind");
    const options = Array.from(select.querySelectorAll("option")).map(
      (option) => option.textContent,
    );
    expect(options).toEqual(["All kinds", "console.log", "http.request"]);
  });

  it("calls onKindChange when a kind is selected", () => {
    const onKindChange = vi.fn();
    render(
      <SearchControls
        query=""
        kind=""
        availableKinds={["console.log", "http.request"]}
        onQueryChange={vi.fn()}
        onKindChange={onKindChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Filter by kind"), {
      target: { value: "http.request" },
    });

    expect(onKindChange).toHaveBeenCalledExactlyOnceWith("http.request");
  });
});
