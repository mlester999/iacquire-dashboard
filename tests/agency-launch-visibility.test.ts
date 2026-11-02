// What iAcquire's staff can see of each client's launch: a Launch column fed by the ledger (and only for the clients the person may see), a read-only checklist on the client's setup page
// that is the client's own readiness without the client's buttons, and the same fields in the AQi workspace tool. Test database only; nothing is sent, booked or contacted.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import type { LaunchItem, LaunchReadiness } from "@/lib/launch-readiness";
import { agencyLaunchView, getAgencyLaunchChecklist, listClientSetupOverview } from "@/server/setup/snapshots";
import { getLaunchReadiness } from "@/server/setup/launch-readiness";
import { recordLaunchSnapshot } from "@/server/setup/launch-ledger";
import { stuckOverDay, waitingOnIacquire } from "@/components/admin/client-state";
import { LaunchReadinessPanel } from "@/components/setup/launch-readiness-panel";
import { agencyUser, createOrg, createUser } from "./support/fixtures";
import { draftClient, itemOf } from "./support/launch";
import { createOpsRun, type OpsToolOutcome } from "@/server/aqi/ops/executor";
import { resolveOpsScope } from "@/server/aqi/ops/scope";
import { PLATFORM_SCOPE, type OpsScope } from "@/lib/aqi/ops/types";

// The panel is a client component that asks the server for its own state and refreshes the router; neither exists in a static render of the page.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/admin", notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("@/app/actions/launch-readiness", () => ({ getLaunchReadinessAction: vi.fn(), dismissCalendarNoticeAction: vi.fn(), runLaunchIntentAction: vi.fn() }));
vi.mock("@/components/admin/setup/manager", () => ({ SetupManager: () => null }));
const session = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("@/server/tenancy/context", async (original) => ({ ...(await original<typeof import("@/server/tenancy/context")>()), requireAgencyOrgPermissionOrThrow: async () => session.user }));

const SYSTEM = { kind: "system" } as const;
const admin = async () => agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
const staffFor = async (...orgIds: string[]) => {
  const u = await createUser({ platformRole: "agency_staff" });
  for (const orgId of orgIds) await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [orgId, u.id]));
  return agencyUser(u, "agency_staff");
};

async function runTool(user: Awaited<ReturnType<typeof admin>>, scope: OpsScope, toolId: string, args: Record<string, unknown> = {}): Promise<{ outcome: OpsToolOutcome }> {
  const run = await createOpsRun({ user, scope, signal: new AbortController().signal, plannedToolIds: [toolId] });
  return { outcome: await run.runTool(toolId, args) };
}

let a: Awaited<ReturnType<typeof draftClient>>;
let b: Awaited<ReturnType<typeof draftClient>>;
let silent: Awaited<ReturnType<typeof draftClient>>;
beforeEach(async () => {
  if (a) return;
  a = await draftClient("Agency View Roofing", "America/Chicago");
  b = await draftClient("Agency View Dental", "Asia/Manila");
  silent = await draftClient("Agency View Silent Co", "UTC");
  await recordLaunchSnapshot(a.org.id, SYSTEM);
  await recordLaunchSnapshot(b.org.id, SYSTEM);
}, 180_000);

describe("the Launch column on the client list", () => {
  it("carries what the ledger last recorded for each client, and null for a client with nothing recorded", async () => {
    const rows = await listClientSetupOverview(await admin());
    const row = rows.find((r) => r.id === a.org.id)!;
    const current = (await withSystem((db) => db.query<{ metadata: { percent: number; passed: number; total: number; needsYou: number; needsIacquire: number; topBlocker: { key: string } | null }; created_at: Date }>(
      "select metadata, created_at from audit_logs where org_id = $1 and action = 'setup.launch_state_changed' order by id desc limit 1", [a.org.id],
    ))).rows[0];
    expect(row.launch).toMatchObject({
      state: "action_required", label: "Action required", percent: current.metadata.percent, passed: current.metadata.passed, total: current.metadata.total,
      needsClient: current.metadata.needsYou, needsIacquire: current.metadata.needsIacquire, topBlocker: { key: current.metadata.topBlocker?.key },
    });
    expect(row.launch?.since).toBe(current.created_at.toISOString());
    expect(row.launch?.needsClient).toBeGreaterThan(0);
    // The row is not computed from the old checklist: that is a different percentage with its own meaning.
    expect(row.setup.percent).not.toBe(row.launch?.percent);
    expect(rows.find((r) => r.id === silent.org.id)?.launch).toBeNull();
  }, 120_000);

  it("shows a staff member only the clients assigned to them, with their launch fields, and never another client's launch rows", async () => {
    const staff = await staffFor(a.org.id);
    const mine = await listClientSetupOverview(staff);
    expect(mine.map((r) => r.id)).toEqual([a.org.id]);
    expect(mine[0].launch?.state).toBe("action_required");
    expect(JSON.stringify(mine)).not.toContain(b.org.id);
    expect(JSON.stringify(mine)).not.toContain("Agency View Dental");
    // Someone with no agency role at all is refused outright.
    await expect(listClientSetupOverview({ ...staff, platformRole: "none" })).rejects.toThrow(/Agency access/);
    // A staff member with no assignment sees no client, so no launch row.
    expect(await listClientSetupOverview(await staffFor())).toEqual([]);
  }, 120_000);

  it("calls a client waiting on iAcquire only when something iAcquire's blocks it, and stuck only when it stayed in one state for over a day", async () => {
    const row = (await listClientSetupOverview(await admin())).find((r) => r.id === a.org.id)!;
    const launch = row.launch!;
    expect(waitingOnIacquire({ ...row, launch: { ...launch, needsIacquire: 0 } })).toBe(false);
    expect(waitingOnIacquire({ ...row, launch: { ...launch, needsIacquire: 2 } })).toBe(true);
    expect(waitingOnIacquire({ ...row, launch: { ...launch, needsIacquire: 2, state: "ready_to_launch" } })).toBe(false);
    expect(waitingOnIacquire({ ...row, launch: null })).toBe(false);
    const since = new Date(launch.since).getTime();
    expect(stuckOverDay(row, since + 23 * 3_600_000)).toBe(false);
    expect(stuckOverDay(row, since + 25 * 3_600_000)).toBe(true);
    expect(stuckOverDay({ ...row, launch: { ...launch, state: "ready_to_launch" } }, since + 48 * 3_600_000)).toBe(false);
    expect(stuckOverDay({ ...row, launch: null }, since + 48 * 3_600_000)).toBe(false);
  }, 120_000);
});

