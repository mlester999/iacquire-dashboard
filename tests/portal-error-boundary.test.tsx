// @vitest-environment jsdom
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import PortalError from "@/app/(portal)/error";

describe("portal error boundary", () => {
  it("offers retry without exposing server error details", () => {
    const retry = vi.fn();
    render(<PortalError error={new Error("private database detail")} retry={retry} />);

    expect(screen.getByRole("heading", { name: "This part of your workspace couldn't load" })).toBeTruthy();
    expect(screen.queryByText(/private database detail/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
