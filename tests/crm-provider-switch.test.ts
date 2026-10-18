// CRM provider switching (Phase 6, package B): preview, backup, dry run, cutover, verification, completion and rollback, the pauses while a
// switch cuts over, and hybrid ownership. Synthetic database fixtures and an intercepted fetch only: nothing here contacts GoHighLevel or
// any messaging or calendar provider, and every request the code makes is checked to be a GET to GoHighLevel's official host.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/crm/settings/provider", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/cache", () => ({ revalidatePath() {} }));

import { withSystem, withUser } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { AppError } from "@/server/errors";
import { saveIntegrationConnection } from "@/server/integrations/manager";
import { agencyActor, memberActor, startSupportSession, type CrmActor } from "@/server/crm/actor";
import { createContact, updateContact } from "@/server/crm/contacts";
import * as ghlMigrationModule from "@/server/crm/ghl-migration";
import { scopeFor } from "@/server/crm/page";
import {
  advanceSwitchWork, backupBeforeSwitch, cancelSwitch, completeCutover, cutoverSwitch, downloadSwitchBackup, getProviderSwitchState, getSwitchReviewRows, getSwitchView, planSwitch,
  previewSwitch, processProviderSwitches, readRestOfSwitchStep, retrySwitchStep, rollbackSwitch, startSwitchDryRun, type SwitchView,
} from "@/server/crm/provider-switch";
import { cancelGhlStep, checkGhlImportAgain, createGhlImportJob, rollbackGhlImport, startGhlImport } from "@/server/crm/ghl-migration";
import { advanceImport } from "@/server/crm/imports";
import { providerChoiceLock } from "@/server/setup/crm-guide";
import { crmEventDispatch, type Subscriber } from "@/server/crm/dispatch";
import { createWorkflow, publishWorkflow, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { startManualRun } from "@/server/crm/workflows/runs";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { processDueFollowUps } from "@/server/messaging/followups";
import { dispatchDue, queueOutbound } from "@/server/messaging/send";
import { sendHumanReply } from "@/server/messaging/inbox";
import { writeBackDue } from "@/server/calendars/sync";
import { createAppointmentType, createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { bookingPageActor, bookNativeAppointment } from "@/server/calendars/booking";
import { requestBooking } from "@/server/appointments/booking";
import type { AppointmentProvider } from "@/server/appointments/provider";
import { createSmartList } from "@/server/crm/smart-lists";
import { approveTemplate, createTemplate } from "@/server/crm/message-templates";
import { createCampaign, previewCampaign, requestCampaignApproval } from "@/server/crm/campaigns";
import { processCampaigns } from "@/server/crm/campaigns/job";
import { decideApproval } from "@/server/approvals/service";
import { JOBS } from "@/server/ops/tick";
import { GHL_MIGRATION_ENTITIES } from "@/lib/crm/ghl-migration";
import { CRM_CAPABILITIES, type CrmCapability } from "@/lib/crm/types";
import { requiredForNative } from "@/lib/crm/provider-switch";
import { ProviderView } from "@/components/crm/views/settings-views";
import { ContactsView } from "@/components/crm/views/contacts-view";
import { pollDelay } from "@/components/crm/provider-switch/wizard";
import { addMember, createUser, ctxFor, uid } from "./support/fixtures";
import { agencyPeople, crmOrg, type CrmOrg } from "./support/crm";
import { inbound, messagingOrg, recordingProvider, type MessagingOrg } from "./support/messaging";

// Whole migrations through the import pipeline, in an in-memory database: some scenarios take longer than the default.
vi.setConfig({ testTimeout: 120_000 });

type Rec = Record<string, unknown>;
const ORIGIN = "https://services.leadconnectorhq.com";
// Only SMS campaigns are previewed here; every SMS send goes to a recording transport, so nothing reaches Twilio.
const ENV = ["TWILIO_WRITES_ENABLED"] as const;

// ---------------------------------------------------------------------------
// A synthetic GoHighLevel location (GET only)
// ---------------------------------------------------------------------------

interface Synth {
  loc: string;
  contacts: Rec[];
  opportunities: Rec[];
  businesses: Rec[];
  customFields: Rec[];
  tags: Rec[];
  pipelines: Rec[];
  users: Rec[];
}

function cursorPage(rows: Rec[], url: URL, key: string) {
  const limit = Number(url.searchParams.get("limit") ?? 20);
  const after = url.searchParams.get("startAfterId");
  const start = after ? rows.findIndex((r) => r.id === after) + 1 : 0;
  const page = rows.slice(start, start + limit);
  const more = start + limit < rows.length;
  const last = page[page.length - 1];
  return { [key]: page, meta: { total: rows.length, startAfterId: more ? last.id : undefined, startAfter: more ? Date.parse(String(last.dateAdded ?? last.createdAt)) : undefined, nextPageUrl: more ? `${ORIGIN}/next` : null } };
}

/** Every request is recorded; anything that isn't GoHighLevel's official host gets a 599 and is listed in `foreign`. */
function ghlServer(...locations: Synth[]) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const foreign: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push({ url, init: init ?? {} });
    if (url.origin !== ORIGIN) {
      foreign.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
      return new Response("not in tests", { status: 599 });
    }
    const p = url.pathname;
    const s = locations.find((l) => p.includes(l.loc) || url.searchParams.get("locationId") === l.loc || url.searchParams.get("location_id") === l.loc) ?? locations[0];
    if (p === `/locations/${s.loc}`) return Response.json({ location: { id: s.loc, name: "Synthetic Location", companyId: "companySynth01" } });
    if (p === "/users/search") return Response.json({ users: s.users, count: s.users.length });
    if (p === `/locations/${s.loc}/customFields`) return Response.json({ customFields: s.customFields });
    if (p === `/locations/${s.loc}/tags`) return Response.json({ tags: s.tags });
    if (p === "/opportunities/pipelines") return Response.json({ pipelines: s.pipelines });
    if (p === "/businesses/") {
      const skip = Number(url.searchParams.get("skip") ?? 0);
      return Response.json({ businesses: s.businesses.slice(skip, skip + Number(url.searchParams.get("limit") ?? 100)) });
    }
    if (p === "/contacts/") return Response.json(cursorPage(s.contacts, url, "contacts"));
    if (p === "/opportunities/search") return Response.json(cursorPage(s.opportunities, url, "opportunities"));
    if (p === "/calendars/") return Response.json({ calendars: [{ id: "calSynth0001", locationId: s.loc }] });
    return new Response("{}", { status: 404 });
  });
  return { spy, calls, foreign };
}

/** Every request was a GET, to GoHighLevel's official host, with a Version header: nothing is ever written to GoHighLevel. */
function expectReadOnly(server: ReturnType<typeof ghlServer>, opts: { some?: boolean } = {}) {
  if (opts.some !== false) expect(server.calls.length).toBeGreaterThan(0);
  expect(server.foreign).toEqual([]);
  for (const c of server.calls) {
    expect(c.init.method ?? "GET").toBe("GET");
    expect(c.url.origin).toBe(ORIGIN);
    expect((c.init.headers as Record<string, string>).Version).toMatch(/^2021-0[47]-(15|28)$/);
  }
}

const day = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();

function sample(loc: string, ownerEmail: string): Synth {
  return {
    loc,
    users: [{ id: "userOwner01", email: ownerEmail }],
    customFields: [{ id: "cfMember01", name: "Membership", fieldKey: "contact.membership", dataType: "SINGLE_OPTIONS", picklistOptions: ["Gold", "Silver"], model: "contact", locationId: loc }],
    tags: [{ id: "tagVip0001", name: "VIP", locationId: loc }, { id: "tagLead001", name: "Lead", locationId: loc }],
    pipelines: [{ id: "pipeSales1", name: "Sales", locationId: loc, stages: [{ id: "stNew0001", name: "New", position: 0 }, { id: "stWon0001", name: "Won", position: 1 }] }],
    businesses: [{ id: "bizAcme001", name: "Acme Inc", locationId: loc }],
    contacts: [
      { id: "ghlCt0", firstName: "Ana", lastName: "Reyes", email: "ana@example.test", phone: "+639170000101", tags: ["VIP"], customFields: [{ id: "cfMember01", value: "Gold" }], businessId: "bizAcme001", assignedTo: "userOwner01", dateAdded: day(0), locationId: loc },
      { id: "ghlCt1", firstName: "Ben", lastName: "Cruz", email: "ben@example.test", phone: "+639170000102", tags: ["Lead"], dateAdded: day(1), locationId: loc },
      { id: "ghlCt2", firstName: "Cara", lastName: "Diaz", email: "cara@example.test", phone: "+639170000103", dateAdded: day(2), locationId: loc },
    ],
    opportunities: [
      { id: "ghlOpp1", name: "Website build", pipelineId: "pipeSales1", pipelineStageId: "stNew0001", status: "open", monetaryValue: 500, contactId: "ghlCt0", createdAt: day(10), locationId: loc },
      { id: "ghlOpp2", name: "Retainer", pipelineId: "pipeSales1", pipelineStageId: "stWon0001", status: "won", monetaryValue: 900, contactId: "ghlCt1", createdAt: day(11), locationId: loc },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let admin: Awaited<ReturnType<typeof agencyPeople>>["superAdmin"];
let staff: Awaited<ReturnType<typeof agencyPeople>>["staff"];
beforeAll(async () => {
  ({ superAdmin: admin, staff } = await agencyPeople());
  for (const k of ENV) process.env[k] = "true";
  resetEnvCache();
});
afterAll(() => {
  for (const k of ENV) delete process.env[k];
  resetEnvCache();
});
afterEach(() => vi.restoreAllMocks());

const one = async <T extends Rec>(sql: string, params: unknown[]) => (await withSystem((db) => db.query<T>(sql, params))).rows;
const count = async (sql: string, params: unknown[]) => Number((await one<{ n: string }>(sql, params))[0].n);

async function connect(orgId: string, loc: string) {
  await saveIntegrationConnection(admin, orgId, { provider: "ghl", label: "Synthetic GHL", environment: "development", secret: "synthetic-key-" + "k".repeat(30), config: { locationId: loc, scopes: ["locations.readonly", "opportunities.readonly"] } });
}

/** A CRM workspace with one person in every role, its GoHighLevel location connected read-only, in the given mode. */
async function connected(name: string, loc: string, mode: "native" | "ghl" = "ghl"): Promise<CrmOrg> {
  const c = await crmOrg({ name });
  await connect(c.org.id, loc);
  if (mode === "ghl") await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [c.org.id]));
  return c;
}

/** A controlled hybrid: GoHighLevel owns exactly these capabilities, iAcquire the rest (explicit owners, as a switch would leave them). */
async function hybrid(orgId: string, ghl: CrmCapability[]) {
  await withSystem(async (db) => {
    await db.query("update crm_workspaces set mode = 'hybrid' where org_id = $1", [orgId]);
    for (const c of CRM_CAPABILITIES) {
      await db.query(
        "insert into crm_capability_providers (org_id, capability, provider) values ($1, $2, $3) on conflict (org_id, capability) do update set provider = excluded.provider",
        [orgId, c, ghl.includes(c) ? "ghl" : "native"],
      );
    }
  });
}

const workspaceRow = async (orgId: string) => (await one<{ mode: string; switching: boolean }>("select mode, switching from crm_workspaces where org_id = $1", [orgId]))[0];
const ownerRows = async (orgId: string) => one<{ capability: string; provider: string; sync_policy: string }>("select capability, provider, sync_policy from crm_capability_providers where org_id = $1 order by capability", [orgId]);

/** Moves a switch forward (as the scheduler and the wizard's polling do) until `done` says it has arrived. */
async function drive(id: string, actor: CrmActor, done: (v: SwitchView) => boolean, max = 120): Promise<SwitchView> {
  for (let i = 0; i < max; i++) {
    const v = await getSwitchView(actor, id);
    if (done(v)) return v;
    await advanceSwitchWork(id);
  }
  const v = await getSwitchView(actor, id);
  throw new Error(`switch did not arrive: ${v.status} ${v.error ?? ""} ${JSON.stringify(v.steps.map((s) => [s.entity, s.status, s.error]))}`);
}

const settled = (v: SwitchView) => ["completed", "verifying", "rolled_back", "cancelled"].includes(v.status);

/** Moves one import job forward (as the scheduler does for the migration panel's runs) until it reaches one of `until`. */
async function driveJob(id: string, until: string[], max = 60): Promise<string> {
  const status = async () => (await one<{ status: string }>("select status from crm_import_jobs where id = $1", [id]))[0].status;
  for (let i = 0; i < max; i++) {
    const s = await status();
    if (until.includes(s)) return s;
    await advanceImport(id);
  }
  return status();
}

/** Moves a switch forward up to `max` times, stopping early when `done` says so; never throws (for states that hold). */
async function nudge(id: string, actor: CrmActor, done: (v: SwitchView) => boolean, max = 30): Promise<SwitchView> {
  for (let i = 0; i < max; i++) {
    const v = await getSwitchView(actor, id);
    if (done(v)) return v;
    await advanceSwitchWork(id);
  }
  return getSwitchView(actor, id);
}

const liveEmails = async (orgId: string) => (await one<{ email: string }>("select email::text as email from contacts where org_id = $1 and deleted_at is null order by 1", [orgId])).map((r) => r.email);

/** Backs up, dry-runs and cuts over a switch as `actor`, then drives it to the end. */
async function runSwitch(actor: CrmActor, input: { to: "native" | "ghl"; capabilities: CrmCapability[] }, opts: { stopAfterCutover?: boolean } = {}) {
  const backed = await backupBeforeSwitch(actor, input);
  if (backed.preview.entities.length) {
    await startSwitchDryRun(actor, backed.id);
    await drive(backed.id, actor, (v) => v.can.cutover);
  }
  const cut = await cutoverSwitch(actor, backed.id);
  if (opts.stopAfterCutover) return cut;
  return drive(backed.id, actor, settled);
}

const expectAppError = async (p: Promise<unknown>, code: string, text?: RegExp) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (text) expect((err as AppError).message).toMatch(text);
};

