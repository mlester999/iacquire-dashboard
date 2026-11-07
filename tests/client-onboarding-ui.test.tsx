// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { SetupPaymentLine } from "@/components/setup/setup-payment-line";
import { OnboardedBanner } from "@/components/setup/onboarded-banner";
import SetupPage from "@/app/(portal)/setup/page";
import { ReviewPanel } from "@/components/onboarding/review-panel";
import { WorkforceGallery } from "@/components/workforce/gallery";
import { AGENT_BY_KEY, AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { deriveLaunchReadiness, type EmployeeFact, type LaunchFacts } from "@/lib/launch-readiness";
import { toStored } from "@/server/onboarding/answers";
import { buildReviewModel, computeProgress, planAddOns, planScope, type ConnectionFacts } from "@/lib/onboarding/engine";
import { PAYMENT_REQUIRED_SENTENCE } from "@/lib/billing-clearance";
import { SETUP_PAYMENT_CONFIRMED, SETUP_PAYMENT_WAITING, setupPaymentLine } from "@/lib/onboarding/setup-payment-line";
import { SETUP_REQUIRED_LABEL } from "@/lib/agents";
import type { AnswerValue, StoredAnswers } from "@/lib/onboarding/types";

vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("@/app/actions/workforce", () => ({ requestSetupAction: vi.fn() }));
// The launch panel asks the server for its state; here that never answers, so nothing changes under a test.
vi.mock("@/app/actions/launch-readiness", () => ({ getLaunchReadinessAction: vi.fn(() => new Promise<never>(() => {})), dismissCalendarNoticeAction: vi.fn(), runLaunchIntentAction: vi.fn() }));

// The Setup page reads the workspace, the launch state and the saved answers. Each is a fixture a test sets; the page's own output is what is rendered.
const server = vi.hoisted(() => ({ ctx: null as unknown, launch: null as unknown, answerRows: [] as unknown[], answersFail: false, roleRows: [{ role_key: "lead_hunter" }] }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/setup" }));
vi.mock("@/server/tenancy/context", () => ({ requireOrgContext: async () => server.ctx }));
vi.mock("@/server/setup/snapshots", () => ({ getClientSetupSnapshot: async () => ({ tasks: [] }) }));
vi.mock("@/components/setup/setup-center", () => ({ SetupCenter: () => <div data-testid="setup-center" /> }));
vi.mock("@/server/setup/launch-readiness", () => ({
  getLaunchReadiness: async () => {
    if (server.launch instanceof Error) throw server.launch;
    return server.launch;
  },
}));
vi.mock("@/server/db", () => ({
  withSystem: async (fn: (db: unknown) => unknown) => fn({ query: async () => ({ rows: [] }) }),
  withUser: async (_id: string, fn: (db: unknown) => unknown) => fn({ query: async (sql: string) => ({ rows: /from agent_instances where/.test(sql) ? server.roleRows : [] }) }),
}));
vi.mock("@/server/workforce/service", () => ({ listAgents: async () => [] }));
vi.mock("@/server/billing/clearance", () => ({ isSetupPaymentClearedFor: async () => true }));
vi.mock("@/server/setup/native-evidence", () => ({ crmOwners: async () => ({ mode: "native" }) }));
vi.mock("@/server/onboarding/service", () => ({ latestOnboardingNotes: async () => [] }));
vi.mock("@/server/onboarding/answers", async (original) => ({
  ...(await original<typeof import("@/server/onboarding/answers")>()),
  loadAnswerRows: async () => {
    if (server.answersFail) throw new Error("answers unavailable");
    return server.answerRows;
  },
}));
vi.mock("@/server/calendars/connections", () => ({ CALENDAR_NOTICE_COOKIE: "calendar_notice", calendarNoticeFor: () => null }));

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(() => cleanup());

describe("the Setup payment line", () => {
  it("says confirmed or waiting from the database's yes or no, and nothing when it was not answered", () => {
    expect(setupPaymentLine(true)).toBe(SETUP_PAYMENT_CONFIRMED);
    expect(setupPaymentLine(false)).toBe(SETUP_PAYMENT_WAITING);
    expect(setupPaymentLine(null)).toBeNull();
    expect(setupPaymentLine(undefined)).toBeNull();
    const { container } = render(<SetupPaymentLine cleared={undefined} billingHref="/settings/billing" />);
    expect(container.innerHTML).toBe("");
  });

  it("waiting: the plain sentence, no claim that anything was detected or paid, and a way to ask", () => {
    render(<SetupPaymentLine cleared={false} />);
    const region = screen.getByRole("region", { name: "Setup payment not confirmed yet" });
    expect(region.getAttribute("data-state")).toBe("waiting");
    expect(region.textContent).toContain(`${PAYMENT_REQUIRED_SENTENCE}.`);
    expect(region.textContent).toContain("help button");
    expect(region.textContent).not.toMatch(/detected|received your|thank you for your payment/i);
    expect(within(region).queryByRole("link")).toBeNull();
  });

  it("confirmed: says so, and gives the billing link only to someone who may see billing", () => {
    const { unmount } = render(<SetupPaymentLine cleared billingHref="/settings/billing" />);
    const region = screen.getByRole("region", { name: "Setup payment confirmed" });
    expect(region.getAttribute("data-state")).toBe("confirmed");
    const link = within(region).getByRole("link", { name: "View billing" });
    expect(link.getAttribute("href")).toBe("/settings/billing");
    expect(link.className).toContain("min-h-11");
    unmount();
    render(<SetupPaymentLine cleared billingHref={null} />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("the review's optional connections", () => {
  const answers: StoredAnswers = Object.fromEntries(
    Object.entries({ "a.business_name": "Optional Co", "a.industry": "real_estate", "a.business_model": "mixed" } as Record<string, AnswerValue>).map(([id, value]) => [id, { value, source: "user" as const, skipped: false, needsConfirmation: false, updatedAt: "2026-10-21T04:00:00Z" }]),
  );
  const facts = (extra: Partial<ConnectionFacts> = {}): ConnectionFacts => ({
    crmLinked: false, aiEmployeesVerified: 0, aiEmployeesTotal: 6, automationMapped: false,
    channels: { sms: { enabled: false, registration: "not_started" }, whatsapp: { enabled: false, registration: "not_started" }, email: { enabled: false, registration: "not_started" } },
    calendarConnected: false, websiteDomainVerified: false, invitedStaff: 0, ...extra,
  });
  const panel = (extra: Partial<ConnectionFacts>) =>
    render(<ReviewPanel review={buildReviewModel(answers, facts(extra), [])} loading={false} error={null} confirmed={false} submitting={false} alreadySubmitted={false} onRetry={() => {}} onEdit={() => {}} onConfirmChange={() => {}} onSubmit={() => {}} hideSubmit />);

  it("lists website chat and social media with their honest state, and says none of them is needed", () => {
    panel({ chatWidget: "waiting", socialConnected: false });
    const section = screen.getByRole("region", { name: "Optional connections" });
    const items = within(section).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Website chat is switched on, waiting for its first visit");
    expect(items[0].textContent).toContain("Waiting");
    expect(items[1].textContent).toContain("No social media account is connected");
    expect(items[1].textContent).toContain("Not connected");
    expect(section.textContent).toContain("Approving your setup does not depend on any of them");
  });

  it("shows a connected line as connected and a verified website address", () => {
    panel({ chatWidget: "installed", socialConnected: true, websiteDomainVerified: true });
    const section = screen.getByRole("region", { name: "Optional connections" });
    expect(within(section).getAllByText("Connected")).toHaveLength(3);
    expect(section.textContent).toContain("Website address verified");
  });

  it("shows no section when the server said nothing about any of them", () => {
    panel({});
    expect(screen.queryByRole("region", { name: "Optional connections" })).toBeNull();
  });
});

describe("the employee cards while Setup required", () => {
  const employee = (over: Record<string, unknown>) => ({
    id: String(over.role_key), role_key: "sales_assistant", display_name: "Sam", enabled: true, status: "setup_required", mode: "approval_required", summary: "Sam answers leads.",
    config_version: 1, last_health_check_at: null, last_health_ok: null, credential_ready: true, ...over,
  });
  const show = (agents: Array<Record<string, unknown>>, paymentCleared?: boolean) =>
    render(<WorkforceGallery agents={agents as never} capabilities={{}} companyName="Gallery Co" canConfigure canUse evaluatedAt={Date.parse("2026-10-24T00:00:00Z")} paymentCleared={paymentCleared} />);

  it("says the setup payment while it is unconfirmed", () => {
    show([employee({ role_key: "sales_assistant" }), employee({ role_key: "lead_hunter" })], false);
    expect(screen.getAllByText(`${SETUP_REQUIRED_LABEL}: waiting for setup payment`)).toHaveLength(2);
    expect(screen.queryByText(/Hermes profile not connected/)).toBeNull();
  });

  it("says the Hermes profile once the payment is confirmed, or when the page did not ask", () => {
    show([employee({ role_key: "sales_assistant" })], true);
    expect(screen.getByText(`${SETUP_REQUIRED_LABEL}: Hermes profile not connected`)).toBeTruthy();
    expect(screen.queryByText(/waiting for setup payment/)).toBeNull();
    cleanup();
    show([employee({ role_key: "sales_assistant" })], undefined);
    expect(screen.getByText(`${SETUP_REQUIRED_LABEL}: Hermes profile not connected`)).toBeTruthy();
  });

  it("the pill and the line agree, and a paused employee keeps its own wording", () => {
    show([employee({ role_key: "sales_assistant" }), employee({ role_key: "lead_hunter", enabled: false, status: "disabled" })], false);
    const cards = screen.getAllByRole("article");
    const sam = cards.find((c) => within(c).queryByText(`${SETUP_REQUIRED_LABEL}: waiting for setup payment`));
    expect(sam).toBeTruthy();
    expect(within(sam!).getAllByText(SETUP_REQUIRED_LABEL).length).toBeGreaterThanOrEqual(1);
    const paused = cards.find((c) => within(c).queryByText("Paused"));
    expect(paused).toBeTruthy();
    expect(within(paused!).queryByText(/Setup required:/)).toBeNull();
  });
});

describe("the retained capability records", () => {
  it("keeps saved role data reviewable while every new-work link opens the one permanent conversation", () => {
    const checkedAt = "2026-10-24T00:00:00.000Z";
    const profile = {
      id: "legacy-lead-hunter",
      role_key: "lead_hunter",
      display_name: "Lead Hunter",
      enabled: true,
      status: "online",
      mode: "approval_required",
      summary: "Researches and qualifies prospective customers.",
      config_version: 1,
      last_health_check_at: checkedAt,
      last_health_ok: true,
      credential_ready: true,
      tool_inventory_contract: "hermes.api_server.tool_catalog.v1",
      tool_inventory_digest: "a".repeat(64),
      tool_inventory_verified_at: checkedAt,
      tool_inventory_expires_at: "2026-10-24T00:02:00.000Z",
      tool_inventory_tool_count: 5,
    };
    render(<WorkforceGallery
      agents={[profile] as never}
      capabilities={{ lead_hunter: ["Research approved sources", "Check customer fit"] }}
      companyName="Gallery Co"
      canConfigure
      canUse
      evaluatedAt={Date.parse(checkedAt)}
      paymentCleared
    />);

    expect(screen.getByText("One AI Growth Partner.")).toBeTruthy();
    expect(screen.getByText("Legacy capability record 02")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Lead research" })).toBeTruthy();
    expect(screen.getByText("Preserved capability details")).toBeTruthy();
    const partnerLinks = screen.getAllByRole("link", { name: "Open AI Growth Partner" });
    expect(partnerLinks).toHaveLength(2);
    expect(partnerLinks.every((link) => link.getAttribute("href") === "/growth-partner/conversation")).toBe(true);
    expect(screen.queryByRole("link", { name: "Open chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check setup status" })).toBeNull();
    expect(screen.getByRole("link", { name: "Review record" }).getAttribute("href")).toBe("/employees/lead-hunter");
  });
});

describe("the review's plan", () => {
  const answers: StoredAnswers = Object.fromEntries(
    Object.entries({ "a.business_name": "Plan Co", "a.industry": "healthcare", "a.business_model": "local" } as Record<string, AnswerValue>).map(([id, value]) => [id, { value, source: "user" as const, skipped: false, needsConfirmation: false, updatedAt: "2026-10-21T04:00:00Z" }]),
  );
  const facts: ConnectionFacts = {
    crmLinked: false, aiEmployeesVerified: 0, aiEmployeesTotal: 6, automationMapped: false,
    channels: { sms: { enabled: false, registration: "not_started" }, whatsapp: { enabled: false, registration: "not_started" }, email: { enabled: false, registration: "not_started" } },
    calendarConnected: false, websiteDomainVerified: false, invitedStaff: 0,
  };
  const show = (roles: readonly AgentRoleKey[], studio = false) =>
    render(<ReviewPanel review={buildReviewModel(answers, facts, [...roles], planScope(roles), planAddOns({ studio: { entitled: studio, reason: "Automation Studio is part of the optional Managed Maintenance plan." }, managedStorage: studio }))} loading={false} error={null} confirmed={false} submitting={false} alreadySubmitted={false} onRetry={() => {}} onEdit={() => {}} onConfirmChange={() => {}} onSubmit={() => {}} hideSubmit />);

  it("shows five retained role profiles for a plan that leaves one out and keeps the existing plan exclusion", () => {
    show(AGENT_ROLE_KEYS.filter((r) => r !== "sales_assistant"));
    const plan = screen.getByRole("region", { name: "What your plan includes" });
    expect(plan.textContent).toContain("Your current plan includes five of the six retained role profiles.");
    expect(plan.textContent).toMatch(/AI Sales Assistant: not part of your plan, so it does not hold up launch/);
    expect(within(plan).getAllByRole("listitem").length).toBeGreaterThanOrEqual(6);
    expect(screen.getByRole("heading", { name: "Existing profile settings" })).toBeTruthy();
    expect(screen.getByText(/histories stay with your workspace.*staged migration to one AI Growth Partner/i)).toBeTruthy();
    expect(screen.getByText("Prepare or update and verify retained profiles")).toBeTruthy();
  });

  it("shows all six retained role profiles for the full legacy plan", () => {
    show(AGENT_ROLE_KEYS);
    expect(screen.getByRole("region", { name: "What your plan includes" }).textContent).toContain("Your current plan includes all six retained role profiles.");
    expect(screen.getByRole("heading", { name: "Existing profile settings" })).toBeTruthy();
  });

  it("shows the paid extras as information, included only when the plan has them", () => {
    const { unmount } = show(AGENT_ROLE_KEYS, false);
    let plan = screen.getByRole("region", { name: "What your plan includes" });
    expect(within(plan).getAllByText("Not included")).toHaveLength(2);
    expect(plan.textContent).toContain("Automation Studio");
    expect(plan.textContent).toContain("Your CRM, inbox, booking and website are not part of any plan limit.");
    unmount();
    show(AGENT_ROLE_KEYS, true);
    plan = screen.getByRole("region", { name: "What your plan includes" });
    expect(within(plan).getAllByText("Included")).toHaveLength(2);
    expect(within(plan).queryByText("Not included")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The banner after submitting, and the Setup page's own states
// ---------------------------------------------------------------------------

const launchEmployee = (role: AgentRoleKey, over: Partial<EmployeeFact> = {}): EmployeeFact => ({
  role, entitled: true, provisioning: "succeeded", provisioningDetail: null, attempts: 1, maxAttempts: 3, nextRetryAt: null, healthFailed: false, healthDetail: null, heldForReview: false, configVersion: 3,
  readiness: { state: "ready", chatAvailable: true, workReady: true, description: "Ready.", blocking: [] }, ...over,
});
function launchFacts(over: Partial<LaunchFacts> = {}): LaunchFacts {
  return {
    submitted: true, paymentCleared: true, canOpenBilling: true,
    profile: { companyName: true, industry: true, description: true, timezone: "America/Chicago", timezoneAnswered: true },
    knowledge: { approved: 3, pending: 0 },
    crm: { mode: "native", blueprint: "verified", pipelineReady: true, records: { state: "in_place", tags: 2, contactFields: 1, forms: 1 }, providerConnected: false },
    appointments: { wanted: false, calendar: null, externalCalendarConnected: false },
    channels: [],
    employees: AGENT_ROLE_KEYS.map((role) => launchEmployee(role)),
    verification: AGENT_ROLE_KEYS.map((role) => ({ role, state: "passed" as const, configVersion: 3, detail: null })),
    ...over,
  };
}
const companyNotSaved = { companyName: false, industry: true, description: true, timezone: "America/Chicago", timezoneAnswered: true };

describe("the existing AI profiles banner", () => {
  it("never says 'N/6 ready' while the launch judge says action required, and shows only the judge's own numbers", () => {
    // Every employee answers in chat, and the company details are not saved: the old count would have said 6/6 ready above an "Action required".
    const readiness = deriveLaunchReadiness(launchFacts({ profile: companyNotSaved }));
    expect(readiness.state).toBe("action_required");
    render(<OnboardedBanner nativeCrm crmGuide readiness={readiness} />);
    expect(document.body.textContent).not.toMatch(/\d+\s*\/\s*6\s*ready/i);
    expect(screen.getByTestId("banner-launch").textContent).toBe(`${readiness.label}: ${readiness.passed} of ${readiness.total} checks passed`);
  });

  it("says each employee in the judge's own words, so the banner and the panel never disagree", () => {
    const hunter = launchEmployee("lead_hunter", { provisioning: "in_progress", readiness: { state: "pending_setup", chatAvailable: false, workReady: false, description: "Not ready.", blocking: [] } });
    const readiness = deriveLaunchReadiness(launchFacts({ employees: AGENT_ROLE_KEYS.map((role) => (role === "lead_hunter" ? hunter : launchEmployee(role))) }));
    const { container } = render(<OnboardedBanner nativeCrm crmGuide readiness={readiness} />);
    const card = (role: AgentRoleKey) => container.querySelector(`[data-employee="${role}"]`) as HTMLElement;
    const hunterItem = readiness.steps.flatMap((s) => s.items).find((i) => i.key === "employees.lead_hunter")!;
    expect(within(card("lead_hunter")).getByText("In progress")).toBeTruthy();
    expect(card("lead_hunter").textContent).toContain(hunterItem.detail);
    expect(within(card("lead_hunter")).getByRole("link").getAttribute("href")).toBe(`/employees/${AGENT_BY_KEY.lead_hunter.slug}`);
    // Completed checks remain attached to the preserved record; client work still uses one Growth Partner conversation.
    expect(within(card("crm_manager")).getByText("Done")).toBeTruthy();
    expect(within(card("crm_manager")).getByRole("link").getAttribute("href")).toBe(`/employees/${AGENT_BY_KEY.crm_manager.slug}`);
  });

  it("counts nothing when the judge could not be read, and shows no count of its own", () => {
    render(<OnboardedBanner nativeCrm crmGuide readiness={null} />);
    expect(document.body.textContent).not.toMatch(/\d+\s*\/\s*6\s*ready/i);
    expect(screen.queryByTestId("banner-launch")).toBeNull();
    expect(screen.getAllByText("Action required")).toHaveLength(6);
  });

  it("labels retained records as previous role profiles and keeps them out of chat", () => {
    render(<OnboardedBanner nativeCrm crmGuide readiness={null} />);
    const records = screen.getByRole("status", { name: "Previous role profiles" });
    expect(screen.getByText("Previous role profiles preserved")).toBeTruthy();
    expect(screen.getByText(/Moving this workspace to one AI Growth Partner requires its own runtime and permission checks plus your approval/)).toBeTruthy();
    const profileLinks = within(records).getAllByRole("link").filter((link) => link.getAttribute("href")?.startsWith("/employees/"));
    expect(profileLinks).toHaveLength(6);
    expect(within(records).queryByRole("link", { name: /Open chat/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/six AI employees/i);
  });
});

// The Setup page reads the workspace, the launch state and the saved answers; here those are fixtures, and what the page hands the browser is what is rendered.
describe("the Setup page", () => {
  const user = (over: Record<string, unknown> = {}) => ({ source: "user", skipped: false, needs_confirmation: false, updated_at: new Date("2026-10-26T06:00:00Z"), ...over });
  const answerRow = (question_id: string, value: unknown, over: Record<string, unknown> = {}) => ({ question_id, value, ...user(over) });
  const page = async (params: { onboarded?: string } = {}) => render(await SetupPage({ searchParams: Promise.resolve(params) }));

  beforeEach(() => {
    server.ctx = { user: { id: "u1", fullName: "Dana Reyes" }, org: { orgId: "o1", kind: "client", name: "Roofing Co", onboardingCompletedAt: null, isDemo: false, timezone: "America/Chicago" }, can: () => true };
    server.launch = null;
    server.answerRows = [];
    server.answersFail = false;
  });

  it("before submitting, with nothing answered, offers to start", async () => {
    await page();
    expect(screen.getByText("Let's start with your company information")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Start company setup" }).getAttribute("href")).toBe("/onboarding");
    expect(screen.queryByText("Continue where you left off")).toBeNull();
  });

  it("before submitting, with answers saved, says so with the counts and offers to continue", async () => {
    server.answerRows = [answerRow("a.business_name", "Roofing Co"), answerRow("a.timezone", "America/Chicago"), answerRow("a.contact_email", "owner@roofing.example")];
    const expected = computeProgress(toStored(server.answerRows as never), planScope(["lead_hunter"]));
    expect(expected.done).toBeGreaterThan(0);
    await page();
    expect(screen.getByText("Continue where you left off")).toBeTruthy();
    expect(screen.getByText(new RegExp(`^${expected.done} of ${expected.total} questions are saved\\.`))).toBeTruthy();
    expect(screen.getByRole("link", { name: "Continue company setup" }).getAttribute("href")).toBe("/onboarding");
    expect(screen.queryByText("Let's start with your company information")).toBeNull();
  });

  it("does not call what the workspace already knew an answer the person gave", async () => {
    server.answerRows = [answerRow("a.business_name", "Roofing Co", { source: "prefill" }), answerRow("a.timezone", "America/Chicago", { source: "prefill" })];
    await page();
    expect(screen.getByText("Let's start with your company information")).toBeTruthy();
    expect(screen.queryByText("Continue where you left off")).toBeNull();
  });

  it("offers no way in to a member who may not edit the company profile, and does not read their answers", async () => {
    server.ctx = { ...(server.ctx as object), can: () => false };
    server.answerRows = [answerRow("a.business_name", "Roofing Co")];
    await page();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Let's start with your company information")).toBeTruthy();
  });

  it("falls back to the plain start when the saved answers cannot be read", async () => {
    server.answersFail = true;
    await page();
    expect(screen.getByText("Let's start with your company information")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Start company setup" })).toBeTruthy();
  });

  describe("after submitting", () => {
    const submitted = () => { server.ctx = { ...(server.ctx as object), org: { ...((server.ctx as { org: object }).org), onboardingCompletedAt: "2026-10-26T06:00:00Z" } }; };

    it("shows the launch panel and the checklist when the launch status was read", async () => {
      submitted();
      server.launch = deriveLaunchReadiness(launchFacts({ profile: companyNotSaved }));
      await page();
      expect(screen.getByRole("heading", { name: "Action required" })).toBeTruthy();
      expect(screen.getByTestId("setup-center")).toBeTruthy();
      expect(screen.queryByText("We couldn't read your launch status just now")).toBeNull();
    });

    it("says so, in an alert with a retry, when the launch status could not be read, keeps the checklist, and logs the kind of failure without any name", async () => {
      submitted();
      server.launch = new TypeError("connection reset");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await page();
        const alert = screen.getByRole("alert");
        expect(alert.textContent).toContain("We couldn't read your launch status just now");
        expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
        expect(screen.getByTestId("setup-center")).toBeTruthy();
        expect(warn).toHaveBeenCalledTimes(1);
        const logged = String(warn.mock.calls[0][0]);
        expect(logged).toContain("TypeError");
        expect(logged).not.toContain("Roofing Co");
        expect(logged).not.toContain("connection reset");
        expect(logged).not.toContain("o1");
      } finally {
        warn.mockRestore();
      }
    });

    it("hands the panel the judge's reading and the banner the same one, so they cannot disagree", async () => {
      submitted();
      const readiness = deriveLaunchReadiness(launchFacts({ profile: companyNotSaved }));
      server.launch = readiness;
      await page({ onboarded: "1" });
      expect(screen.getByTestId("banner-launch").textContent).toBe(`${readiness.label}: ${readiness.passed} of ${readiness.total} checks passed`);
      expect(document.body.textContent).not.toMatch(/\d+\s*\/\s*6\s*ready/i);
      expect(screen.getByRole("heading", { name: "Action required" })).toBeTruthy();
    });
  });
});
