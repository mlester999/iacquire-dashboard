import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { loadWorkloadHome } from "@/server/staff-workload/overview";
import { WorkloadHomeView, MyWorkloadView } from "@/components/staff-workload/home";
import { WorkloadDenied, WorkloadHeader, WorkloadOff } from "@/components/staff-workload/shell";
import { makeTicket, workloadWorld } from "./support/staff-workload";

// The assignment dialog is a client component; the rest of the page is server-rendered. A static render has no Next router, so the dialog's hook is replaced here
// exactly as the browser-only test helpers do; the component's own behaviours are covered by its action/service tests.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

// The workload screens render from the same read models the pages use. These are server-side renders, not browsers: they catch a component that throws, a missing
// branch, or a page that would show a client name it was not given. The interaction and responsive checks are the browser pass's job (see the ledger).

const noop = async () => undefined;

describe("the workload screens render from their read models", () => {
  it("renders the team overview with the people, the attention list, the project health and the unassigned lane", async () => {
    const w = await workloadWorld();
    await makeTicket(w.clientA.id, { subject: "Overview render ticket" });
    const home = await loadWorkloadHome(w.manager);
    expect(home.kind).toBe("team");
    if (home.kind !== "team") throw new Error("expected the team view");
    const html = renderToStaticMarkup(<WorkloadHomeView data={home} enableAction={noop} />);
    expect(html).toContain("Team load");
    expect(html).toContain("Needs attention");
    expect(html).toContain("Project health");
    expect(html).toContain("Unassigned work");
    expect(html).toContain(w.staff.name);
    expect(html).toContain("Overview render ticket");
    expect(html).not.toContain("undefined");
  });

  it("renders a person's own view without the team sections", async () => {
    const w = await workloadWorld();
    const home = await loadWorkloadHome(w.staff);
    expect(home.kind).toBe("mine");
    if (home.kind !== "mine") throw new Error("expected the own view");
    const html = renderToStaticMarkup(<MyWorkloadView mine={home.mine} />);
    expect(html).toContain("Your load");
    expect(html).toContain("Your open work");
    expect(html).not.toContain("Team load");
  });

  it("renders the off and denied states with the honest next step", () => {
    const off = renderToStaticMarkup(
      <div>
        <WorkloadHeader active="overview" showTeam={false} showSettings />
        <WorkloadOff canEnable={false} enableAction={noop} />
      </div>,
    );
    expect(off).toContain("Staff workload is switched off");
    expect(off).toContain("About staff workload");
    const denied = renderToStaticMarkup(<WorkloadDenied />);
    expect(denied).toContain("Staff workload is not available to you");
  });
});