const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<!-- -->/g, "").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&rsquo;/g, "’");
const text = (el: React.ReactElement) => html(el).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

describe("the plan", () => {
  const ghlAll = Object.fromEntries(CRM_CAPABILITIES.map((c) => [c, "ghl"])) as Record<CrmCapability, "native" | "ghl">;
  const nativeAll = Object.fromEntries(CRM_CAPABILITIES.map((c) => [c, "native"])) as Record<CrmCapability, "native" | "ghl">;

  it("brings what records point at along, imports in wave A's order, and moves the rest as ownership only", () => {
    expect(requiredForNative("contacts")).toEqual(["custom_fields", "tags"]);
    expect(requiredForNative("opportunities")).toEqual(["custom_fields", "tags", "pipelines", "contacts"]);
    expect(requiredForNative("calendars")).toEqual([]);
    const p = planSwitch(ghlAll, { to: "native", capabilities: ["opportunities", "conversations"] }, new Set());
    expect(p.moving).toEqual(["contacts", "tags", "custom_fields", "pipelines", "opportunities", "conversations"]);
    expect(p.added).toEqual(["contacts", "tags", "custom_fields", "pipelines"]);
    expect(p.entities).toEqual(["custom_field", "tag", "pipeline", "contact", "opportunity"]);
    expect(p.modeAfter).toBe("hybrid");
    // Everything to iAcquire: every step, in GHL_MIGRATION_ENTITIES order, and the workspace ends native.
    const all = planSwitch(ghlAll, { to: "native", capabilities: [...CRM_CAPABILITIES] }, new Set());
    expect(all.entities).toEqual([...GHL_MIGRATION_ENTITIES]);
    expect(all.modeAfter).toBe("native");
    // A prerequisite iAcquire already owns but never imported runs too; one imported before doesn't.
    const owners = { ...ghlAll, tags: "native" as const, custom_fields: "native" as const };
    expect(planSwitch(owners, { to: "native", capabilities: ["contacts"] }, new Set()).alsoImported).toEqual(["custom_field", "tag"]);
    expect(planSwitch(owners, { to: "native", capabilities: ["contacts"] }, new Set(["custom_field", "tag"] as const)).entities).toEqual(["contact"]);
    // Handing back to GoHighLevel never imports anything; capabilities already there are left out.
    const back = planSwitch(nativeAll, { to: "ghl", capabilities: ["contacts", "conversations"] }, new Set());
    expect(back).toMatchObject({ moving: ["contacts", "conversations"], entities: [], added: [], modeAfter: "hybrid" });
    expect(planSwitch(ghlAll, { to: "ghl", capabilities: ["contacts"] }, new Set())).toMatchObject({ moving: [], unchanged: ["contacts"] });
  });
});

// ---------------------------------------------------------------------------
// Preview (read-only)
// ---------------------------------------------------------------------------

describe("preview", () => {
  it("is read-only: counts both sides, lists dependencies, pauses and gaps, stores nothing, and only GETs the official host", async () => {
    const loc = "synthSwitchLocPrev01";
    const c = await connected("Preview Switch Co", loc);
    await withSystem((db) => db.query("insert into crm_pipelines (org_id, ghl_pipeline_id, name, stages) values ($1, 'cachePipe0001', 'Cached pipeline', '[]')", [c.org.id]));
    const server = ghlServer(sample(loc, c.people.owner.email));
    const before = { ws: await workspaceRow(c.org.id), rows: await ownerRows(c.org.id) };
    const p = await previewSwitch(c.actor("owner"), { to: "native", capabilities: ["contacts"] });
    expect(p.plan.moving).toEqual(["contacts", "tags", "custom_fields"]);
    expect(p.plan.added).toEqual(["tags", "custom_fields"]);
    expect(p.blockers).toEqual([]);
    expect(p.ghl).toMatchObject({ connected: true, read: true });
    const contacts = p.capabilities.find((x) => x.capability === "contacts")!;
    expect(contacts).toMatchObject({ from: "ghl", to: "native", moves: true, importEntity: "contact", native: { count: 0, noun: "contacts" }, ghl: { count: 3, countKind: "exact", status: "ok" } });
    expect(p.capabilities.find((x) => x.capability === "tags")!.ghl).toMatchObject({ count: 2 });
    expect(p.capabilities.find((x) => x.capability === "pipelines")).toMatchObject({ moves: false, dependencies: [{ key: "ghl_pipelines_cache", count: 1 }] });
    expect(p.imports.map((i) => [i.entity, i.count])).toEqual([["custom_field", 1], ["tag", 2], ["contact", 3]]);
    expect(p.paused.map((x) => x.key)).toEqual(["workflows", "followups", "campaigns", "messages", "writebacks", "events", "ai_bookings"]);
    expect(p.notMigrated.length).toBeGreaterThan(0);
    // Nothing was stored: no switch, no job, ownership unchanged.
    expect(await count("select count(*)::text as n from crm_provider_switches where org_id = $1", [c.org.id])).toBe(0);
    expect(await count("select count(*)::text as n from crm_import_jobs where org_id = $1", [c.org.id])).toBe(0);
    expect(await count("select count(*)::text as n from contacts where org_id = $1", [c.org.id])).toBe(0);
    expect({ ws: await workspaceRow(c.org.id), rows: await ownerRows(c.org.id) }).toEqual(before);
    expectReadOnly(server);
    // Handing contacts back to GoHighLevel from iAcquire warns about what stays here and uses them.
    const n = await connected("Preview Back Co", "synthSwitchLocPrev02", "native");
    const back = await previewSwitch(n.actor("owner"), { to: "ghl", capabilities: ["contacts"] });
    expect(back.plan.entities).toEqual([]);
    expect(back.warnings.join(" ")).toMatch(/Opportunities stay in iAcquire but use contacts/);
    expect(back.capabilities.find((x) => x.capability === "contacts")!.notes.join(" ")).toMatch(/Nothing is deleted here and nothing is copied to GoHighLevel/);
    // Without a connection, an import is refused honestly before anything happens.
    const bare = await crmOrg({ name: "No GHL Co" });
    await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [bare.org.id]));
    const none = await previewSwitch(bare.actor("owner"), { to: "native", capabilities: ["tags"] });
    expect(none.ghl.read).toBe(false);
    expect(none.blockers.join(" ")).toMatch(/needs this workspace's GoHighLevel location connected/);
    await expectAppError(backupBeforeSwitch(bare.actor("owner"), { to: "native", capabilities: ["tags"] }), "conflict", /connected/);
  });
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

describe("who may switch", () => {
  it("lets the owner and a super admin's write session run it; managers, staff roles, viewers and read sessions only look", async () => {
    const loc = "synthSwitchLocPerm01";
    const c = await connected("Permission Switch Co", loc);
    const server = ghlServer(sample(loc, c.people.owner.email));
    const input = { to: "native" as const, capabilities: ["tags"] as CrmCapability[] };
    for (const who of ["manager", "sales", "setter", "support", "viewer"] as const) {
      await expectAppError(previewSwitch(c.actor(who), input), "forbidden", /Only the workspace owner/);
      await expectAppError(backupBeforeSwitch(c.actor(who), input), "forbidden");
      expect((await getProviderSwitchState(c.actor(who))).can.manage).toBe(false);
    }
    // Agency: a read session looks (no GoHighLevel request is made for it); staff can't open a write session at all.
    await startSupportSession(admin, c.org.id, { mode: "read", reason: "Looking at the provider screen" });
    const reader = await agencyActor(admin, c.org.id);
    const n = server.calls.length;
    await expectAppError(previewSwitch(reader, input), "forbidden", /read-only/);
    await expectAppError(backupBeforeSwitch(reader, input), "forbidden", /read-only/);
    expect(server.calls.length).toBe(n);
    expect((await getProviderSwitchState(reader)).can).toMatchObject({ manage: false, readOnlyReason: expect.stringMatching(/read-only/) });
    await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2) on conflict do nothing", [c.org.id, staff.id]));
    await expectAppError(startSupportSession(staff, c.org.id, { mode: "write", reason: "Trying to switch providers" }), "forbidden", /super admins/);
    await startSupportSession(staff, c.org.id, { mode: "read", reason: "Following the switch" });
    await expectAppError(previewSwitch(await agencyActor(staff, c.org.id), input), "forbidden");
    // A super admin's write session runs it end to end (and can't download the backup: exports stay with the client).
    await startSupportSession(admin, c.org.id, { mode: "write", reason: "Helping with the provider switch" });
    const helper = await agencyActor(admin, c.org.id);
    expect((await getProviderSwitchState(helper)).can.manage).toBe(true);
    expect((await previewSwitch(helper, input)).blockers).toEqual([]);
    const done = await runSwitch(helper, input);
    expect(done.status).toBe("completed");
    expect(done.can.downloadBackup).toBe(false);
    await expectAppError(downloadSwitchBackup(helper, done.id), "forbidden");
    // The owner can.
    const owner = c.actor("owner");
    expect((await getSwitchView(owner, done.id)).can.downloadBackup).toBe(true);
    const audit = await one<{ action: string; actor_kind: string }>("select action, actor_kind from audit_logs where org_id = $1 and action like 'crm.provider.switch%' order by id", [c.org.id]);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["crm.provider.switch_backed_up", "crm.provider.switch_dry_run_started", "crm.provider.switch_cutover_started", "crm.provider.switch_completed"]));
    expect(audit.find((a) => a.action === "crm.provider.switch_cutover_started")?.actor_kind).toBe("agency");
    expectReadOnly(server);
  });
});

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

