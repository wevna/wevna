import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExceptionDetails } from "./ExceptionDetails.tsx";

describe("ExceptionDetails", () => {
  it("shows the error's type and message", () => {
    render(
      <ExceptionDetails
        attributes={{ name: "TypeError", message: "cannot read property of undefined" }}
      />,
    );

    expect(screen.getByText("TypeError")).toBeInTheDocument();
    expect(screen.getByText("cannot read property of undefined")).toBeInTheDocument();
  });

  it("defaults the error type to 'Error' when no name attribute is present", () => {
    render(<ExceptionDetails attributes={{ message: "boom" }} />);

    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("shows a placeholder when there is no message", () => {
    render(<ExceptionDetails attributes={{ name: "Error" }} />);

    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders the stack trace exactly as captured, preserving line breaks", () => {
    const stack = "Error: boom\n    at handler (/app/index.js:10:5)\n    at Layer.handle";

    render(<ExceptionDetails attributes={{ name: "Error", message: "boom", stack }} />);

    const stackElement = document.querySelector(".exception-details__stack");
    expect(stackElement?.textContent).toBe(stack);
  });

  it("renders no stack trace section when the attribute is absent", () => {
    render(<ExceptionDetails attributes={{ name: "Error", message: "boom" }} />);

    expect(document.querySelector(".exception-details__stack")).toBeNull();
    expect(screen.queryByText("Stack Trace")).not.toBeInTheDocument();
  });

  it("ignores a non-string stack attribute rather than rendering it", () => {
    render(
      <ExceptionDetails attributes={{ name: "Error", message: "boom", stack: { weird: true } }} />,
    );

    expect(document.querySelector(".exception-details__stack")).toBeNull();
  });
});
