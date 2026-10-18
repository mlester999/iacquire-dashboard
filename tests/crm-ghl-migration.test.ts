// GoHighLevel live-record migration (Phase 6, package A). Synthetic database fixtures and an intercepted fetch only: nothing here
// contacts GoHighLevel, and every request the code makes is checked to be a GET to the official host.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { saveIntegrationConnection } from "@/server/integrations/manager";
import { ghlMigrationGet, parseRetryAfter, takeGhlBurstSlot } from "@/server/integrations/ghl";
import { advanceImport, getImportJob, ImportLeaseLost, listImportJobs, startImport } from "@/server/crm/imports";
import {
  GHL_MIGRATION_ENTITIES, GHL_TRANSIENT_MAX_ERRORS, REQUESTS_PER_ADVANCE, advanceGhlMigration, cancelGhlStep, checkGhlImportAgain, createGhlImportJob, createGhlMigrationRun, fetchGhlChunk,
  getGhlMigrationState, ghlMigrationComparison, planGhlMigration, rollbackGhlImport, startGhlImport, transientDelayMs, type GhlMigrationEntity,
} from "@/server/crm/ghl-migration";
import { updateContact } from "@/server/crm/contacts";
import { createOpportunity } from "@/server/crm/opportunities";
import { addNote } from "@/server/crm/notes";
import { agencyActor, startSupportSession, type CrmActor } from "@/server/crm/actor";
import { agencyPeople, crmOrg, type CrmOrg } from "./support/crm";

type Rec = Record<string, unknown>;
const ORIGIN = "https://services.leadconnectorhq.com";

interface Synth {
  loc: string;
  contacts: Rec[];
  opportunities: Rec[];
  businesses: Rec[];
  customFields: Rec[];
  tags: Rec[];
  pipelines: Rec[];
  users: Rec[];
  details?: Record<string, Rec>;
  /** Return a response to answer this request differently (a 429, say), or throw to make the request fail (a timeout). May be async. */
  intercept?: (url: URL, n: number) => Response | null | Promise<Response | null>;
}

/** GoHighLevel's documented paging: startAfterId/startAfter plus meta (total, nextPageUrl). */
function cursorPage(rows: Rec[], url: URL, key: string) {
  const limit = Number(url.searchParams.get("limit") ?? 20);
  const after = url.searchParams.get("startAfterId");
  const start = after ? rows.findIndex((r) => r.id === after) + 1 : 0;
  const page = rows.slice(start, start + limit);
  const more = start + limit < rows.length;
  const last = page[page.length - 1];
  return { [key]: page, meta: { total: rows.length, startAfterId: more ? last.id : undefined, startAfter: more ? Date.parse(String(last.dateAdded ?? last.createdAt)) : undefined, nextPageUrl: more ? `${ORIGIN}/next` : null } };
}

function ghlServer(s: Synth) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    const special = await s.intercept?.(url, calls.length);
    if (special) return special;
    const p = url.pathname;
    if (p === `/locations/${s.loc}`) return Response.json({ location: { id: s.loc, name: "Synthetic Location", companyId: "companySynth01" } });
    if (p === "/users/search") return Response.json({ users: s.users, count: s.users.length });
    if (p === `/locations/${s.loc}/customFields`) return Response.json({ customFields: s.customFields });
    if (p === `/locations/${s.loc}/tags`) return Response.json({ tags: s.tags });
    if (p === "/opportunities/pipelines") return Response.json({ pipelines: s.pipelines });
    if (p === "/businesses/") {
      const skip = Number(url.searchParams.get("skip") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return Response.json({ businesses: s.businesses.slice(skip, skip + limit) });
    }
    if (p === "/contacts/") return Response.json(cursorPage(s.contacts, url, "contacts"));
    if (p.startsWith("/contacts/")) {
      const d = s.details?.[decodeURIComponent(p.slice("/contacts/".length))];
      return d ? Response.json({ contact: d }) : new Response("{}", { status: 404 });
    }
    if (p === "/opportunities/search") return Response.json(cursorPage(s.opportunities, url, "opportunities"));
    if (p === "/calendars/") return Response.json({ calendars: [{ id: "calSynth0001", locationId: s.loc }] });
    return new Response("{}", { status: 404 });
  });
  return { spy, calls };
}

/** Every request was a GET, to GoHighLevel's official host, with a Version header. */
function expectReadOnly(calls: Array<{ url: URL; init: RequestInit }>) {
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) {
    expect(c.init.method ?? "GET").toBe("GET");
    expect(c.url.origin).toBe(ORIGIN);
    expect((c.init.headers as Record<string, string>).Version).toMatch(/^2021-0[47]-(15|28)$/);
  }
}

const day = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();

/** A small but complete location: every documented kind, with the awkward cases a real account has. */
function sampleLocation(loc: string, ownerEmail: string): Synth {
  return {
    loc,
    users: [{ id: "userOwner01", email: ownerEmail }, { id: "userGhost01", email: "ghost.user@example.test" }],
    customFields: [
      { id: "cfMember01", name: "Membership", fieldKey: "contact.membership", dataType: "SINGLE_OPTIONS", picklistOptions: ["Gold", "Silver"], model: "contact", locationId: loc },
      { id: "cfBudget01", name: "Budget", fieldKey: "opportunity.budget", dataType: "MONETORY", model: "opportunity", locationId: loc },
      { id: "cfFile0001", name: "Contract", fieldKey: "contact.contract", dataType: "FILE_UPLOAD", model: "contact", locationId: loc },
    ],
    tags: [{ id: "tagVip0001", name: "VIP", locationId: loc }, { id: "tagLead001", name: "Lead", locationId: loc }],
    pipelines: [{ id: "pipeSales1", name: "Sales", locationId: loc, stages: [{ id: "stNew0001", name: "New", position: 0 }, { id: "stClose001", name: "Closing", position: 1 }] }],
    businesses: [{ id: "bizAcme001", name: "Acme Inc", website: "acme.example", locationId: loc }],
    contacts: [
      { id: "ghlCt0", firstName: "Ana", lastName: "Reyes", email: "ana@example.test", phone: "+639170000101", tags: ["VIP"], customFields: [{ id: "cfMember01", value: "Gold" }], businessId: "bizAcme001", assignedTo: "userOwner01", country: "PH", dateAdded: day(0), locationId: loc },
      { id: "ghlCt1", firstName: "Ben", lastName: "Cruz", email: "ben@example.test", phone: "+639170000102", dnd: true, assignedTo: "userGhost01", tags: ["Lead"], companyName: "Bayside Co", dateAdded: day(1), locationId: loc },
      // The documented list schema has no name or phone: this one is read again with GET /contacts/{id}.
      { id: "ghlCt2", tags: ["VIP"], dateAdded: day(2), locationId: loc },
      { id: "ghlCt3", firstName: "Dan", lastName: "Lim", email: "dan@example.test", country: "Atlantis", customFields: [{ id: "cfMember01", value: "Platinum" }], dateAdded: day(3), locationId: loc },
      { id: "ghlCt4", firstName: "Dan", lastName: "Twin", email: "dan@example.test", dateAdded: day(4), locationId: loc },
    ],
    details: { ghlCt2: { id: "ghlCt2", firstName: "Cara", lastName: "Diaz", email: "cara@example.test", tags: ["VIP"], locationId: loc } },
    opportunities: [
      { id: "ghlOpp1", name: "Website build", pipelineId: "pipeSales1", pipelineStageId: "stNew0001", status: "open", monetaryValue: 500, contactId: "ghlCt0", assignedTo: "userOwner01", customFields: [{ id: "cfBudget01", fieldValue: 1200 }], createdAt: day(10), locationId: loc },
      { id: "ghlOpp2", name: "Retainer", pipelineId: "pipeSales1", pipelineStageId: "stClose001", status: "won", monetaryValue: 900, contactId: "ghlCt1", lastStatusChangeAt: "2026-09-01T10:00:00.000Z", lastStageChangeAt: "2026-08-15T09:00:00.000Z", createdAt: day(11), locationId: loc },
      { id: "ghlOpp3", name: "Old lead", pipelineId: "pipeSales1", pipelineStageId: "stNew0001", status: "abandoned", contactId: "ghlCt2", createdAt: day(12), locationId: loc },
      { id: "ghlOpp4", name: "Twin deal", pipelineId: "pipeSales1", pipelineStageId: "stNew0001", status: "open", contactId: "ghlCt4", createdAt: day(13), locationId: loc },
    ],
  };
}

let admin: Awaited<ReturnType<typeof agencyPeople>>["superAdmin"];
beforeAll(async () => {
  admin = (await agencyPeople()).superAdmin;
});
afterEach(() => vi.restoreAllMocks());

async function connected(name: string, loc: string, mode: "native" | "ghl" = "native"): Promise<CrmOrg> {
  const c = await crmOrg({ name });
  await saveIntegrationConnection(admin, c.org.id, { provider: "ghl", label: "Synthetic GHL", environment: "development", secret: "synthetic-key-" + "k".repeat(30), config: { locationId: loc, scopes: ["locations.readonly", "opportunities.readonly"] } });
  if (mode === "ghl") await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [c.org.id]));
  return c;
}