describe("backup", () => {
  it("keeps the offboarding export privately, with its checksum; the switch row keeps counts only", async () => {
    const loc = "synthSwitchLocBack01";
    const c = await connected("Backup Switch Co", loc, "native");
    ghlServer(sample(loc, c.people.owner.email));
    await createContact(c.actor("owner"), { firstName: "Priya", lastName: "Secretname", email: "priya.secret@example.test" });
    const v = await backupBeforeSwitch(c.actor("owner"), { to: "ghl", capabilities: ["conversations"] });
    expect(v).toMatchObject({ status: "backed_up", direction: "ghl", capabilities: ["conversations"] });
    expect(v.backup!.bytes).toBeGreaterThan(1000);
    const row = (await one<Rec>("select * from crm_provider_switches where id = $1", [v.id]))[0];
    const backup = (await one<{ bytes: Buffer; sha256: string; size_bytes: string; counts: Record<string, number> }>("select bytes, sha256, size_bytes, counts from crm_provider_switch_backups where id = $1", [row.backup_id]))[0];
    expect(Buffer.from(backup.bytes).subarray(0, 2).toString()).toBe("PK");
    expect(Number(backup.size_bytes)).toBe(backup.bytes.length);
    expect(backup.counts.contacts).toBe(1);
    expect(await import("node:crypto").then((m) => m.createHash("sha256").update(backup.bytes).digest("hex"))).toBe(backup.sha256);
    // The archive holds the contact; the switch row never does.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("priya.secret@example.test");
    expect(serialized).not.toContain("Secretname");
    expect((row.preview as { native: Record<string, number> }).native.contacts).toBe(1);
    // Downloads: the owner only. The application role can't read backups at all.
    const dl = await downloadSwitchBackup(c.actor("owner"), v.id);
    expect(dl.bytes.equals(Buffer.from(backup.bytes))).toBe(true);
    await expectAppError(downloadSwitchBackup(c.actor("manager"), v.id), "forbidden");
    await expect(withUser(c.people.owner.id, (db) => db.query("select id from crm_provider_switch_backups"))).rejects.toThrow(/permission denied/);
    const seen = await withUser(c.people.viewer.id, (db) => db.query<{ id: string }>("select id from crm_provider_switches"));
    expect(seen.rows.map((r) => r.id)).toEqual([v.id]);
    // One switch in progress at a time.
    await expectAppError(backupBeforeSwitch(c.actor("owner"), { to: "ghl", capabilities: ["workflows"] }), "conflict", /already/);
    // Cancelling before the cutover changes nothing and keeps the backup.
    const cancelled = await cancelSwitch(c.actor("owner"), v.id);
    expect(cancelled.status).toBe("cancelled");
    expect(await count("select count(*)::text as n from crm_provider_switch_backups where org_id = $1", [c.org.id])).toBe(1);
    expect(await workspaceRow(c.org.id)).toEqual({ mode: "native", switching: false });
  });
});

// ---------------------------------------------------------------------------
// Cutover, import, completion
// ---------------------------------------------------------------------------

describe("cutover", () => {
  it("moves every capability to iAcquire with its records, verifies, and ends native with switching off", async () => {
    const loc = "synthSwitchLocFull01";
    const c = await connected("Full Switch Co", loc);
    const server = ghlServer(sample(loc, c.people.owner.email));
    const owner = c.actor("owner");
    const backed = await backupBeforeSwitch(owner, { to: "native", capabilities: [...CRM_CAPABILITIES] });
    expect(backed.preview.entities).toEqual([...GHL_MIGRATION_ENTITIES]);
    expect(backed.can).toMatchObject({ dryRun: true, cutover: false, cancel: true });
    await expectAppError(cutoverSwitch(owner, backed.id), "conflict", /dry run first/);
    const dry = await startSwitchDryRun(owner, backed.id);
    expect(dry.status).toBe("dry_run");
    const ready = await drive(backed.id, owner, (v) => v.can.cutover);
    expect(ready.steps.map((s) => s.status)).toEqual(GHL_MIGRATION_ENTITIES.map(() => "validated"));
    expect(ready.steps.find((s) => s.entity === "contact")!.planned.create).toBe(3);
    // The dry run wrote no CRM record, and GoHighLevel still owns everything.
    expect(await count("select count(*)::text as n from contacts where org_id = $1", [c.org.id])).toBe(0);
    expect(await workspaceRow(c.org.id)).toEqual({ mode: "ghl", switching: false });

    const cut = await cutoverSwitch(owner, backed.id);
    expect(cut.status).toBe("cutting_over");
    expect(await workspaceRow(c.org.id)).toEqual({ mode: "hybrid", switching: true });
    const rows = await ownerRows(c.org.id);
    expect(rows).toHaveLength(11);
    expect(rows.every((r) => r.provider === "native")).toBe(true);
    expect(rows.filter((r) => r.sync_policy === "import_only").map((r) => r.capability).sort()).toEqual(["companies", "contacts", "custom_fields", "opportunities", "pipelines", "tags"]);
    expect(cut.ownersBefore.contacts).toBe("ghl");
    // A second cutover call is a no-op.
    expect((await cutoverSwitch(owner, backed.id)).status).toBe("cutting_over");

    const done = await drive(backed.id, owner, settled);
    expect(done.status).toBe("completed");
    expect(done.verification).toMatchObject({ ok: true, issues: [] });
    const contactStep = done.verification!.steps.find((s) => s.entity === "contact")!;
    expect(contactStep).toMatchObject({ sourceCount: 3, sourceCountKind: "reported", staged: 3, mapped: 3, failed: 0, needsReview: 0, destinationCount: 3 });
    expect(contactStep.samples).toEqual({ checked: 3, passed: 3, failed: 0 });
    expect(done.verification!.steps.find((s) => s.entity === "opportunity")!.samples).toEqual({ checked: 2, passed: 2, failed: 0 });
    expect(await workspaceRow(c.org.id)).toEqual({ mode: "native", switching: false });
    expect(await count("select count(*)::text as n from contacts where org_id = $1 and deleted_at is null", [c.org.id])).toBe(3);
    expect(await count("select count(*)::text as n from crm_opportunities where org_id = $1 and provider = 'native' and archived_at is null", [c.org.id])).toBe(2);
    expect(await count("select count(*)::text as n from crm_tags where org_id = $1", [c.org.id])).toBe(2);
    // Every job belongs to the switch (the foreign key from 0039).
    expect(await count("select count(*)::text as n from crm_import_jobs where org_id = $1 and switch_id = $2", [c.org.id, backed.id])).toBe(6);
    const audit = (await one<{ action: string }>("select action from audit_logs where org_id = $1 and action like 'crm.provider.switch%' order by id", [c.org.id])).map((a) => a.action);
    expect(audit).toEqual(["crm.provider.switch_backed_up", "crm.provider.switch_dry_run_started", "crm.provider.switch_cutover_started", "crm.provider.switch_completed"]);
    const notes = await one<{ title: string; user_id: string }>("select title, user_id from notifications where org_id = $1 and kind = 'system' order by created_at", [c.org.id]);
    expect(notes.map((n) => n.title)).toEqual(expect.arrayContaining([expect.stringMatching(/switch started/), expect.stringMatching(/switch finished/)]));
    // The setup guide's first-time provider choice is locked from now on.
    expect(await withSystem((db) => providerChoiceLock(db, c.org.id))).toMatch(/provider switch has already run/);
    // A completed switch: the migration events it wrote never reached the dispatcher (they were marked as already handled).
    expect(await count("select count(*)::text as n from crm_events where org_id = $1 and dispatched_at is null and payload->>'via' = 'ghl_migration'", [c.org.id])).toBe(0);
    expectReadOnly(server);
  });

  it("waits for the owner when verification finds something: automations stay paused until it is completed anyway or rolled back", async () => {
    const loc = "synthSwitchLocReview1";
    const c = await connected("Review Switch Co", loc);
    const synth = sample(loc, c.people.owner.email);
    // Two GoHighLevel contacts share an email: the second is held for review, so the check can't pass by itself.
    synth.contacts.push({ id: "ghlCt3", firstName: "Ana", lastName: "Twin", email: "ana@example.test", phone: "+639170000104", dateAdded: day(3), locationId: loc });
    const server = ghlServer(synth);
    const owner = c.actor("owner");
    const v = await runSwitch(owner, { to: "native", capabilities: ["contacts"] });
    expect(v.status).toBe("verifying");
    expect(v.verification?.ok).toBe(false);
    expect(v.verification?.issues.join(" ")).toMatch(/Contacts: 1 held for review/);
    expect(v.can).toMatchObject({ complete: false, completeAnyway: true, rollBack: true });
    expect(await workspaceRow(c.org.id)).toEqual({ mode: "hybrid", switching: true });
    expect((await one<{ action: string }>("select action from audit_logs where org_id = $1 and action = 'crm.provider.switch_needs_review'", [c.org.id]))).toHaveLength(1);
    await expectAppError(completeCutover(owner, v.id), "conflict", /Check these first, or complete anyway/);
    const done = await completeCutover(owner, v.id, { acknowledge: true });
    expect(done).toMatchObject({ status: "completed", acknowledgedIssues: true });
    expect(await workspaceRow(c.org.id)).toEqual({ mode: "hybrid", switching: false });
    expect((await getSwitchReviewRows(owner, v.id)).map((r) => r.name)).toContain("Ana Twin");
    expectReadOnly(server);
  });

  it("moves one capability and leaves a controlled hybrid with an explicit owner for each", async () => {
    const loc = "synthSwitchLocPart01";
    const c = await connected("Partial Switch Co", loc);
    const server = ghlServer(sample(loc, c.people.owner.email));
    const done = await runSwitch(c.actor("owner"), { to: "native", capabilities: ["tags"] });
    expect(done.status).toBe("completed");
    expect(await workspaceRow(c.org.id)).toEqual({ mode: "hybrid", switching: false });
    const rows = await ownerRows(c.org.id);
    expect(rows.filter((r) => r.provider === "native").map((r) => r.capability)).toEqual(["tags"]);
    expect(rows.filter((r) => r.provider === "ghl")).toHaveLength(10);
    const state = await getProviderSwitchState(c.actor("viewer"));
    expect(state).toMatchObject({ mode: "hybrid", switching: false, owners: { tags: "native", contacts: "ghl" } });
    expect(state.explicit).toHaveLength(11);
    expect(state.current?.status).toBe("completed");
    expectReadOnly(server);
  });

  it("hands a capability back to GoHighLevel as ownership only: nothing deleted, nothing written to GoHighLevel", async () => {
    const loc = "synthSwitchLocBack02";
    const c = await connected("Hand Back Co", loc, "native");
    const server = ghlServer(sample(loc, c.people.owner.email));
    const kept = await createContact(c.actor("owner"), { firstName: "Stays", lastName: "Here", email: "stays@example.test" });
    const backed = await backupBeforeSwitch(c.actor("owner"), { to: "ghl", capabilities: ["contacts"] });
    expect(backed.can).toMatchObject({ dryRun: false, cutover: true });
    await cutoverSwitch(c.actor("owner"), backed.id);
    const done = await drive(backed.id, c.actor("owner"), settled);
    expect(done).toMatchObject({ status: "completed", steps: [], verification: { ok: true } });
    expect(await workspaceRow(c.org.id)).toEqual({ mode: "hybrid", switching: false });
    // The native contact is still there; iAcquire just stops writing contacts.
    expect(await count("select count(*)::text as n from contacts where org_id = $1 and id = $2 and deleted_at is null", [c.org.id, kept.id])).toBe(1);
    await expectAppError(createContact(c.actor("owner"), { firstName: "New" }), "conflict", /managed in GoHighLevel/);
    // The contacts screen says so and shows what iAcquire holds, read-only (no "New contact").
    const scope = await scopeFor(c.actor("owner"), "/crm");
    const t = text(await ContactsView({ actor: c.actor("owner"), scope, searchParams: {} }));
    expect(t).toMatch(/Contacts are managed in GoHighLevel for this workspace, so these are shown read-only/);
    expect(t).toContain("Stays");
    expect(t).not.toContain("New contact");
    expectReadOnly(server, { some: false });
  });

  it("rechecks the GoHighLevel connection at an ownership-only cutover", async () => {
    const c = await connected("Disconnected Hand Back Co", "synthSwitchLocBack03", "native");
    const owner = c.actor("owner");
    const backed = await backupBeforeSwitch(owner, { to: "ghl", capabilities: ["contacts"] });
    await withSystem((db) => db.query("update ghl_location_mappings set status = 'disabled' where org_id = $1", [c.org.id]));
    await expectAppError(cutoverSwitch(owner, backed.id), "conflict", /connection was turned off/);
    expect((await getSwitchView(owner, backed.id)).status).toBe("backed_up");
    expect(await workspaceRow(c.org.id)).toEqual({ mode: "native", switching: false });
  });
});

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

