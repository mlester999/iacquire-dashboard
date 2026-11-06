// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TeamGrid } from "@/components/overview/overview-panels";

afterEach(cleanup);

describe("overview retained-profile links", () => {
  it("routes enabled legacy entries to the permanent conversation and keeps disabled records reviewable", () => {
    render(<TeamGrid agents={[
      { id: "enabled", role_key: "lead_hunter", display_name: "Lead Hunter", enabled: true, status: "online" },
      { id: "disabled", role_key: "crm_manager", display_name: "CRM Manager", enabled: false, status: "disabled" },
    ]} />);

    expect(screen.getByRole("link", { name: /Lead Hunter/ }).getAttribute("href"))
      .toBe("/growth-partner/conversation");
    expect(screen.getByRole("link", { name: /CRM Manager/ }).getAttribute("href"))
      .toBe("/employees/crm-manager");
  });
});