describe("the client launch checklist the agency reads", () => {
  it("is the client's own readiness with the client's buttons and screens taken out, and iAcquire's own screens where there is one", async () => {
    const clientView = (await getLaunchReadiness(a.ctx))!;
    const agencyView = (await getAgencyLaunchChecklist(await admin(), a.org.id))!;
    // The same answer: state, percentage and who each item waits on do not change with the viewer.
    expect(agencyView.state).toBe(clientView.state);
    expect(agencyView.percent).toBe(clientView.percent);
    expect(agencyView.blocking.map((i) => `${i.key}:${i.owner}`)).toEqual(clientView.blocking.map((i) => `${i.key}:${i.owner}`));
    // The client has a button for the host; staff have none, and no host picker.
    expect(itemOf(clientView, "calendar.host").action?.intent).toBe("assign_host");
    const items = agencyView.steps.flatMap((s) => s.items);
    expect(items.some((i) => i.action?.intent)).toBe(false);
    expect(items.some((i) => i.hostChoices)).toBe(false);
    expect(agencyView.blocking.some((i) => i.action?.intent)).toBe(false);
    // Every link that is left is one of iAcquire's own pages for this client and no other.
    const links = items.flatMap((i) => (i.action?.href ? [i.action.href] : []));
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((href) => href.startsWith(`/admin/clients/${a.org.id}/`))).toBe(true);
  }, 120_000);

  it("is refused for a client the staff member is not assigned to, for someone without an agency role, and for a workspace that is not a client's", async () => {
    const staff = await staffFor(a.org.id);
    await expect(getAgencyLaunchChecklist(staff, b.org.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(getAgencyLaunchChecklist({ ...staff, platformRole: "none" }, a.org.id)).rejects.toMatchObject({ code: "forbidden" });
    expect(await getAgencyLaunchChecklist(staff, a.org.id)).toMatchObject({ state: "action_required" });
    // Reading it writes nothing: no ledger row, no notice.
    const rows = async () => Number((await withSystem((db) => db.query<{ n: string }>("select count(*) as n from audit_logs where org_id = $1 and action = 'setup.launch_state_changed'", [a.org.id]))).rows[0].n);
    const before = await rows();
    await getAgencyLaunchChecklist(await admin(), a.org.id);
    expect(await rows()).toBe(before);
  }, 120_000);

  it("maps each kind of item to the agency screen that handles it, and drops the client's own links and buttons", () => {
    const item = (key: string, action?: LaunchItem["action"]): LaunchItem => ({ key, label: key, state: "action_required", required: true, detail: "", owner: "you", action, hostChoices: key === "calendar.host" ? [{ id: "u1", name: "Pat" }] : undefined });
    const readiness: LaunchReadiness = {
      state: "action_required", label: "Action required", headline: "h", detail: "d", percent: 10, passed: 1, total: 10, blocking: [],
      steps: [{ key: "employees", title: "Employees", state: "action_required", summary: "", items: [
        item("employees.lead_hunter", { label: "Run", intent: "run_checks" }), item("verification.crm_manager", { label: "Open", href: "/employees" }), item("integrations.email", { label: "Connect", href: "/settings/messaging" }),
        item("integrations.none"), item("calendar.connection", { label: "Connect", href: "/api/crm/calendar-oauth/google/start" }), item("calendar.host", { label: "Make me host", intent: "assign_host" }),
        item("crm.blueprint"), item("profile.company", { label: "Answer", href: "/onboarding" }), item("knowledge.approved", { label: "Review", href: "/knowledge" }),
      ] }],
    };
    const base = "/admin/clients/o1";
    const view = agencyLaunchView({ ...readiness, blocking: readiness.steps[0].items }, "o1");
    const byKey = Object.fromEntries(view.steps[0].items.map((i) => [i.key, i.action?.href]));
    expect(byKey).toEqual({
      "employees.lead_hunter": `${base}/provisioning`, "verification.crm_manager": `${base}/provisioning`, "integrations.email": `${base}/communications`, "integrations.none": undefined,
      "calendar.connection": `${base}/integrations`, "calendar.host": undefined, "crm.blueprint": `${base}/crm`, "profile.company": undefined, "knowledge.approved": undefined,
    });
    expect(view.steps[0].items.some((i) => i.hostChoices)).toBe(false);
    expect(view.blocking.map((i) => i.action?.href)).toEqual(view.steps[0].items.map((i) => i.action?.href));
    // The state and the numbers are the client's own, untouched.
    expect(view).toMatchObject({ state: "action_required", percent: 10, passed: 1, total: 10 });
  });
});

describe("the block on /admin/clients/[id]/setup", () => {
  const render = async (user: unknown, orgId: string) => {
    session.user = user;
    const { default: Page } = await import("@/app/(admin)/admin/clients/[id]/setup/page");
    return renderToStaticMarkup(await Page({ params: Promise.resolve({ id: orgId }) }));
  };

  it("renders the read-only checklist for the agency audience, with iAcquire's links and no button that runs a step", async () => {
    const html = await render(await admin(), a.org.id);
    expect(html).toContain("Client launch checklist");
    expect(html).toContain('data-audience="agency"');
    expect(html).toContain("Action required");
    // No client-only control: nothing in the block is a button, and every link is an agency page.
    expect(html).not.toContain("<button");
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.every((h) => h.startsWith("/admin/"))).toBe(true);
    // It is not a live view of anybody's workspace: it never says "Updated Ns ago" (the panel's live line is for the client).
    expect(html).not.toMatch(/Updated \d+s ago/);
  }, 120_000);

  it("is the same panel that gives the CLIENT a button: the missing button above is the audience, not an empty page", async () => {
    const clientView = (await getLaunchReadiness(a.ctx))!;
    const html = renderToStaticMarkup(React.createElement(LaunchReadinessPanel, { readiness: clientView, audience: "client" }));
    expect(html).toContain("<button");
    expect(html).toContain('data-audience="client"');
  }, 120_000);

  it("stops a staff member who is not assigned to the client before the block is built, and a workspace that is not a client's has no checklist", async () => {
    const staff = await staffFor(a.org.id);
    expect(await render(staff, a.org.id)).toContain("Client launch checklist");
    // The page asks for the client's setup first, which refuses a client the person is not assigned to: nothing of its launch is rendered.
    await expect(render(staff, b.org.id)).rejects.toThrow();
    // An agency workspace has no checklist (null), so the page shows a plain sentence there and not the panel, whose retry would ask about the viewer's own workspace.
    const agencyOrg = await createOrg({ name: "Agency Workspace", kind: "agency" });
    expect(await getAgencyLaunchChecklist(await admin(), agencyOrg.id)).toBeNull();
  }, 120_000);
});