describe("rollback", () => {
  it("undoes the imports newest first, restores the owners exactly, and keeps what changed since as needs review", async () => {
    const loc = "synthSwitchLocRoll01";
    const c = await connected("Rollback Switch Co", loc);
    const server = ghlServer(sample(loc, c.people.owner.email));
    const owner = c.actor("owner");
    const beforeRows = await ownerRows(c.org.id);
    const done = await runSwitch(owner, { to: "native", capabilities: ["contacts"] });
    expect(done.status).toBe("completed");
    expect(await workspaceRow(c.org.id)).toEqual({ mode: "hybrid", switching: false });
    // Someone edits an imported contact after the cutover, and a new contact arrives natively.
    const ben = (await one<{ id: string; version: number }>("select id, version from contacts where org_id = $1 and email = 'ben@example.test'", [c.org.id]))[0];
    await updateContact(owner, ben.id, { city: "Changed after the import" });
    const fresh = await createContact(owner, { firstName: "Arrived", lastName: "During", email: "arrived@example.test" });

    const rolling = await rollbackSwitch(owner, done.id);
    expect(["rolling_back", "rolled_back"]).toContain(rolling.status);
    const back = await drive(done.id, owner, settled);
    expect(back.status).toBe("rolled_back");
    // Owners exactly as before (GoHighLevel mode, no explicit rows), switching off.
    expect(await workspaceRow(c.org.id)).toEqual({ mode: "ghl", switching: false });
    expect(await ownerRows(c.org.id)).toEqual(beforeRows);
    // Nothing silently dropped: the edited contact stays (held for review), the others are undone, the new one stays.
    const live = (await one<{ email: string }>("select email::text as email from contacts where org_id = $1 and deleted_at is null order by email", [c.org.id])).map((r) => r.email);
    expect(live).toEqual(["arrived@example.test", "ben@example.test"]);
    const report = back.rollbackReport!;
    expect(report.steps!.find((s) => s.entity === "contact")).toMatchObject({ undone: 2, kept: 1 });
    expect(report.steps!.find((s) => s.entity === "tag")).toMatchObject({ kept: 1 });
    expect(report.addedSinceCutover).toMatchObject({ contacts: 1 });
    void fresh;
    const review = await getSwitchReviewRows(owner, done.id);
    expect(review.find((r) => r.entity === "contact")).toMatchObject({ name: "Ben Cruz", status: "needs_review", reason: expect.stringMatching(/Changed since the import/) });
    expect(review.find((r) => r.entity === "tag")).toMatchObject({ name: "Lead", reason: expect.stringMatching(/Still used/) });
    expect((await one<{ action: string }>("select action from audit_logs where org_id = $1 and action like 'crm.provider.switch_roll%' order by id", [c.org.id])).map((a) => a.action)).toEqual(["crm.provider.switch_rollback_started", "crm.provider.switch_rolled_back"]);
    // A rolled-back switch can't be rolled back again or completed; a new switch can start.
    expect((await rollbackSwitch(owner, done.id)).status).toBe("rolled_back");
    await expectAppError(completeCutover(owner, done.id), "conflict");
    expect((await getProviderSwitchState(owner)).current?.status).toBe("rolled_back");
    expectReadOnly(server);
  });

  it("rolls back mid-cutover: running imports stop first, then everything imported is undone", async () => {
    const loc = "synthSwitchLocRoll02";
    const c = await connected("Midway Rollback Co", loc);
    const server = ghlServer(sample(loc, c.people.owner.email));
    const owner = c.actor("owner");
    const cut = await runSwitch(owner, { to: "native", capabilities: ["contacts"] }, { stopAfterCutover: true });
    expect(cut.status).toBe("cutting_over");
    // A cutover can't be cancelled (only rolled back), and isn't complete while steps run.
    await expectAppError(cancelSwitch(owner, cut.id), "conflict", /roll it back/);
    await expectAppError(completeCutover(owner, cut.id), "conflict", /haven't finished/);
    await rollbackSwitch(owner, cut.id);
    const back = await drive(cut.id, owner, settled);
    expect(back.status).toBe("rolled_back");
    expect(await workspaceRow(c.org.id)).toEqual({ mode: "ghl", switching: false });
    expect(await count("select count(*)::text as n from contacts where org_id = $1 and deleted_at is null", [c.org.id])).toBe(0);
    expect(await count("select count(*)::text as n from crm_import_jobs where org_id = $1 and switch_id = $2 and status not in ('rolled_back', 'cancelled')", [c.org.id, cut.id])).toBe(0);
    expectReadOnly(server);
  });

  it("refuses a rollback that a newer run outside the switch would stop half way, saying where to undo it; afterwards it finishes", async () => {
    const loc = "synthSwitchLocRoll03";
    const c = await connected("Blocked Rollback Co", loc);
    const server = ghlServer(sample(loc, c.people.owner.email));
    const owner = c.actor("owner");
    const done = await runSwitch(owner, { to: "native", capabilities: ["contacts"] });
    expect(done.status).toBe("completed");
    // After the switch, the owner reads and imports contacts again from Settings → Imports & Exports (wave A's panel): outside the switch.
    const panel = await createGhlImportJob(owner, { entity: "contact" });
    expect(await driveJob(panel.id, ["validated", "failed"])).toBe("validated");
    await startGhlImport(owner, panel.id);
    expect(await driveJob(panel.id, ["completed", "failed"])).toBe("completed");
    // Wave A undoes runs of a step newest first, so the switch's undo would stop at contacts with automations paused: refused up front.
    await expectAppError(rollbackSwitch(owner, done.id), "conflict", /The contacts run from .+, outside this switch and newer than it, has records to undo; undo it in Settings → Imports & Exports first/);
    expect(await workspaceRow(c.org.id)).toEqual({ mode: "hybrid", switching: false });
    expect((await getSwitchView(owner, done.id)).status).toBe("completed");
    // Undone there, the switch rolls back all the way: switching off, the earlier mode restored.
    await rollbackGhlImport(owner, panel.id);
    expect(await driveJob(panel.id, ["rolled_back", "failed"])).toBe("rolled_back");
    await rollbackSwitch(owner, done.id);
    const back = await drive(done.id, owner, settled);
    expect(back).toMatchObject({ status: "rolled_back", error: null });
    expect(await workspaceRow(c.org.id)).toEqual({ mode: "ghl", switching: false });
    expect(await liveEmails(c.org.id)).toEqual([]);
    expectReadOnly(server);
  });
});

// ---------------------------------------------------------------------------
// GoHighLevel keeps creating records after the read
// ---------------------------------------------------------------------------

describe("records created in GoHighLevel after the read", () => {
  it("refuses to cut over with a read over a day old; reading the steps again replaces it and brings what GoHighLevel created since", async () => {
    const loc = "synthSwitchLocStale1";
    const c = await connected("Stale Read Co", loc);
    const synth = sample(loc, c.people.owner.email);
    const server = ghlServer(synth);
    const owner = c.actor("owner");
    const backed = await backupBeforeSwitch(owner, { to: "native", capabilities: ["contacts"] });
    await startSwitchDryRun(owner, backed.id);
    const ready = await drive(backed.id, owner, (v) => v.can.cutover);
    expect(ready.steps.every((s) => s.fetchedAt !== null && !s.stale)).toBe(true);
    // A week passes before the cutover, and a new lead arrives in GoHighLevel meanwhile.
    synth.contacts.push({ id: "ghlCt9", firstName: "Late", lastName: "Arrival", email: "late@example.test", dateAdded: day(9), locationId: loc });
    await withSystem((db) => db.query("update crm_import_jobs set validated_at = validated_at - interval '7 days', fetched_at = fetched_at - interval '7 days' where switch_id = $1", [backed.id]));
    const stale = await getSwitchView(owner, backed.id);
    expect(stale.steps.map((s) => s.stale)).toEqual([true, true, true]);
    expect(stale.can.cutover).toBe(false);
    expect(stale.can.retry).toEqual(["custom_field", "tag", "contact"]);
    await expectAppError(cutoverSwitch(owner, backed.id), "conflict", /were read 7 days ago; read them again before cutting over/);
    expect(await workspaceRow(c.org.id)).toEqual({ mode: "ghl", switching: false });
    // Reading again replaces each checked read with a fresh one, which sees the new lead.
    for (const e of ["custom_field", "tag", "contact"] as const) await retrySwitchStep(owner, backed.id, e);
    expect(await count("select count(*)::text as n from crm_import_jobs where switch_id = $1 and status = 'cancelled'", [backed.id])).toBe(3);
    const fresh = await drive(backed.id, owner, (v) => v.can.cutover);
    expect(fresh.steps.find((s) => s.entity === "contact")!.planned.create).toBe(4);
    await cutoverSwitch(owner, backed.id);
    const done = await drive(backed.id, owner, settled);
    expect(done).toMatchObject({ status: "completed", verification: { ok: true } });
    expect(await liveEmails(c.org.id)).toContain("late@example.test");
    expectReadOnly(server);
  });

  it("recounts GoHighLevel at verification: what was created after the read holds the switch for review, and reading the rest brings it over", async () => {
    const loc = "synthSwitchLocRest01";
    const c = await connected("Read Rest Co", loc);
    const synth = sample(loc, c.people.owner.email);
    const server = ghlServer(synth);
    const owner = c.actor("owner");
    const backed = await backupBeforeSwitch(owner, { to: "native", capabilities: ["contacts"] });
    await startSwitchDryRun(owner, backed.id);
    await drive(backed.id, owner, (v) => v.can.cutover);
    // A lead arrives in GoHighLevel after the read: its forms keep creating contacts.
    synth.contacts.push({ id: "ghlCt9", firstName: "Late", lastName: "Arrival", email: "late@example.test", dateAdded: day(9), locationId: loc });
    await cutoverSwitch(owner, backed.id);
    const v = await drive(backed.id, owner, settled);
    expect(v.status).toBe("verifying");
    expect(v.verification!.ok).toBe(false);
    expect(v.verification!.issues.join(" ")).toMatch(/Contacts: GoHighLevel now has 1 more than were read \(read .+\)\. Read the rest to bring them over\./);
    expect(v.verification!.steps.find((s) => s.entity === "contact")!.recount).toMatchObject({ status: "ok", count: 4, more: 1 });
    expect(v.verification!.steps.find((s) => s.entity === "tag")!.recount).toMatchObject({ status: "ok", more: 0 });
    expect(v.can.readRest).toEqual(["custom_field", "tag", "contact"]);
    expect(await liveEmails(c.org.id)).not.toContain("late@example.test");
    expect(await workspaceRow(c.org.id)).toEqual({ mode: "hybrid", switching: true });
    // Read the rest: the step is read and imported again inside the switch; the new lead comes across and nothing is copied twice.
    const secondOwnerUser = await createUser({ name: "Second Owner" });
    await addMember(c.org.id, secondOwnerUser.id, "owner");
    const secondOwner = memberActor(ctxFor(secondOwnerUser, c.org, "owner"));
    const originalCreateJob = ghlMigrationModule.createGhlImportJob;
    let jobCreated!: () => void;
    let allowCreateToReturn!: () => void;
    const created = new Promise<void>((resolve) => { jobCreated = resolve; });
    const waitToReturn = new Promise<void>((resolve) => { allowCreateToReturn = resolve; });
    const createSpy = vi.spyOn(ghlMigrationModule, "createGhlImportJob").mockImplementation(async (...args) => {
      const job = await originalCreateJob(...args);
      jobCreated();
      await waitToReturn;
      return job;
    });
    const readingRest = readRestOfSwitchStep(secondOwner, backed.id, "contact");
    await created;
    try {
      await expectAppError(rollbackSwitch(owner, backed.id), "conflict", /step is still running/);
    } finally {
      allowCreateToReturn();
    }
    const again = await readingRest;
    createSpy.mockRestore();
    expect(again.status).toBe("cutting_over");
    const done = await drive(backed.id, secondOwner, settled);
    expect(done).toMatchObject({ status: "completed", verification: { ok: true } });
    expect(await liveEmails(c.org.id)).toEqual(["ana@example.test", "ben@example.test", "cara@example.test", "late@example.test"]);
    expect(await count("select count(*)::text as n from crm_import_jobs where switch_id = $1 and entity = 'contact'", [backed.id])).toBe(2);
    expect(await workspaceRow(c.org.id)).toEqual({ mode: "hybrid", switching: false });
    const phaseAudit = await one<{ action: string; actor_user_id: string }>(
      "select action, actor_user_id from audit_logs where org_id = $1 and action in ('crm.provider.switch_read_rest_started', 'crm.provider.switch_completed') order by id",
      [c.org.id],
    );
    expect(phaseAudit.every((event) => event.actor_user_id === secondOwnerUser.id)).toBe(true);
    expect(await one<{ cutover_by: string; read_rest_by: string }>("select cutover_by::text, read_rest_by::text from crm_provider_switches where id = $1", [backed.id])).toEqual([{ cutover_by: owner.userId, read_rest_by: secondOwnerUser.id }]);
    // Completed and the latest switch: the rest can be read again later; a rollback undoes the extra run with the rest.
    expect((await getSwitchView(owner, backed.id)).can.readRest).toEqual(["custom_field", "tag", "contact"]);
    await rollbackSwitch(owner, backed.id);
    const back = await drive(backed.id, owner, settled);
    expect(back.status).toBe("rolled_back");
    expect(await workspaceRow(c.org.id)).toEqual({ mode: "ghl", switching: false });
    expect(await liveEmails(c.org.id)).not.toContain("late@example.test");
    const audit = (await one<{ action: string }>("select action from audit_logs where org_id = $1 and action like 'crm.provider.switch%' order by id", [c.org.id])).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(["crm.provider.switch_needs_review", "crm.provider.switch_read_rest_started", "crm.provider.switch_completed"]));
    expectReadOnly(server);
  });

  it("doesn't pass silently when GoHighLevel can't be recounted", async () => {
    const loc = "synthSwitchLocRest02";
    const c = await connected("Recount Down Co", loc);
    const server = ghlServer(sample(loc, c.people.owner.email));
    const owner = c.actor("owner");
    const backed = await backupBeforeSwitch(owner, { to: "native", capabilities: ["tags"] });
    await startSwitchDryRun(owner, backed.id);
    await drive(backed.id, owner, (v) => v.can.cutover);
    // GoHighLevel stops answering the tags list after the read.
    server.spy.mockImplementation(async (input) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      server.calls.push({ url, init: {} });
      if (url.pathname.endsWith("/tags")) return new Response("{}", { status: 503 });
      if (url.pathname === `/locations/${loc}`) return Response.json({ location: { id: loc, name: "Synthetic Location", companyId: "companySynth01" } });
      return Response.json({});
    });
    await cutoverSwitch(owner, backed.id);
    const v = await nudge(backed.id, owner, settled, 40);
    expect(v.status).toBe("verifying");
    expect(v.verification!.issues.join(" ")).toMatch(/Tags: couldn't recheck GoHighLevel's count/);
    expect(v.verification!.steps[0].recount).toMatchObject({ status: "unavailable" });
  });
});

