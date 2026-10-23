// @vitest-environment jsdom
// The Invoices entry in the side menu: offered only where the module is switched on for the workspace, the person may see invoices and the workspace is a client's. The pages and
// actions check all three again; this is what the menu shows.
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }), usePathname: () => "/overview" }));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string; prefetch?: boolean }>(function Link({ href, prefetch: _p, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link, useLinkStatus: () => ({ pending: false }) };
});

import { Sidebar } from "@/components/shell/sidebar";
import { SettingsNav } from "@/components/settings/settings-nav";
import { ShellProvider } from "@/components/shell/shell-context";
import { TooltipProvider } from "@/components/ui/overlays";
import { PERMISSION_MATRIX, type Permission } from "@/lib/permissions";
import type { ShellData } from "@/server/queries/shell";

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

const shell = (over: { kind?: string; permissions?: Permission[]; features?: string[] } = {}): ShellData => ({
  user: { id: "u1", name: "Bailey Owner", email: "owner@example.test", platformRole: "none" },
  org: { id: "o1", name: "Brightside Roofing", isDemo: false, kind: over.kind ?? "client", onboardingComplete: true, timezone: "UTC", role: "owner" },
  memberships: [], permissions: over.permissions ?? ["invoices.view"], agents: [], unreadNotifications: 0, pendingApprovals: 0, setup: { visible: false, percent: null, needsAttention: 0 },
  projectsAttention: 0, requestsAttention: 0, inboxAttention: 0, crmMode: "native", features: over.features,
});
const renderSidebar = (data: ShellData) => render(<ShellProvider value={data}><TooltipProvider><Sidebar /></TooltipProvider></ShellProvider>);
const link = () => screen.queryByRole("link", { name: /Invoices/ });

describe("the Invoices menu entry", () => {
  it("is offered where the module is on, the person may see invoices and the workspace is a client's", () => {
    renderSidebar(shell({ features: ["invoices"] }));
    expect(link()?.getAttribute("href")).toBe("/invoices");
  });

  it("is not offered without the switch, with another module's switch, without the right, or in an agency workspace", () => {
    for (const data of [
      shell({ features: [] }), shell(), shell({ features: ["proposals", "esign"] }), shell({ features: ["invoices"], permissions: [] }), shell({ features: ["invoices"], kind: "agency" }),
    ]) {
      renderSidebar(data);
      expect(link()).toBeNull();
      cleanup();
    }
  });

  it("is for the roles that may see invoices, as the permission table says: the owner, managers and salespeople, and not agency staff or the rest", () => {
    expect([...PERMISSION_MATRIX["invoices.view"]].sort()).toEqual(["admin", "owner", "sales_rep"]);
  });
});

describe("the Customer payments entry in Settings", () => {
  const entry = () => screen.queryByRole("link", { name: "Customer payments" });

  it("is offered to the person who may connect a payment account, where invoicing is on, as a separate entry from iAcquire's own billing", () => {
    render(<SettingsNav permissions={["invoices.connect_payments", "usage.view"]} features={["invoices"]} />);
    expect(entry()?.getAttribute("href")).toBe("/settings/payments");
    expect(screen.getByRole("link", { name: "Billing & credits" }).getAttribute("href")).toBe("/settings/billing");
  });

  it("is not offered without the right, without the switch, or when only other modules are on", () => {
    for (const [permissions, features] of [
      [["usage.view"], ["invoices"]], [["invoices.connect_payments"], []], [["invoices.connect_payments"], undefined], [["invoices.connect_payments"], ["proposals"]], [["invoices.view"], ["invoices"]],
    ] as Array<[Permission[], string[] | undefined]>) {
      render(<SettingsNav permissions={permissions} features={features} />);
      expect(entry()).toBeNull();
      cleanup();
    }
  });
});
