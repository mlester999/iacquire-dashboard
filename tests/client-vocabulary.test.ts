// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AnalyticsView } from "@/components/analytics/analytics-view";
import { PartnerOverviewCard } from "@/components/overview/partner-overview-card";
import { Sidebar } from "@/components/shell/sidebar";
import { ShellProvider } from "@/components/shell/shell-context";
import { TooltipProvider } from "@/components/ui/overlays";
import type { ShellData } from "@/server/queries/shell";
import type { Permission } from "@/lib/permissions";
import {
  allowlistDrift,
  CLIENT_VOCABULARY_ALLOWLIST,
  FORBIDDEN_COPY_PATTERNS,
  forbiddenValueMatches,
  sourceTextValues,
  sourceTextValuesFromText,
  typescriptFiles,
} from "./support/vocabulary-allowlist";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/overview",
}));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }>(function Link({ href, prefetch: _prefetch, ...props }, ref) {
    return React.createElement("a", { ...props, href, ref });
  });
  return { default: Link, useLinkStatus: () => ({ pending: false }) };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/shell", () => ({ switchOrgAction: vi.fn() }));
vi.mock("@/components/notifications/notification-center", () => ({ NotificationCenter: () => null }));
vi.mock("@/components/auth/logout-confirmation", () => ({ useLogoutConfirmation: () => ({ requestLogout: vi.fn() }) }));
vi.mock("@/components/providers", () => ({ useTheme: () => ({ resolved: "light", setTheme: vi.fn() }) }));
vi.mock("@/components/charts", () => ({
  AreaChart: () => null,
  Columns: () => null,
  StatusSplit: () => null,
  HBarList: ({ rows }: { rows: Array<{ key: string; label: React.ReactNode; value: number }> }) => React.createElement("ul", null, ...rows.map((row) => React.createElement("li", { key: row.key }, row.label, " ", row.value))),
}));
vi.mock("@/components/ui/overlays", async () => {
  const React = await import("react");
  return {
    TooltipProvider: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    Segmented: () => null,
    Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  };
});

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

const CLIENT_SCAN_ROOTS = [
  "src/app/(portal)",
  "src/app/(setup)",
  "src/app/(auth)",
  "src/app/actions",
  "src/components",
  "src/lib/agents.ts",
  "src/lib/chat-navigation.ts",
  "src/lib/onboarding/business-profile.ts",
  "src/lib/permissions.ts",
  "src/lib/setup-copy.ts",
  "src/lib/storage-policy.ts",
  "src/server/chat/service.ts",
  "src/server/onboarding",
  "src/server/setup",
];
const CLIENT_EXCLUDED_PREFIXES = ["src/components/admin", "src/components/workforce"];
const CLIENT_TERMS = FORBIDDEN_COPY_PATTERNS.map(({ term }) => term).filter((term) => term !== "price_literal" && term !== "unverified_voice_booking");
const CLIENT_FILES = typescriptFiles(CLIENT_SCAN_ROOTS, CLIENT_EXCLUDED_PREFIXES);
const LEGACY_ROLES = ["Operations Manager", "Lead Hunter", "Appointment Setter", "Sales Assistant", "CRM Manager", "Performance Analyst"];
const PARTNER_ROLE = "growth_partner" as ShellData["agents"][number]["role"];

const PERMISSIONS: Permission[] = [
  "agents.use", "agents.configure", "workspace.view", "inbox.view", "leads.view", "appointments.view", "sales.view",
  "proposals.view", "invoices.view", "retention.view", "analytics.view", "approvals.view", "knowledge.view", "website.view",
  "social.view", "activity.view", "contacts.view", "crm.view", "workflows.view", "projects.view", "maintenance.view",
  "support.use", "integrations.view", "team.view", "usage.view", "billing.view", "setup.view", "staff.availability",
];

function partnerOnlyShell(): ShellData {
  return {
    user: { id: "u-partner", name: "Morgan Owner", email: "owner@example.test", platformRole: "client" },
    org: { id: "o-partner", name: "Northstar Roofing", isDemo: false, kind: "client", onboardingComplete: true, timezone: "UTC", role: "owner" },
    memberships: [],
    permissions: PERMISSIONS,
    agents: [
      { role: PARTNER_ROLE, displayName: "AI Growth Partner", status: "online" as const, enabled: true },
      ...LEGACY_ROLES.map((displayName, index) => ({ role: ["operations_manager", "lead_hunter", "appointment_setter", "sales_assistant", "crm_manager", "performance_analyst"][index] as ShellData["agents"][number]["role"], displayName, status: "offline" as const, enabled: false })),
    ],
    unreadNotifications: 0,
    pendingApprovals: 0,
    setup: { visible: true, percent: 100, needsAttention: 0 },
    projectsAttention: 0,
    requestsAttention: 0,
    inboxAttention: 0,
    crmMode: "native",
    automationStudio: { entitled: true },
    features: ["proposals", "invoices", "request_changes"],
  };
}

