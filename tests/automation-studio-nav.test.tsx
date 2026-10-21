// @vitest-environment jsdom
// The sidebar's Automation Studio entry: shown where the workflow engine runs and the person can see automations, with a lock (and words for
// screen readers) when the workspace doesn't have the plan. The lock is cosmetic; the pages and actions check the plan on the server.
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Sidebar } from "@/components/shell/sidebar";
import { ShellProvider } from "@/components/shell/shell-context";
import { TooltipProvider } from "@/components/ui/overlays";
import type { ShellData } from "@/server/queries/shell";
import type { Permission } from "@/lib/permissions";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: vi.fn(), push: vi.fn() }),
  usePathname: () => "/automation-studio",
}));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }>(function Link({ href, prefetch: _prefetch, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link, useLinkStatus: () => ({ pending: false }) };
});

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

function shell(permissions: Permission[], over: Partial<ShellData> = {}): ShellData {
  return {
    user: { id: "u1", name: "Bailey Owner", email: "owner@example.test", platformRole: "client" },
    org: { id: "o1", name: "Brightside Roofing", isDemo: false, kind: "client", onboardingComplete: true, timezone: "UTC", role: "owner" },
    memberships: [],
    permissions,
    agents: [],
    unreadNotifications: 0,
    pendingApprovals: 0,
    setup: { visible: false, percent: null, needsAttention: 0 },
    projectsAttention: 0,
    requestsAttention: 0,
    inboxAttention: 0,
    crmMode: "native",
    ...over,
  };
}

function renderSidebar(data: ShellData, compact = false) {
  return render(
    <ShellProvider value={data}>
      <TooltipProvider>
        <Sidebar compact={compact} />
      </TooltipProvider>
    </ShellProvider>,
  );
}
const entry = () => screen.queryByRole("link", { name: /Automation Studio/ });

describe("the Automation Studio navigation entry", () => {
  it("links to the studio with a lock and a spoken reason when the workspace doesn't have the plan", () => {
    renderSidebar(shell(["crm.view", "workflows.view"], { automationStudio: { entitled: false } }));
    const link = entry()!;
    expect(link.getAttribute("href")).toBe("/automation-studio");
    expect(link.getAttribute("data-aqi-target")).toBe("nav.automation-studio");
    expect(link.textContent).toMatch(/Needs the Automation Studio plan/);
  });

  it("has no lock when the plan is active", () => {
    renderSidebar(shell(["crm.view", "workflows.view"], { automationStudio: { entitled: true } }));
    expect(entry()).not.toBeNull();
    expect(entry()!.textContent).not.toMatch(/Needs the Automation Studio plan/);
  });

  it("names the lock on the compact rail too, where only the icon shows", () => {
    renderSidebar(shell(["crm.view", "workflows.view"], { automationStudio: { entitled: false } }), true);
    expect(screen.getByRole("link", { name: "Automation Studio (needs the Automation Studio plan)" })).toBeTruthy();
  });

  it("is hidden from people who can't see automations, and where GoHighLevel runs the workflows", () => {
    renderSidebar(shell(["crm.view"], { automationStudio: undefined }));
    expect(entry()).toBeNull();
    cleanup();
    renderSidebar(shell(["crm.view", "workflows.view"], { crmMode: "ghl", automationStudio: { entitled: true } }));
    expect(entry()).toBeNull();
  });
});
