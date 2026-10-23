// @vitest-environment jsdom
// The "Jump to your workspace" search lists the same modules the side navigation does. Social Media belongs to a client's workspace, so an agency workspace is not
// offered it there either (its pages and actions refuse in an agency workspace).
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Topbar } from "@/components/shell/topbar";
import { ShellProvider } from "@/components/shell/shell-context";
import { TooltipProvider } from "@/components/ui/overlays";
import type { ShellData } from "@/server/queries/shell";
import type { Permission } from "@/lib/permissions";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/overview",
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

const shell = (kind: string, permissions: Permission[]): ShellData => ({
  user: { id: "u1", name: "Bailey Owner", email: "owner@example.test", platformRole: "none" },
  org: { id: "o1", name: "Brightside Roofing", isDemo: false, kind, onboardingComplete: true, timezone: "UTC", role: "owner" },
  memberships: [], permissions, agents: [], unreadNotifications: 0, pendingApprovals: 0, setup: { visible: false, percent: null, needsAttention: 0 },
  projectsAttention: 0, requestsAttention: 0, inboxAttention: 0, crmMode: "native",
});

function searchFor(data: ShellData, query: string) {
  render(<ShellProvider value={data}><TooltipProvider><Topbar onOpenMenu={() => {}} /></TooltipProvider></ShellProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Search workspace navigation" }));
  fireEvent.change(screen.getByLabelText("Search workspace modules"), { target: { value: query } });
}

describe("the workspace search", () => {
  it("offers Social Media in a client workspace to people who can see it", () => {
    searchFor(shell("client", ["social.view"]), "social");
    expect(screen.getByRole("link", { name: /Social Media/ }).getAttribute("href")).toBe("/social");
  });

  it("does not offer it in an agency workspace, or to people who cannot see it", () => {
    searchFor(shell("agency", ["social.view"]), "social");
    expect(screen.queryByRole("link", { name: /Social Media/ })).toBeNull();
    expect(screen.getByText("No modules match your search.")).toBeTruthy();
    cleanup();
    searchFor(shell("client", []), "social");
    expect(screen.queryByRole("link", { name: /Social Media/ })).toBeNull();
  });
});