const analyticsData = {
  sources: { crm: false, calendar: false, native: { opportunities: false, appointments: false } },
  leads: { totals: { total: 0, approved: 0, rejected: 0, reviewed: 0, avg_score: null, with_sources: 0 }, bySource: [] },
  appointments: null,
  sales: null,
  workforce: {
    byAgent: [
      { role_key: "growth_partner", total: 3, completed: 3, failed: 0, tokens: 600 },
      ...["operations_manager", "lead_hunter", "appointment_setter", "sales_assistant", "crm_manager", "performance_analyst"].map((role_key) => ({ role_key, total: 0, completed: 0, failed: 0, tokens: 0 })),
    ],
    toolSteps: 0,
    cancelled: 0,
  },
  execution: { succeeded: 0, blocked: 0, failed: 0, rejected: 0, expired: 0 },
  usage: { messages: 0, tokens: 0, research: 0, help: 0 },
  retention: { total: 0, active: 0, at_risk: 0, churned: 0 },
} as React.ComponentProps<typeof AnalyticsView>["data"];

describe("client vocabulary ratchet", () => {
  it("ignores comments, identifiers, import paths and object keys while retaining copy values", () => {
    const values = sourceTextValuesFromText(`
      // AI team in a comment is not UI copy.
      import { AI_Growth_Partner } from "AI team import path";
      const AI_team = "harmless";
      const labels = { "AI team": "AI Growth Partner" };
    `).map(({ value }) => value);
    expect(values).toEqual(["harmless", "AI Growth Partner"]);
  });

  it("scans client-facing source text and holds reviewed exceptions to exact counts", () => {
    const matches = CLIENT_FILES.flatMap((file) => forbiddenValueMatches(file, sourceTextValues(file), CLIENT_TERMS));
    const drift = allowlistDrift(matches, CLIENT_VOCABULARY_ALLOWLIST);
    expect({ unexpected: drift.unexpected, stale: drift.stale, changed: drift.changed }, JSON.stringify({ files: CLIENT_FILES.length, unexpected: drift.unexpected, stale: drift.stale, changed: drift.changed }, null, 2)).toEqual({ unexpected: [], stale: [], changed: [] });
  });

  it("keeps the twelve required product terms on their intended client destinations", () => {
    const required = [
      ["AI Growth Partner", "src/components/shell/sidebar.tsx"],
      ["AI Work Board", "src/components/shell/sidebar.tsx"],
      ["Business Brain", "src/components/growth-partner/control-center.tsx"],
      ["Integrations", "src/components/settings/settings-nav.tsx"],
      ["Goals", "src/components/growth-partner/control-center.tsx"],
      ["Permanent Conversation", "src/components/growth-partner/control-center.tsx"],
      ["Capability Access", "src/components/growth-partner/control-center.tsx"],
      ["Schedules & Calendar", "src/components/shell/sidebar.tsx"],
      ["Growth Partner Settings", "src/components/settings/settings-nav.tsx"],
      ["Activity and Approvals", "src/components/growth-partner/control-center.tsx"],
      ["Memory and Knowledge", "src/components/growth-partner/control-center.tsx"],
      ["Performance Reporting", "src/components/shell/sidebar.tsx"],
    ] as const;
    for (const [term, file] of required) {
      expect(sourceTextValues(file).map(({ value }) => value).join("\n"), `${term} in ${file}`).toContain(term);
    }
  });

  it("renders Overview, Performance Reporting and the sidebar for one partner with disabled legacy rows", () => {
    const overview = React.createElement(PartnerOverviewCard, { state: { status: "configured", currentVersion: 3 }, hasEnabledLegacyProfile: false, canConfigure: true });
    const analytics = React.createElement(AnalyticsView, {
      data: analyticsData,
      leadsByDay: [],
      messagesByDay: [],
      range: { key: "30d", from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T23:59:59.000Z", days: 30 },
      timeZone: "UTC",
      canExport: false,
      canChat: false,
    });
    const ShellProviderForTest = ShellProvider as React.ComponentType<{ value: ShellData; children?: React.ReactNode }>;
    const TooltipProviderForTest = TooltipProvider as React.ComponentType<{ children?: React.ReactNode }>;
    const sidebar = React.createElement(ShellProviderForTest, { value: partnerOnlyShell() }, React.createElement(TooltipProviderForTest, null, React.createElement(Sidebar)));
    const { container } = render(React.createElement(React.Fragment, null, overview, analytics, sidebar));
    const rendered = container.textContent ?? "";
    expect(rendered).toContain("AI Growth Partner");
    expect(rendered).toContain("AI Work Board");
    expect(rendered).toContain("Schedules & Calendar");
    expect(rendered).toContain("Performance Reporting");
    for (const role of LEGACY_ROLES) expect(rendered).not.toContain(role);
    expect(rendered).not.toMatch(/\bHermes\b|\bZeng\b|\bAI employees?\b|\bAI team\b/i);
  });
});
