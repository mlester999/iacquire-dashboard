// @vitest-environment jsdom
// The Automation Studio screens added for connections, templates and usage: what a person sees and what each control sends to the server. The server
// actions are stand-ins here (their rules are tested against the real services elsewhere); what is checked is that the screens say the true thing,
// ask before anything leaves the workspace, never show a secret, and disable what the plan or permission doesn't allow.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const actions = vi.hoisted(() => ({
  createConnectionAction: vi.fn(async (_input: unknown) => ({ ok: true as const, data: {} })),
  testConnectionAction: vi.fn(async (_id: string, _input: { confirmed: boolean }) => ({ ok: true as const, data: { ok: true, detail: "The test went through. The connection is verified.", connection: {} } })),
  rotateConnectionAction: vi.fn(async (_id: string, _secret: string) => ({ ok: true as const, data: {} })),
  revokeConnectionAction: vi.fn(async (_id: string) => ({ ok: true as const, data: { connection: {}, workflowsUsingIt: 2 } })),
  connectionCallsAction: vi.fn(async (_id: string) => ({ ok: true as const, data: [{ at: new Date().toISOString(), origin: "step", method: "POST", host: "api.example.com", path: "/v1/leads", outcome: "sent", httpStatus: 201, durationMs: 120, detail: null }] })),
  createFromStudioTemplateAction: vi.fn(async (_key: string, _input: { inputs: Record<string, unknown> }) => ({ ok: true as const, data: { id: "11111111-1111-4111-8111-111111111111", problems: 0 } })),
  setStudioWorkflowStatusAction: vi.fn(async (_id: string, _status: string) => ({ ok: true as const, data: {} })),
}));
vi.mock("@/app/actions/automation-studio", () => actions);
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn(), prefetch: vi.fn() }), usePathname: () => "/automation-studio" }));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }>(function Link({ href, prefetch: _p, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link };
});

import { ConnectionsPanel } from "@/components/automation-studio/connections-panel";
import { UsagePanel, type UsageData, type PlanSummary } from "@/components/automation-studio/usage-panel";
import { TemplateGallery } from "@/components/automation-studio/template-gallery";
import { TooltipProvider } from "@/components/ui/overlays";
import type { ConnectionView } from "@/lib/automation-studio/connections";
import type { EditorOptions } from "@/components/crm/workflows/types";

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const wrap = (ui: React.ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>);
const SECRET = "sk_live_Zr7Qw1XyAbCdEf90";
const HOOK = ["https://hooks.slack.com/services", "T0ABCDEFG", "B0HIJKLMN", "AbCdEfGhIjKlMnOpQrStUvWx"].join("/");

const conn = (over: Partial<ConnectionView> = {}): ConnectionView => ({
  id: "c1000000-0000-4000-8000-000000000001", kind: "http", name: "Operations API", status: "active", statusDetail: null, secretHint: "ef90", secretVersion: 1,
  settings: { host: "api.example.com", pathPrefix: "/v1", methods: ["GET", "POST"], auth: { type: "bearer" }, testPath: "/ping" }, host: "api.example.com",
  verifiedAt: new Date().toISOString(), lastUsedAt: null, consecutiveFailures: 0, rotatedAt: null, revokedAt: null, createdAt: new Date().toISOString(), ...over,
});
const slack = (over: Partial<ConnectionView> = {}) => conn({ id: "c2000000-0000-4000-8000-000000000002", kind: "slack_webhook", name: "Sales channel", host: "hooks.slack.com", settings: { channelLabel: "#sales" }, secretHint: "uvWx", ...over });