// ---------------------------------------------------------------------------
// Only the owner runs a switch: runs from the migration panel can't stall it
// ---------------------------------------------------------------------------

describe("migration panel controls during a provider switch", () => {
  it("blocks panel mutations while the wizard owns the steps, then lets its own dry run and cutover finish", async () => {
    const loc = "synthSwitchLocPanel1";
    const c = await connected("Panel Run Co", loc);
    const server = ghlServer(sample(loc, c.people.owner.email));
    const owner = c.actor("owner");
    const manager = c.actor("manager");
    const backed = await backupBeforeSwitch(owner, { to: "native", capabilities: ["contacts"] });
    await startSwitchDryRun(owner, backed.id);
    const ready = await drive(backed.id, owner, (v) => v.can.cutover);
    const tagJob = ready.steps.find((s) => s.entity === "tag")!.jobId!;
    const locked = /A CRM provider switch is in progress\. Manage its migration steps in Settings → CRM Provider\./;

    await expectAppError(createGhlImportJob(manager, { entity: "company" }), "conflict", locked);
    await expectAppError(cancelGhlStep(manager, tagJob), "conflict", locked);
    await expectAppError(checkGhlImportAgain(owner, tagJob), "conflict", locked);
    await expectAppError(startGhlImport(owner, tagJob), "conflict", locked);
    await expectAppError(rollbackGhlImport(owner, tagJob), "conflict", locked);

    await cutoverSwitch(owner, backed.id);
    const mid = await nudge(backed.id, owner, (v) => v.steps.find((s) => s.entity === "custom_field")?.status === "completed" || settled(v), 40);
    expect(mid.status).toBe("cutting_over");
    await expectAppError(createGhlImportJob(manager, { entity: "custom_field" }), "conflict", locked);
    await expectAppError(cancelGhlStep(manager, mid.steps.find((s) => s.entity === "tag")!.jobId!), "conflict", locked);
    const done = await drive(backed.id, owner, settled);
    expect(done.status).toBe("completed");
    expect(await workspaceRow(c.org.id)).toEqual({ mode: "hybrid", switching: false });
    expectReadOnly(server);
  });

  it("stops a step created for a switch that was cancelled meanwhile, so it can't hold the next switch", async () => {
    const loc = "synthSwitchLocOrphan";
    const c = await connected("Orphan Step Co", loc);
    const server = ghlServer(sample(loc, c.people.owner.email));
    const owner = c.actor("owner");
    const first = await backupBeforeSwitch(owner, { to: "native", capabilities: ["tags"] });
    await startSwitchDryRun(owner, first.id);
    await cancelSwitch(owner, first.id);
    // The moment a dry run's loop created one more step just after the cancel committed.
    const late = await createGhlImportJob(owner, { entity: "tag", switchId: first.id });
    expect(late.status).toBe("fetching");
    await processProviderSwitches();
    expect((await one<{ status: string }>("select status from crm_import_jobs where id = $1", [late.id]))[0].status).toBe("cancelled");
    expect((await one<{ action: string }>("select action from audit_logs where org_id = $1 and action = 'crm.provider.switch_step_dropped'", [c.org.id]))).toHaveLength(1);
    // The next switch's dry run isn't blocked by it.
    const next = await backupBeforeSwitch(owner, { to: "native", capabilities: ["tags"] });
    expect((await startSwitchDryRun(owner, next.id)).status).toBe("dry_run");
    await cancelSwitch(owner, next.id);
    expectReadOnly(server, { some: false });
  });
});

// ---------------------------------------------------------------------------
// Claims made just before a cutover
// ---------------------------------------------------------------------------