async function drain(jobId: string, max = 100): Promise<string> {
  for (let i = 0; i < max; i++) {
    const r = await advanceImport(jobId);
    if (r.done) {
      // A step that stopped says why, so a failing test shows the reason instead of just "failed".
      if (r.status === "failed") return `failed: ${(await one<{ error: string }>("select error from crm_import_jobs where id = $1", [jobId]))[0]?.error}`;
      return r.status;
    }
  }
  throw new Error("job did not finish");
}

async function latest(c: CrmOrg, entity: GhlMigrationEntity) {
  const s = await getGhlMigrationState(c.actor("owner"));
  return s.jobs[entity]!;
}

/** The owner imports one step: the dry run is repeated first when earlier steps were imported after it. */
async function importStep(actor: CrmActor, c: CrmOrg, entity: GhlMigrationEntity) {
  const job = await latest(c, entity);
  let r = await startGhlImport(actor, job.id);
  if (r.recheck) {
    expect(await drain(job.id)).toBe("validated");
    r = await startGhlImport(actor, job.id);
  }
  expect(r).toEqual({ started: true, recheck: false });
  return drain(job.id);
}

async function dryRunAll(c: CrmOrg) {
  const jobs = await createGhlMigrationRun(c.actor("owner"));
  for (const j of jobs) expect(await drain(j.id)).toBe("validated");
  return jobs;
}

async function importAll(c: CrmOrg, actor = c.actor("owner")) {
  for (const e of GHL_MIGRATION_ENTITIES) expect(await importStep(actor, c, e)).toBe("completed");
}

const one = async <T extends Rec>(sql: string, params: unknown[]) => (await withSystem((db) => db.query<T>(sql, params))).rows;

/** Reads one step again ("Run this step again") and waits for its dry run. */
async function reread(c: CrmOrg, entity: GhlMigrationEntity, actor = c.actor("owner")) {
  const job = await createGhlImportJob(actor, { entity });
  expect(await drain(job.id)).toBe("validated");
  return job.id;
}

/** Reads, dry-runs and imports one step as the owner. Returns the job id. */
async function runStep(c: CrmOrg, entity: GhlMigrationEntity) {
  const id = await reread(c, entity);
  expect(await importStep(c.actor("owner"), c, entity)).toBe("completed");
  return id;
}

async function undoRun(c: CrmOrg, jobId: string) {
  await rollbackGhlImport(c.actor("owner"), jobId);
  expect(await drain(jobId)).toBe("rolled_back");
}

/** The documented GET /contacts/ page without meta (and, when given, the documented top-level count). */
function bareContactsPage(rows: Rec[], url: URL, count?: number) {
  const { contacts } = cursorPage(rows, url, "contacts");
  return Response.json(count === undefined ? { contacts } : { contacts, count });
}

const jobRow = async (id: string) => (await one<{ status: string; total_rows: number; fetch_cursor: Rec | null; fetch_state: Rec; fetch_not_before: Date | null; claimed_at: Date | null; error: string | null }>(
  "select status, total_rows, fetch_cursor, fetch_state, fetch_not_before, claimed_at, error from crm_import_jobs where id = $1", [id]))[0];
const readyNow = (id: string) => withSystem((db) => db.query("update crm_import_jobs set fetch_not_before = now() - interval '1 second' where id = $1", [id]));

