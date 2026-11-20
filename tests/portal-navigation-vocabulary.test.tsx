// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { ShellProvider } from "@/components/shell/shell-context";
import { TooltipProvider } from "@/components/ui/overlays";
import type { ShellData } from "@/server/queries/shell";
import type { Permission } from "@/lib/permissions";

const pathname = vi.hoisted(() => ({ current: "/overview" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => pathname.current,
}));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }>(function Link({ href, prefetch: _prefetch, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link, useLinkStatus: () => ({ pending: false }) };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/shell", () => ({ switchOrgAction: vi.fn() }));
vi.mock("@/components/notifications/notification-center", () => ({ NotificationCenter: () => null }));
vi.mock("@/components/auth/logout-confirmation", () => ({ useLogoutConfirmation: () => ({ requestLogout: vi.fn() }) }));
vi.mock("@/components/providers", () => ({ useTheme: () => ({ resolved: "light", setTheme: vi.fn() }) }));

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

const PERMISSIONS: Permission[] = [
  "agents.use", "agents.configure", "workspace.view", "inbox.view", "leads.view", "appointments.view", "sales.view",
  "proposals.view", "invoices.view", "retention.view", "analytics.view", "approvals.view", "knowledge.view", "website.view",
  "social.view", "activity.view", "contacts.view", "crm.view", "workflows.view", "projects.view", "maintenance.view",
  "support.use", "integrations.view", "team.view", "usage.view", "billing.view", "setup.view", "staff.availability",
];

function shell(crmMode: ShellData["crmMode"]): ShellData {
  return {
    user: { id: "u1", name: "Bailey Owner", email: "owner@example.test", platformRole: "client" },
    org: { id: "o1", name: "Brightside Roofing", isDemo: false, kind: "client", onboardingComplete: true, timezone: "UTC", role: "owner" },
    memberships: [],
    permissions: PERMISSIONS,
    agents: [{ role: "lead_hunter", displayName: "Lead Hunter", status: "online", enabled: true }],
    unreadNotifications: 0,
    pendingApprovals: 0,
    setup: { visible: true, percent: 100, needsAttention: 0 },
    projectsAttention: 0,
    requestsAttention: 0,
    inboxAttention: 0,
    crmMode,
    automationStudio: { entitled: true },
    features: ["proposals", "invoices", "request_changes"],
  };
}

describe("portal navigation vocabulary", () => {
  it.each(["native", "ghl", "hybrid"] as const)("keeps the sidebar and Ctrl+K palette in sync for %s CRM", (crmMode) => {
    pathname.current = "/overview";
    render(
      <ShellProvider value={shell(crmMode)}>
        <TooltipProvider>
          <Sidebar />
          <Topbar onOpenMenu={() => {}} />
        </TooltipProvider>
      </ShellProvider>,
    );

    const sidebar = screen.getByRole("navigation", { name: "Main" });
    const sidebarEntries = within(sidebar).getAllByRole("link").flatMap((link) => {
      const href = link.getAttribute("href");
      const label = link.getAttribute("aria-label") ?? link.textContent?.trim();
      if (!href || !label || (href === "/overview" && label === "iAcquireOS overview") || href === "/settings/security") return [];
      return [{ href, label }];
    });
    const sidebarHrefs = sidebarEntries.map((entry) => entry.href);
    expect(new Set(sidebarHrefs).size).toBe(sidebarHrefs.length);

    if (crmMode === "native") {
      expect(sidebarHrefs).not.toContain("/sales");
      expect(sidebarHrefs).not.toContain("/appointments");
      expect(sidebarHrefs).toContain("/crm/pipelines");
      expect(sidebarHrefs).toContain("/crm/calendar");
    } else if (crmMode === "ghl") {
      expect(sidebarHrefs).toContain("/sales");
      expect(sidebarHrefs).toContain("/appointments");
      expect(sidebarHrefs).not.toContain("/crm/pipelines");
      expect(sidebarHrefs).not.toContain("/crm/calendar");
      expect(sidebarHrefs).not.toContain("/automation-studio");
    } else {
      expect(sidebarHrefs).toContain("/sales");
      expect(sidebarHrefs).toContain("/crm/pipelines");
      expect(sidebarHrefs).toContain("/appointments");
      expect(sidebarHrefs).toContain("/crm/calendar");
    }

    fireEvent.click(screen.getByRole("button", { name: "Search workspace navigation" }));
    const dialog = screen.getByRole("dialog", { name: "Jump to your workspace" });
    const search = within(dialog).getByRole("textbox", { name: "Search workspace modules" });
    for (const entry of sidebarEntries) {
      fireEvent.change(search, { target: { value: entry.label } });
      const matchingDestination = within(dialog).getAllByRole("link").filter((link) => link.getAttribute("href") === entry.href);
      expect(matchingDestination, `${crmMode}: ${entry.label} (${entry.href})`).toHaveLength(1);
      expect(matchingDestination[0].textContent?.trim()).toBe(entry.label);
    }
    expect(sidebarEntries.find((entry) => entry.href === "/work")).toMatchObject({ label: "AI Work Board" });
    expect(sidebarEntries.find((entry) => entry.href === "/work/calendar")).toMatchObject({ label: "Schedules & Calendar" });
  });
});
