// Phase 6 wave B, package L: the lead's integration items from the wave A packages and the Blueprint review. Each describe names its item
// (B1, A1, A2, A4, A7, C1 to C6, E1 to E3). Synthetic data on the in-memory database only: GoHighLevel is a mocked fetch that sees GET
// requests to the official host and nothing else, channel capability tests use an injected tester, and no message is sent.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  failPickup: false,
  crmActor: null as null | import("@/server/crm/actor").CrmActor,
  orgCtx: null as null | import("@/server/tenancy/context").OrgContext,
}));
// Lets a test make the Setup Center's evidence pickup fail; every other call goes to the real pass.
vi.mock("@/server/setup/automation", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/setup/automation")>();
  return {
    ...mod,
    reconcileSetupAutomation: async (orgId: string) => {
      if (h.failPickup) throw new Error("synthetic pickup failure");
      return mod.reconcileSetupAutomation(orgId);
    },
  };
});
// Routes and actions resolve who is acting from the session; here the test chooses, and the permission checks still run.
vi.mock("@/server/crm/request", async () => {
  const { assertCan } = await import("@/server/crm/actor");
  return {
    resolveCrmActor: async (_orgId: string | null, permission: import("@/lib/permissions").Permission) => {
      if (!h.crmActor) throw new Error("No actor chosen for this test.");
      assertCan(h.crmActor, permission);
      return h.crmActor;
    },
  };
});
vi.mock("@/server/tenancy/context", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/tenancy/context")>();
  const { AppError } = await import("@/server/errors");
  return {
    ...mod,
    requireOrgContextOrThrow: async (permission?: import("@/lib/permissions").Permission) => {
      if (!h.orgCtx) throw new Error("No workspace chosen for this test.");
      if (permission && !h.orgCtx.can(permission)) throw new AppError("forbidden", "Your role doesn't allow this action. Ask a workspace owner for access.");
      return h.orgCtx;
    },
  };
});
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
  usePathname: () => "/inbox",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { hasDbErrorCode, OperationFailure } from "@/server/diagnostics";
import { crmRead, MEMBER_READ_STATEMENT_TIMEOUT } from "@/server/crm/actor";
import { scopeFor } from "@/server/crm/page";
import { applyBlueprint, getApplication, listApplicationsForOrg, previewApplication, rollbackApplication } from "@/server/crm/blueprints/apply";
import { listApplications } from "@/server/crm/blueprints/library";
import { getBlueprintChecklistForOrg } from "@/server/crm/blueprints/checklist";
import { GHL_READ_SCOPES, inspectGhl } from "@/server/integrations/inspection";
import { integrationSaveSchema } from "@/server/integrations/manager";
import { triggerMatches } from "@/server/crm/workflows/triggers";
import type { CrmEventRow } from "@/server/crm/events";
import { buildExport } from "@/server/offboarding/export";
import { readZip } from "@/server/offboarding/zip";
import { listExportJobs, exportContactsCsv } from "@/server/crm/exports";
import { createImportJob, listImportJobs } from "@/server/crm/imports";
import { GET as exportRoute } from "@/app/api/crm/export/route";
import { createClientTenant } from "@/server/admin/tenants";
import { ensureInstanceStandalone } from "@/server/setup/core";
import { setServices } from "@/server/setup/agency";
import { runChecks } from "@/server/setup/automation";
import { getAgencySetupSnapshot } from "@/server/setup/snapshots";
import { getPreparationJobs, queueOnboardingPreparations } from "@/server/setup/jobs";
import { channelEvidence, crmOwners } from "@/server/setup/native-evidence";
import { configureNativeChannel, enableChannel, runChannelCapabilityTest } from "@/server/messaging/channels";
import { activateCalendar } from "@/server/calendars/activation";
import { createAppointmentType, createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { CONVERSATION_MESSAGE_PAGE, getConversationDetail, getMessagesByIds, getOlderMessages, MESSAGES_BY_ID_LIMIT, withDeliveryDetail, type ConversationDetail } from "@/server/messaging/inbox";
import { discardDraftAction, loadMessagesByIdAction, loadOlderMessagesAction } from "@/app/actions/inbox";
import { countListValues, MAX_FILTER_LIST_VALUES, parseFilter } from "@/lib/crm/filters";
import { CRM_NAV, navFor } from "@/lib/crm/nav";
import { CRM_CAPABILITIES, type CapabilityProvider, type CrmCapability } from "@/lib/crm/types";
import type { CapabilityTest } from "@/server/messaging/transports/types";
import type { ApplyOptions, BlueprintContent } from "@/lib/crm/blueprints/types";
import type { GhlMigrationState } from "@/server/crm/ghl-migration";
import type { ExportJobView } from "@/server/crm/exports";
import { DataView } from "@/components/crm/views/settings-views";
import { CrmShell } from "@/components/crm/crm-shell";
import { SupportAccessLog } from "@/components/crm/settings-screens";
import { excludedLabel } from "@/components/admin/setup/task-drawer";
import { OnboardedBanner } from "@/components/setup/onboarded-banner";
import { GHL_SCOPE_CHOICES } from "@/components/admin/integration-wizard";
import {
  approvedDraftToast, InboxWorkspace, isOlderThanPage, isScrolledToEnd, newestMessageId, olderLoadedNote, OlderMessagesNotice, olderMessagesToShow, restoreOlderFocus,
  settleLoadedDraft, STALE_DRAFT_REREAD_LIMIT, staleLoadedDrafts, threadBlocks, type InboxDetail, type InboxMessage,
} from "@/components/inbox/inbox-workspace";
import { agencyPeople, crmOrg, type CrmOrg } from "./support/crm";
import { agencyUser, createUser, ctxFor, uid } from "./support/fixtures";
import { clone, confirmation, insertPublishedBlueprint, publishVersion, smallContent, type PublishedBlueprint } from "./support/blueprints";

type Agency = Awaited<ReturnType<typeof agencyPeople>>;
let agency: Agency;
beforeAll(async () => {
  agency = await agencyPeople();
});
afterEach(() => {
  h.failPickup = false;
  h.crmActor = null;
  h.orgCtx = null;
  vi.restoreAllMocks();
});

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(sql, params))).rows;
const check = async (orgId: string, key: string) => (await q<{ status: string; detail: string }>("select status, detail from client_setup_checks where org_id = $1 and check_key = $2", [orgId, key]))[0];
const task = async (orgId: string, key: string) =>
  (await q<{ id: string; status: string; completion_source: string | null }>("select id, status, completion_source from client_setup_tasks where org_id = $1 and template_key = $2", [orgId, key]))[0];

/** Previews and applies a published version the way the agency does (the confirmation carries the preview's plan digest). */
async function run(orgId: string, bp: PublishedBlueprint, options: ApplyOptions, key = confirmation()) {
  const preview = await previewApplication(agency.superAdmin, orgId, { blueprintId: bp.blueprintId, version: bp.version, options });
  return applyBlueprint(agency.superAdmin, orgId, { blueprintId: bp.blueprintId, version: bp.version, options, planDigest: preview.plan.digest, idempotencyKey: key });
}

/** A client with a Setup Center checklist and the given services (the CRM service by default). */
async function client(services: string[] = ["crm"]): Promise<CrmOrg> {
  const c = await crmOrg();
  await ensureInstanceStandalone(c.org.id);
  await setServices(agency.superAdmin, c.org.id, services);
  return c;
}

async function finishOnboarding(orgId: string) {
  await withSystem(async (db) => {
    await db.query("update organizations set onboarding_completed_at = now() where id = $1", [orgId]);
    await db.query("insert into onboarding_responses (org_id, current_step, completed_at) values ($1, 5, now()) on conflict (org_id) do update set completed_at = now()", [orgId]);
  });
}

const passing = async (): Promise<CapabilityTest> => ({ ok: true, checkedAt: new Date().toISOString(), checks: [{ label: "Account", ok: true, detail: "The account is active." }], registrationStatus: "approved" });
const failing = async (): Promise<CapabilityTest> => ({ ok: false, checkedAt: new Date().toISOString(), checks: [{ label: "Account", ok: false, detail: "Twilio refused the auth token." }] });

async function twilioSms(orgId: string) {
  const accountId = `AC${crypto.randomBytes(16).toString("hex")}`;
  await configureNativeChannel(agency.superAdmin, orgId, {
    channel: "sms", provider: "twilio", secret: { accountSid: accountId, authToken: crypto.randomBytes(16).toString("hex") },
    senderIdentity: `+1512555${String(Math.floor(Math.random() * 9000) + 1000)}`, senderId: `MG${crypto.randomBytes(16).toString("hex")}`, accountId, replaceLiveChannel: true,
  });
}

async function resendEmail(orgId: string) {
  await configureNativeChannel(agency.superAdmin, orgId, {
    channel: "email", provider: "resend", secret: `re_${crypto.randomBytes(16).toString("hex")}`,
    senderIdentity: `Sample Clinic <hello-${crypto.randomBytes(3).toString("hex")}@example.test>`, senderId: crypto.randomUUID(), replaceLiveChannel: true,
  });
}