describe("claimed just before the cutover", () => {
  it("hands an event back unhandled when its workspace started switching after the claim (no subscriber runs, no attempt counted)", async () => {
    const c = await crmOrg({ name: "Dispatch Race Co" });
    const owner = c.actor("owner");
    await crmEventDispatch();
    const a = await createContact(owner, { firstName: "First", lastName: "Lead" });
    const b = await createContact(owner, { firstName: "Second", lastName: "Lead" });
    const handled: string[] = [];
    const subscribers: Subscriber[] = [
      // The cutover commits while the first event is being handled (here, inside its transaction).
      { name: "cutover", run: async (db, e) => { if (e.orgId === c.org.id && !handled.length) await db.query("update crm_workspaces set switching = true where org_id = $1", [c.org.id]); } },
      { name: "record", run: async (_db, e) => { if (e.orgId === c.org.id) handled.push(e.entityId ?? ""); } },
    ];
    await crmEventDispatch({ subscribers });
    expect(handled[0]).toBe(a.id);
    expect(handled).not.toContain(b.id);
    const ev = async (id: string) => (await one<{ dispatched_at: Date | null; dispatch_attempts: number; dispatch_claimed_at: Date | null }>(
      "select dispatched_at, dispatch_attempts, dispatch_claimed_at from crm_events where org_id = $1 and type = 'contact.created' and entity_id = $2", [c.org.id, id]))[0];
    expect(await ev(b.id)).toEqual({ dispatched_at: null, dispatch_attempts: 0, dispatch_claimed_at: null });
    // After the switch, it is handled once.
    await withSystem((db) => db.query("update crm_workspaces set switching = false where org_id = $1", [c.org.id]));
    await crmEventDispatch({ subscribers });
    expect(handled.filter((x) => x === b.id)).toHaveLength(1);
    expect((await ev(b.id)).dispatched_at).not.toBeNull();
  });

  it("gives a calendar write-back lease back when the workspace started switching after the lease", async () => {
    const NOW = new Date("2026-10-19T00:00:00Z");
    const c = await crmOrg({ name: "Write-back Race Co", timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    await setHostAvailability(owner, c.people.owner.id, { timezone: "Asia/Manila", rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })) });
    const cal = await createCalendar(owner, { name: `Consults ${uid()}`, assignment: "single", public: true, members: [{ userId: c.people.owner.id }] });
    const type = await createAppointmentType(owner, cal.id, { name: "Visit", durationMinutes: 60, minNoticeMinutes: 60, maxDaysAhead: 30, locationKind: "phone", meetingProvider: "none", questions: [] });
    await bookNativeAppointment(await bookingPageActor(c.org.id), { typeId: type.id, startAt: new Date("2026-10-21T10:00:00+08:00"), contact: { firstName: "Hal", email: "hal@example.test" }, via: "booking_page", now: NOW });
    const connId = (await one<{ id: string }>(
      `insert into crm_calendar_connections (org_id, user_id, provider, account_label, status, credentials, external_calendar_id, write_events)
       values ($1, $2, 'google', 'race@example.test', 'connected', 'not-a-sealed-secret', 'primary', true) returning id`,
      [c.org.id, c.people.owner.id],
    ))[0].id;
    // The cutover commits right after the lease is taken (a trigger stands in for the other transaction).
    await withSystem(async (db) => {
      await db.query(`create or replace function test_switch_after_lease() returns trigger language plpgsql as $f$
        begin
          if new.id = '${connId}'::uuid and (new.sync_cursors->>'writeLeaseUntil') is not null and (old.sync_cursors->>'writeLeaseUntil') is distinct from (new.sync_cursors->>'writeLeaseUntil') then
            update crm_workspaces set switching = true where org_id = new.org_id;
          end if;
          return new;
        end $f$`);
      await db.query("create trigger test_switch_after_lease after update on crm_calendar_connections for each row execute function test_switch_after_lease()");
    });
    try {
      const r = await writeBackDue({ now: NOW });
      expect(r.failed).toBe(0);
    } finally {
      await withSystem(async (db) => {
        await db.query("drop trigger test_switch_after_lease on crm_calendar_connections");
        await db.query("drop function test_switch_after_lease()");
      });
    }
    // Nothing was tried (the synthetic sign-in would have failed), and the lease is free again.
    const conn = (await one<{ status: string; lease: string | null }>("select status, sync_cursors->>'writeLeaseUntil' as lease from crm_calendar_connections where id = $1", [connId]))[0];
    expect(conn).toEqual({ status: "connected", lease: null });
    expect((await workspaceRow(c.org.id)).switching).toBe(true);
    // After the switch, the pending write is tried.
    await withSystem((db) => db.query("update crm_workspaces set switching = false where org_id = $1", [c.org.id]));
    await writeBackDue({ now: NOW });
    expect((await one<{ status: string }>("select status from crm_calendar_connections where id = $1", [connId]))[0].status).toBe("needs_reauth");
  });
});

// ---------------------------------------------------------------------------
// While a switch cuts over, automations hold; afterwards they continue
// ---------------------------------------------------------------------------

async function messagingWorkspace(name: string, loc: string) {
  const m = await messagingOrg({ name, provider: { sms: "twilio" } });
  await connect(m.org.id, loc);
  return m;
}

/** A follow-up plan whose first step is due now. */
async function dueFollowUp(m: MessagingOrg, conversationId: string, contactId: string) {
  return withSystem(async (db) => {
    const plan = await db.query<{ id: string }>("insert into follow_up_plans (org_id, contact_id, conversation_id, agent_id, preset, max_attempts) values ($1, $2, $3, $4, 'balanced', 1) returning id", [m.org.id, contactId, conversationId, m.salesAgentId]);
    const step = await db.query<{ id: string }>("insert into follow_up_steps (org_id, plan_id, contact_id, step_number, channel, due_at) values ($1, $2, $3, 1, 'sms', now() - interval '1 minute') returning id", [m.org.id, plan.rows[0].id, contactId]);
    return step.rows[0].id;
  });
}

const stepStatus = async (id: string) => (await one<{ status: string }>("select status from follow_up_steps where id = $1", [id]))[0].status;
const messageStatus = async (id: string) => (await one<{ status: string; blocked_reason: string | null; send_after: Date }>("select status, blocked_reason, send_after from conversation_messages where id = $1", [id]))[0];

describe("while switching", () => {
  it("holds workflows, event handling, follow-ups, campaigns, messages and calendar write-backs, then lets them continue; another workspace never waits", async () => {
    const NOW = new Date("2026-10-19T00:00:00Z");
    const LATER = new Date(Date.now() + 11 * 60_000);
    const loc = "synthSwitchLocHold01";
    const m = await messagingWorkspace("Hold Co", loc);
    const other = await messagingWorkspace("Other Co", "synthSwitchLocHold02");
    const owner = memberActor(m.ctx("owner"));
    const server = ghlServer(sample(loc, m.people.owner.email), sample("synthSwitchLocHold02", other.people.owner.email));
    await hybrid(m.org.id, ["tags"]);
    const rec = recordingProvider("twilio");

    // Before the switch: a queued AI message, a due follow-up, a campaign, an appointment waiting to be written to a connected calendar,
    // and (once the events so far are handled) a workflow on new contacts and a manual one.
    const conv = await inbound(m.org.id, { provider: "twilio", ghlContactId: null });
    const queued = await withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId: conv.conversationId, scope: "reply", actor: { kind: "ai", agentId: m.salesAgentId }, body: "Thanks! We have room on Thursday." }));
    expect(queued.status).toBe("queued");
    const conv2 = await inbound(m.org.id, { provider: "twilio", ghlContactId: null });
    const fu = await dueFollowUp(m, conv2.conversationId, conv2.contactId);
    const otherConv = await inbound(other.org.id, { provider: "twilio", ghlContactId: null });
    const otherFu = await dueFollowUp(other, otherConv.conversationId, otherConv.contactId);
    const campaign = await approvedCampaign(m);
    await setHostAvailability(owner, m.people.owner.id, { timezone: "Asia/Manila", rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })) });
    const cal = await createCalendar(owner, { name: `Consults ${uid()}`, assignment: "single", public: true, members: [{ userId: m.people.owner.id }] });
    const type = await createAppointmentType(owner, cal.id, { name: "Visit", durationMinutes: 60, minNoticeMinutes: 60, maxDaysAhead: 30, locationKind: "phone", meetingProvider: "none", questions: [] });
    await bookNativeAppointment(await bookingPageActor(m.org.id), { typeId: type.id, startAt: new Date("2026-10-20T10:00:00+08:00"), contact: { firstName: "Dee", email: "dee@example.test" }, via: "booking_page", now: NOW });
    const connId = (await one<{ id: string }>(
      `insert into crm_calendar_connections (org_id, user_id, provider, account_label, status, credentials, external_calendar_id, write_events)
       values ($1, $2, 'google', 'owner@example.test', 'connected', 'not-a-sealed-secret', 'primary', true) returning id`,
      [m.org.id, m.people.owner.id],
    ))[0].id;
    const conv3 = await inbound(m.org.id, { provider: "twilio", ghlContactId: null });
    await withSystem((db) => db.query("insert into appointment_settings (org_id, ai_booking_enabled) values ($1, true) on conflict (org_id) do update set ai_booking_enabled = true", [m.org.id]));
    await crmEventDispatch();
    const wf = await createWorkflow(owner, { name: `On new contact ${uid()}`, definition: { trigger: { type: "contact.created" }, steps: [{ key: "task", kind: "create_task", config: { title: "Call the new lead", priority: "high", assignee: "contact_owner" }, next: null }] } as never });
    await publishWorkflow(owner, wf.id);
    await setWorkflowStatus(owner, wf.id, "active");
    const manual = await createWorkflow(owner, { name: `Manual ${uid()}`, definition: { trigger: { type: "manual" }, steps: [{ key: "task", kind: "create_task", config: { title: "Manual follow-up", priority: "normal", assignee: "contact_owner" }, next: null }] } as never });
    await publishWorkflow(owner, manual.id);
    await setWorkflowStatus(owner, manual.id, "active");

    // Cut over (moving tags: a quick import that is still running when the cutover returns).
    const cut = await runSwitch(owner, { to: "native", capabilities: ["tags"] }, { stopAfterCutover: true });
    expect(cut.status).toBe("cutting_over");
    expect((await workspaceRow(m.org.id)).switching).toBe(true);

    // Events wait in the outbox, unclaimed.
    const lead = await createContact(owner, { firstName: "During", lastName: "Switch", email: "during@example.test" });
    await crmEventDispatch();
    const ev = (await one<{ dispatched_at: Date | null; dispatch_attempts: number }>("select dispatched_at, dispatch_attempts from crm_events where org_id = $1 and type = 'contact.created' and entity_id = $2", [m.org.id, lead.id]))[0];
    expect(ev).toEqual({ dispatched_at: null, dispatch_attempts: 0 });
    expect(await count("select count(*)::text as n from crm_workflow_runs where workflow_id = $1", [wf.id])).toBe(0);
    // A run that was already going holds without doing its step.
    const { runId } = await startManualRun(owner, manual.id, { contactId: lead.id });
    await processWorkflowRuns();
    expect(await count("select count(*)::text as n from crm_workflow_run_steps where run_id = $1", [runId])).toBe(0);
    expect(await count("select count(*)::text as n from tasks where org_id = $1", [m.org.id])).toBe(0);
    // Follow-ups stay scheduled; the other workspace's go out.
    await processDueFollowUps({ plan: false });
    expect(await stepStatus(fu)).toBe("scheduled");
    expect(await stepStatus(otherFu)).not.toBe("scheduled");
    // The queued message waits (credit still held), a new AI message is queued for later, a person is told to wait.
    await dispatchDue({ transport: rec.transport });
    expect(rec.calls.filter((x) => x.orgId === m.org.id)).toHaveLength(0);
    expect(await messageStatus(queued.messageId)).toMatchObject({ status: "queued" });
    expect((await messageStatus(queued.messageId)).send_after.getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);
    const later = await withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId: conv.conversationId, scope: "reply", actor: { kind: "ai", agentId: m.salesAgentId }, body: "One more thing." }));
    expect(later.status).toBe("queued");
    await withSystem((db) => db.query("update conversations set owner_kind = 'human', owner_user_id = $2 where id = $1", [conv3.conversationId, m.people.sales.id]));
    await expectAppError(sendHumanReply(m.ctx("sales"), conv3.conversationId, "One moment"), "conflict", /switching providers/);
    // The campaign waits in place, with the reason; nothing is queued for it.
    await processCampaigns({ now: new Date() });
    const waiting = await one<{ status: string; reason: string | null }>("select status, reason from crm_campaign_recipients where campaign_id = $1", [campaign]);
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.every((r) => r.status === "pending" && (r.reason ?? "").startsWith("waiting:provider_switching"))).toBe(true);
    expect(await count("select count(*)::text as n from conversation_messages where org_id = $1 and dedupe_key like $2", [m.org.id, `camp:${campaign}:%`])).toBe(0);
    // An AI booking waits for a person's yes instead of going straight in (the owner let the AI book on its own).
    const aiAsk = await requestBooking({ orgId: m.org.id, contactId: conv.contactId, startAt: new Date("2026-10-20T14:00:00+08:00"), actor: { kind: "ai", agentId: m.salesAgentId }, now: NOW });
    expect(aiAsk.status).toBe("awaiting_approval");
    // Nothing is written to the connected calendar.
    await writeBackDue({ now: NOW });
    expect((await one<{ status: string }>("select status from crm_calendar_connections where id = $1", [connId]))[0].status).toBe("connected");
    // The other workspace's events are dispatched as usual.
    const otherLead = await createContact(memberActor(other.ctx("owner")), { firstName: "Other", lastName: "Lead" });
    await crmEventDispatch();
    expect((await one<{ dispatched_at: Date | null }>("select dispatched_at from crm_events where org_id = $1 and type = 'contact.created' and entity_id = $2", [other.org.id, otherLead.id]))[0].dispatched_at).not.toBeNull();

    // Finish the switch: everything continues by itself, once each.
    const done = await drive(cut.id, owner, settled);
    expect(done.status).toBe("completed");
    expect((await workspaceRow(m.org.id)).switching).toBe(false);
    await crmEventDispatch();
    expect(await count("select count(*)::text as n from crm_workflow_runs where workflow_id = $1", [wf.id])).toBe(1);
    await processWorkflowRuns({ now: LATER });
    await processWorkflowRuns({ now: LATER });
    expect(await count("select count(*)::text as n from tasks where org_id = $1 and title in ('Call the new lead', 'Manual follow-up')", [m.org.id])).toBe(2);
    await processDueFollowUps({ plan: false });
    expect(await stepStatus(fu)).not.toBe("scheduled");
    await dispatchDue({ transport: rec.transport, now: LATER });
    expect(await messageStatus(queued.messageId)).toMatchObject({ status: "sent" });
    expect(await messageStatus(later.messageId)).toMatchObject({ status: "sent" });
    await processCampaigns({ now: LATER });
    expect(await count("select count(*)::text as n from conversation_messages where org_id = $1 and dedupe_key like $2", [m.org.id, `camp:${campaign}:%`])).toBeGreaterThan(0);
    const aiBooks = await requestBooking({ orgId: m.org.id, contactId: conv.contactId, startAt: new Date("2026-10-20T15:00:00+08:00"), actor: { kind: "ai", agentId: m.salesAgentId }, now: NOW });
    expect(aiBooks.status).toBe("booked");
    await writeBackDue({ now: NOW });
    // The (synthetic, unreadable) calendar sign-in is now tried, and reported honestly: the write-back ran again.
    expect((await one<{ status: string }>("select status from crm_calendar_connections where id = $1", [connId]))[0].status).toBe("needs_reauth");
    // The migration's own events were never re-dispatched.
    expect(await count("select count(*)::text as n from crm_events where org_id = $1 and payload->>'via' = 'ghl_migration' and dispatch_error not like 'Migrated from GoHighLevel%'", [m.org.id])).toBe(0);
    // The other workspace was never touched.
    expect(await workspaceRow(other.org.id)).toEqual({ mode: "native", switching: false });
    expect(await ownerRows(other.org.id)).toEqual([]);
    expectReadOnly(server);
  });
});