describe("GoHighLevel read primitives", () => {
  it("keeps to a burst budget under GoHighLevel's 100 requests per 10 seconds, and reads Retry-After in both forms", () => {
    const t = 1_900_000_000_000;
    for (let i = 0; i < 90; i++) expect(takeGhlBurstSlot("burstUnitLoc01", t + i)).toBe(0);
    expect(takeGhlBurstSlot("burstUnitLoc01", t + 100)).toBeGreaterThan(9000);
    expect(takeGhlBurstSlot("burstUnitLoc01", t + 10_001)).toBe(0);
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
    expect(parseRetryAfter("soon")).toBeNull();
  });

  it("refuses the protected locations before any request, in code and in the database", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    for (const locationId of ["u69CVh0ZlAofUmRoj1zF", "SQvVnld5MBHdMQ1qnSfw"]) {
      await expect(ghlMigrationGet({ orgId: "x", orgKind: "client", locationId, pipelineId: null, calendarIds: [], token: "synthetic-token-0123456789" }, "/contacts/", {})).rejects.toThrow(/protected/);
    }
    // iAcquire's agency location is never read for a migration, even from the agency organization.
    await expect(ghlMigrationGet({ orgId: "x", orgKind: "agency", locationId: "agencyOwnLoc0001", pipelineId: null, calendarIds: [], token: "synthetic-token-0123456789" }, "/contacts/", {})).rejects.toThrow(/protected/);
    expect(spy).not.toHaveBeenCalled();
    const c = await crmOrg();
    for (const loc of ["u69CVh0ZlAofUmRoj1zF", "SQvVnld5MBHdMQ1qnSfw"]) {
      await expect(withSystem((db) => db.query("insert into crm_import_jobs (org_id, entity, source, status, source_location) values ($1, 'contact', 'ghl_api', 'fetching', $2)", [c.org.id, loc]))).rejects.toThrow();
    }
    // A workspace without its own mapped location can't start a step at all (and nothing is fetched).
    await expect(createGhlImportJob(c.actor("owner"), { entity: "contact" })).rejects.toThrow(/No usable GoHighLevel connection/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("GoHighLevel migration preview", () => {
  it("counts what the location holds with GET requests only and stores nothing", async () => {
    const c = await connected("Preview Co", "synthMigLocA0001");
    const { calls } = ghlServer(sampleLocation("synthMigLocA0001", c.people.manager.email));
    const plan = await planGhlMigration(c.actor("sales"));
    expectReadOnly(calls);
    const by = Object.fromEntries(plan.entities.map((e) => [e.entity, e]));
    expect(plan.connected).toBe(true);
    expect(by.custom_field).toMatchObject({ status: "ok", count: 3, countKind: "exact", unsupported: [{ name: "Contract", type: "FILE_UPLOAD" }] });
    expect(by.tag).toMatchObject({ count: 2, countKind: "exact" });
    expect(by.pipeline).toMatchObject({ count: 1, detail: "2 stages in total." });
    expect(by.company).toMatchObject({ count: 1, countKind: "exact" });
    expect(by.contact).toMatchObject({ count: 5, countKind: "exact" });
    expect(by.opportunity).toMatchObject({ count: 4, countKind: "exact" });
    expect(plan.owners).toMatchObject({ status: "ok", ghlUsers: 2, matched: 1, unmatched: 1 });
    expect(plan.appointments.calendars).toBe(1);
    expect(plan.can).toEqual({ dryRun: false, import: false });
    // Calendars use their own documented Version header; everything else 2021-07-28.
    expect(calls.find((x) => x.url.pathname === "/calendars/")!.init.headers).toMatchObject({ Version: "2021-04-15" });
    expect(calls.filter((x) => x.url.pathname !== "/calendars/").every((x) => (x.init.headers as Record<string, string>).Version === "2021-07-28")).toBe(true);
    expect(await one("select 1 from crm_import_jobs where org_id = $1", [c.org.id])).toHaveLength(0);
    expect(await one("select 1 from contacts where org_id = $1", [c.org.id])).toHaveLength(0);
  });
});

describe("paging and rate limits", () => {
  it("reads every page, waits out a 429 with Retry-After, and resumes from its cursor without staging anything twice", async () => {
    const loc = "synthMigLocPage01";
    const c = await connected("Paging Co", loc);
    const s = sampleLocation(loc, c.people.manager.email);
    s.contacts = Array.from({ length: 250 }, (_, i) => ({ id: `pg${String(i).padStart(4, "0")}`, firstName: `Person${i}`, email: `p${i}@example.test`, phone: null, dateAdded: day(i), locationId: loc }));
    let limited = false;
    s.intercept = (url) => {
      if (url.pathname === "/contacts/" && url.searchParams.get("startAfterId") && !limited) {
        limited = true;
        return new Response("{}", { status: 429, headers: { "Retry-After": "30" } });
      }
      return null;
    };
    const { calls } = ghlServer(s);
    const job = await createGhlImportJob(c.actor("owner"), { entity: "contact" });
    await advanceImport(job.id);
    const state = (await one<{ status: string; total_rows: number; fetch_state: Rec; wait: number }>("select status, total_rows, fetch_state, extract(epoch from fetch_not_before - now())::int as wait from crm_import_jobs where id = $1", [job.id]))[0];
    expect(state).toMatchObject({ status: "fetching", total_rows: 100 });
    expect(state.fetch_state.rateLimited).toBe(1);
    expect(state.wait).toBeGreaterThan(20);
    // While it waits, nothing asks GoHighLevel again.
    const before = calls.length;
    expect(await advanceImport(job.id)).toEqual({ status: "fetching", done: false });
    expect(calls.length).toBe(before);
    // Time passes: it resumes from the stored cursor.
    await withSystem((db) => db.query("update crm_import_jobs set fetch_not_before = now() - interval '1 second' where id = $1", [job.id]));
    expect(await drain(job.id)).toBe("validated");
    const pages = calls.filter((x) => x.url.pathname === "/contacts/");
    expect(pages.map((x) => x.url.searchParams.get("startAfterId"))).toEqual([null, "pg0099", "pg0099", "pg0199"]);
    expect(pages[1].url.searchParams.get("startAfter")).toBe(String(Date.parse(day(99))));
    expectReadOnly(calls);
    const staged = (await one<{ n: number; d: number }>("select count(*)::int as n, count(distinct data->>'ghl_id')::int as d from crm_import_rows where job_id = $1", [job.id]))[0];
    expect(staged).toEqual({ n: 250, d: 250 });
    const view = await getImportJob(c.actor("owner"), job.id);
    expect(view.fetch).toMatchObject({ rateLimited: 1, sourceTotal: 250, truncated: false, ownersReadable: true });
    expect(view.summary).toMatchObject({ validated: 250, create: 250 });
    // The CSV wizard can't start a migration step; it has its own authorization and ordering.
    await expect(startImport(c.actor("owner"), job.id)).rejects.toThrow(/migration panel/);
  });
});

describe("a full migration", () => {
  let c: CrmOrg;
  let other: CrmOrg;
  beforeAll(async () => {
    c = await connected("Full Migration Co", "synthMigLocFull01");
    other = await crmOrg({ name: "Unrelated Co" });
  });

  it("dry-runs every step without writing a CRM record, then imports in order", async () => {
    const { calls } = ghlServer(sampleLocation("synthMigLocFull01", c.people.manager.email));
    await dryRunAll(c);
    expect(await one("select 1 from contacts where org_id = $1", [c.org.id])).toHaveLength(0);
    expect(await one("select 1 from crm_custom_fields where org_id = $1", [c.org.id])).toHaveLength(0);
    // Order is enforced: opportunities need pipelines, contacts and custom fields first.
    await expect(startGhlImport(c.actor("owner"), (await latest(c, "opportunity")).id)).rejects.toThrow(/custom fields step first/);
    await expect(startGhlImport(c.actor("owner"), (await latest(c, "contact")).id)).rejects.toThrow(/custom fields step first/);
    await importAll(c);
    expectReadOnly(calls);
    expect(calls.some((x) => x.url.pathname === "/contacts/ghlCt2")).toBe(true);
  });

  it("brings contacts across with tags, custom field values, companies, owners and opt-outs", async () => {
    const contacts = await one<{ ext: string; display_name: string; email: string | null; assigned_user_id: string | null; created_via: string; country: string | null }>(
      "select e.external_id as ext, c.display_name, c.email::text as email, c.assigned_user_id, c.created_via, c.country from contacts c join crm_external_ids e on e.native_id = c.id and e.provider = 'ghl' and e.entity = 'contact' where c.org_id = $1 and c.deleted_at is null order by e.external_id",
      [c.org.id],
    );
    expect(contacts.map((x) => x.ext)).toEqual(["ghlCt0", "ghlCt1", "ghlCt2", "ghlCt3"]);
    expect(contacts.every((x) => x.created_via === "ghl_migration")).toBe(true);
    expect(contacts[0]).toMatchObject({ display_name: "Ana Reyes", assigned_user_id: c.people.manager.id, country: "PH" });
    expect(contacts[1].assigned_user_id).toBeNull();
    expect(contacts[2]).toMatchObject({ display_name: "Cara Diaz", email: "cara@example.test" });
    expect(contacts[3].country).toBeNull();
    const tags = await one<{ ext: string; tag: string }>(
      "select e.external_id as ext, t.name::text as tag from crm_contact_tags ct join crm_tags t on t.id = ct.tag_id join crm_external_ids e on e.native_id = ct.contact_id and e.entity = 'contact' where ct.org_id = $1 order by 1, 2",
      [c.org.id],
    );
    expect(tags).toEqual([{ ext: "ghlCt0", tag: "VIP" }, { ext: "ghlCt1", tag: "Lead" }, { ext: "ghlCt2", tag: "VIP" }]);
    const field = await one<{ value_text: string }>("select v.value_text from crm_field_values v join crm_custom_fields f on f.id = v.field_id where v.org_id = $1 and f.key = 'membership'", [c.org.id]);
    expect(field).toEqual([{ value_text: "gold" }]);
    expect(await one("select 1 from crm_custom_fields where org_id = $1 and key = 'contract'", [c.org.id])).toHaveLength(0);
    const acme = await one<{ name: string }>("select co.name from crm_contact_companies cc join crm_companies co on co.id = cc.company_id join crm_external_ids e on e.native_id = cc.contact_id and e.external_id = 'ghlCt0' where cc.org_id = $1", [c.org.id]);
    expect(acme).toEqual([{ name: "Acme Inc" }]);
    // Do not disturb stays an opt-out on every channel the contact can be reached on.
    const supp = await one<{ channel: string; address: string }>("select channel, address from suppressions where org_id = $1 and source = 'ghl_migration_dnd' order by channel", [c.org.id]);
    expect(supp).toEqual([{ channel: "email", address: "ben@example.test" }, { channel: "sms", address: "+639170000102" }, { channel: "whatsapp", address: "+639170000102" }]);
    // Migrated records already happened in GoHighLevel: their events never start workflows or webhooks here.
    const [events] = await one<{ pending: number; quiet: number }>("select count(*) filter (where dispatched_at is null)::int as pending, count(*) filter (where dispatch_error like 'Migrated from GoHighLevel%')::int as quiet from crm_events where org_id = $1", [c.org.id]);
    expect(events.pending).toBe(0);
    expect(events.quiet).toBeGreaterThan(5);
    // And the GoHighLevel owners were never notified of an "assignment".
    expect(await one("select 1 from notifications where org_id = $1 and kind = 'crm_assigned'", [c.org.id])).toHaveLength(0);
  });

  it("resolves each opportunity's contact, pipeline and stage through external ids, and keeps its outcome", async () => {
    const opps = await one<{ ext: string; status: string; value: string | null; contact: string | null; stage: string; pipeline: string; lost_reason: string | null; closed_at: Date | null; owner: string | null; key: string; created_at: Date; stage_entered_at: Date }>(
      `select e.external_id as ext, o.status, o.monetary_value::text as value, ce.external_id as contact, s.name as stage, p.name as pipeline, o.lost_reason, o.closed_at, o.assigned_user_id as owner, o.idempotency_key as key,
              o.created_at, o.stage_entered_at
       from crm_opportunities o join crm_external_ids e on e.native_id = o.id and e.entity = 'opportunity'
       join crm_pipeline_stages s on s.id = o.stage_ref join crm_pipelines p on p.id = o.pipeline_ref
       left join crm_external_ids ce on ce.native_id = o.contact_id and ce.entity = 'contact'
       where o.org_id = $1 and o.provider = 'native' order by 1`,
      [c.org.id],
    );
    expect(opps.map((o) => [o.ext, o.status, o.contact, o.pipeline, o.stage])).toEqual([
      ["ghlOpp1", "open", "ghlCt0", "Sales", "New"],
      ["ghlOpp2", "won", "ghlCt1", "Sales", "Closing"],
      ["ghlOpp3", "lost", "ghlCt2", "Sales", "New"],
    ]);
    expect(opps[0]).toMatchObject({ value: "500.00", owner: c.people.manager.id, key: "ghl:ghlOpp1" });
    expect(new Date(opps[1].closed_at!).toISOString()).toBe("2026-09-01T10:00:00.000Z");
    expect(opps[2].lost_reason).toBe("Abandoned in GoHighLevel");
    // Each deal keeps when GoHighLevel created it (and when it entered its stage), so reports don't count history as new on migration day.
    expect(opps.map((o) => new Date(o.created_at).toISOString())).toEqual([day(10), day(11), day(12)]);
    expect(new Date(opps[1].stage_entered_at).toISOString()).toBe("2026-08-15T09:00:00.000Z");
    expect(new Date(opps[0].stage_entered_at).toISOString()).toBe(day(10));
    const budget = await one<{ value_number: string }>("select v.value_number::text from crm_field_values v join crm_custom_fields f on f.id = v.field_id where v.org_id = $1 and f.key = 'budget'", [c.org.id]);
    expect(budget.map((b) => Number(b.value_number))).toEqual([1200]);
  });

  it("compares source and destination per step, with the gap report's notes", async () => {
    const cmp = await ghlMigrationComparison(c.actor("owner"));
    const by = Object.fromEntries(cmp.rows.map((r) => [r.entity, r]));
    expect(by.contact).toMatchObject({ sourceCount: 5, staged: 5, destinationCount: 4, mapped: 4, created: 4, needsReview: 1, failed: 0, skipped: 0 });
    expect(by.contact.flags).toMatchObject({ duplicate_in_source: 1, owner_unmapped: 1, country_dropped: 1, field_value_dropped: 1, dnd: 1, company_by_name: 1 });
    expect(by.opportunity).toMatchObject({ sourceCount: 4, mapped: 3, needsReview: 1, failed: 0 });
    expect(by.opportunity.flags).toMatchObject({ abandoned_as_lost: 1 });
    expect(by.custom_field).toMatchObject({ sourceCount: 3, created: 2, skipped: 1, unsupported: [{ name: "Contract", type: "FILE_UPLOAD" }] });
    expect(by.tag).toMatchObject({ sourceCount: 2, created: 2, destinationCount: 2 });
    expect(by.pipeline).toMatchObject({ sourceCount: 1, created: 1, destinationCount: 1 });
    expect(by.company).toMatchObject({ sourceCount: 1, created: 1, destinationCount: 1 });
    const review = await getImportJob(c.actor("owner"), by.contact.jobId!);
    expect(review.problems.find((p) => p.status === "needs_review")!.errors[0]).toMatch(/Same email or phone/);
  });

  it("runs again without duplicating anything", async () => {
    const count = async () => (await one<Rec>(
      `select (select count(*) from contacts where org_id = $1 and deleted_at is null)::int as contacts, (select count(*) from crm_opportunities where org_id = $1 and provider = 'native' and archived_at is null)::int as opps,
              (select count(*) from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null)::int as pipes, (select count(*) from crm_pipeline_stages where org_id = $1)::int as stages,
              (select count(*) from crm_tags where org_id = $1)::int as tags, (select count(*) from crm_custom_fields where org_id = $1)::int as fields,
              (select count(*) from crm_companies where org_id = $1 and deleted_at is null)::int as companies, (select count(*) from crm_external_ids where org_id = $1)::int as links`,
      [c.org.id],
    ))[0];
    const before = await count();
    ghlServer(sampleLocation("synthMigLocFull01", c.people.manager.email));
    // Every step is imported, so the bulk dry run has nothing left to start; each step is read again explicitly.
    expect((await getGhlMigrationState(c.actor("owner"))).remaining).toEqual([]);
    for (const e of GHL_MIGRATION_ENTITIES) await reread(c, e);
    const dry = await ghlMigrationComparison(c.actor("owner"));
    expect(dry.rows.find((r) => r.entity === "contact")!.planned).toMatchObject({ create: 0, update: 4, review: 1 });
    expect(dry.rows.find((r) => r.entity === "opportunity")!.planned).toMatchObject({ create: 0, skip: 3, review: 1 });
    await importAll(c);
    expect(await count()).toEqual(before);
    const cmp = await ghlMigrationComparison(c.actor("owner"));
    expect(cmp.rows.find((r) => r.entity === "contact")).toMatchObject({ created: 0, linked: 4, destinationCount: 4 });
  });

  it("shows another workspace nothing and lets it touch nothing", async () => {
    const jobId = (await latest(c, "contact")).id;
    const state = await getGhlMigrationState(other.actor("owner"));
    expect(state.connected).toBe(false);
    expect(Object.values(state.jobs).every((j) => j === null)).toBe(true);
    expect((await ghlMigrationComparison(other.actor("owner"))).rows.every((r) => r.jobId === null && r.destinationCount === 0)).toBe(true);
    await expect(getImportJob(other.actor("owner"), jobId)).rejects.toThrow(/not found/);
    await expect(startGhlImport(other.actor("owner"), jobId)).rejects.toThrow(/not found/);
    await expect(rollbackGhlImport(other.actor("owner"), jobId)).rejects.toThrow(/not found/);
    await expect(checkGhlImportAgain(other.actor("owner"), jobId)).rejects.toThrow(/not found/);
    await advanceGhlMigration(other.actor("owner"), [jobId]);
    expect(await listImportJobs(other.actor("owner"))).toHaveLength(0);
    expect(await ghlMigrationComparison(other.actor("owner"), [jobId])).toMatchObject({ rows: expect.arrayContaining([expect.objectContaining({ entity: "contact", jobId: null })]) });
  });
});

describe("undoing a migration", () => {
  it("undoes in reverse order and keeps whatever someone changed or still uses", async () => {
    const c = await connected("Undo Co", "synthMigLocUndo01");
    ghlServer(sampleLocation("synthMigLocUndo01", c.people.manager.email));
    await dryRunAll(c);
    await importAll(c);
    const job = async (e: GhlMigrationEntity) => (await latest(c, e)).id;
    await expect(rollbackGhlImport(c.actor("owner"), await job("custom_field"))).rejects.toThrow(/Undo the contacts step first/);
    await expect(rollbackGhlImport(c.actor("owner"), await job("contact"))).rejects.toThrow(/Undo the opportunities step first/);
    await rollbackGhlImport(c.actor("owner"), await job("opportunity"));
    expect(await drain(await job("opportunity"))).toBe("rolled_back");
    const opps = await one<{ archived: boolean; key: string | null }>("select archived_at is not null as archived, idempotency_key as key from crm_opportunities where org_id = $1 and provider = 'native'", [c.org.id]);
    expect(opps).toHaveLength(3);
    expect(opps.every((o) => o.archived && o.key === null)).toBe(true);
    // Someone edits a migrated contact before the contacts step is undone.
    const ana = (await one<{ id: string }>("select native_id as id from crm_external_ids where org_id = $1 and provider = 'ghl' and entity = 'contact' and external_id = 'ghlCt0'", [c.org.id]))[0].id;
    await updateContact(c.actor("owner"), ana, { city: "Cebu" });
    await rollbackGhlImport(c.actor("owner"), await job("contact"));
    expect(await drain(await job("contact"))).toBe("rolled_back");
    const left = await one<{ id: string; city: string | null }>("select id, city from contacts where org_id = $1 and deleted_at is null", [c.org.id]);
    expect(left).toEqual([{ id: ana, city: "Cebu" }]);
    const view = await getImportJob(c.actor("owner"), await job("contact"));
    expect(view.summary).toMatchObject({ rolledBack: 3, keptChanged: 2 });
    expect(view.problems.find((p) => p.status === "needs_review" && p.errors[0]?.includes("Changed since the import"))).toBeTruthy();
    // The company made by name for Ben goes with him; Acme stays (Ana still works there). Opt-outs are never undone.
    expect(await one("select 1 from crm_companies where org_id = $1 and name = 'Bayside Co' and deleted_at is null", [c.org.id])).toHaveLength(0);
    expect(await one("select 1 from suppressions where org_id = $1 and source = 'ghl_migration_dnd'", [c.org.id])).toHaveLength(3);
    for (const e of ["company", "pipeline", "tag", "custom_field"] as const) {
      await rollbackGhlImport(c.actor("owner"), await job(e));
      expect(await drain(await job(e))).toBe("rolled_back");
    }
    expect(await one("select name from crm_companies where org_id = $1 and deleted_at is null", [c.org.id])).toEqual([{ name: "Acme Inc" }]);
    expect(await one("select 1 from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null", [c.org.id])).toHaveLength(0);
    expect(await one("select name::text as name from crm_tags where org_id = $1", [c.org.id])).toEqual([{ name: "VIP" }]);
    expect(await one("select key from crm_custom_fields where org_id = $1", [c.org.id])).toEqual([{ key: "membership" }]);
    // Run again after the undo: everything that was undone comes back, nothing is doubled.
    ghlServer(sampleLocation("synthMigLocUndo01", c.people.manager.email));
    await dryRunAll(c);
    await importAll(c);
    expect(await one("select 1 from contacts where org_id = $1 and deleted_at is null", [c.org.id])).toHaveLength(4);
    expect(await one("select 1 from crm_opportunities where org_id = $1 and provider = 'native' and archived_at is null", [c.org.id])).toHaveLength(3);
  });
});

describe("ownership and authorization", () => {
  it("dry-runs while GoHighLevel owns the capability, imports only once iAcquire owns it, and never touches the GoHighLevel cache", async () => {
    const loc = "synthMigLocOwn001";
    const c = await connected("Ownership Co", loc, "ghl");
    await withSystem(async (db) => {
      await db.query("insert into crm_pipelines (org_id, ghl_pipeline_id, name, stages) values ($1, 'cachePipe0001', 'Cached pipeline', '[]')", [c.org.id]);
      await db.query("insert into crm_opportunities (org_id, ghl_opportunity_id, name, status) values ($1, 'cacheOpp00001', 'Cached deal', 'open')", [c.org.id]);
    });
    const cache = async () => one("select 'p' as k, id::text, name, synced_at::text from crm_pipelines where org_id = $1 and provider = 'ghl' union all select 'o', id::text, name, synced_at::text from crm_opportunities where org_id = $1 and provider = 'ghl' order by 1", [c.org.id]);
    const before = await cache();
    ghlServer(sampleLocation(loc, c.people.manager.email));
    const job = await createGhlImportJob(c.actor("owner"), { entity: "tag" });
    expect(await drain(job.id)).toBe("validated");
    await expect(startGhlImport(c.actor("owner"), job.id)).rejects.toThrow(/GoHighLevel still owns tags/);
    // A provider switch moves tags to iAcquire (hybrid, with the switch in progress): now the import runs.
    await withSystem(async (db) => {
      await db.query("update crm_workspaces set mode = 'hybrid', switching = true where org_id = $1", [c.org.id]);
      await db.query("insert into crm_capability_providers (org_id, capability, provider, sync_policy) select $1, x, case when x = 'tags' then 'native' else 'ghl' end, 'import_only' from unnest(array['contacts','companies','tags','custom_fields','pipelines','opportunities','calendars','appointments','conversations','workflows','reporting']) x", [c.org.id]);
    });
    expect((await startGhlImport(c.actor("owner"), job.id)).started).toBe(true);
    expect(await drain(job.id)).toBe("completed");
    expect(await one("select name::text as name from crm_tags where org_id = $1 order by 1", [c.org.id])).toEqual([{ name: "Lead" }, { name: "VIP" }]);
    expect(await cache()).toEqual(before);
    // If GoHighLevel takes the capability back mid-import, the step stops (what was imported stays and can be undone).
    const again = await createGhlImportJob(c.actor("owner"), { entity: "pipeline" });
    await withSystem((db) => db.query("update crm_capability_providers set provider = 'native' where org_id = $1 and capability = 'pipelines'", [c.org.id]));
    expect(await drain(again.id)).toBe("validated");
    expect((await startGhlImport(c.actor("owner"), again.id)).started).toBe(true);
    await withSystem((db) => db.query("update crm_capability_providers set provider = 'ghl' where org_id = $1 and capability = 'pipelines'", [c.org.id]));
    expect(await drain(again.id)).toBe("cancelled");
    expect((await getImportJob(c.actor("owner"), again.id)).error).toMatch(/GoHighLevel owns this part of the CRM again/);
  });

  it("lets the owner run it, managers dry-run it, everyone preview it; read sessions get nothing, a super admin's write session helps", async () => {
    const loc = "synthMigLocPerm001";
    const c = await connected("Permissions Co", loc);
    const { calls } = ghlServer(sampleLocation(loc, c.people.manager.email));
    // Preview: anyone in the workspace.
    for (const who of ["owner", "manager", "sales", "viewer"] as const) expect((await planGhlMigration(c.actor(who))).connected).toBe(true);
    // Dry run: owners and managers only.
    await expect(createGhlImportJob(c.actor("sales"), { entity: "tag" })).rejects.toThrow(/owners and managers/i);
    await expect(ghlMigrationComparison(c.actor("sales"))).rejects.toThrow();
    const tagJob = await createGhlImportJob(c.actor("manager"), { entity: "tag" });
    expect(await drain(tagJob.id)).toBe("validated");
    // The real run and the undo: the owner only.
    await expect(startGhlImport(c.actor("manager"), tagJob.id)).rejects.toThrow(/workspace owner/);
    expect((await startGhlImport(c.actor("owner"), tagJob.id)).started).toBe(true);
    expect(await drain(tagJob.id)).toBe("completed");
    await expect(rollbackGhlImport(c.actor("manager"), tagJob.id)).rejects.toThrow(/workspace owner/);
    const { superAdmin } = await agencyPeople();
    // An agency read session: no preview (it would use the client's credential), no dry run, no import, no comparison.
    await startSupportSession(superAdmin, c.org.id, { mode: "read", reason: "Looking at the migration" });
    const reader = await agencyActor(superAdmin, c.org.id);
    const n = calls.length;
    await expect(planGhlMigration(reader)).rejects.toThrow(/read-only/);
    await expect(createGhlImportJob(reader, { entity: "pipeline" })).rejects.toThrow(/read-only/);
    await expect(startGhlImport(reader, tagJob.id)).rejects.toThrow(/read-only/);
    await expect(ghlMigrationComparison(reader)).rejects.toThrow(/read-only/);
    expect(calls.length).toBe(n);
    const readState = await getGhlMigrationState(reader);
    expect(readState.can).toEqual({ preview: false, dryRun: false, import: false });
    // A super admin's write session can assist end to end.
    await startSupportSession(superAdmin, c.org.id, { mode: "write", reason: "Helping with the migration" });
    const helper = await agencyActor(superAdmin, c.org.id);
    expect((await planGhlMigration(helper)).can).toEqual({ dryRun: true, import: true });
    const pipeJob = await createGhlImportJob(helper, { entity: "pipeline" });
    expect(await drain(pipeJob.id)).toBe("validated");
    expect((await startGhlImport(helper, pipeJob.id)).started).toBe(true);
    expect(await drain(pipeJob.id)).toBe("completed");
    await rollbackGhlImport(helper, pipeJob.id);
    expect(await drain(pipeJob.id)).toBe("rolled_back");
    const audit = await one<{ action: string; actor_kind: string }>("select action, actor_kind from audit_logs where org_id = $1 and action like 'crm.ghl_migration%' order by id", [c.org.id]);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["crm.ghl_migration_previewed", "crm.ghl_migration_job_created", "crm.ghl_migration_fetched", "crm.ghl_migration_import_started"]));
    expect(audit.some((a) => a.actor_kind === "agency")).toBe(true);
    expectReadOnly(calls);
  });
});

// ---------------------------------------------------------------------------
// Review fixes: re-runs and undo, cancelling, records in use, contact re-reads, passing errors, request budget and lease, the bulk dry
// run, the comparison's source counts, who the audit names, and the location's user list.
// ---------------------------------------------------------------------------

const links = async (c: CrmOrg, entity: string) => (await one<{ external_id: string }>("select external_id from crm_external_ids where org_id = $1 and provider = 'ghl' and entity = $2 order by 1", [c.org.id, entity])).map((x) => x.external_id);

describe("undoing a re-run", () => {
  it("removes only the links that run made, so the first run's records stay linked and nothing is duplicated", async () => {
    const loc = "synthMigLocRerun01";
    const c = await connected("Rerun Undo Co", loc);
    const s = sampleLocation(loc, c.people.manager.email);
    // A business with no website (no domain to match on) and a contact with a name only (no email or phone to match on).
    s.businesses.push({ id: "bizPlain01", name: "Plain Co", locationId: loc });
    s.contacts.push({ id: "ghlCtSolo", firstName: "Solo", lastName: "Nameonly", phone: null, dateAdded: day(5), locationId: loc });
    ghlServer(s);
    const owner = c.actor("owner");
    const dupes = async (sql: string) => one<{ name: string; n: number }>(sql, [c.org.id]);

    // Companies: run, run again, undo the second run.
    const co1 = await runStep(c, "company");
    expect(await links(c, "company")).toEqual(["bizAcme001", "bizPlain01"]);
    const co2 = await runStep(c, "company");
    expect((await getGhlMigrationState(owner)).undo.company!.id).toBe(co2);
    await undoRun(c, co2);
    expect(await links(c, "company")).toEqual(["bizAcme001", "bizPlain01"]);
    // The panel now offers Undo for the first run (the second has nothing left to undo).
    expect((await getGhlMigrationState(owner)).undo.company!.id).toBe(co1);
    const co3 = await runStep(c, "company");
    expect(await dupes("select name, count(*)::int as n from crm_companies where org_id = $1 and deleted_at is null group by name having count(*) > 1")).toEqual([]);

    // Contacts (including one with a name only).
    await runStep(c, "custom_field");
    await runStep(c, "tag");
    const ct1 = await runStep(c, "contact");
    const contactLinks = await links(c, "contact");
    expect(contactLinks).toContain("ghlCtSolo");
    const ct2 = await runStep(c, "contact");
    await undoRun(c, ct2);
    expect(await links(c, "contact")).toEqual(contactLinks);
    const ct3 = await runStep(c, "contact");
    expect(await dupes("select display_name as name, count(*)::int as n from contacts where org_id = $1 and deleted_at is null group by 1 having count(*) > 1")).toEqual([]);
    expect(await one("select 1 from contacts where org_id = $1 and deleted_at is null and display_name = 'Solo Nameonly'", [c.org.id])).toHaveLength(1);

    // Pipelines: the second run adds a stage; undoing it removes that stage and its link, never the pipeline's link from the first run.
    await runStep(c, "pipeline");
    s.pipelines[0].stages = [...(s.pipelines[0].stages as Rec[]), { id: "stProp0001", name: "Proposal", position: 2 }];
    const p2 = await runStep(c, "pipeline");
    expect((await one<{ result: Rec }>("select result from crm_import_rows where job_id = $1", [p2]))[0].result).toMatchObject({ linked: true, pipelineLinkInserted: false });
    await undoRun(c, p2);
    expect(await links(c, "pipeline")).toEqual(["pipeSales1"]);
    expect(await links(c, "stage")).toEqual(["stClose001", "stNew0001"]);
    // So the opportunities step still finds the pipeline, and imports the deals.
    const opp = await runStep(c, "opportunity");
    expect(await one("select 1 from crm_import_rows where job_id = $1 and status = 'created'", [opp])).toHaveLength(3);

    // Undo everything back to the first runs: the companies the first run created go (they are not "changed since the import").
    await undoRun(c, opp);
    await undoRun(c, ct3);
    await undoRun(c, ct1);
    await undoRun(c, co3);
    await undoRun(c, co1);
    expect(await one<{ status: string }>("select status from crm_import_rows where job_id = $1 order by row_number", [co1])).toEqual([{ status: "rolled_back" }, { status: "rolled_back" }]);
    expect(await one("select name from crm_companies where org_id = $1 and deleted_at is null", [c.org.id])).toEqual([]);
    expect(await links(c, "company")).toEqual([]);
  });
});

describe("cancelling a step", () => {
  it("stops a read before its next page, frees a checked step to be read again, and follows who may stop what", async () => {
    const loc = "synthMigLocCancel1";
    const c = await connected("Cancel Co", loc);
    const s = sampleLocation(loc, c.people.manager.email);
    s.contacts = Array.from({ length: 250 }, (_, i) => ({ id: `cn${String(i).padStart(4, "0")}`, firstName: `P${i}`, email: `cn${i}@example.test`, phone: null, dateAdded: day(i), locationId: loc }));
    let jobId = "";
    // The manager cancels while the second page is being read.
    s.intercept = async (url) => {
      if (url.pathname === "/contacts/" && url.searchParams.get("startAfterId") === "cn0099") await cancelGhlStep(c.actor("manager"), jobId);
      return null;
    };
    ghlServer(s);
    jobId = (await createGhlImportJob(c.actor("manager"), { entity: "contact" })).id;
    expect(await advanceImport(jobId)).toEqual({ status: "cancelled", done: true });
    const row = await jobRow(jobId);
    expect(row).toMatchObject({ status: "cancelled", total_rows: 100 });
    expect(row.fetch_state.users).toBeUndefined();
    expect(await advanceImport(jobId)).toEqual({ status: "cancelled", done: true });
    expect((await jobRow(jobId)).total_rows).toBe(100);

    // A step checked and waiting to be imported can be cancelled, and then read again.
    const tag = await reread(c, "tag", c.actor("manager"));
    await expect(createGhlImportJob(c.actor("manager"), { entity: "tag" })).rejects.toThrow(/checked and waiting to be imported/);
    await expect(cancelGhlStep(c.actor("sales"), tag)).rejects.toThrow(/owners and managers/i);
    const { superAdmin } = await agencyPeople();
    await startSupportSession(superAdmin, c.org.id, { mode: "read", reason: "Looking at the migration" });
    await expect(cancelGhlStep(await agencyActor(superAdmin, c.org.id), tag)).rejects.toThrow(/read-only/);
    await cancelGhlStep(c.actor("manager"), tag);
    const again = await reread(c, "tag", c.actor("manager"));
    expect(again).not.toBe(tag);

    // A running import: only the owner may stop it (what it imported stays, and can be undone).
    expect((await startGhlImport(c.actor("owner"), again)).started).toBe(true);
    await expect(cancelGhlStep(c.actor("manager"), again)).rejects.toThrow(/workspace owner/);
    await cancelGhlStep(c.actor("owner"), again);
    expect((await jobRow(again)).status).toBe("cancelled");
    const audit = await one<{ action: string; metadata: Rec }>("select action, metadata from audit_logs where org_id = $1 and action = 'crm.ghl_migration_step_cancelled' order by id", [c.org.id]);
    expect(audit.map((a) => a.metadata.from)).toEqual(["fetching", "validated", "importing"]);
  });
});

describe("undo keeps contacts the team has worked on", () => {
  it("keeps a migrated contact with a native deal or a note (link and details included) and removes the rest", async () => {
    const loc = "synthMigLocInUse01";
    const c = await connected("In Use Co", loc);
    ghlServer(sampleLocation(loc, c.people.manager.email));
    await runStep(c, "custom_field");
    await runStep(c, "tag");
    const contacts = await runStep(c, "contact");
    const native = async (ext: string) => (await one<{ id: string }>("select native_id as id from crm_external_ids where org_id = $1 and provider = 'ghl' and entity = 'contact' and external_id = $2", [c.org.id, ext]))[0].id;
    const ana = await native("ghlCt0");
    const ben = await native("ghlCt1");
    const cara = await native("ghlCt2");
    // After the import the team works these two natively. Neither changes the contact itself.
    const deal = await createOpportunity(c.actor("owner"), { name: "Native follow-up deal", contactId: ana });
    await addNote(c.actor("owner"), "contact", ben, "Called after the migration.");
    await undoRun(c, contacts);
    const live = await one<{ id: string; email: string | null; phone: string | null }>("select id, email::text as email, phone from contacts where org_id = $1 and deleted_at is null order by display_name", [c.org.id]);
    expect(live).toEqual([{ id: ana, email: "ana@example.test", phone: "+639170000101" }, { id: ben, email: "ben@example.test", phone: "+639170000102" }]);
    expect(await one("select 1 from contacts where id = $1 and deleted_at is not null", [cara])).toHaveLength(1);
    const kept = await one<{ entity_id: string; errors: string[] }>("select entity_id, errors from crm_import_rows where job_id = $1 and status = 'needs_review' and entity_id = any($2::uuid[]) order by row_number", [contacts, [ana, ben]]);
    expect(kept).toHaveLength(2);
    expect(kept.every((k) => /Used by records added after the import/.test(k.errors[0]))).toBe(true);
    // The deal still points at a live contact, and both stay linked to GoHighLevel, so a re-run links instead of duplicating.
    expect(await one("select 1 from crm_opportunities o join contacts c on c.id = o.contact_id and c.deleted_at is null where o.id = $1", [deal.id])).toHaveLength(1);
    expect(await links(c, "contact")).toEqual(["ghlCt0", "ghlCt1"]);
    const rerun = await runStep(c, "contact");
    expect(await one("select 1 from contacts where org_id = $1 and deleted_at is null and display_name in ('Ana Reyes', 'Ben Cruz')", [c.org.id])).toHaveLength(2);
    expect(await one<{ status: string }>("select status from crm_import_rows where job_id = $1 and data->>'ghl_id' in ('ghlCt0', 'ghlCt1') order by row_number", [rerun])).toEqual([{ status: "updated" }, { status: "updated" }]);
  });
});

describe("contacts in GoHighLevel's documented list shape", () => {
  it("reads a contact again when the list leaves out its name and phone, and flags one whose full record can't be read", async () => {
    const loc = "synthMigLocDocShp1";
    const c = await connected("Documented Shape Co", loc);
    const s = sampleLocation(loc, c.people.manager.email);
    // ContactsSearchSchema: id, email, tags, dateAdded… but no firstName, lastName or phone.
    s.contacts = [
      { id: "docCt1", email: "doc1@example.test", tags: [], dateAdded: day(0), locationId: loc },
      { id: "docCt2", email: "doc2@example.test", dateAdded: day(1), locationId: loc },
      // A list that does carry the keys (even empty) costs no extra request.
      { id: "docCt3", firstName: "Keyed", lastName: null, phone: null, email: "doc3@example.test", dateAdded: day(2), locationId: loc },
    ];
    s.details = { docCt1: { id: "docCt1", firstName: "Dora", lastName: "Lane", phone: "+639170000201", email: "doc1@example.test", locationId: loc } };
    const { calls } = ghlServer(s);
    await runStep(c, "custom_field");
    await runStep(c, "tag");
    const job = await runStep(c, "contact");
    const reads = (id: string) => calls.filter((x) => x.url.pathname === `/contacts/${id}`).length;
    expect([reads("docCt1"), reads("docCt2"), reads("docCt3")]).toEqual([1, 1, 0]);
    const dora = await one<{ first_name: string; last_name: string; phone: string }>("select c.first_name, c.last_name, c.phone from contacts c join crm_external_ids e on e.native_id = c.id and e.external_id = 'docCt1' where c.org_id = $1", [c.org.id]);
    expect(dora).toEqual([{ first_name: "Dora", last_name: "Lane", phone: "+639170000201" }]);
    const flags = await one<{ id: string; flags: string[] }>("select data->>'ghl_id' as id, flags from crm_import_rows where job_id = $1 order by row_number", [job]);
    expect(flags.find((f) => f.id === "docCt1")!.flags).toEqual([]);
    expect(flags.find((f) => f.id === "docCt2")!.flags).toEqual(expect.arrayContaining(["detail_unavailable", "name_phone_missing"]));
    expect(flags.find((f) => f.id === "docCt3")!.flags).toEqual([]);
    const cmp = await ghlMigrationComparison(c.actor("owner"), [job]);
    expect(cmp.rows.find((r) => r.entity === "contact")!.flags).toMatchObject({ detail_unavailable: 1, name_phone_missing: 1 });
    expectReadOnly(calls);
  });
});

describe("passing GoHighLevel errors", () => {
  it("backs off from a 503 and a timeout and resumes from its cursor", async () => {
    const loc = "synthMigLocFlaky01";
    const c = await connected("Flaky Co", loc);
    const s = sampleLocation(loc, c.people.manager.email);
    s.contacts = Array.from({ length: 450 }, (_, i) => ({ id: `tr${String(i).padStart(4, "0")}`, firstName: `T${i}`, email: `tr${i}@example.test`, phone: null, dateAdded: day(i), locationId: loc }));
    let failed503 = false;
    let timedOut = false;
    s.intercept = (url) => {
      if (url.pathname !== "/contacts/") return null;
      const after = url.searchParams.get("startAfterId");
      if (after === "tr0199" && !failed503) {
        failed503 = true;
        return new Response("{}", { status: 503 });
      }
      if (after === "tr0299" && !timedOut) {
        timedOut = true;
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return null;
    };
    const { calls } = ghlServer(s);
    const job = await createGhlImportJob(c.actor("owner"), { entity: "contact" });
    expect(await advanceImport(job.id)).toEqual({ status: "fetching", done: false });
    let row = await jobRow(job.id);
    expect(row).toMatchObject({ status: "fetching", total_rows: 200, fetch_cursor: { startAfterId: "tr0199" } });
    expect(new Date(row.fetch_not_before!).getTime()).toBeGreaterThan(Date.now());
    expect(row.fetch_state).toMatchObject({ transientErrors: 1, lastWaitReason: "error", lastError: "GoHighLevel returned 503." });
    expect((await getImportJob(c.actor("owner"), job.id)).fetch).toMatchObject({ waitReason: "error", transientErrors: 1, lastError: "GoHighLevel returned 503." });
    // While it waits, nothing asks GoHighLevel again.
    const before = calls.length;
    expect(await advanceImport(job.id)).toEqual({ status: "fetching", done: false });
    expect(calls.length).toBe(before);
    await readyNow(job.id);
    expect(await advanceImport(job.id)).toEqual({ status: "fetching", done: false });
    row = await jobRow(job.id);
    // The page after the 503 was staged (the count started again), then the timeout made it wait once more.
    expect(row).toMatchObject({ total_rows: 300, fetch_cursor: { startAfterId: "tr0299" } });
    expect(row.fetch_state).toMatchObject({ transientErrors: 1, lastError: "GoHighLevel could not be reached." });
    await readyNow(job.id);
    expect(await drain(job.id)).toBe("validated");
    const pages = calls.filter((x) => x.url.pathname === "/contacts/").map((x) => x.url.searchParams.get("startAfterId"));
    expect(pages).toEqual([null, "tr0099", "tr0199", "tr0199", "tr0299", "tr0299", "tr0399"]);
    expect((await one<{ n: number; d: number }>("select count(*)::int as n, count(distinct data->>'ghl_id')::int as d from crm_import_rows where job_id = $1", [job.id]))[0]).toEqual({ n: 450, d: 450 });
    expect((await jobRow(job.id)).fetch_state.transientErrors).toBeUndefined();
    expectReadOnly(calls);
    // The waits grow: 2 s, 4 s, 8 s … up to five minutes, with up to a second of jitter.
    expect([1, 2, 3, 9, 20].map((n) => transientDelayMs(n, 0))).toEqual([2000, 4000, 8000, 300_000, 300_000]);
    expect(transientDelayMs(1, 0.999)).toBe(2999);
  });

  it("stops after a few errors in a row, and Run this step again resumes from where it stopped", async () => {
    const loc = "synthMigLocDown001";
    const c = await connected("Down Co", loc);
    const s = sampleLocation(loc, c.people.manager.email);
    s.contacts = Array.from({ length: 250 }, (_, i) => ({ id: `fl${String(i).padStart(4, "0")}`, firstName: `F${i}`, email: `fl${i}@example.test`, phone: null, dateAdded: day(i), locationId: loc }));
    let down = true;
    let errors = 0;
    // GoHighLevel's documented contact list (no meta): the comparison can't take a total from it.
    s.intercept = (url) => {
      if (url.pathname !== "/contacts/") return null;
      if (down && url.searchParams.get("startAfterId") === "fl0099") {
        errors++;
        return new Response("{}", { status: 502 });
      }
      return bareContactsPage(s.contacts, url);
    };
    const { calls } = ghlServer(s);
    const job = await createGhlImportJob(c.actor("owner"), { entity: "contact" });
    let status = (await advanceImport(job.id)).status;
    for (let i = 0; i < 20 && status === "fetching"; i++) {
      await readyNow(job.id);
      status = (await advanceImport(job.id)).status;
    }
    expect(status).toBe("failed");
    expect(errors).toBe(GHL_TRANSIENT_MAX_ERRORS + 1);
    const row = await jobRow(job.id);
    expect(row).toMatchObject({ total_rows: 100, fetch_cursor: { startAfterId: "fl0099" } });
    expect(row.error).toMatch(/GoHighLevel returned 502\. It failed 9 times in a row\..*resumes where it stopped/);
    // The location's user list is kept only while reading.
    expect(row.fetch_state.users).toBeUndefined();
    // The comparison doesn't present what was read as GoHighLevel's own count.
    expect((await ghlMigrationComparison(c.actor("owner"), [job.id])).rows.find((r) => r.entity === "contact")).toMatchObject({ sourceCount: 100, sourceCountKind: "at_least", staged: 100 });
    // GoHighLevel is back: running the step again carries on from the stored cursor, in the same job.
    down = false;
    const n = calls.length;
    const resumed = await createGhlImportJob(c.actor("owner"), { entity: "contact" });
    expect(resumed).toMatchObject({ id: job.id, status: "fetching", totalRows: 100 });
    expect(await drain(job.id)).toBe("validated");
    expect(calls.slice(n).filter((x) => x.url.pathname === "/contacts/").map((x) => x.url.searchParams.get("startAfterId"))[0]).toBe("fl0099");
    expect((await one<{ n: number; d: number }>("select count(*)::int as n, count(distinct data->>'ghl_id')::int as d from crm_import_rows where job_id = $1", [job.id]))[0]).toEqual({ n: 250, d: 250 });
    expect((await ghlMigrationComparison(c.actor("owner"), [job.id])).rows.find((r) => r.entity === "contact")).toMatchObject({ sourceCount: 250, sourceCountKind: "listed" });
    expect(await one("select 1 from audit_logs where org_id = $1 and action = 'crm.ghl_migration_step_resumed' and target_id = $2", [c.org.id, job.id])).toHaveLength(1);
  });

  it("drops the location's user list when a step stops for another reason (a missing scope)", async () => {
    const loc = "synthMigLocScope01";
    const c = await connected("Scope Co", loc);
    const s = sampleLocation(loc, c.people.manager.email);
    s.intercept = (url) => (url.pathname === "/contacts/" ? new Response("{}", { status: 403 }) : null);
    ghlServer(s);
    const job = await createGhlImportJob(c.actor("owner"), { entity: "contact" });
    expect(await drain(job.id)).toMatch(/^failed: The GoHighLevel token can't read contacts/);
    const row = await jobRow(job.id);
    expect(row.fetch_state.ownersReadable).toBe(true);
    expect(row.fetch_state.users).toBeUndefined();
  });
});

describe("the worker's request budget and lease", () => {
  it("keeps one worker step to its request budget when every contact needs reading again, and resumes right after the last one staged", async () => {
    const loc = "synthMigLocBudget1";
    const c = await connected("Budget Co", loc);
    const s = sampleLocation(loc, c.people.manager.email);
    const ids = Array.from({ length: 60 }, (_, i) => `bd${String(i).padStart(4, "0")}`);
    s.contacts = ids.map((id, i) => ({ id, email: `${id}@example.test`, dateAdded: day(i), locationId: loc }));
    s.details = Object.fromEntries(ids.map((id) => [id, { id, firstName: `B${id}`, phone: null, email: `${id}@example.test`, locationId: loc }]));
    const { calls } = ghlServer(s);
    const job = await createGhlImportJob(c.actor("owner"), { entity: "contact" });
    expect(await advanceImport(job.id)).toEqual({ status: "fetching", done: false });
    expect(calls.length).toBeLessThanOrEqual(REQUESTS_PER_ADVANCE + 1);
    const row = await jobRow(job.id);
    expect(row.total_rows).toBeGreaterThan(0);
    expect(row.total_rows).toBeLessThan(60);
    // Not a wait: the next worker step carries on straight away.
    expect(row.fetch_not_before).toBeNull();
    expect(row.fetch_cursor).toMatchObject({ startAfterId: ids[row.total_rows - 1] });
    expect(await drain(job.id)).toBe("validated");
    expect((await one<{ n: number; d: number }>("select count(*)::int as n, count(distinct data->>'ghl_id')::int as d from crm_import_rows where job_id = $1", [job.id]))[0]).toEqual({ n: 60, d: 60 });
    // Every contact was read again exactly once.
    expect(ids.map((id) => calls.filter((x) => x.url.pathname === `/contacts/${id}`).length).every((k) => k === 1)).toBe(true);
    expect(calls.filter((x) => x.url.pathname === "/contacts/").map((x) => x.url.searchParams.get("startAfterId"))).toEqual([null, ids[row.total_rows - 1]]);
  });

  it("writes nothing more once another worker took the step over", async () => {
    const loc = "synthMigLocLease01";
    const c = await connected("Lease Co", loc);
    const s = sampleLocation(loc, c.people.manager.email);
    s.contacts = Array.from({ length: 250 }, (_, i) => ({ id: `ls${String(i).padStart(4, "0")}`, firstName: `L${i}`, email: `ls${i}@example.test`, phone: null, dateAdded: day(i), locationId: loc }));
    let jobId = "";
    let takeover = true;
    // While the second page is read, the claim is taken by another worker (as if this read outlasted the two-minute claim).
    s.intercept = async (url) => {
      if (takeover && url.pathname === "/contacts/" && url.searchParams.get("startAfterId") === "ls0099") {
        takeover = false;
        await withSystem((db) => db.query("update crm_import_jobs set claimed_at = date_trunc('milliseconds', now()) + interval '5 seconds' where id = $1", [jobId]));
      }
      return null;
    };
    ghlServer(s);
    jobId = (await createGhlImportJob(c.actor("owner"), { entity: "contact" })).id;
    expect(await advanceImport(jobId)).toEqual({ status: "fetching", done: false });
    const row = await jobRow(jobId);
    // The first page was staged (and the lease renewed with it); the second page, read after the takeover, wasn't.
    expect(row).toMatchObject({ status: "fetching", total_rows: 100, fetch_cursor: { startAfterId: "ls0099" } });
    // The other worker's claim is left as it is.
    expect(row.claimed_at).not.toBeNull();
    // Called directly with a stale lease, the worker refuses to write at all.
    await expect(fetchGhlChunk(jobId, { at: new Date(Date.now() - 600_000) })).rejects.toBeInstanceOf(ImportLeaseLost);
    expect((await jobRow(jobId)).total_rows).toBe(100);
    // The other worker finishes the read.
    await withSystem((db) => db.query("update crm_import_jobs set claimed_at = null where id = $1", [jobId]));
    expect(await drain(jobId)).toBe("validated");
    expect((await one<{ n: number; d: number }>("select count(*)::int as n, count(distinct data->>'ghl_id')::int as d from crm_import_rows where job_id = $1", [jobId]))[0]).toEqual({ n: 250, d: 250 });
  });
});

describe("the bulk dry run", () => {
  it("starts only the steps that still need one, and leaves imported steps (and their Undo) alone", async () => {
    const loc = "synthMigLocRemain1";
    const c = await connected("Remaining Co", loc);
    ghlServer(sampleLocation(loc, c.people.manager.email));
    const owner = c.actor("owner");
    const fields = await runStep(c, "custom_field");
    const tags = await runStep(c, "tag");
    const contacts = await reread(c, "contact");
    expect((await getGhlMigrationState(owner)).remaining).toEqual(["pipeline", "company", "opportunity"]);
    await createGhlMigrationRun(owner);
    const state = await getGhlMigrationState(owner);
    expect(Object.fromEntries(GHL_MIGRATION_ENTITIES.map((e) => [e, state.jobs[e]!.status]))).toEqual({
      custom_field: "completed", tag: "completed", pipeline: "fetching", company: "fetching", contact: "validated", opportunity: "fetching",
    });
    expect([state.jobs.custom_field!.id, state.jobs.tag!.id, state.jobs.contact!.id]).toEqual([fields, tags, contacts]);
    expect([state.undo.custom_field!.id, state.undo.tag!.id]).toEqual([fields, tags]);
    expect(state.remaining).toEqual([]);
    expect(await one("select 1 from crm_import_jobs where org_id = $1 and entity in ('custom_field', 'tag')", [c.org.id])).toHaveLength(2);
    for (const e of ["pipeline", "company", "opportunity"] as const) expect(await drain(state.jobs[e]!.id)).toBe("validated");
    // Contacts aren't held up by steps that were already imported; only by the companies step that just started (contacts link to companies).
    await expect(startGhlImport(owner, contacts)).rejects.toThrow(/Import the companies .*step first/);
    expect(await importStep(owner, c, "company")).toBe("completed");
    expect(await importStep(owner, c, "contact")).toBe("completed");
    // Nothing left to start: the bulk dry run creates no job.
    const count = (await one("select 1 from crm_import_jobs where org_id = $1", [c.org.id])).length;
    await createGhlMigrationRun(owner);
    expect((await one("select 1 from crm_import_jobs where org_id = $1", [c.org.id])).length).toBe(count);
  });
});

describe("the comparison's source counts", () => {
  it("says whether GoHighLevel reported a total, listed everything, or may hold more", async () => {
    const owner = (c: CrmOrg) => c.actor("owner");
    const row = async (c: CrmOrg, entity: GhlMigrationEntity, id: string) => (await ghlMigrationComparison(owner(c), [id])).rows.find((r) => r.entity === entity)!;

    // The documented contact list: no meta, a top-level count.
    const a = await connected("Count Co", "synthMigLocCount01");
    const sa = sampleLocation("synthMigLocCount01", a.people.manager.email);
    sa.contacts = sa.contacts.slice(0, 2).map((x) => ({ ...x, phone: x.phone ?? null }));
    sa.intercept = (url) => (url.pathname === "/contacts/" ? bareContactsPage(sa.contacts, url, 7) : null);
    ghlServer(sa);
    const aj = await reread(a, "contact");
    expect(await row(a, "contact", aj)).toMatchObject({ sourceCount: 7, sourceCountKind: "reported", staged: 2 });
    // Companies: GoHighLevel reports no total, and the whole list was read.
    const co = await reread(a, "company");
    expect(await row(a, "company", co)).toMatchObject({ sourceCount: 1, sourceCountKind: "listed", staged: 1 });
    vi.restoreAllMocks();

    // A count that is only the page's size (smaller than what was read) is ignored.
    const b = await connected("Page Count Co", "synthMigLocCount02");
    const sb = sampleLocation("synthMigLocCount02", b.people.manager.email);
    sb.contacts = Array.from({ length: 150 }, (_, i) => ({ id: `pc${String(i).padStart(4, "0")}`, firstName: `C${i}`, email: `pc${i}@example.test`, phone: null, dateAdded: day(i), locationId: "synthMigLocCount02" }));
    sb.intercept = (url) => {
      if (url.pathname !== "/contacts/") return null;
      const after = url.searchParams.get("startAfterId");
      return bareContactsPage(sb.contacts, url, after ? 50 : 100);
    };
    ghlServer(sb);
    const bj = await reread(b, "contact");
    expect((await jobRow(bj)).fetch_state).toMatchObject({ countNotTotal: true, sourceTotal: null });
    expect(await row(b, "contact", bj)).toMatchObject({ sourceCount: 150, sourceCountKind: "listed" });
    vi.restoreAllMocks();

    // A full page GoHighLevel gives no way past (no cursor, no dateAdded): reading stops early, so there may be more.
    const d = await connected("Stuck Co", "synthMigLocStuck01");
    const sd = sampleLocation("synthMigLocStuck01", d.people.manager.email);
    sd.contacts = Array.from({ length: 100 }, (_, i) => ({ id: `st${String(i).padStart(4, "0")}`, firstName: `S${i}`, email: `st${i}@example.test`, phone: null, locationId: "synthMigLocStuck01" }));
    sd.intercept = (url) => (url.pathname === "/contacts/" ? bareContactsPage(sd.contacts, url) : null);
    ghlServer(sd);
    const dj = await reread(d, "contact");
    expect(await row(d, "contact", dj)).toMatchObject({ sourceCount: 100, sourceCountKind: "at_least", truncated: true });
  });
});

describe("who the audit trail names", () => {
  it("names the person who authorized the import and the undo, and tells both the importer and whoever ran the dry run", async () => {
    const loc = "synthMigLocAudit01";
    const c = await connected("Audit Co", loc);
    ghlServer(sampleLocation(loc, c.people.manager.email));
    const job = await reread(c, "custom_field", c.actor("manager"));
    expect(await importStep(c.actor("owner"), c, "custom_field")).toBe("completed");
    const by = async (action: string) => (await one<{ actor_user_id: string | null }>("select actor_user_id from audit_logs where org_id = $1 and action = $2 order by id", [c.org.id, action])).map((a) => a.actor_user_id);
    expect(await by("crm.import_completed")).toEqual([c.people.owner.id]);
    expect(new Set(await by("crm.field_created"))).toEqual(new Set([c.people.owner.id]));
    const notified = await one<{ user_id: string }>("select user_id from notifications where org_id = $1 and kind = 'crm_import_finished' order by user_id", [c.org.id]);
    expect(notified.map((x) => x.user_id).sort()).toEqual([c.people.owner.id, c.people.manager.id].sort());
    await undoRun(c, job);
    expect(await by("crm.import_rolled_back")).toEqual([c.people.owner.id]);
  });
});
