// @vitest-environment jsdom
// The top bar's breadcrumb shows the page's title from src/components/shell/titles.ts: on an invoice screen it says Invoices, not the product name.
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Topbar } from "@/components/shell/topbar";
import { ShellProvider } from "@/components/shell/shell-context";
import { TooltipProvider } from "@/components/ui/overlays";
import type { ShellData } from "@/server/queries/shell";

const path = vi.hoisted(() => ({ current: "/overview" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => path.current,
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

const shell: ShellData = {
  user: { id: "u1", name: "Bailey Owner", email: "owner@example.test", platformRole: "none" },
  org: { id: "o1", name: "Brightside Roofing", isDemo: false, kind: "client", onboardingComplete: true, timezone: "UTC", role: "owner" },
  memberships: [], permissions: ["invoices.view"], agents: [], unreadNotifications: 0, pendingApprovals: 0, setup: { visible: false, percent: null, needsAttention: 0 },
  projectsAttention: 0, requestsAttention: 0, inboxAttention: 0, crmMode: "native", features: ["invoices"],
};

function breadcrumbAt(pathname: string): string {
  path.current = pathname;
  render(<ShellProvider value={shell}><TooltipProvider><Topbar onOpenMenu={() => {}} /></TooltipProvider></ShellProvider>);
  return screen.getByRole("navigation", { name: "Breadcrumb" }).textContent ?? "";
}

describe("the top bar breadcrumb", () => {
  it("says Invoices on every invoice screen", () => {
    for (const p of ["/invoices", "/invoices/new", "/invoices/settings"]) {
      const text = breadcrumbAt(p);
      expect(text, p).toContain("Invoices");
      expect(text, p).not.toMatch(/iAcquire$/);
      cleanup();
    }
  });

  it("says Reviews on the reviews pages and Proposals on the proposal pages", () => {
    expect(breadcrumbAt("/crm/reviews")).toContain("Reviews");
    cleanup();
    expect(breadcrumbAt("/proposals/new")).toContain("Proposals");
  });
});