describe("Connections", () => {
  it("lists each connection with its host, allowed methods and status, and never a secret", () => {
    const { container } = wrap(<ConnectionsPanel connections={[conn(), slack({ status: "unverified", verifiedAt: null })]} timezone="UTC" canManage planReason={null} />);
    expect(screen.getByRole("heading", { name: "Connections", level: 1 })).toBeTruthy();
    const list = screen.getByRole("list", { name: "Connections" });
    expect(within(list).getByText("Operations API")).toBeTruthy();
    expect(within(list).getByText(/GET, POST/)).toBeTruthy();
    expect(within(list).getAllByText("Verified").length).toBeGreaterThan(0);
    expect(within(list).getAllByText("Not verified yet").length).toBeGreaterThan(0);
    expect(within(list).getByText(/Automations that use it wait until you send the test/)).toBeTruthy();
    expect(container.textContent).not.toContain(SECRET);
    expect(container.textContent).not.toContain("AbCdEfGhIjKlMnOpQrStUvWx");
    expect(container.textContent).toMatch(/…ef90/);
    // Slack is honest about what it is.
    expect(container.textContent).toMatch(/Signing in with Slack to pick channels isn’t available yet/);
  });

  it("says why a connection needs attention and offers the way out", () => {
    wrap(<ConnectionsPanel connections={[conn({ status: "needs_attention", statusDetail: "The other system refused the credentials." })]} timezone="UTC" canManage planReason={null} />);
    expect(screen.getByText(/The other system refused the credentials/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Verify with a test/ })).toBeTruthy();
  });

  it("asks before sending a test, says exactly what will be sent where, and sends nothing until confirmed", async () => {
    wrap(<ConnectionsPanel connections={[conn({ status: "unverified", verifiedAt: null })]} timezone="UTC" canManage planReason={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Verify with a test/ }));
    const dialog = await screen.findByRole("alertdialog").catch(() => screen.findByRole("dialog"));
    expect(dialog.textContent).toMatch(/one GET request/);
    expect(dialog.textContent).toContain("api.example.com/v1/ping");
    expect(actions.testConnectionAction).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send the test" }));
    await waitFor(() => expect(actions.testConnectionAction).toHaveBeenCalledWith("c1000000-0000-4000-8000-000000000001", { confirmed: true }));
  });

  it("describes a Slack test as one visible message, and does not send it on cancel", async () => {
    wrap(<ConnectionsPanel connections={[slack({ status: "unverified", verifiedAt: null })]} timezone="UTC" canManage planReason={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Verify with a test/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/one message/);
    expect(dialog.textContent).toMatch(/Everyone in that channel will see it/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(actions.testConnectionAction).not.toHaveBeenCalled();
  });

  it("revoking asks first, says what it does, and reports how many automations depend on it", async () => {
    wrap(<ConnectionsPanel connections={[conn()]} timezone="UTC" canManage planReason={null} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Operations API" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Revoke/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/erased for good/);
    expect(actions.revokeConnectionAction).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke connection" }));
    await waitFor(() => expect(actions.revokeConnectionAction).toHaveBeenCalledWith("c1000000-0000-4000-8000-000000000001"));
  });

  it("saves a Slack connection with the address typed into a masked field, and trims nothing the server needs", async () => {
    wrap(<ConnectionsPanel connections={[]} timezone="UTC" canManage planReason={null} />);
    expect(screen.getByText("No connections yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Add connection/ }));
    const dialog = await screen.findByRole("dialog");
    const address = within(dialog).getByLabelText("Slack webhook address") as HTMLInputElement;
    expect(address.type).toBe("password");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Sales channel" } });
    fireEvent.change(address, { target: { value: HOOK } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save connection" }));
    await waitFor(() => expect(actions.createConnectionAction).toHaveBeenCalledWith({ kind: "slack_webhook", name: "Sales channel", webhookUrl: HOOK, channelLabel: undefined }));
  });

  it("saves an HTTP connection with only the methods ticked and the credential in a masked field", async () => {
    wrap(<ConnectionsPanel connections={[]} timezone="UTC" canManage planReason={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Add connection/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: /HTTP API/ }));
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Orders" } });
    fireEvent.change(within(dialog).getByLabelText("Address"), { target: { value: "https://api.example.com/v1" } });
    const token = within(dialog).getByLabelText("Token") as HTMLInputElement;
    expect(token.type).toBe("password");
    fireEvent.change(token, { target: { value: SECRET } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save connection" }));
    await waitFor(() => expect(actions.createConnectionAction).toHaveBeenCalled());
    expect(actions.createConnectionAction.mock.calls[0][0]).toMatchObject({ kind: "http", name: "Orders", baseUrl: "https://api.example.com/v1", methods: ["GET", "POST"], auth: { type: "bearer" }, secret: SECRET });
  });

  it("without the plan: explains why, blocks setup and tests, and still lets a credential be revoked", () => {
    wrap(<ConnectionsPanel connections={[conn()]} timezone="UTC" canManage planReason="Your plan has expired. Setting up, verifying and replacing connections needs the plan." />);
    expect(screen.getByRole("note").textContent).toMatch(/You can still revoke a connection/);
    expect((screen.getByRole("button", { name: /Add connection/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Send test again/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "More actions for Operations API" })).toBeTruthy();
  });

  it("without the permission: read only, with the reason", () => {
    wrap(<ConnectionsPanel connections={[conn()]} timezone="UTC" canManage={false} planReason={null} />);
    expect(screen.queryByRole("button", { name: /Add connection/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Send test/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull();
    expect(screen.getByRole("note").textContent).toMatch(/needs the “Build and change automations” permission/);
  });

  it("shows the recent calls without anything that was sent or received", async () => {
    wrap(<ConnectionsPanel connections={[conn()]} timezone="UTC" canManage planReason={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Recent calls/ }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.textContent).toContain("POST api.example.com/v1/leads"));
    expect(dialog.textContent).toMatch(/sent · 201/);
    expect(dialog.textContent).toMatch(/What was sent and received isn’t kept/);
  });
});

// ---------------------------------------------------------------------------

const usage = (over: Partial<UsageData> = {}): UsageData => ({
  period: "2026-10", periodLabel: "October 2026", hardStop: true, warnAtPercent: 80, note: null,
  lines: [
    { key: "monthlyRuns", label: "Workflow runs", used: 120, limit: 5000, state: "ok", percent: 2, remaining: 4880, custom: false },
    { key: "monthlySteps", label: "Steps executed", used: 4100, limit: 5000, state: "warning", percent: 82, remaining: 900, custom: false },
    { key: "monthlyIntegrationCalls", label: "Calls to outside systems", used: 600, limit: 500, state: "exceeded", percent: 100, remaining: 0, custom: true },
  ],
  counters: [{ label: "Workflow runs", quantity: 120 }, { label: "Integration calls", quantity: 600 }],
  ...over,
});
const planOf = (over: Partial<PlanSummary> = {}): PlanSummary => ({ state: "active", title: "Managed Maintenance + Automation Studio", detail: "Your plan is active.", paidThrough: "Nov 20, 2026", graceEnds: null, entitled: true, ...over });
const wfs = [
  { id: "w1000000-0000-4000-8000-000000000001", name: "Lead alert", status: "active" as const, pausedForPlan: false, stepCount: 2 },
  { id: "w2000000-0000-4000-8000-000000000002", name: "Reminders", status: "paused" as const, pausedForPlan: true, stepCount: 3 },
  { id: "w3000000-0000-4000-8000-000000000003", name: "Draft idea", status: "draft" as const, pausedForPlan: false, stepCount: 1 },
];

describe("Usage and plan", () => {
  it("shows each limit with a real progress bar and says what happens at the limit", () => {
    wrap(<UsagePanel plan={planOf()} usage={usage()} workflows={wfs} canManage connectionsNeedingAttention={0} />);
    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(3);
    expect(bars[0].getAttribute("aria-valuetext")).toMatch(/120 of 5,000. Within your limit/);
    expect(bars[1].getAttribute("aria-valuetext")).toMatch(/Getting close/);
    expect(bars[2].getAttribute("aria-valuetext")).toMatch(/Limit reached/);
    expect(screen.getByText(/New work waits until next month, or until your limit is raised/)).toBeTruthy();
    expect(screen.getByText(/A limit set for your workspace/)).toBeTruthy();
    expect(screen.getByText(/Paid through Nov 20, 2026, as recorded by iAcquire after the payment was verified/)).toBeTruthy();
  });

  it("says a past-due plan keeps working until the grace date, and never that a payment was taken", () => {
    const { container } = wrap(<UsagePanel plan={planOf({ state: "past_due", detail: "A payment for your plan didn't go through.", graceEnds: "Oct 28, 2026", paidThrough: null })} usage={usage()} workflows={wfs} canManage connectionsNeedingAttention={1} />);
    expect(screen.getByRole("status").textContent).toMatch(/keeps working until Oct 28, 2026/);
    expect(screen.getByText("Payment past due")).toBeTruthy();
    expect(screen.getByRole("link", { name: /1 connection needs attention/ })).toBeTruthy();
    expect(container.textContent).not.toMatch(/payment received|thank you for your payment|charged/i);
  });

  it("lists plan-paused automations for review and turns one on only when asked", async () => {
    wrap(<UsagePanel plan={planOf()} usage={usage()} workflows={wfs} canManage connectionsNeedingAttention={0} />);
    const section = screen.getByText("Paused because of the plan").closest(".card-surface") as HTMLElement;
    expect(within(section).getByText("Reminders")).toBeTruthy();
    expect(actions.setStudioWorkflowStatusAction).not.toHaveBeenCalled();
    fireEvent.click(within(section).getByRole("button", { name: /Turn on/ }));
    await waitFor(() => expect(actions.setStudioWorkflowStatusAction).toHaveBeenCalledWith("w2000000-0000-4000-8000-000000000002", "active"));
    // An active one can be paused from the list.
    fireEvent.click(screen.getByRole("button", { name: /^Pause/ }));
    await waitFor(() => expect(actions.setStudioWorkflowStatusAction).toHaveBeenCalledWith("w1000000-0000-4000-8000-000000000001", "paused"));
  });

  it("offers no turn-on control without the plan or the permission, and points to the real plan page", () => {
    const { unmount } = wrap(<UsagePanel plan={planOf({ state: "expired", entitled: false, detail: "Your plan has expired.", paidThrough: null })} usage={usage()} workflows={wfs} canManage connectionsNeedingAttention={0} />);
    expect(screen.queryByRole("button", { name: /Turn on/ })).toBeNull();
    expect(screen.getByRole("link", { name: "See how to get the plan" }).getAttribute("href")).toBe("/maintenance");
    unmount();
    wrap(<UsagePanel plan={planOf()} usage={usage()} workflows={wfs} canManage={false} connectionsNeedingAttention={0} />);
    expect(screen.queryByRole("button", { name: /Turn on|Pause/ })).toBeNull();
  });
});

// ---------------------------------------------------------------------------

const options = (over: Partial<EditorOptions> = {}): EditorOptions => ({
  tags: [{ id: "t1", name: "Hot", color: "#f00" }], members: [{ id: "u1", name: "Bailey", role: "owner" }],
  pipelines: [{ id: "p1", name: "Sales", stages: [{ id: "s1", name: "Quote sent", kind: "open" }, { id: "s2", name: "Won", kind: "won" }] }],
  contactFields: [], opportunityFields: [], assignmentRules: [], assignmentRuleRefs: [],
  templates: [
    { id: "m1", key: "welcome", name: "Welcome", channel: "sms", purpose: "service", version: 1, subject: null, body: "Hi {{contact.first_name}}", contentHash: "a".repeat(64) },
    { id: "m2", key: "review", name: "Review request", channel: "sms", purpose: "service", version: 1, subject: null, body: "Review us: {{review.link}}", contentHash: "b".repeat(64) },
  ],
  unapprovedTemplates: [], n8nMappings: [], webhooks: [], employees: [{ roleKey: "crm_manager", name: "CRM Manager", mode: "ask", enabled: true, ready: true, connected: true, liveRuns: true }],
  calendars: [{ id: "cal1", name: "Estimates" }], appointmentTypes: [], forms: [{ id: "f1", name: "Enquiry", status: "published" }], customValues: [],
  connections: [{ id: "c2000000-0000-4000-8000-000000000002", name: "Sales channel", kind: "slack_webhook", status: "active", host: "hooks.slack.com", methods: [] }],
  folders: [], ...over,
});

describe("Ready-made automations", () => {
  it("shows every template with what it reaches and what is missing, and filters by category", () => {
    wrap(<TemplateGallery options={options()} canBuild />);
    const cards = document.querySelectorAll("[data-template]");
    expect(cards.length).toBeGreaterThanOrEqual(15);
    fireEvent.click(screen.getByRole("button", { name: "Other systems" }));
    const shown = [...document.querySelectorAll("[data-template]")].map((c) => c.getAttribute("data-template"));
    expect(shown.sort()).toEqual(["booking-sync-http", "lead-sync-http", "won-deal-billing-http"]);
    // The workspace has no HTTP connection: these say so, offer the way to add one, and can't be set up yet.
    const card = document.querySelector('[data-template="lead-sync-http"]') as HTMLElement;
    expect(card.textContent).toMatch(/Needs an HTTP connection first/);
    expect(within(card).getByRole("link", { name: "Add a connection" }).getAttribute("href")).toBe("/automation-studio/connections");
    expect((within(card).getByRole("button", { name: "Set up" }) as HTMLButtonElement).disabled).toBe(true);
    expect(card.textContent).toMatch(/Calls another system/);
  });

  it("sets up a template with only the workspace's own choices and opens the result", async () => {
    wrap(<TemplateGallery options={options()} canBuild />);
    const card = document.querySelector('[data-template="stalled-deal-watch"]') as HTMLElement;
    expect(card.textContent).toMatch(/Stays inside iAcquire/);
    fireEvent.click(within(card).getByRole("button", { name: "Set up" }));
    const dialog = await screen.findByRole("dialog");
    const create = within(dialog).getByRole("button", { name: "Create automation" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true); // the stage is required
    const select = within(dialog).getByLabelText("Stage to watch") as HTMLSelectElement;
    // Only open stages of a pipeline are offered.
    expect([...select.options].map((o) => o.textContent)).toEqual(["Choose…", "Quote sent"]);
    fireEvent.change(select, { target: { value: select.options[1].value } });
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(actions.createFromStudioTemplateAction).toHaveBeenCalledWith("stalled-deal-watch", { inputs: { stage: { pipelineId: "p1", stageId: "s1" } } }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/automation-studio/11111111-1111-4111-8111-111111111111"));
  });

  it("warns that anything reaching outside needs testing, publishing and the owner's approval of the exact version", async () => {
    wrap(<TemplateGallery options={options()} canBuild />);
    fireEvent.click(within(document.querySelector('[data-template="new-lead-slack-alert"]') as HTMLElement).getByRole("button", { name: "Set up" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/Posts to Slack\. It does nothing until you test it, publish it and the owner of your workspace approves this exact version/);
    const slackSelect = within(dialog).getByLabelText("Slack connection") as HTMLSelectElement;
    expect([...slackSelect.options].map((o) => o.textContent)).toEqual(["Choose…", "Sales channel (verified)"]);
  });

  it("offers only review templates for a review request and disables everything without the permission", () => {
    const { unmount } = wrap(<TemplateGallery options={options()} canBuild />);
    fireEvent.click(within(document.querySelector('[data-template="post-visit-review-request"]') as HTMLElement).getByRole("button", { name: "Set up" }));
    const select = screen.getByLabelText("Review request message") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Choose…", "Review request (SMS)"]);
    unmount();
    wrap(<TemplateGallery options={options()} canBuild={false} />);
    for (const b of screen.getAllByRole("button", { name: "Set up" })) expect((b as HTMLButtonElement).disabled).toBe(true);
  });
});
