// @vitest-environment jsdom
// The percentage the client sees in the sidebar and on the overview card is the launch readiness the ledger recorded: never the old checklist's (iAcquire's preparation tasks), which
// has its own label inside the Setup Center. Server reads use the embedded test database; the screens are rendered from shell data. Nothing is sent or contacted.
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { withSystem } from "@/server/db";
import { getShellData, type ShellData } from "@/server/queries/shell";
import { recordLaunchSnapshot, readLaunchCurrent } from "@/server/setup/launch-ledger";
import { ensureInstanceStandalone } from "@/server/setup/core";
import { Sidebar } from "@/components/shell/sidebar";
import { SetupNudge } from "@/components/setup/setup-nudge";
import { SetupCenter } from "@/components/setup/setup-center";
import { ShellProvider } from "@/components/shell/shell-context";
import { TooltipProvider } from "@/components/ui/overlays";
import { clientFixture } from "@/app/dev/setup-preview/fixtures";
import { markActivated } from "./support/billing";
import { draftClient } from "./support/launch";

vi.mock("next/navigation", () => ({ useRouter: () => ({ prefetch: vi.fn(), push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/overview" }));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }>(function Link({ href, prefetch: _prefetch, ...props }, ref) {
    return React.createElement("a", { ...props, href, ref });
  });
  return { default: Link, useLinkStatus: () => ({ pending: false }) };
});
vi.mock("@/app/actions/setup", () => ({ respondToSetupAction: vi.fn() }));

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

const SYSTEM = { kind: "system" } as const;

describe("the shell reads the launch percentage from the ledger", () => {
  it("has no launch figure until something is recorded, then carries the ledger's percentage, label and count, and not the checklist's", async () => {
    const c = await draftClient("Shell Percent Roofing", "America/Chicago");
    await ensureInstanceStandalone(c.org.id);
    // Make the checklist's own percentage something the launch percentage is not.
    await withSystem(async (db) => {
      await db.query("update client_setup_tasks set status = 'completed', completed_at = now(), completion_source = 'agency' where id in (select id from client_setup_tasks where org_id = $1 and required and completion_mode = 'manual' order by sort_order limit 2)", [c.org.id]);
    });

    const before = (await getShellData(c.ctx)).setup;
    expect(before.visible).toBe(true);
    expect(before.launch).toBeUndefined();

    await recordLaunchSnapshot(c.org.id, SYSTEM);
    const current = (await readLaunchCurrent([c.org.id])).get(c.org.id)!;
    const after = (await getShellData(c.ctx)).setup;
    expect(after.launch).toEqual({ percent: current.percent, state: "action_required", label: "Action required", needsYou: current.needsYou });
    expect(after.percent).not.toBeNull();
    expect(after.launch?.percent).not.toBe(after.percent);
    expect(after.launch?.needsYou).toBeGreaterThan(0);
  }, 180_000);

  it("never shows another client's figure, and shows none once the setup is approved", async () => {
    const x = await draftClient("Shell Percent X Dental", "Asia/Manila");
    const y = await draftClient("Shell Percent Y Dental", "Asia/Manila");
    for (const c of [x, y]) await ensureInstanceStandalone(c.org.id);
    await recordLaunchSnapshot(x.org.id, SYSTEM);
    // Y has nothing recorded: X's row does not show up there.
    expect((await getShellData(y.ctx)).setup.launch).toBeUndefined();
    await recordLaunchSnapshot(y.org.id, SYSTEM);
    const xs = (await getShellData(x.ctx)).setup.launch;
    const ys = (await getShellData(y.ctx)).setup.launch;
    expect(xs).toEqual(expect.objectContaining({ percent: (await readLaunchCurrent([x.org.id])).get(x.org.id)?.percent }));
    expect(ys).toEqual(expect.objectContaining({ percent: (await readLaunchCurrent([y.org.id])).get(y.org.id)?.percent }));
    // Approved for activation: the setup entry is hidden altogether, so no figure.
    await markActivated(x.org.id);
    const done = (await getShellData(x.ctx)).setup;
    expect(done.visible).toBe(false);
    expect(done.launch).toBeUndefined();
  }, 180_000);
});

function shell(setup: ShellData["setup"]): ShellData {
  return {
    user: { id: "u1", name: "Bailey Owner", email: "owner@example.test", platformRole: "none" },
    org: { id: "o1", name: "Brightside Roofing", isDemo: false, kind: "client", onboardingComplete: true, timezone: "UTC", role: "owner" },
    memberships: [], permissions: [], agents: [], unreadNotifications: 0, pendingApprovals: 0, setup, projectsAttention: 0, requestsAttention: 0, inboxAttention: 0, crmMode: "native",
  };
}
const inShell = (data: ShellData, node: React.ReactElement) => React.createElement(ShellProvider as React.FC<{ value: ShellData; children?: React.ReactNode }>, { value: data }, React.createElement(TooltipProvider, null, node));
const setupLink = () => screen.getByRole("link", { name: /Setup Center/ });

describe("the sidebar entry", () => {
  const launch = { percent: 37, state: "action_required" as const, label: "Action required", needsYou: 0 };

  it("shows the launch percentage and says what it is, and never the checklist's percentage", () => {
    render(inShell(shell({ visible: true, percent: 83, needsAttention: 0, launch }), React.createElement(Sidebar)));
    expect(setupLink().textContent).toContain("37%");
    expect(setupLink().textContent).toContain("launch readiness: Action required");
    expect(setupLink().textContent).not.toContain("83");
  });

  it("with something waiting on the client, shows the launch count and not the checklist's", () => {
    render(inShell(shell({ visible: true, percent: 83, needsAttention: 9, launch: { ...launch, needsYou: 2 } }), React.createElement(Sidebar)));
    expect(setupLink().textContent).toContain("2");
    expect(setupLink().textContent).not.toContain("9");
    expect(setupLink().textContent).not.toContain("83");
  });

  it("before anything is recorded shows no percentage at all (the checklist's is not a stand-in)", () => {
    render(inShell(shell({ visible: true, percent: 83, needsAttention: 0 }), React.createElement(Sidebar)));
    expect(setupLink().textContent).not.toContain("83");
    expect(setupLink().textContent).not.toMatch(/\d+%/);
  });
});

describe("the overview card", () => {
  it("says the launch readiness and its label from the ledger, with a bar of the same value", () => {
    render(inShell(shell({ visible: true, percent: 83, needsAttention: 4, launch: { percent: 62, state: "provisioning", label: "Provisioning", needsYou: 1 } }), React.createElement(SetupNudge)));
    expect(screen.getByText("Launch readiness is 62%")).toBeTruthy();
    expect(screen.getByText("Provisioning")).toBeTruthy();
    expect(screen.getByText("1 thing needs your attention.")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Launch readiness" }).getAttribute("aria-valuenow")).toBe("62");
    expect(document.body.textContent).not.toMatch(/83%|Your system is/);
  });

  it("before anything is recorded invites the client to look, with no figure and no bar", () => {
    render(inShell(shell({ visible: true, percent: 83, needsAttention: 0 }), React.createElement(SetupNudge)));
    expect(screen.getByText("See what we're setting up for you")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(document.body.textContent).not.toMatch(/83%/);
  });

  it("is hidden once the setup is approved", () => {
    const { container } = render(inShell(shell({ visible: false, percent: 100, needsAttention: 0 }), React.createElement(SetupNudge)));
    expect(container.innerHTML).toBe("");
  });
});

describe("the checklist percentage inside the Setup Center", () => {
  it("is labelled as iAcquire's preparation and says it is not the launch readiness", () => {
    render(React.createElement(SetupCenter, { initial: clientFixture(), firstName: "Bailey", timeZone: "UTC", preview: true }));
    expect(document.body.textContent).toContain("iAcquire's preparation");
    expect(document.body.textContent).toContain("not your launch readiness");
    expect(document.body.textContent).not.toContain("Setup tasks");
  });
});
