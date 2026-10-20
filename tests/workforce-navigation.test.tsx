// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { Sidebar } from "@/components/shell/sidebar";
import { ShellProvider } from "@/components/shell/shell-context";
import { TooltipProvider } from "@/components/ui/overlays";
import type { ShellData } from "@/server/queries/shell";
import type { Permission } from "@/lib/permissions";

const nav = vi.hoisted(() => ({ pathname: "/employees" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: vi.fn(), push: vi.fn() }),
  usePathname: () => nav.pathname,
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
beforeEach(() => {
  nav.pathname = "/employees";
});
afterEach(cleanup);

function shell(permissions: Permission[], over: Partial<ShellData> = {}): ShellData {
  return {
    user: { id: "u1", name: "Bailey Owner", email: "owner@example.test", platformRole: "client" },
    org: { id: "o1", name: "Brightside Roofing", isDemo: false, kind: "client", onboardingComplete: true, timezone: "UTC", role: "owner" },
    memberships: [],
    permissions,
    agents: [
      { role: "operations_manager", displayName: "Operations Manager", status: "online", enabled: true },
      { role: "lead_hunter", displayName: "Lead Hunter", status: "setup_required", enabled: true },
      { role: "appointment_setter", displayName: "Appointment Setter", status: "busy", enabled: true },
      { role: "sales_assistant", displayName: "Sales Assistant", status: "online", enabled: false },
    ],
    unreadNotifications: 0,
    pendingApprovals: 0,
    setup: { visible: false, percent: null, needsAttention: 0 },
    projectsAttention: 0,
    requestsAttention: 0,
    inboxAttention: 0,
    crmMode: null,
    ...over,
  };
}

function renderSidebar(permissions: Permission[] = ["agents.use", "agents.configure"]) {
  return render(
    <ShellProvider value={shell(permissions)}>
      <TooltipProvider>
        <Sidebar />
      </TooltipProvider>
    </ShellProvider>,
  );
}

const hrefs = () => screen.getAllByRole("link").map((a) => a.getAttribute("href"));

describe("management navigation (main iAcquire sidebar)", () => {
  it("opens an employee's profile when the employee is selected, never the chat", () => {
    renderSidebar();
    const links = hrefs();
    expect(links).toContain("/employees/operations-manager");
    expect(links).toContain("/employees/lead-hunter");
    expect(links).toContain("/employees/appointment-setter");
    // The primary row for an employee is the management route; chat is a separate, explicitly labelled action.
    const lead = screen.getAllByRole("link").find((a) => a.getAttribute("href") === "/employees/lead-hunter")!;
    expect(lead.textContent).toContain("Lead Hunter");
    expect(links).not.toContain("/chat/lead-hunter");
  });

  it("offers an explicit 'Chat with' shortcut only for employees that can actually chat", () => {
    renderSidebar();
    expect(screen.getByRole("link", { name: "Chat with Operations Manager" }).getAttribute("href")).toBe("/chat/operations-manager");
    expect(screen.getByRole("link", { name: "Chat with Appointment Setter" }).getAttribute("href")).toBe("/chat/appointment-setter");
    // Setup required: no chat shortcut, so a management click can never land on a blocked chat by accident.
    expect(screen.queryByRole("link", { name: "Chat with Lead Hunter" })).toBeNull();
    // Not enabled for this workspace: not listed at all.
    expect(hrefs()).not.toContain("/employees/sales-assistant");
    expect(screen.queryByRole("link", { name: /Chat with Sales Assistant/ })).toBeNull();
  });

  it("hides every chat shortcut from people who may not use AI employees", () => {
    renderSidebar([]);
    expect(screen.queryByRole("link", { name: /^Chat with/ })).toBeNull();
    expect(hrefs()).toContain("/employees/operations-manager");
  });

  it("highlights the employee being managed and nothing else", () => {
    nav.pathname = "/employees/lead-hunter";
    renderSidebar();
    const current = screen.getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page");
    const employeeRows = current.filter((a) => a.getAttribute("href")?.startsWith("/employees/"));
    expect(employeeRows.map((a) => a.getAttribute("href"))).toEqual(["/employees/lead-hunter"]);
  });

  it("keeps the AQi walkthrough anchors for AI Employees", () => {
    const { container } = renderSidebar();
    expect(container.querySelector('[data-tour="workforce"]')).not.toBeNull();
    expect(container.querySelector('a[href="/employees"][data-aqi-target="nav.workforce"]')).not.toBeNull();
    expect(container.querySelector('a[href="/overview"][data-aqi-target]')).not.toBeNull();
  });

  it("renders the wordmark through the shared Logo with no colour override on the link", () => {
    renderSidebar();
    const brand = screen.getByRole("link", { name: "iAcquire overview" });
    expect(brand.className).toContain("workspace-nav-brand");
    expect(brand.className).not.toContain("text-white");
    expect(within(brand).getByText("Acquire").className).toContain("logo-accent");
    expect(screen.getByRole("navigation", { name: "Main" }).className).toContain("workspace-nav");
  });
});