/** An SMS campaign (Smart List "springfield") prepared by the manager and approved by the owner in the Approval Center. */
async function approvedCampaign(m: MessagingOrg): Promise<string> {
  const owner = memberActor(m.ctx("owner"));
  const manager = memberActor(m.ctx("manager"));
  await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      "insert into contacts (org_id, display_name, first_name, phone, city, source, created_via) values ($1, 'Pat Example', 'Pat', '+15552001234', 'Springfield', 'manual', 'manual') returning id",
      [m.org.id],
    );
    await db.query("insert into contact_identities (org_id, contact_id, kind, value, verified, verified_via) values ($1, $2, 'phone', '+15552001234', true, 'staff_confirmed')", [m.org.id, rows[0].id]);
    await db.query("insert into contact_consent_events (org_id, contact_id, channel, purpose, status, source, evidence) values ($1, $2, 'sms', 'marketing', 'granted', 'test', 'Opted in on a form')", [m.org.id, rows[0].id]);
  });
  const t = await createTemplate(owner, { name: "Autumn offer", channel: "sms", purpose: "marketing", body: "Hi {{contact.first_name}}, 20% off this week at {{business.name}}. Reply STOP to opt out." });
  await approveTemplate(owner, t.id, { version: t.currentVersion, contentHash: t.contentHash });
  const list = await createSmartList(owner, { entity: "contact", name: "Springfield", visibility: "team", filter: { op: "and", conditions: [{ field: "city", op: "equals", value: "springfield" }] } });
  const { id } = await createCampaign(manager, { name: "Autumn offer", channel: "sms", smartListId: list.id, templateId: t.id, schedule: { mode: "now" }, ratePerMinute: 30 });
  const p = await previewCampaign(manager, { campaignId: id });
  expect(p.problems).toEqual([]);
  const req = await requestCampaignApproval(manager, id, { fingerprint: p.fingerprint! });
  const { outcome } = await decideApproval(m.ctx("owner"), req.approvalId, "approve");
  expect(outcome?.status, outcome?.detail).toBe("succeeded");
  return id;
}

// ---------------------------------------------------------------------------
// Hybrid: one owner per capability, so two systems never act on the same thing
// ---------------------------------------------------------------------------

