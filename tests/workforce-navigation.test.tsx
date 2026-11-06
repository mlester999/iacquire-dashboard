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
  nav.pathname = "/growth-partner";
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

function renderSidebar(permissions: Permission[] = ["agents.use", "agents.configure"], over: Partial<ShellData> = {}) {
  return render(
    <ShellProvider value={shell(permissions, over)}>
      <TooltipProvider>
        <Sidebar />
      </TooltipProvider>
    </ShellProvider>,
  );
}

const hrefs = () => screen.getAllByRole("link").map((a) => a.getAttribute("href"));

describe("Growth Partner navigation (main iAcquire sidebar)", () => {
  it("shows one Growth Partner destination and keeps old profiles under migration access", () => {
    renderSidebar();
    const links = hrefs();
    expect(links).toContain("/growth-partner");
    expect(screen.getByRole("link", { name: "AI Growth Partner" }).getAttribute("href")).toBe("/growth-partner");
    expect(screen.getByRole("link", { name: "Previous role profiles" }).getAttribute("href")).toBe("/employees");
    expect(links.filter((href) => href?.startsWith("/employees/") || href?.startsWith("/chat/")).length).toBe(0);
  });

  it("keeps migration-only profiles hidden from people who cannot configure agents", () => {
    renderSidebar(["agents.use"]);
    expect(hrefs()).toContain("/growth-partner");
    expect(hrefs()).not.toContain("/employees");
    expect(hrefs().filter((href) => href?.startsWith("/employees/") || href?.startsWith("/chat/")).length).toBe(0);
  });

  it("hides previous profiles from a Growth Partner-only workspace", () => {
    renderSidebar(["agents.use", "agents.configure"], { agents: [] });
    expect(hrefs()).toContain("/growth-partner");
    expect(hrefs()).not.toContain("/employees");
  });

  it("hides retained profile access after legacy runtimes are disabled", () => {
    const disabled = shell(["agents.use", "agents.configure"]).agents.map((agent) => ({ ...agent, enabled: false }));
    renderSidebar(["agents.use", "agents.configure"], { agents: disabled });
    expect(hrefs()).toContain("/growth-partner");
    expect(hrefs()).not.toContain("/employees");
  });

  it("hides Growth Partner navigation from people without AI access", () => {
    renderSidebar([]);
    expect(hrefs()).not.toContain("/growth-partner");
    expect(hrefs()).not.toContain("/employees");
  });

  it("highlights the single partner route", () => {
    nav.pathname = "/growth-partner";
    renderSidebar();
    const current = screen.getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page");
    expect(current.map((a) => a.getAttribute("href"))).toContain("/growth-partner");
    expect(current.map((a) => a.getAttribute("href"))).not.toContain("/employees");
  });

  it("keeps the AQi walkthrough anchor on the Growth Partner link", () => {
    const { container } = renderSidebar();
    expect(container.querySelector('[data-tour="workforce"]')).not.toBeNull();
    expect(container.querySelector('a[href="/growth-partner"][data-aqi-target="nav.workforce"]')).not.toBeNull();
    expect(container.querySelector('a[href="/overview"][data-aqi-target]')).not.toBeNull();
  });

  it("renders the wordmark through the shared Logo with no colour override on the link", () => {
    renderSidebar();
    const brand = screen.getByRole("link", { name: "iAcquire overview" });
    expect(brand.className).toContain("workspace-nav-brand");
    expect(brand.className).not.toContain("text-white");
    expect(within(brand).getByText("AcquireOS").className).toContain("logo-accent");
    expect(screen.getByRole("navigation", { name: "Main" }).className).toContain("workspace-nav");
  });
});