const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
/** An iAcquire calendar whose host has weekly hours, turned back into a draft so it has to be activated. */
async function draftCalendar(c: CrmOrg) {
  const owner = c.actor("owner");
  await setHostAvailability(owner, c.people.owner.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
  const cal = await createCalendar(owner, { name: `Consults ${crypto.randomUUID().slice(0, 6)}`, assignment: "single", public: true, members: [{ userId: c.people.owner.id }] });
  await createAppointmentType(owner, cal.id, { name: "Site visit", durationMinutes: 60, minNoticeMinutes: 60, maxDaysAhead: 30, locationKind: "phone", meetingProvider: "none" });
  await q("update crm_calendars set status = 'draft', public = false, is_default = false where id = $1", [cal.id]);
  return cal.id;
}

// ---------------------------------------------------------------------------
// B1: "the rest of vN" on an application's detail and on the apply result
// ---------------------------------------------------------------------------

describe("B1: updateAvailable on one application's summary", () => {
  it("follows listApplications: the apply result and the detail offer the rest of a version a section-limited update left out", async () => {
    const c = await crmOrg();
    const base = smallContent();
    const bp = await insertPublishedBlueprint(base);
    const v1 = await run(c.org.id, bp, { strategy: "update_compatible" });
    // A full application of the latest version: nothing more to offer.
    expect(v1.application).toMatchObject({ version: 1, latestVersion: 1, updateAvailable: false });

    const v2 = clone(base) as BlueprintContent;
    v2.assets.messageTemplates[0].body = `${v2.assets.messageTemplates[0].body} See you soon.`;
    v2.assets.pipelines[0].description = "Now with a description.";
    const pub = await publishVersion(bp.blueprintId, v2);
    // v1's detail now offers version 2.
    expect((await getApplication(agency.superAdmin, c.org.id, v1.application.id)).updateAvailable).toBe(true);

    const key = confirmation();
    const partly = await run(c.org.id, pub, { strategy: "update_compatible", sections: ["messageTemplates"] }, key);
    // Version 2 of 2, yet its pipelines are still to apply: the result says so, and so does the detail view.
    expect(partly.application).toMatchObject({ version: 2, latestVersion: 2, updateAvailable: true, canRollBack: true });
    expect(await getApplication(agency.superAdmin, c.org.id, partly.application.id)).toMatchObject({ updateAvailable: true });
    // Only the newest live application offers it, as in the library's list.
    expect((await getApplication(agency.superAdmin, c.org.id, v1.application.id)).updateAvailable).toBe(false);
    const listed = await listApplications(agency.superAdmin, { orgId: c.org.id, blueprintId: bp.blueprintId });
    expect(listed.map((a) => [a.id, a.updateAvailable])).toEqual([[partly.application.id, true], [v1.application.id, false]]);
    const forOrg = await withSystem((db) => listApplicationsForOrg(db, agency.superAdmin, c.org.id));
    expect(forOrg.map((a) => [a.id, a.updateAvailable])).toEqual(listed.map((a) => [a.id, a.updateAvailable]));
    // A replay of the same confirmation reports the same.
    const replay = await run(c.org.id, pub, { strategy: "update_compatible", sections: ["messageTemplates"] }, key);
    expect(replay).toMatchObject({ replayed: true, application: { id: partly.application.id, updateAvailable: true } });

    // Applying the rest leaves nothing to offer anywhere.
    const rest = await run(c.org.id, pub, { strategy: "update_compatible", sections: ["pipelines"] });
    expect(rest.application.updateAvailable).toBe(false);
    for (const id of [v1.application.id, partly.application.id, rest.application.id]) {
      expect((await getApplication(agency.superAdmin, c.org.id, id)).updateAvailable, id).toBe(false);
    }
    // A failed or rolled-back application never offers an update.
    await rollbackApplication(agency.superAdmin, c.org.id, rest.application.id);
    expect((await getApplication(agency.superAdmin, c.org.id, rest.application.id)).updateAvailable).toBe(false);
    // The rollback put v2's partial application back on top: its pipelines are to apply again.
    expect((await getApplication(agency.superAdmin, c.org.id, partly.application.id)).updateAvailable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A1: the migration's token scopes can be recorded and verified
// ---------------------------------------------------------------------------

const SECRET = "synthetic-ghl-token-" + "k".repeat(32);
const LOCATION = "syntheticLead12345";
const MIGRATION_SCOPES = ["contacts.readonly", "businesses.readonly", "users.readonly"] as const;

describe("A1: GoHighLevel migration scopes", () => {
  it("are offered by the wizard and accepted by the save schema, up to 15", () => {
    for (const s of MIGRATION_SCOPES) {
      expect(GHL_READ_SCOPES).toContain(s);
      expect(GHL_SCOPE_CHOICES).toContain(s);
    }
    // Every wizard choice is a read scope the server accepts.
    for (const s of GHL_SCOPE_CHOICES) expect(GHL_READ_SCOPES as readonly string[]).toContain(s);
    const save = (scopes: string[]) => integrationSaveSchema.safeParse({ provider: "ghl", label: "Synthetic CRM", environment: "development", secret: SECRET, config: { locationId: LOCATION, scopes } });
    expect(save([...GHL_READ_SCOPES]).success).toBe(true);
    expect(GHL_READ_SCOPES.length).toBeLessThanOrEqual(15);
    expect(save(Array.from({ length: 16 }, () => "contacts.readonly")).success).toBe(false);
    expect(save(["contacts.write"]).success).toBe(false);
  });

  it("are proven by one GET each on the official host, scoped to the verified location, and keep nothing they read", async () => {
    const calls: Array<{ url: URL; method: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.pathname === `/locations/${LOCATION}`) return Response.json({ location: { id: LOCATION, companyId: "syntheticCompany01" } });
      if (url.pathname === "/contacts/") return Response.json({ contacts: [{ id: "c1", locationId: LOCATION, email: "ana@example.test", firstName: "Ana" }], count: 1 });
      if (url.pathname === "/businesses/") return Response.json({ businesses: [{ id: "b1", locationId: LOCATION, name: "Ana's Bakery" }] });
      if (url.pathname === "/users/search") return Response.json({ users: [{ id: "u1", email: "rep@example.test" }], count: 1 });
      return new Response("not expected", { status: 404 });
    });
    const result = await inspectGhl({ locationId: LOCATION, token: SECRET, orgKind: "client" }, ["locations.readonly", ...MIGRATION_SCOPES]);
    expect(result.capabilities.provenReadPermissions).toEqual(["locations.readonly", ...MIGRATION_SCOPES]);
    expect(result.capabilities.unavailablePermissions).toEqual([]);
    expect(result.capabilities.unverifiedPermissions).toEqual([]);
    // Nothing the record reads returned is kept: no names, emails or ids in the inspection.
    expect(JSON.stringify(result)).not.toMatch(/ana@example|Ana|rep@example|Bakery|"c1"|"b1"|"u1"/);
    expect(calls.every((c) => c.method === "GET" && c.url.origin === "https://services.leadconnectorhq.com")).toBe(true);
    const byPath = Object.fromEntries(calls.map((c) => [c.url.pathname, c.url.searchParams]));
    expect(byPath["/contacts/"].get("locationId")).toBe(LOCATION);
    expect(byPath["/contacts/"].get("limit")).toBe("1");
    expect(byPath["/businesses/"].get("locationId")).toBe(LOCATION);
    expect(byPath["/users/search"].get("companyId")).toBe("syntheticCompany01");
    expect(byPath["/users/search"].get("locationId")).toBe(LOCATION);
  });

  it("records a refused scope as unavailable, an unaskable one as unverified, and stops at a record from another location", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/locations/${LOCATION}`) return Response.json({ location: { id: LOCATION } });
      if (url.pathname === "/contacts/") return new Response("forbidden", { status: 403 });
      if (url.pathname === "/businesses/") return Response.json({ businesses: [] });
      return new Response("not expected", { status: 404 });
    });
    const limited = await inspectGhl({ locationId: LOCATION, token: SECRET, orgKind: "client" }, ["locations.readonly", "opportunities.readonly", ...MIGRATION_SCOPES]);
    expect(limited.status).toBe("permission_limited");
    expect(limited.capabilities.unavailablePermissions).toEqual(expect.arrayContaining(["contacts.readonly"]));
    expect(limited.capabilities.provenReadPermissions).toContain("businesses.readonly");
    // No company id on the location: users can't be asked for, so the scope stays unverified rather than refused.
    expect(limited.capabilities.unverifiedPermissions).toEqual(["users.readonly"]);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/locations/${LOCATION}`) return Response.json({ location: { id: LOCATION } });
      return Response.json({ contacts: [{ id: "x", locationId: "anotherLocation99" }] });
    });
    await expect(inspectGhl({ locationId: LOCATION, token: SECRET, orgKind: "client" }, ["contacts.readonly"])).rejects.toThrow(/another location/);
  });

  it("never reads either protected location", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    for (const locationId of ["u69CVh0ZlAofUmRoj1zF", "SQvVnld5MBHdMQ1qnSfw"]) {
      await expect(inspectGhl({ locationId, token: SECRET, orgKind: "client" }, [...MIGRATION_SCOPES])).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A2: migration events never start a workflow unless the trigger asks for them
// ---------------------------------------------------------------------------

describe("A2: the trigger's second safety layer for migrated records", () => {
  const event = (payload: Record<string, unknown>, type = "contact.created"): CrmEventRow => ({
    id: 1, orgId: crypto.randomUUID(), type, entityType: "contact", entityId: crypto.randomUUID(), contactId: crypto.randomUUID(), payload, depth: 0, actorKind: "system", occurredAt: new Date().toISOString(),
  });
  // No filter here reads the database: a stand-in that fails if one ever did.
  const db = { query: async () => { throw new Error("no query expected"); } } as unknown as Parameters<typeof triggerMatches>[0];
  const none = { contactId: null, opportunityId: null, appointmentId: null, taskId: null };
  const matches = (e: CrmEventRow, filters: Record<string, unknown> = {}) => triggerMatches(db, e, { type: e.type as never, filters } as never, none, "UTC");

  it("skips an event that came from the migration, by via or by tag source, unless the trigger names that source", async () => {
    expect(await matches(event({ via: "ghl_migration" }))).toBe(false);
    expect(await matches(event({ via: "ghl_migration" }), { createdVia: ["import", "manual"] })).toBe(false);
    expect(await matches(event({ tagId: crypto.randomUUID(), source: "ghl_migration" }, "contact.tag_added"))).toBe(false);
    // A trigger that asks for migrated contacts by name still gets them.
    expect(await matches(event({ via: "ghl_migration" }), { createdVia: ["ghl_migration"] })).toBe(true);
    // Everything else is unchanged.
    expect(await matches(event({ via: "import" }))).toBe(true);
    expect(await matches(event({ via: "import" }), { createdVia: ["import"] })).toBe(true);
    expect(await matches(event({ via: "manual" }), { createdVia: ["import"] })).toBe(false);
    expect(await matches(event({ tagId: crypto.randomUUID(), source: "import" }, "contact.tag_added"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A4: the offboarding export leaves out a migration step's reading state
// ---------------------------------------------------------------------------

describe("A4: offboarding export of the import history", () => {
  it("keeps each job but never its fetch_state (the GoHighLevel users' emails while a step reads)", async () => {
    const c = await crmOrg();
    const [job] = await q<{ id: string }>(
      `insert into crm_import_jobs (org_id, entity, source, source_location, status, fetch_state)
       values ($1, 'contact', 'ghl_api', 'syntheticExport01', 'fetching', $2) returning id`,
      [c.org.id, JSON.stringify({ pages: 2, users: { u1: "rep-lead-items@example.test" } })],
    );
    const out = await buildExport(c.org.id);
    expect(out.counts.crm_import_jobs).toBe(1);
    const history = readZip(out.bytes).find((f) => f.name.endsWith("crm/import-history.json"))!.data.toString("utf8");
    const rows = JSON.parse(history) as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.id)).toEqual([job.id]);
    expect(rows[0]).not.toHaveProperty("fetch_state");
    expect(rows[0]).not.toHaveProperty("claimed_at");
    expect(history).not.toContain("rep-lead-items@example.test");
  });
});

// ---------------------------------------------------------------------------
// A7: Imports & Exports opens for anyone who can view the CRM; exports stay gated
// ---------------------------------------------------------------------------

describe("A7: reaching the migration preview without the import permission", () => {
  it("opens the page, the nav entry and the agency mirror at crm.view", () => {
    const entry = CRM_NAV.flatMap((s) => s.items).find((i) => i.path === "/settings/data");
    expect(entry?.permission).toBe("crm.view");
    const page = readFileSync("src/app/(portal)/crm/settings/data/page.tsx", "utf8");
    expect(page).toMatch(/clientCrmActor\("crm\.view"\)/);
    expect(page).not.toContain("contacts.import");
    const mirror = readFileSync("src/app/(admin)/admin/clients/[id]/crm/[[...path]]/page.tsx", "utf8");
    expect(mirror).toMatch(/if \(b === "data"\) \{\s*(\/\/[^\n]*\n\s*)?need\("crm\.view"\);/);
  });

  it("keeps the history, CSV imports and every export behind their own permissions", async () => {
    const c = await crmOrg();
    const viewer = c.actor("viewer");
    expect(viewer.can("crm.view")).toBe(true);
    expect(viewer.can("contacts.import") || viewer.can("contacts.export")).toBe(false);
    const props = (el: React.ReactElement) => (el as React.ReactElement<{ jobs: unknown[]; exports: ExportJobView[] | null; ghlMigration: GhlMigrationState }>).props;
    const seen = props(await DataView({ actor: viewer, scope: await scopeFor(viewer, "/crm") }));
    expect(seen.jobs).toEqual([]);
    expect(seen.exports).toBeNull();
    expect(seen.ghlMigration.can.preview).toBe(true);
    const owner = c.actor("owner");
    expect(Array.isArray(props(await DataView({ actor: owner, scope: await scopeFor(owner, "/crm") })).exports)).toBe(true);

    // The services refuse on their own, whatever a page lets through.
    await expect(listExportJobs(viewer)).rejects.toMatchObject({ code: "forbidden" });
    await expect(listImportJobs(viewer)).rejects.toMatchObject({ code: "forbidden" });
    await expect(createImportJob(viewer, { entity: "contact", fileName: "people.csv", csv: "email\nana@example.test\n" })).rejects.toMatchObject({ code: "forbidden" });
    await expect((async () => {
      for await (const chunk of exportContactsCsv(viewer, {})) void chunk;
    })()).rejects.toThrow(/export permission/);
    // The download route too: the viewer is refused before any row is read, the owner gets the file.
    h.crmActor = viewer;
    const refused = await exportRoute(new Request("http://localhost/api/crm/export"));
    expect(refused.status).toBe(403);
    h.crmActor = owner;
    const ok = await exportRoute(new Request("http://localhost/api/crm/export"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toMatch(/text\/csv/);
    await ok.text();
  });
});

describe("capability ownership in CRM navigation", () => {
  it("labels GHL-owned sections while leaving their read-only pages reachable", () => {
    const capabilityOwners = Object.fromEntries(CRM_CAPABILITIES.map((c) => [c, c === "contacts" ? "ghl" : "native"])) as Record<CrmCapability, CapabilityProvider>;
    const shellProps = {
      base: "/crm", sections: navFor(() => true, "client"), mode: "hybrid", capabilityOwners, orgName: "Synthetic client",
    } as React.ComponentProps<typeof CrmShell>;
    const html = renderToStaticMarkup(React.createElement(CrmShell, shellProps, React.createElement("div", null, "CRM content")));
    const contacts = html.match(/<a[^>]*href="\/crm\/contacts"[^>]*>[\s\S]*?<\/a>/g) ?? [];
    const companies = html.match(/<a[^>]*href="\/crm\/companies"[^>]*>[\s\S]*?<\/a>/g) ?? [];
    expect(contacts).toHaveLength(2);
    expect(contacts.every((link) => link.includes('title="Managed in GoHighLevel">GHL</span>'))).toBe(true);
    expect(companies).toHaveLength(2);
    expect(companies.every((link) => !link.includes("GHL"))).toBe(true);
  });
});

describe("support access log keyboard access", () => {
  it("makes the horizontally scrolling table a labeled, keyboard-focusable region", () => {
    const html = renderToStaticMarkup(React.createElement(SupportAccessLog, {
      sessions: [{
        id: "session-a11y", person: "Agency Admin", mode: "read", reason: "Review setup", startedAt: new Date().toISOString(),
        endedAt: null, expiresAt: new Date(Date.now() + 60_000).toISOString(), active: true, views: 1, changes: 0,
      }],
    }));
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Support access history table"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("focus-visible:outline-primary");
  });
});

// ---------------------------------------------------------------------------
// C1: a native client isn't seeded with GoHighLevel status rows
// ---------------------------------------------------------------------------

describe("C1: integration status rows for a new client", () => {
  it("seeds only Hermes for iAcquire CRM, and Hermes plus both GoHighLevel rows for a GoHighLevel client", async () => {
    const admin = agencyUser(await createUser({ platformRole: "agency_super_admin", name: "Lead Admin" }), "agency_super_admin");
    const providers = async (orgId: string) => (await q<{ provider: string; status: string }>("select provider, status from integration_status where org_id = $1 order by provider", [orgId]));
    const native = await createClientTenant(admin, { name: `Native Co ${uid()}`, ownerEmail: `owner-${uid()}@example.test`, enabledRoles: ["lead_hunter"] });
    expect(native.crmMode).toBe("native");
    expect(await providers(native.orgId)).toEqual([{ provider: "hermes", status: "not_configured" }]);
    const ghl = await createClientTenant(admin, { name: `GHL Co ${uid()}`, ownerEmail: `owner-${uid()}@example.test`, enabledRoles: ["lead_hunter"], crmMode: "ghl" });
    expect((await providers(ghl.orgId)).map((r) => r.provider)).toEqual(["ghl", "ghl_calendar", "hermes"]);
  });
});

// ---------------------------------------------------------------------------
// C2: the Setup Center sees new evidence at once
// ---------------------------------------------------------------------------

describe("C2: immediate evidence pickup", () => {
  it("verifies the Blueprint checks right after an apply, and withdraws them right after the rollback", async () => {
    const c = await client();
    await finishOnboarding(c.org.id);
    await runChecks(c.org.id, { actorUserId: null, live: false, force: true });
    expect((await check(c.org.id, "crm_snapshot")).status).toBe("unverified");
    const bp = await insertPublishedBlueprint(smallContent());
    const applied = await run(c.org.id, bp, { strategy: "add_missing" });
    // No runChecks here: the apply itself let the Setup Center look.
    expect((await check(c.org.id, "crm_snapshot")).status).toBe("verified");
    expect((await check(c.org.id, "crm_assets")).status).toBe("verified");
    expect(await task(c.org.id, "crm_snapshot")).toMatchObject({ status: "completed", completion_source: "connector" });

    await rollbackApplication(agency.superAdmin, c.org.id, applied.application.id);
    expect((await check(c.org.id, "crm_snapshot")).status).not.toBe("verified");
  });

  it("records a sender's capability test in the Setup Center as soon as it ran, pass or fail", async () => {
    const c = await client();
    await twilioSms(c.org.id);
    await runChannelCapabilityTest(agency.superAdmin, c.org.id, "sms", { test: passing });
    expect((await check(c.org.id, "sms_sender")).status).toBe("verified");
    expect(await task(c.org.id, "sms_sender")).toMatchObject({ status: "completed", completion_source: "connector" });
    await runChannelCapabilityTest(agency.superAdmin, c.org.id, "sms", { test: failing });
    expect(await check(c.org.id, "sms_sender")).toMatchObject({ status: "failed", detail: expect.stringMatching(/refused the auth token/) });
  });

  it("verifies the calendar check as soon as a calendar is activated", async () => {
    const c = await client(["crm", "calendar"]);
    const calendarId = await draftCalendar(c);
    await runChecks(c.org.id, { actorUserId: null, live: false, keys: ["calendar"] });
    expect((await check(c.org.id, "calendar")).status).toBe("unverified");
    const res = await activateCalendar(c.actor("owner"), calendarId);
    expect(res.activated).toBe(true);
    expect(await check(c.org.id, "calendar")).toMatchObject({ status: "verified", detail: expect.stringMatching(/calendar-only setup/) });
  });

  it("never fails the person's action when the pickup fails: it is logged and left to the scheduled pass", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const c = await client(["crm", "calendar"]);
    await runChecks(c.org.id, { actorUserId: null, live: false, force: true });
    h.failPickup = true;

    const bp = await insertPublishedBlueprint(smallContent());
    const applied = await run(c.org.id, bp, { strategy: "add_missing" });
    expect(applied.application.status).toBe("applied");
    expect((await check(c.org.id, "crm_snapshot")).status).toBe("unverified");

    await twilioSms(c.org.id);
    expect((await runChannelCapabilityTest(agency.superAdmin, c.org.id, "sms", { test: passing })).ok).toBe(true);
    const calendarId = await draftCalendar(c);
    expect((await activateCalendar(c.actor("owner"), calendarId)).activated).toBe(true);
    expect((await rollbackApplication(agency.superAdmin, c.org.id, applied.application.id)).status).toBe("rolled_back");

    const logged = warn.mock.calls.map((args) => String(args[0]));
    for (const after of ["a Blueprint apply", "a channel capability test", "a calendar activation", "a Blueprint rollback"]) {
      expect(logged.some((m) => m.includes(`setup evidence pickup after ${after} failed`)), after).toBe(true);
    }
    // Nothing about the failure's internals reaches the log.
    expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic pickup failure");
    // The scheduled pass still picks it all up.
    h.failPickup = false;
    await runChecks(c.org.id, { actorUserId: null, live: false });
    expect((await check(c.org.id, "sms_sender")).status).toBe("verified");
    expect((await check(c.org.id, "calendar")).status).toBe("verified");
  });
});

// ---------------------------------------------------------------------------
// C3: excluded steps are labelled by what excluded them
// ---------------------------------------------------------------------------

describe("C3: the badge on a step left out of a client's setup", () => {
  it("names the CRM provider only when the step's service is purchased", () => {
    expect(excludedLabel({ crmProvider: "ghl", service: null }, [])).toBe("Not used by this CRM provider");
    expect(excludedLabel({ crmProvider: "native", service: "crm" }, ["crm"])).toBe("Not used by this CRM provider");
    expect(excludedLabel({ crmProvider: "native", service: "crm" }, ["website"])).toBe("Not in package");
    expect(excludedLabel({ crmProvider: null, service: "website" }, ["crm"])).toBe("Not in package");
    expect(excludedLabel({ service: "website" }, [])).toBe("Not in package");
  });

  it("labels a native client's GoHighLevel sub-account step by provider, and a website-only client's sender steps by package", async () => {
    const native = await client(["crm"]);
    const snap = await getAgencySetupSnapshot(agency.superAdmin, native.org.id);
    const sub = snap.tasks.find((t) => t.templateKey === "ghl_subaccount")!;
    expect(sub).toMatchObject({ serviceExcluded: true, crmProvider: "ghl" });
    expect(excludedLabel(sub, snap.services)).toBe("Not used by this CRM provider");

    const site = await client(["website"]);
    const siteSnap = await getAgencySetupSnapshot(agency.superAdmin, site.org.id);
    const sms = siteSnap.tasks.find((t) => t.templateKey === "sms_sender")!;
    expect(sms).toMatchObject({ serviceExcluded: true, crmProvider: "native", service: "crm" });
    expect(excludedLabel(sms, siteSnap.services)).toBe("Not in package");
  });
});

// ---------------------------------------------------------------------------
// C4: the onboarding banner for native clients
// ---------------------------------------------------------------------------

describe("C4: the 'company setup approved' banner", () => {
  const text = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<!-- -->/g, "").replace(/&#x27;|&#39;/g, "'");

  it("says the team applies the industry Blueprint for iAcquire CRM, links the CRM for GoHighLevel, and links the setup guide", async () => {
    const native = text(React.createElement(OnboardedBanner, { nativeCrm: true, crmGuide: true }));
    expect(native).toContain("applies your industry Blueprint");
    expect(native).not.toContain("links your CRM");
    expect(native).toContain('href="/crm/setup"');
    expect(native).toContain('role="status"');
    const ghl = text(React.createElement(OnboardedBanner, { nativeCrm: false, crmGuide: true }));
    expect(ghl).toContain("links your CRM");
    expect(ghl).not.toContain("Blueprint");
    // Without the CRM permission there is no link to a page that would refuse.
    expect(text(React.createElement(OnboardedBanner, { nativeCrm: true, crmGuide: false }))).not.toContain("/crm/setup");
    // The page reads the mode the same way: a new client is native, a GoHighLevel client isn't.
    const c = await crmOrg();
    expect((await withSystem((db) => crmOwners(db, c.org.id))).mode).toBe("native");
    await q("update crm_workspaces set mode = 'ghl' where org_id = $1", [c.org.id]);
    expect((await withSystem((db) => crmOwners(db, c.org.id))).mode).toBe("ghl");
  });
});

// ---------------------------------------------------------------------------
// C5: no GoHighLevel mapping job for a workspace that doesn't use GoHighLevel
// ---------------------------------------------------------------------------

describe("C5: onboarding preparation jobs by CRM provider", () => {
  const ops = async (c: CrmOrg) => {
    await withSystem((db) => queueOnboardingPreparations(db, c.org.id, agency.superAdmin.id));
    return (await getPreparationJobs(agency.superAdmin, c.org.id)).jobs.map((j) => j.operation).sort();
  };

  it("skips manual_ghl_mapping for native and all-native hybrid workspaces, and keeps it once any capability is on GoHighLevel", async () => {
    const native = await crmOrg();
    expect(await ops(native)).not.toContain("manual_ghl_mapping");
    const hybridNative = await crmOrg();
    await q("update crm_workspaces set mode = 'hybrid' where org_id = $1", [hybridNative.org.id]);
    expect(await ops(hybridNative)).toEqual(["manual_hermes_profiles", "prepare_ai_configuration", "prepare_automation_configuration"]);
    const hybridGhl = await crmOrg();
    await q("update crm_workspaces set mode = 'hybrid' where org_id = $1", [hybridGhl.org.id]);
    await q("insert into crm_capability_providers (org_id, capability, provider) values ($1, 'calendars', 'ghl')", [hybridGhl.org.id]);
    expect(await ops(hybridGhl)).toContain("manual_ghl_mapping");
  });
});

// ---------------------------------------------------------------------------
// C6: the Blueprint checklist judges senders by the Setup Center's evidence
// ---------------------------------------------------------------------------

describe("C6: sender items on the Blueprint checklist", () => {
  it("are done only with a recent passed live test and sending on, and otherwise say what the Setup Center says", async () => {
    const c = await client();
    const bp = await insertPublishedBlueprint(smallContent());
    await run(c.org.id, bp, { strategy: "add_missing" });
    const email = async () => (await getBlueprintChecklistForOrg(c.org.id)).items.find((i) => i.key === "email_provider")!;
    const summary = async () => (await withSystem((db) => channelEvidence(db, c.org.id)))["email"].summary;

    expect(await email()).toMatchObject({ status: "pending", detail: await summary() });
    await resendEmail(c.org.id);
    expect(await email()).toMatchObject({ status: "pending", detail: await summary() });
    await runChannelCapabilityTest(agency.superAdmin, c.org.id, "email", { test: passing });
    expect(await email()).toMatchObject({ status: "pending", detail: "Email passed its live test, but sending on this channel is switched off." });
    await enableChannel(agency.superAdmin, c.org.id, "email");
    expect(await email()).toMatchObject({ status: "done", detail: "Email sending is connected and passed its live test." });

    // A pass older than the Setup Center accepts: the channel is still on, but neither screen counts it any more.
    await q("update messaging_channels set capability_tested_at = now() - interval '40 days' where org_id = $1 and channel = 'email'", [c.org.id]);
    const stale = await email();
    expect(stale.status).toBe("pending");
    expect(stale.detail).toBe(await summary());
    expect(stale.detail).toMatch(/run again/);
  });
});

// ---------------------------------------------------------------------------
// E1 and E2: older messages, and delivery events newest-first under the cap
// ---------------------------------------------------------------------------

/** A conversation of `total` messages, message g being g minutes old (so "Message 1" is the newest). */
async function longThread(c: CrmOrg, total: number) {
  return withSystem(async (db) => {
    const k = await db.query<{ id: string }>("insert into contacts (org_id, display_name, first_name) values ($1, 'Long Thread', 'Long') returning id", [c.org.id]);
    const conv = await db.query<{ id: string }>(
      "insert into conversations (org_id, contact_id, channel, status, owner_kind, last_message_at, last_message_preview) values ($1, $2, 'sms', 'open', 'ai', now(), 'Latest') returning id",
      [c.org.id, k.rows[0].id],
    );
    await db.query(
      `insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, scope, created_at)
       select $1, $2, case when g % 2 = 0 then 'inbound' else 'outbound' end, case when g % 2 = 0 then 'contact' else 'human' end, 'Message ' || g,
              case when g % 2 = 0 then 'received' else 'sent' end, case when g % 2 = 0 then null else 'human' end, now() - (g * interval '1 minute')
       from generate_series(1, $3) g`,
      [c.org.id, conv.rows[0].id, total],
    );
    return conv.rows[0].id;
  });
}
const bodies = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => `Message ${from - i}`);

describe("E1: loading older messages", () => {
  it("pages back through a long thread, oldest first, with no gap and no repeat", async () => {
    const c = await crmOrg();
    const owner = ctxFor(c.people.owner, c.org, "owner");
    const convId = await longThread(c, 450);
    const detail = await getConversationDetail(owner, convId);
    expect(detail.messages.map((m) => m.body)).toEqual(bodies(CONVERSATION_MESSAGE_PAGE, 1));
    expect(detail.olderMessages).toEqual({ beforeId: detail.messages[0].id });

    const first = await getOlderMessages(owner, convId, detail.olderMessages!.beforeId);
    expect(first.messages.map((m) => m.body)).toEqual(bodies(400, 201));
    expect(first.olderMessages).toEqual({ beforeId: first.messages[0].id });
    const last = await getOlderMessages(owner, convId, first.olderMessages!.beforeId);
    expect(last.messages.map((m) => m.body)).toEqual(bodies(450, 401));
    expect(last.olderMessages).toBeUndefined();
    const all = [...last.messages, ...first.messages, ...detail.messages];
    expect(new Set(all.map((m) => m.id)).size).toBe(450);
    // Same message shape as the conversation itself.
    expect(Object.keys(first.messages[0]).sort()).toEqual(Object.keys(detail.messages[0]).sort());
  });

  it("follows the conversation's visibility: other workspaces, unassigned roles and foreign anchors find nothing", async () => {
    const c = await crmOrg();
    const other = await crmOrg();
    const convId = await longThread(c, CONVERSATION_MESSAGE_PAGE + 5);
    const owner = ctxFor(c.people.owner, c.org, "owner");
    const anchor = (await getConversationDetail(owner, convId)).olderMessages!.beforeId;
    // Another workspace's owner.
    await expect(getOlderMessages(ctxFor(other.people.owner, other.org, "owner"), convId, anchor)).rejects.toMatchObject({ code: "not_found" });
    // A sales rep sees only conversations they own or are assigned.
    const rep = ctxFor(c.people.sales, c.org, "sales_rep");
    await expect(getOlderMessages(rep, convId, anchor)).rejects.toMatchObject({ code: "not_found" });
    await q("update conversations set assigned_user_id = $2 where id = $1", [convId, c.people.sales.id]);
    expect((await getOlderMessages(rep, convId, anchor)).messages).toHaveLength(5);
    // An anchor from another conversation, or not a message id at all.
    const otherConv = await longThread(c, 3);
    const foreign = (await getConversationDetail(owner, otherConv)).messages[0].id;
    await expect(getOlderMessages(owner, convId, foreign)).rejects.toMatchObject({ code: "not_found" });
    await expect(getOlderMessages(owner, convId, "not-a-message")).rejects.toMatchObject({ code: "not_found" });
    // Without the inbox permission at all.
    const noInbox = { ...owner, can: () => false } as typeof owner;
    await expect(getOlderMessages(noInbox, convId, anchor)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("the action returns the page with each message's delivery detail, and refuses without inbox access", async () => {
    const c = await crmOrg();
    const owner = ctxFor(c.people.owner, c.org, "owner");
    const convId = await longThread(c, CONVERSATION_MESSAGE_PAGE + 2);
    const anchor = (await getConversationDetail(owner, convId)).olderMessages!.beforeId;
    const oldest = (await q<{ id: string }>("select id from conversation_messages where conversation_id = $1 and body = 'Message 201'", [convId]))[0].id;
    await q(
      "insert into message_delivery_events (org_id, message_id, provider, provider_event_id, status, occurred_at) values ($1, $2, 'twilio', $3, 'sent', now() - interval '3 hours'), ($1, $2, 'twilio', $4, 'delivered', now() - interval '2 hours')",
      [c.org.id, oldest, `ev-${uid()}`, `ev-${uid()}`],
    );
    h.orgCtx = owner;
    const r = await loadOlderMessagesAction(convId, anchor);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.messages.map((m) => m.body)).toEqual(["Message 202", "Message 201"]);
    expect(r.data.olderMessages).toBeNull();
    expect(r.data.messages[1].deliveryEvents.map((e) => e.status)).toEqual(["sent", "delivered"]);
    h.orgCtx = { ...owner, can: () => false } as typeof owner;
    expect(await loadOlderMessagesAction(convId, anchor)).toMatchObject({ ok: false, code: "forbidden" });
    h.orgCtx = owner;
    expect(await loadOlderMessagesAction(convId, "nope")).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("the thread says it shows the newest 200 and offers the older ones; a short thread says nothing", async () => {
    const c = await crmOrg();
    const owner = ctxFor(c.people.owner, c.org, "owner");
    const render = async (convId: string) => {
      const d = await getConversationDetail(owner, convId);
      const detail: InboxDetail = { ...d, messages: await withDeliveryDetail(owner.user.id, d.messages) };
      return renderToStaticMarkup(React.createElement(InboxWorkspace, {
        list: [detail.conversation], detail, escalations: [], me: { id: owner.user.id, isOwner: true },
        perms: { reply: true, assign: true, notes: true, resume: true, respond: true, editContacts: true }, team: [], templates: [], timeZone: "UTC",
        filters: { q: "", channel: "", owner: "", unread: false },
      }));
    };
    const long = await render(await longThread(c, CONVERSATION_MESSAGE_PAGE + 1));
    expect(long).toContain("Showing the newest 200 messages.");
    expect(long).toContain("Load older messages");
    expect(long).toContain('aria-live="off"');
    const short = await render(await longThread(c, 3));
    expect(short).not.toContain("Showing the newest");
    expect(short).not.toContain("Load older messages");
  });

  it("keeps only older messages the page doesn't list, newest copy first, never a draft", () => {
    const m = (id: string, at: string, over: Partial<InboxMessage> = {}): InboxMessage => ({
      id, direction: "inbound", authorKind: "contact", authorName: null, body: id, status: "received", statusDetail: null, blockedReason: null, scope: null,
      createdAt: `2026-10-0${at}T00:00:00.000Z`, sentAt: null, deliveredAt: null, provider: null, providerLabel: null, deliveryEvents: [], ...over,
    });
    const page = [m("held", "1", { status: "draft", direction: "outbound", authorKind: "ai" }), m("p1", "5"), m("p2", "6")];
    const detail = { messages: page, olderMessages: { beforeId: "p1" } };
    const loaded = [m("o2", "3"), m("o1", "2"), m("p1", "5"), m("gone", "5", { createdAt: "2026-10-05T12:00:00.000Z" }), m("d", "4", { status: "draft" }), m("o2", "3", { body: "newer copy" })];
    const shown = olderMessagesToShow(loaded, detail);
    expect(shown.map((x) => x.id)).toEqual(["o1", "o2"]);
    expect(shown[1].body).toBe("newer copy");
    // When the page is the whole thread, nothing loaded earlier is shown.
    expect(olderMessagesToShow(loaded, { messages: page })).toEqual([]);
    // The held draft takes its place by time among the older messages, not after them.
    const { olderBlock, newestPage } = threadBlocks(shown, detail);
    expect([...olderBlock, ...newestPage].map((x) => x.id)).toEqual(["held", "o1", "o2", "p1", "p2"]);
    const mid = [m("o1", "2"), m("held", "3", { status: "draft", direction: "outbound", authorKind: "ai" }), m("p1", "5")];
    const midDetail = { messages: [mid[1], mid[2]], olderMessages: { beforeId: "p1" } };
    const midBlocks = threadBlocks(olderMessagesToShow([m("o3", "4"), mid[0]], midDetail), midDetail);
    expect(midBlocks.olderBlock.map((x) => x.id)).toEqual(["o1", "held", "o3"]);
    expect(midBlocks.newestPage.map((x) => x.id)).toEqual(["p1"]);
    // A page that is the whole conversation, or one with no held drafts, is left as it is.
    expect(threadBlocks([], { messages: page })).toEqual({ olderBlock: [], newestPage: page, shownCount: 3 });
    expect(threadBlocks(shown, { messages: page.slice(1), olderMessages: { beforeId: "p1" } })).toEqual({ olderBlock: shown, newestPage: page.slice(1), shownCount: 4 });
    // The count leaves out a held draft older than everything shown, and counts one inside the run.
    expect(threadBlocks(shown, detail).shownCount).toBe(4);
    expect(midBlocks.shownCount).toBe(4);
  });

  it("after a load, an older draft still waiting for approval sits among the loaded messages in time order, not after them", async () => {
    const c = await crmOrg();
    const owner = ctxFor(c.people.owner, c.org, "owner");
    const convId = await longThread(c, 450);
    // "Message 300" (older than the newest page of 200) becomes an AI draft waiting for approval.
    await q("update conversation_messages set direction = 'outbound', author_kind = 'ai', status = 'draft', scope = 'reply' where conversation_id = $1 and body = 'Message 300'", [convId]);
    const raw = await getConversationDetail(owner, convId);
    const detail: InboxDetail = { ...raw, messages: await withDeliveryDetail(owner.user.id, raw.messages) };
    expect(detail.messages.map((x) => x.body)).toEqual(["Message 300", ...bodies(200, 1)]);
    // Before any load the held draft leads the thread, as before.
    const before = threadBlocks(olderMessagesToShow([], detail), detail);
    expect([...before.olderBlock, ...before.newestPage].map((x) => x.body)).toEqual(["Message 300", ...bodies(200, 1)]);
    // The thread keeps the page it had and adds the older page, as loadOlder does.
    const older = await getOlderMessages(owner, convId, detail.olderMessages!.beforeId);
    expect(older.messages.map((x) => x.body)).toEqual(bodies(400, 201));
    const shown = olderMessagesToShow([...detail.messages, ...(await withDeliveryDetail(owner.user.id, older.messages))], detail);
    const { olderBlock, newestPage } = threadBlocks(shown, detail);
    const thread = [...olderBlock, ...newestPage];
    expect(thread.map((x) => x.body)).toEqual(bodies(400, 1));
    expect(thread.filter((x) => x.status === "draft").map((x) => x.body)).toEqual(["Message 300"]);
    // "Showing the newest N": before the load the held draft is older than the whole run and not counted; after it, it is one of 400.
    expect(before.shownCount).toBe(200);
    expect(threadBlocks(shown, detail).shownCount).toBe(400);

    // Rendered on open, the held draft sits in the block above the newest page, before "Message 200".
    const d = detail;
    const html = renderToStaticMarkup(React.createElement(InboxWorkspace, {
      list: [d.conversation], detail: d, escalations: [], me: { id: owner.user.id, isOwner: true },
      perms: { reply: true, assign: true, notes: true, resume: true, respond: true, editContacts: true }, team: [], templates: [], timeZone: "UTC",
      filters: { q: "", channel: "", owner: "", unread: false },
    }));
    const at = (body: string) => html.search(new RegExp(`>${body}<`));
    expect(at("Message 300")).toBeGreaterThan(html.indexOf('aria-live="off"'));
    expect(at("Message 300")).toBeLessThan(at("Message 200"));
    expect(at("Message 200")).toBeLessThan(at("Message 1"));
  });

  it("keeps keyboard focus on 'Load older messages' while it loads, and hands it to the start line when the last page replaces it", () => {
    const notice = (over: Partial<React.ComponentProps<typeof OlderMessagesNotice>>) =>
      renderToStaticMarkup(React.createElement(OlderMessagesNotice, { nextBefore: "m1", shownCount: 200, loading: false, onLoad: () => undefined, ...over }));
    const idle = notice({});
    expect(idle).toContain("Showing the newest 200 messages.");
    expect(idle).toContain("Load older messages");
    expect(idle).not.toMatch(/disabled=""/);
    expect(idle).not.toContain('aria-disabled="');
    // Loading: still focusable (no native disabled, which drops focus to the page), but marked busy and unavailable.
    const loading = notice({ loading: true });
    expect(loading).not.toMatch(/\sdisabled=""/);
    expect(loading).toContain('aria-disabled="true"');
    expect(loading).toContain('aria-busy="true"');
    // At the start: a line that can take focus from script, without joining the tab order.
    const start = notice({ nextBefore: null });
    expect(start).toMatch(/<p[^>]*tabindex="-1"[^>]*>This is the start of the conversation\.<\/p>/);
    expect(start).not.toContain("Load older messages");

    const el = () => ({ focus: vi.fn() });
    const button = el();
    const line = el();
    restoreOlderFocus(true, button, line);
    expect(button.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(line.focus).not.toHaveBeenCalled();
    // The last page unmounted the button: focus goes to the start line.
    restoreOlderFocus(true, null, line);
    expect(line.focus).toHaveBeenCalledWith({ preventScroll: true });
    // Focus somewhere else when the load began is left alone.
    const untouched = el();
    restoreOlderFocus(false, untouched, null);
    expect(untouched.focus).not.toHaveBeenCalled();
    expect(() => restoreOlderFocus(true, null, null)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// E1 review fixes: handled older drafts keep their place, auto-scroll on long threads, and every older load is announced
// ---------------------------------------------------------------------------

/** An AI draft waiting for approval, `minutesAgo` minutes old (between longThread's messages when fractional). */
async function aiDraft(c: CrmOrg, convId: string, minutesAgo: number) {
  const rows = await q<{ id: string }>(
    "insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, scope, created_at) values ($1, $2, 'outbound', 'ai', $3, 'draft', 'reply', now() - ($4::text || ' seconds')::interval) returning id",
    [c.org.id, convId, `AI draft ${minutesAgo}`, String(Math.round(minutesAgo * 60))],
  );
  return rows[0].id;
}
const asInbox = async (userId: string, d: ConversationDetail): Promise<InboxDetail> => ({ ...d, messages: await withDeliveryDetail(userId, d.messages) });
/** Every message of the conversation in thread order (by time, then id), optionally from one message on. */
const threadIds = async (convId: string, fromId?: string) =>
  (await q<{ id: string }>(
    `select m.id from conversation_messages m where m.conversation_id = $1
       and ($2::uuid is null or (m.created_at, m.id) >= (select b.created_at, b.id from conversation_messages b where b.id = $2))
     order by m.created_at, m.id`,
    [convId, fromId ?? null],
  )).map((r) => r.id);

describe("E1 review: an older draft handled after 'Load older messages' keeps its place in the thread", () => {
  it("approved after the start was reached: re-read by id, it shows again with its real status, and nothing is asked twice", async () => {
    const c = await crmOrg();
    const owner = ctxFor(c.people.owner, c.org, "owner");
    const convId = await longThread(c, CONVERSATION_MESSAGE_PAGE + 20);
    const draftId = await aiDraft(c, convId, 210.5);
    const before = await asInbox(owner.user.id, await getConversationDetail(owner, convId));
    expect(before.messages.find((m) => m.id === draftId)?.status).toBe("draft");
    // "Load older messages" until the start line shows, as loadOlder does (the page as it is now, plus the older page).
    const older = await getOlderMessages(owner, convId, before.olderMessages!.beforeId);
    expect(older.olderMessages).toBeUndefined();
    const loaded: InboxMessage[] = [...before.messages, ...(await withDeliveryDetail(owner.user.id, older.messages))];

    // Approved (as queueApprovedDraft records it: the same row, created_at unchanged), then the page refreshes.
    await q("update conversation_messages set status = 'queued', queued_at = now() where id = $1", [draftId]);
    const after = await asInbox(owner.user.id, await getConversationDetail(owner, convId));
    expect(after.messages.some((m) => m.id === draftId)).toBe(false);
    // The loaded copies still say "draft": stale, so re-read, and not shown as still waiting meanwhile.
    expect(staleLoadedDrafts(loaded, after)).toEqual([draftId]);
    expect(olderMessagesToShow(loaded, after).some((m) => m.id === draftId)).toBe(false);

    h.orgCtx = owner;
    const r = await loadMessagesByIdAction(convId, staleLoadedDrafts(loaded, after));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.messages.map((m) => [m.id, m.status])).toEqual([[draftId, "queued"]]);
    expect(r.data.messages[0].deliveryEvents).toEqual([]);
    const reread = [...loaded, ...r.data.messages];
    // Nothing is stale any more, so the thread doesn't ask again.
    expect(staleLoadedDrafts(reread, after)).toEqual([]);
    const shown = olderMessagesToShow(reread, after);
    const { olderBlock, newestPage, shownCount } = threadBlocks(shown, after, null);
    const thread = [...olderBlock, ...newestPage];
    // The whole conversation, in order, with the approved message in its place and its real status.
    expect(thread.map((m) => m.id)).toEqual(await threadIds(convId));
    expect(thread).toHaveLength(CONVERSATION_MESSAGE_PAGE + 21);
    expect(thread.find((m) => m.id === draftId)?.status).toBe("queued");
    expect(shownCount).toBe(CONVERSATION_MESSAGE_PAGE + 21);
  });

  it("discarded elsewhere: it stays as discarded; a draft whose row is gone is still dropped and isn't asked for again", async () => {
    const c = await crmOrg();
    const owner = ctxFor(c.people.owner, c.org, "owner");
    const convId = await longThread(c, 450);
    const discarded = await aiDraft(c, convId, 300.5);
    const gone = await aiDraft(c, convId, 350.5);
    const before = await asInbox(owner.user.id, await getConversationDetail(owner, convId));
    expect(before.messages.slice(0, 2).map((m) => m.id)).toEqual([gone, discarded]);
    const older = await getOlderMessages(owner, convId, before.olderMessages!.beforeId);
    expect(older.olderMessages).toBeDefined();
    const loaded: InboxMessage[] = [...before.messages, ...(await withDeliveryDetail(owner.user.id, older.messages))];

    // A teammate discards one (the real action); the other's row is removed.
    h.orgCtx = owner;
    expect(await discardDraftAction(discarded)).toEqual({ ok: true });
    await q("delete from conversation_messages where id = $1", [gone]);
    const after = await asInbox(owner.user.id, await getConversationDetail(owner, convId));
    expect(staleLoadedDrafts(loaded, after)).toEqual([discarded, gone]);
    const r = await loadMessagesByIdAction(convId, staleLoadedDrafts(loaded, after));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.messages.map((m) => [m.id, m.status, m.blockedReason])).toEqual([[discarded, "blocked", "discarded"]]);
    const reread = [...loaded, ...r.data.messages];
    // The gone row stays stale (same list, so the thread's re-read isn't repeated) and is never shown.
    expect(staleLoadedDrafts(reread, after)).toEqual([gone]);
    const shown = olderMessagesToShow(reread, after);
    expect(shown.find((m) => m.id === discarded)).toMatchObject({ status: "blocked", blockedReason: "discarded" });
    expect(shown.some((m) => m.id === gone)).toBe(false);
    // From the oldest loaded page's first message on, the thread is the conversation as it is now, with no gap.
    const runStart = shown.find((m) => m.id === older.olderMessages!.beforeId)!;
    const { olderBlock, newestPage, shownCount } = threadBlocks(shown, after, runStart);
    const expected = await threadIds(convId, runStart.id);
    expect([...olderBlock, ...newestPage].map((m) => m.id)).toEqual(expected);
    expect(shownCount).toBe(expected.length);
  });

  it("re-reads by id under the conversation's visibility, and refuses bad input", async () => {
    const c = await crmOrg();
    const other = await crmOrg();
    const owner = ctxFor(c.people.owner, c.org, "owner");
    const convId = await longThread(c, 3);
    const ids = await threadIds(convId);
    expect((await getMessagesByIds(owner, convId, [ids[2], ids[0], ids[2]])).map((m) => m.id)).toEqual([ids[0], ids[2]]);
    expect(await getMessagesByIds(owner, convId, [])).toEqual([]);
    // Another conversation's message isn't returned through this one.
    const otherConv = await longThread(c, 2);
    expect(await getMessagesByIds(owner, convId, await threadIds(otherConv))).toEqual([]);
    // Another workspace, an unassigned sales rep (then assigned), no inbox access.
    await expect(getMessagesByIds(ctxFor(other.people.owner, other.org, "owner"), convId, ids)).rejects.toMatchObject({ code: "not_found" });
    const rep = ctxFor(c.people.sales, c.org, "sales_rep");
    await expect(getMessagesByIds(rep, convId, ids)).rejects.toMatchObject({ code: "not_found" });
    await q("update conversations set assigned_user_id = $2 where id = $1", [convId, c.people.sales.id]);
    expect(await getMessagesByIds(rep, convId, ids)).toHaveLength(3);
    await expect(getMessagesByIds({ ...owner, can: () => false } as typeof owner, convId, ids)).rejects.toMatchObject({ code: "forbidden" });
    // Not an id, or more than the cap.
    await expect(getMessagesByIds(owner, convId, ["nope"])).rejects.toMatchObject({ code: "invalid_input" });
    const many = Array.from({ length: MESSAGES_BY_ID_LIMIT + 1 }, () => crypto.randomUUID());
    await expect(getMessagesByIds(owner, convId, many)).rejects.toMatchObject({ code: "invalid_input" });
    expect(STALE_DRAFT_REREAD_LIMIT).toBe(MESSAGES_BY_ID_LIMIT);
    // The action: the same checks, behind inbox access.
    h.orgCtx = owner;
    expect(await loadMessagesByIdAction(convId, ["nope"])).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await loadMessagesByIdAction(convId, "nope" as unknown as string[])).toMatchObject({ ok: false, code: "invalid_input" });
    h.orgCtx = { ...owner, can: () => false } as typeof owner;
    expect(await loadMessagesByIdAction(convId, ids)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("approving or discarding here keeps an older draft in place at once, counted only inside the run; a page draft is left to the refresh", () => {
    const m = (id: string, day: string, over: Partial<InboxMessage> = {}): InboxMessage => ({
      id, direction: "inbound", authorKind: "contact", authorName: null, body: id, status: "received", statusDetail: null, blockedReason: null, scope: null,
      createdAt: `2026-10-0${day}T00:00:00.000Z`, sentAt: null, deliveredAt: null, provider: null, providerLabel: null, deliveryEvents: [], ...over,
    });
    const held = m("held", "1", { status: "draft", direction: "outbound", authorKind: "ai", blockedReason: "needs_approval" });
    const p1 = m("p1", "5");
    const pageDraft = m("p2", "6", { status: "draft", direction: "outbound", authorKind: "ai" });
    const detail = { messages: [held, p1, pageDraft], olderMessages: { beforeId: "p1" } };
    expect(isOlderThanPage(held, detail)).toBe(true);
    expect(isOlderThanPage(pageDraft, detail)).toBe(false);
    expect(isOlderThanPage(held, { messages: [held, p1] })).toBe(false);

    // Approved before any older page was loaded: added as a loaded copy with the status sending reached.
    const approved = settleLoadedDraft([], held, "sent", detail);
    expect(approved).toEqual([{ ...held, status: "sent", blockedReason: null, statusDetail: null }]);
    const afterRefresh = { messages: [p1, m("p2", "6", { status: "queued", direction: "outbound", authorKind: "ai" })], olderMessages: { beforeId: "p1" } };
    const shown = olderMessagesToShow(approved, afterRefresh);
    expect(shown.map((x) => [x.id, x.status])).toEqual([["held", "sent"]]);
    // It sits in its place, but "Showing the newest N" counts only the unbroken run from the page's first message.
    const blocks = threadBlocks(shown, afterRefresh, p1);
    expect([...blocks.olderBlock, ...blocks.newestPage].map((x) => x.id)).toEqual(["held", "p1", "p2"]);
    expect(blocks.shownCount).toBe(2);

    // Discarded with loaded copies: every copy takes the discard, as discardDraft records it.
    const loaded = [held, m("o1", "2"), held];
    const discarded = settleLoadedDraft(loaded, held, "discarded", detail);
    expect(discarded.filter((x) => x.id === "held")).toEqual([
      { ...held, status: "blocked", blockedReason: "discarded", statusDetail: "Discarded by a teammate." },
      { ...held, status: "blocked", blockedReason: "discarded", statusDetail: "Discarded by a teammate." },
    ]);
    expect(staleLoadedDrafts(discarded, afterRefresh)).toEqual([]);
    // Sending not attempted yet reads as queued; a draft in the newest page is left alone (the refresh shows it).
    expect(settleLoadedDraft([], held, "skipped", detail)[0].status).toBe("queued");
    expect(settleLoadedDraft(loaded, pageDraft, "sent", detail)).toBe(loaded);

    // The toast says what sending reached.
    expect(approvedDraftToast("queued")).toEqual({ tone: "success", text: "Approved and queued." });
    expect(approvedDraftToast("skipped").text).toBe("Approved and queued.");
    expect(approvedDraftToast("sent")).toMatchObject({ tone: "success", text: expect.stringContaining("sent to the provider") });
    expect(approvedDraftToast("failed")).toMatchObject({ tone: "error", text: expect.stringContaining("sending failed") });
    expect(approvedDraftToast("blocked")).toMatchObject({ tone: "warning", text: expect.stringContaining("couldn't be sent yet") });
  });

  it("the thread wires the re-read, the in-place feedback and the status toast", () => {
    const src = readFileSync("src/components/inbox/inbox-workspace.tsx", "utf8");
    expect(src).toMatch(/staleLoadedDrafts\(loadedOlder, detail\)\.slice\(0, STALE_DRAFT_REREAD_LIMIT\)/);
    expect(src).toMatch(/loadMessagesByIdAction\(c\.id, staleKey\.split\(","\)\)/);
    expect(src).toMatch(/approvedDraftToast\(r\.data\.status\)/);
    expect(src).toMatch(/settleDraft\(m, r\.data\.status\)/);
    expect(src).toMatch(/settleDraft\(m, "discarded"\)/);
    expect(src).not.toContain('"Approved and queued.")}');
  });
});

describe("E1 review: auto-scroll on a thread longer than one page", () => {
  it("follows the newest message, which changes when one arrives even though the page stays 200 long", async () => {
    const c = await crmOrg();
    const owner = ctxFor(c.people.owner, c.org, "owner");
    const convId = await longThread(c, CONVERSATION_MESSAGE_PAGE + 10);
    await aiDraft(c, convId, 205.5);
    const before = await getConversationDetail(owner, convId);
    // A held draft leads the page, but the newest message is the page's last.
    expect(before.messages[0].status).toBe("draft");
    expect(newestMessageId(before)).toBe(before.messages.at(-1)!.id);
    expect(before.messages.at(-1)!.body).toBe("Message 1");
    await q("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, created_at) values ($1, $2, 'inbound', 'contact', 'Brand new', 'received', now())", [c.org.id, convId]);
    const after = await getConversationDetail(owner, convId);
    expect(after.messages).toHaveLength(before.messages.length);
    expect(newestMessageId(after)).not.toBe(newestMessageId(before));
    expect(after.messages.at(-1)!.body).toBe("Brand new");
    // Loading older messages doesn't change the page, so it doesn't scroll.
    await getOlderMessages(owner, convId, after.olderMessages!.beforeId);
    expect(newestMessageId(await getConversationDetail(owner, convId))).toBe(newestMessageId(after));
    expect(newestMessageId({ messages: [] })).toBeNull();
  });

  it("follows only while the log shows its end, and the effect is keyed on the newest message", () => {
    expect(isScrolledToEnd({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(isScrolledToEnd({ scrollHeight: 1000, scrollTop: 540, clientHeight: 400 })).toBe(true);
    expect(isScrolledToEnd({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 })).toBe(false);
    expect(isScrolledToEnd({ scrollHeight: 300, scrollTop: 0, clientHeight: 300 })).toBe(true);
    const src = readFileSync("src/components/inbox/inbox-workspace.tsx", "utf8");
    expect(src).toMatch(/if \(followRef\.current\) endRef\.current\?\.scrollIntoView\(\{ block: "end" \}\);\s*\}, \[newestId\]\);/);
    expect(src).not.toContain("[detail.messages.length]");
    expect(src).toMatch(/onScroll=\{\(e\) => \{ followRef\.current = isScrolledToEnd\(e\.currentTarget\); \}\}/);
    // The person's own reply or note is followed even after they scrolled up.
    expect(src.match(/if \(r\.ok\) followRef\.current = true;/g)).toHaveLength(2);
  });
});

describe("E1 review: every 'Load older messages' is announced", () => {
  it("consecutive loads of full pages read differently, and the status line is emptied before each request", async () => {
    const c = await crmOrg();
    const owner = ctxFor(c.people.owner, c.org, "owner");
    const convId = await longThread(c, 650);
    let before = (await getConversationDetail(owner, convId)).olderMessages?.beforeId;
    const counts: number[] = [];
    while (before) {
      const page = await getOlderMessages(owner, convId, before);
      counts.push(page.messages.length);
      before = page.olderMessages?.beforeId;
    }
    expect(counts).toEqual([200, 200, 50]);
    let total = 0;
    const notes = counts.map((n) => olderLoadedNote(n, (total += n)));
    expect(notes).toEqual(["Loaded 200 older messages.", "Loaded 200 more, 400 older messages so far.", "Loaded 50 more, 450 older messages so far."]);
    for (let i = 1; i < notes.length; i++) expect(notes[i]).not.toBe(notes[i - 1]);
    expect(olderLoadedNote(1, 1)).toBe("Loaded 1 older message.");
    expect(olderLoadedNote(0, 400)).toBe("There are no older messages.");
    // In loadOlder the line is emptied before the request, then set from the running total.
    const src = readFileSync("src/components/inbox/inbox-workspace.tsx", "utf8");
    const body = src.slice(src.indexOf("async function loadOlder()"), src.indexOf("const otherOwner ="));
    expect(body.indexOf('setOlderNote("")')).toBeGreaterThan(-1);
    expect(body.indexOf('setOlderNote("")')).toBeLessThan(body.indexOf("await loadOlderMessagesAction"));
    expect(body).toContain("setOlderNote(olderLoadedNote(r.data.messages.length, olderTotal.current))");
  });
});

describe("E2: delivery events for a page of messages", () => {
  it("keeps the newest 1,000 events when there are more, and lists each message's oldest first", async () => {
    const c = await crmOrg();
    const owner = ctxFor(c.people.owner, c.org, "owner");
    const convId = await longThread(c, 2);
    const detail = await getConversationDetail(owner, convId);
    const [older, newer] = detail.messages;
    // 5 events on the older message, then 1,000 later ones on the newer message.
    await q(
      `insert into message_delivery_events (org_id, message_id, provider, provider_event_id, status, occurred_at)
       select $1::uuid, $2::uuid, 'twilio', 'old-' || $4::text || '-' || g, 'sent', now() - interval '2 days' + g * interval '1 second' from generate_series(1, 5) g
       union all
       select $1::uuid, $3::uuid, 'twilio', 'new-' || $4::text || '-' || g, case when g = 1000 then 'delivered' else 'sent' end, now() - interval '1 day' + g * interval '1 second' from generate_series(1, 1000) g`,
      [c.org.id, older.id, newer.id, uid()],
    );
    const out = await withDeliveryDetail(owner.user.id, detail.messages);
    const byId = Object.fromEntries(out.map((x) => [x.id, x]));
    expect(byId[newer.id].deliveryEvents).toHaveLength(1000);
    expect(byId[older.id].deliveryEvents).toHaveLength(0);
    const at = byId[newer.id].deliveryEvents.map((e) => e.at);
    expect(at).toEqual([...at].sort());
    expect(byId[newer.id].deliveryEvents.at(-1)!.status).toBe("delivered");
    expect(byId[newer.id].provider).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// E3: defence: a whole-filter value cap, and a statement timeout for member reads
// ---------------------------------------------------------------------------

describe("E3: filter value cap", () => {
  const tags = (n: number) => Array.from({ length: n }, () => crypto.randomUUID());
  const filter = (lists: number[]) => ({ op: "and", conditions: lists.map((n) => ({ field: "tags", op: "has_any", value: tags(n) })) });

  it("accepts up to 1,000 list values across the whole filter and refuses more with a clear message", () => {
    expect(MAX_FILTER_LIST_VALUES).toBe(1000);
    expect(() => parseFilter(filter([200, 200, 200, 200, 200]))).not.toThrow();
    expect(() => parseFilter(filter([200, 200, 200, 200, 200, 1]))).toThrow("A filter can list at most 1,000 values in total across its conditions.");
    // Nested groups and lists inside a value count too.
    const nested = { op: "or", conditions: [{ op: "and", conditions: [{ field: "opportunity", op: "in_stage", value: { stageIds: tags(600) } }] }, { field: "tags", op: "has_all", value: tags(401) }] };
    expect(countListValues(nested as never)).toBe(1001);
    expect(() => parseFilter(nested)).toThrow(/at most 1,000 values/);
  });

  it("refuses an over-cap filter at the directory before any SQL runs", async () => {
    const c = await crmOrg();
    const { listContacts } = await import("@/server/crm/directory");
    await expect(listContacts(c.actor("owner"), { filter: filter([200, 200, 200, 200, 200, 200]) })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/at most 1,000 values/) });
  });
});

describe("E3: statement timeout for a member's CRM reads", () => {
  const show = (db: Parameters<Parameters<typeof withSystem>[0]>[0]) => db.query<{ statement_timeout: string }>("show statement_timeout").then((r) => r.rows[0].statement_timeout);

  it("bounds each statement of a member's read for that transaction only, and leaves trusted reads and later transactions alone", async () => {
    const c = await crmOrg();
    expect(MEMBER_READ_STATEMENT_TIMEOUT).toBe("30s");
    expect(await crmRead(c.actor("viewer"), show)).toBe("30s");
    expect(await crmRead(c.system, show)).toBe("0");
    expect(await withSystem(show)).toBe("0");
    expect(await withUser(c.people.viewer.id, show)).toBe("0");
  });

  it("turns a statement the database cancelled into a message the person can act on", async () => {
    const c = await crmOrg();
    const cancelled = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    const err = await crmRead(c.actor("owner"), async () => {
      throw cancelled;
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toMatch(/took too long to load/);
    expect(JSON.stringify(err)).not.toContain("canceling statement");
    // Any other error is passed through untouched.
    const other = new Error("something else");
    await expect(crmRead(c.actor("owner"), async () => {
      throw other;
    })).rejects.toBe(other);
  });

  it("recognises the cancel the way the hosted Postgres driver throws it: wrapped in an OperationFailure", async () => {
    const c = await crmOrg();
    // createPostgresDriver rethrows every failed query as OperationFailure("database.postgres_query", driverError): no code of its own.
    const wrapped = new OperationFailure("database.postgres_query", Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }));
    expect((wrapped as unknown as { code?: unknown }).code).toBeUndefined();
    const err = await crmRead(c.actor("viewer"), async () => {
      throw wrapped;
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toBe("This took too long to load, so it was stopped. Narrow the search or filter and try again.");
    expect(JSON.stringify(err)).not.toContain("canceling statement");
    // A wrapped error with any other code (a unique violation here) is still passed through as it is.
    const unique = new OperationFailure("database.postgres_query", Object.assign(new Error("duplicate key"), { code: "23505" }));
    await expect(crmRead(c.actor("viewer"), async () => {
      throw unique;
    })).rejects.toBe(unique);
  });

  it("hasDbErrorCode walks the cause chain, checks the code asked for at each level, and stops on cycles and long chains", () => {
    const pg = Object.assign(new Error("pg"), { code: "57014" });
    expect(hasDbErrorCode(pg, "57014")).toBe(true);
    expect(hasDbErrorCode(new OperationFailure("database.postgres_query", pg), "57014")).toBe(true);
    expect(hasDbErrorCode(new OperationFailure("outer", new OperationFailure("database.postgres_query", pg)), "57014")).toBe(true);
    // An unrelated code on an outer wrapper doesn't hide the one asked for.
    expect(hasDbErrorCode(Object.assign(new Error("outer"), { code: "ERR_WRAPPED", cause: pg }), "57014")).toBe(true);
    expect(hasDbErrorCode(new OperationFailure("database.postgres_query", pg), "23505")).toBe(false);
    for (const nothing of [undefined, null, "57014", 57014, {}]) expect(hasDbErrorCode(nothing, "57014")).toBe(false);
    // A cycle ends the walk; so does a chain deeper than 8.
    const a: { code?: string; cause?: unknown } = {};
    a.cause = { cause: a };
    expect(hasDbErrorCode(a, "57014")).toBe(false);
    let deep: unknown = pg;
    for (let i = 0; i < 8; i++) deep = { cause: deep };
    expect(hasDbErrorCode(deep, "57014")).toBe(false);
  });
});