describe("hybrid ownership", () => {
  it("never sends through iAcquire's own providers while GoHighLevel owns conversations", async () => {
    const m = await messagingWorkspace("GHL Conversations Co", "synthSwitchLocConv01");
    const rec = recordingProvider("twilio");
    const conv = await inbound(m.org.id, { provider: "twilio", ghlContactId: null });
    const before = await withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId: conv.conversationId, scope: "reply", actor: { kind: "ai", agentId: m.salesAgentId }, body: "Queued before the change." }));
    expect(before.status).toBe("queued");
    await hybrid(m.org.id, ["conversations"]);
    // A new AI message is refused with the reason, a person's send too, and the already-queued one is never sent.
    const ai = await withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId: conv.conversationId, scope: "reply", actor: { kind: "ai", agentId: m.salesAgentId }, body: "Hello again." }));
    expect(ai).toMatchObject({ status: "blocked", reason: "provider_owned", detail: expect.stringMatching(/Conversations are managed in GoHighLevel/) });
    await dispatchDue({ transport: rec.transport });
    expect(rec.calls.filter((x) => x.orgId === m.org.id)).toHaveLength(0);
    expect(await messageStatus(before.messageId)).toMatchObject({ status: "blocked", blocked_reason: "provider_owned" });
    await withSystem((db) => db.query("update conversations set owner_kind = 'human', owner_user_id = $2 where id = $1", [conv.conversationId, m.people.sales.id]));
    await expectAppError(sendHumanReply(m.ctx("sales"), conv.conversationId, "Hi there"), "conflict", /Conversations are managed in GoHighLevel/);
    // A campaign stops with the reason before anything is queued.
    const campaign = await approvedCampaign(m);
    await processCampaigns({ now: new Date() });
    const row = (await one<{ status: string; counts: { notice?: { code: string; detail: string } } }>("select status, counts from crm_campaigns where id = $1", [campaign]))[0];
    expect(row.counts.notice).toMatchObject({ code: "provider", detail: expect.stringMatching(/Conversations are managed in GoHighLevel/) });
    expect(await count("select count(*)::text as n from conversation_messages where org_id = $1 and dedupe_key like $2", [m.org.id, `camp:${campaign}:%`])).toBe(0);
  });

  it("refuses native booking while GoHighLevel owns appointments, and refuses GoHighLevel bookings once a switch gave them to iAcquire", async () => {
    const c = await crmOrg({ name: "Appointments Owner Co", timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    await setHostAvailability(owner, c.people.owner.id, { timezone: "Asia/Manila", rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })) });
    const cal = await createCalendar(owner, { name: `Consults ${uid()}`, assignment: "single", public: true, members: [{ userId: c.people.owner.id }] });
    const type = await createAppointmentType(owner, cal.id, { name: "Visit", durationMinutes: 60, minNoticeMinutes: 60, maxDaysAhead: 30, locationKind: "phone", meetingProvider: "none", questions: [] });
    const NOW = new Date("2026-10-19T00:00:00Z");
    // Booked while iAcquire owned appointments: it waits to be written to the host's connected calendar.
    await bookNativeAppointment(await bookingPageActor(c.org.id), { typeId: type.id, startAt: new Date("2026-10-21T10:00:00+08:00"), contact: { firstName: "Fay", email: "fay@example.test" }, via: "booking_page", now: NOW });
    await hybrid(c.org.id, ["appointments"]);
    await expectAppError(
      bookNativeAppointment(await bookingPageActor(c.org.id), { typeId: type.id, startAt: new Date("2026-10-20T10:00:00+08:00"), contact: { firstName: "Eve", email: "eve@example.test" }, via: "booking_page", now: new Date("2026-10-19T00:00:00Z") }),
      "conflict", /Appointments are managed in GoHighLevel/,
    );
    // The other way: a switch moved appointments to iAcquire, which has no calendar for the AI to use. GoHighLevel's calendar is not
    // booked instead. (Explicit owner rows alone don't count: every cutover writes them for all capabilities; see the next test.)
    const g = await connected("Native Appointments Co", "synthSwitchLocAppt01");
    ghlServer(sample("synthSwitchLocAppt01", g.people.owner.email));
    const moved = await runSwitch(g.actor("owner"), { to: "native", capabilities: ["appointments"] });
    expect(moved).toMatchObject({ status: "completed", capabilities: ["appointments"] });
    const contact = await withSystem(async (db) => (await db.query<{ id: string }>("insert into contacts (org_id, display_name, ghl_contact_id, created_via) values ($1, 'Gus', 'ghlGus0001', 'manual') returning id", [g.org.id])).rows[0].id);
    const created: unknown[] = [];
    const provider: AppointmentProvider = {
      name: "recorder",
      freeSlots: async () => ({ ok: true, slots: [], checkedAt: new Date().toISOString() }) as never,
      create: async (r) => { created.push(r); return { ok: true, appointmentId: "x" } as never; },
      update: async () => ({ ok: true }),
    };
    const r = await requestBooking({ orgId: g.org.id, contactId: contact, startAt: new Date(Date.now() + 3 * 86400_000), actor: { kind: "staff", userId: g.people.owner.id } }, { provider });
    expect(r).toMatchObject({ status: "unavailable", reason: "blocked", detail: expect.stringMatching(/Appointments are managed in iAcquire CRM/) });
    expect(created).toEqual([]);
    // Calendar write-backs skip a workspace whose calendars GoHighLevel owns (nothing is lost: the writes stay pending).
    await hybrid(c.org.id, ["calendars", "appointments"]);
    const connId = (await one<{ id: string }>(
      `insert into crm_calendar_connections (org_id, user_id, provider, account_label, status, credentials, external_calendar_id, write_events)
       values ($1, $2, 'google', 'owner2@example.test', 'connected', 'not-a-sealed-secret', 'primary', true) returning id`,
      [c.org.id, c.people.owner.id],
    ))[0].id;
    await writeBackDue({ now: NOW });
    expect((await one<{ status: string }>("select status from crm_calendar_connections where id = $1", [connId]))[0].status).toBe("connected");
    // Back with iAcquire, the pending write is tried (the synthetic sign-in can't be read, which is reported honestly).
    await hybrid(c.org.id, []);
    await writeBackDue({ now: NOW });
    expect((await one<{ status: string }>("select status from crm_calendar_connections where id = $1", [connId]))[0].status).toBe("needs_reauth");
  });

  it("leaves the GoHighLevel calendar booking as it was when a switch moved other capabilities (only conversations to GoHighLevel)", async () => {
    const loc = "synthSwitchLocAppt02";
    const c = await connected("Conversations Only Co", loc, "native");
    const server = ghlServer(sample(loc, c.people.owner.email));
    await withSystem((db) => db.query("update ghl_location_mappings set calendar_ids = array['calSynth0001'] where org_id = $1", [c.org.id]));
    expect(await count("select count(*)::text as n from crm_calendars where org_id = $1", [c.org.id])).toBe(0);
    const contact = await withSystem(async (db) => (await db.query<{ id: string }>("insert into contacts (org_id, display_name, ghl_contact_id, created_via) values ($1, 'Gus', 'ghlGus0002', 'manual') returning id", [c.org.id])).rows[0].id);
    const seen: string[] = [];
    const provider: AppointmentProvider = {
      name: "recorder",
      freeSlots: async () => { seen.push("freeSlots"); return { ok: true, slots: [] } as never; },
      create: async () => { seen.push("create"); return { ok: true, appointmentId: "x" } as never; },
      update: async () => ({ ok: true }),
    };
    const ask = (startAt: Date) => requestBooking({ orgId: c.org.id, contactId: contact, calendarId: "calSynth0001", startAt, actor: { kind: "staff", userId: c.people.owner.id } }, { provider });
    const start = new Date(Date.now() + 3 * 86400_000);
    const before = await ask(start);
    expect(before).not.toMatchObject({ reason: "blocked" });
    expect(seen).toContain("freeSlots");
    // Hand only conversations to GoHighLevel: the cutover writes an explicit (native) row for appointments too, which must not count.
    const done = await runSwitch(c.actor("owner"), { to: "ghl", capabilities: ["conversations"] });
    expect(done.status).toBe("completed");
    expect((await ownerRows(c.org.id)).find((r) => r.capability === "appointments")).toMatchObject({ provider: "native" });
    seen.length = 0;
    const after = await ask(new Date(start.getTime() + 3600_000));
    expect(after).not.toMatchObject({ reason: "blocked" });
    expect(seen).toContain("freeSlots");
    expectReadOnly(server, { some: false });
  });

  it("keeps GoHighLevel owning conversations in GoHighLevel mode too, and says so where native channels are switched on", async () => {
    const loc = "synthSwitchLocChan01";
    const m = await messagingWorkspace("Native Channel Co", loc);
    ghlServer(sample(loc, m.people.owner.email));
    const owner = memberActor(m.ctx("owner"));
    // Handing conversations to GoHighLevel warns that the switched-on Twilio channel stops sending.
    const p = await previewSwitch(owner, { to: "ghl", capabilities: ["conversations"] });
    expect(p.warnings.join(" ")).toMatch(/\d+ sending channels? (is|are) switched on with iAcquire's own providers .* Once GoHighLevel owns conversations (it doesn't|they don't) send/);
    expect((await getProviderSwitchState(owner)).notices).toEqual([]);
    // A workspace in plain GoHighLevel mode: the native channel never sends (both systems would message the same people), and the
    // provider screen says why the channel that looks switched on doesn't send.
    await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [m.org.id]));
    const conv = await inbound(m.org.id, { provider: "twilio", ghlContactId: null });
    const r = await withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId: conv.conversationId, scope: "reply", actor: { kind: "ai", agentId: m.salesAgentId }, body: "Hello." }));
    expect(r).toMatchObject({ status: "blocked", reason: "provider_owned" });
    const state = await getProviderSwitchState(owner);
    expect(state.notices.join(" ")).toMatch(/\d+ sending channels? (is|are) switched on with iAcquire's own providers .* GoHighLevel owns conversations here, so (it doesn't|they don't) send/);
    const t = text(await ProviderView({ actor: owner, scope: await scopeFor(owner, "/crm") }));
    expect(t).toMatch(/GoHighLevel owns conversations here, so (it doesn't|they don't) send/);
  });
});

// ---------------------------------------------------------------------------
// The owner changes mid-switch
// ---------------------------------------------------------------------------

describe("owner change mid-switch", () => {
  it("keeps the authorized cutover going, refuses the former owner, and lets the new owner finish or roll back", async () => {
    const loc = "synthSwitchLocOwner1";
    const c = await connected("Owner Change Co", loc);
    const server = ghlServer(sample(loc, c.people.owner.email));
    const cut = await runSwitch(c.actor("owner"), { to: "native", capabilities: ["contacts"] }, { stopAfterCutover: true });
    expect(cut.status).toBe("cutting_over");
    // Ownership moves from the person who started the switch to the manager.
    await withSystem(async (db) => {
      await db.query("update organization_memberships set role = 'admin' where org_id = $1 and user_id = $2", [c.org.id, c.people.owner.id]);
      await db.query("update organization_memberships set role = 'owner' where org_id = $1 and user_id = $2", [c.org.id, c.people.manager.id]);
    });
    const former = memberActor(ctxFor(c.people.owner, c.org, "admin"));
    const now = memberActor(ctxFor(c.people.manager, c.org, "owner"));
    await expectAppError(rollbackSwitch(former, cut.id), "forbidden", /Only the workspace owner/);
    await expectAppError(completeCutover(former, cut.id), "forbidden");
    // The scheduler keeps the authorized cutover going.
    for (let i = 0; i < 40 && (await getSwitchView(now, cut.id)).status === "cutting_over"; i++) await processProviderSwitches();
    const done = await getSwitchView(now, cut.id);
    expect(done.status).toBe("completed");
    expect(done.can.rollBack).toBe(true);
    expect((await getSwitchView(former, cut.id)).can.rollBack).toBe(false);
    await rollbackSwitch(now, cut.id);
    expect((await drive(cut.id, now, settled)).status).toBe("rolled_back");
    const audit = await one<{ action: string; actor_user_id: string }>("select action, actor_user_id from audit_logs where org_id = $1 and action = 'crm.provider.switch_rollback_started'", [c.org.id]);
    expect(audit[0].actor_user_id).toBe(c.people.manager.id);
    expect(JOBS.map((j) => j.name)).toContain("crmProviderSwitches");
    expectReadOnly(server);
  });
});

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

describe("Settings → CRM Provider", () => {
  it("keeps refreshing the progress after a failed refresh, waiting longer each time (up to 30 seconds)", () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => pollDelay(true, n))).toEqual([1200, 2400, 4800, 9600, 19200, 30000]);
    expect([0, 1, 2, 3].map((n) => pollDelay(false, n))).toEqual([5000, 10000, 20000, 30000]);
  });

  it("shows the owner the wizard and everyone else a read-only view; the contacts screen says when GoHighLevel owns contacts", async () => {
    const loc = "synthSwitchLocView01";
    const c = await connected("Screen Switch Co", loc);
    ghlServer(sample(loc, c.people.owner.email));
    const owner = c.actor("owner");
    const ownerText = text(await ProviderView({ actor: owner, scope: await scopeFor(owner, "/crm") }));
    expect(ownerText).toContain("Switch providers, capability by capability");
    expect(ownerText).toContain("Choose what moves, and where");
    expect(ownerText).toContain("Preview the switch");
    expect(ownerText).not.toContain("It isn't a switch you flip here");
    // The read-only promise is about the switch, not about iAcquire (which can send and book through GoHighLevel when writes are on).
    expect(ownerText).toContain("The switch only reads GoHighLevel (GET requests to its official API); it never changes, deletes or sends anything there.");
    expect(ownerText).not.toContain("iAcquire only ever reads GoHighLevel");
    expect(ownerText).toContain("GoHighLevel connected");
    expect(ownerText).not.toContain("connected read-only");
    const viewer = c.actor("viewer");
    const viewerText = text(await ProviderView({ actor: viewer, scope: await scopeFor(viewer, "/crm") }));
    expect(viewerText).toContain("Only the workspace owner can switch CRM providers");
    expect(viewerText).not.toContain("Preview the switch");
    // A switch in progress: everyone sees its steps; only the owner gets the buttons.
    const backed = await backupBeforeSwitch(owner, { to: "native", capabilities: ["tags"] });
    await startSwitchDryRun(owner, backed.id);
    await drive(backed.id, owner, (v) => v.can.cutover);
    const ownerNow = text(await ProviderView({ actor: owner, scope: await scopeFor(owner, "/crm") }));
    expect(ownerNow).toMatch(/Dry run: reading and checking/);
    expect(ownerNow).toContain("Cut over");
    expect(ownerNow).toContain("Download it");
    const viewerNow = text(await ProviderView({ actor: viewer, scope: await scopeFor(viewer, "/crm") }));
    expect(viewerNow).toMatch(/Dry run: reading and checking/);
    expect(viewerNow).not.toContain("Cancel the switch");
    expect(viewerNow).not.toContain("Download it");
    // When the steps were read is shown with each step.
    expect(ownerNow).toMatch(/read (just now|\d+ minutes? ago)/);
    // GoHighLevel owns contacts and iAcquire holds none: the notice alone.
    const contactsText = text(await ContactsView({ actor: owner, scope: await scopeFor(owner, "/crm"), searchParams: {} }));
    expect(contactsText).toMatch(/Contacts are managed in GoHighLevel/);
    expect(contactsText).not.toContain("New contact");
    await cancelSwitch(owner, backed.id);
  });
});