describe("the AQi workspace tool", () => {
  it("reports the launch state for the selected client, and for the clients the directory lists, from the ledger", async () => {
    const superAdmin = await admin();
    const tenant = await resolveOpsScope(superAdmin, { type: "tenant", id: a.org.id });
    const { outcome } = await runTool(superAdmin, tenant, "workspace.summary");
    const data = outcome.data as { launch: { state: string; percent: number; waitingOnClient: number; topBlocker: { label: string; waitingOn: string } | null } | null };
    expect(data.launch).toMatchObject({ state: "action_required", waitingOnClient: expect.any(Number) });
    expect(data.launch?.percent).toBeGreaterThan(0);
    expect(JSON.stringify(outcome.cards)).toContain("Launch readiness");
    const silentScope = await resolveOpsScope(superAdmin, { type: "tenant", id: silent.org.id });
    expect(((await runTool(superAdmin, silentScope, "workspace.summary")).outcome.data as { launch: unknown }).launch).toBeNull();

    const directory = await runTool(superAdmin, PLATFORM_SCOPE, "workspace.directory", { limit: 25 });
    const clients = (directory.outcome.data as { clients: Array<{ id: string; launch: { state: string } | null }> }).clients;
    expect(clients.find((c) => c.id === a.org.id)?.launch?.state).toBe("action_required");
    expect(clients.find((c) => c.id === silent.org.id)?.launch).toBeNull();
  }, 120_000);
});
