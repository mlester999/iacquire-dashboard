// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PreviousEmployeeProfileNotice } from "@/components/workforce/employee-summary";

afterEach(cleanup);

describe("PreviousEmployeeProfileNotice", () => {
  it("preserves the legacy record and points clients to the permanent Growth Partner conversation", () => {
    render(<PreviousEmployeeProfileNotice />);

    expect(screen.getByRole("complementary", { name: "Previous employee profile" })).toBeTruthy();
    expect(screen.getByText(/settings, schedules and history remain available/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open AI Growth Partner" }).getAttribute("href"))
      .toBe("/growth-partner/conversation");
  });
});
