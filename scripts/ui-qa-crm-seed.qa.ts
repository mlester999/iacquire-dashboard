/**
 * Fictional Native CRM workspaces for isolated local browser QA (scripts/crm-browser-qa.mjs). It writes through the application's own
 * services into the embedded QA database (.data/crm-qa/database) and sends nothing anywhere: no provider is configured, every send switch
 * is off, and inbox history is recorded directly, never through a send path. Every name, email (example.test) and phone number (555-01xx)
 * is made up. Run it with the QA server stopped:
 *
 *   node scripts/run-crm-qa-seed.mjs
 *
 * Idempotent: when the QA agency already exists it adds nothing. Local passwords go to .data/crm-qa/credentials.local.json (gitignored,
 * never printed); ids and counts go to .data/crm-qa/seed-summary.json.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { it } from "vitest";
import { closeDb, withSystem, type Queryable } from "../src/server/db/index";
import { env } from "../src/server/env";
import { hashPassword } from "../src/server/security/crypto";
import { applyInvitation, createInvitation, type SessionUser } from "../src/server/auth/service";
import { ensureAgentInstances } from "../src/server/workforce/service";
import { permissionsFor, roleHasPermission, type OrgRole } from "../src/lib/permissions";
import type { Membership, OrgContext } from "../src/server/tenancy/context";
import { assignStaff, createClientTenant, setGhlMapping } from "../src/server/admin/tenants";
import { saveOnboardingStep } from "../src/server/onboarding/service";
import { memberActor, type CrmActor } from "../src/server/crm/actor";
import { createContact } from "../src/server/crm/contacts";
import { createCompany } from "../src/server/crm/companies";
import { createTag, listTags } from "../src/server/crm/tags";
import { listCustomFields } from "../src/server/crm/fields";
import { createSmartList, listSmartLists } from "../src/server/crm/smart-lists";
import { addNote } from "../src/server/crm/notes";
import { listPipelines } from "../src/server/crm/pipelines";
import { closeOpportunity, createOpportunity } from "../src/server/crm/opportunities";
import { createTask, setTaskStatus } from "../src/server/crm/tasks";
import { listCalendars, setCalendarPublic, setHostAvailability, updateAppointmentType, updateCalendar } from "../src/server/calendars/setup";
import { activateCalendar } from "../src/server/calendars/activation";
import { computeSlots, loadBookingContext } from "../src/server/calendars/availability";
import { bookNativeAppointment, cancelNativeAppointment, setNativeAppointmentStatus } from "../src/server/calendars/booking";
import { getForm, listForms, publishForm, updateFormSettings } from "../src/server/crm/forms/definitions";
import { handleHostedSubmit, hostedFormToken } from "../src/server/crm/forms/public";
import { processFormSubmissions } from "../src/server/crm/forms/process";
import { listCustomValues, updateCustomValue } from "../src/server/crm/custom-values";
import { approveTemplate, createCannedReply, createTemplate, listTemplates } from "../src/server/crm/message-templates";
import { createWorkflow, getWorkflow, publishWorkflow, requestWorkflowApproval, saveWorkflowDraft } from "../src/server/crm/workflows/definitions";
import { decideApproval } from "../src/server/approvals/service";
import { createCampaign } from "../src/server/crm/campaigns";
import { createReviewDestination } from "../src/server/crm/reviews";
import { logCall } from "../src/server/crm/calls";
import { createSavedReport } from "../src/server/crm/reports/definitions";
import { captureFromClient } from "../src/server/crm/blueprints/capture";
import { getBlueprint, listStarters, publishBlueprint } from "../src/server/crm/blueprints/library";

const DATA_DIR = path.resolve(".data/crm-qa");
const CRED_FILE = path.join(DATA_DIR, "credentials.local.json");
const SUMMARY_FILE = path.join(DATA_DIR, "seed-summary.json");
const APP_URL = "http://localhost:3230";
const AGENCY_SLUG = "iacquire-qa";
const STARTER_KEY = "home-services-starter";
const TZ = "America/Chicago";
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Guard, bookkeeping
// ---------------------------------------------------------------------------

const qaDataDir = () => (process.env.PGLITE_DATA_DIR ?? "").replace(/\\/g, "/");
/**
 * True when this process points at the CRM QA database. scripts/ui-qa.vitest.config.ts also runs the messaging and sites seeds, and
 * their documented commands (no file filter) run this file too, under their own QA database: there this seed skips itself instead of
 * failing. Under the CRM runner, which always sets this directory, the full guard below still refuses anything that is not isolated.
 */
const crmQaDatabaseSelected = qaDataDir().startsWith(".data/crm-qa/");

function assertIsolatedDatabase() {
  const e = env();
  const dataDir = qaDataDir();
  if (e.NODE_ENV === "production" || e.AUTH_PROVIDER !== "local" || e.DATABASE_DRIVER !== "pglite" || (e.DATABASE_URL ?? "") !== "" || !dataDir.startsWith(".data/crm-qa/")) {
    throw new Error("Refusing to seed outside the isolated CRM QA database (local sign-in, embedded pglite in .data/crm-qa). Use node scripts/run-crm-qa-seed.mjs.");
  }
}

/** Steps that may fail without stopping the rest (each failure is reported in the summary, never hidden). */
const warnings: string[] = [];
const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 400);
async function step<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    warnings.push(`${label}: ${message(err)}`);
    console.warn(`[crm-qa seed] ${label} did not complete: ${message(err)}`);
    return null;
  }
}

type Role = "agency_admin" | "agency_staff" | "owner" | "manager" | "sales_rep" | "haven_owner" | "ghl_owner";
const credentials: { note: string; baseUrl: string; users: Partial<Record<Role, { email: string; password: string; name: string }>> } = {
  note: "Local QA passwords for the isolated CRM QA database only (.data/crm-qa). Fictional accounts. Gitignored; never commit or share.",
  baseUrl: APP_URL,
  users: {},
};
function writeCredentials() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CRED_FILE, JSON.stringify(credentials, null, 2));
}

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(sql, params))).rows;

// ---------------------------------------------------------------------------
// People and workspaces
// ---------------------------------------------------------------------------

interface LocalUser { id: string; email: string; name: string }
interface Org { id: string; name: string; slug: string; timezone: string }

const newPassword = () => `${crypto.randomBytes(18).toString("base64url")}-Qa9`;

async function createLocalUser(db: Queryable, role: Role, email: string, name: string, platformRole: "none" | "agency_staff" | "agency_super_admin" = "none"): Promise<LocalUser> {
  const password = newPassword();
  const { rows } = await db.query<{ id: string }>(
    "insert into users (email, full_name, email_verified_at, platform_role, timezone) values ($1, $2, now(), $3, $4) returning id",
    [email, name, platformRole, TZ],
  );
  await db.query("insert into auth_credentials (user_id, password_hash) values ($1, $2)", [rows[0].id, await hashPassword(password)]);
  credentials.users[role] = { email, password, name };
  return { id: rows[0].id, email, name };
}

/** A person joins a workspace the way the product does it: an invitation (no email is delivered here), accepted by that person. */
async function joinByInvitation(orgId: string, user: LocalUser, orgRole: OrgRole, invitedBy: string) {
  await withSystem(async (db) => {
    const invite = await createInvitation({ orgId, email: user.email, role: orgRole, invitedBy }, db);
    await applyInvitation(db, invite.id, user.id);
  });
}

function sessionOf(user: LocalUser, platformRole: SessionUser["platformRole"]): SessionUser {
  return { sessionId: crypto.randomUUID(), id: user.id, email: user.email, fullName: user.name, platformRole, timezone: TZ, preferences: {}, emailVerified: true };
}

function orgContext(user: LocalUser, org: Org, role: OrgRole): OrgContext {
  const membership: Membership = {
    orgId: org.id, name: org.name, slug: org.slug, kind: "client", status: "active", role, isDemo: false, onboardingCompletedAt: new Date().toISOString(), timezone: org.timezone,
  };
  return {
    user: { ...sessionOf(user, "none"), timezone: org.timezone },
    org: membership,
    role,
    permissions: permissionsFor(role),
    can: (p) => roleHasPermission(role, p),
    memberships: [membership],
  };
}

async function loadOrg(orgId: string): Promise<Org> {
  const r = (await q<Org>("select id, name, slug, timezone from organizations where id = $1", [orgId]))[0];
  if (!r) throw new Error("The client workspace was not created.");
  return r;
}

/** Marks a client as onboarded and active, as finishing onboarding would. */
async function markOnboarded(orgId: string) {
  await q("update organizations set status = 'active', onboarding_completed_at = coalesce(onboarding_completed_at, now()) where id = $1", [orgId]);
}

async function createAgencyOrg(): Promise<string> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into organizations (name, slug, kind, status, timezone, onboarding_completed_at) values ('iAcquire (QA)', $1, 'agency', 'active', $2, now()) returning id`,
      [AGENCY_SLUG, TZ],
    );
    const id = rows[0].id;
    await db.query("insert into company_profiles (org_id) values ($1) on conflict do nothing", [id]);
    await db.query("insert into usage_limits (org_id) values ($1) on conflict do nothing", [id]);
    await db.query("insert into billing_accounts (org_id) values ($1) on conflict do nothing", [id]);
    await db.query("insert into onboarding_responses (org_id) values ($1) on conflict do nothing", [id]);
    await ensureAgentInstances(id, db);
    return id;
  });
}

// ---------------------------------------------------------------------------
// Fictional records
// ---------------------------------------------------------------------------

const FIRST = ["Avery", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Quinn", "Drew", "Hayden", "Rowan", "Sage", "Emerson", "Finley", "Parker", "Reese", "Skyler", "Cameron", "Dakota", "Elliot", "Harper"];
const LAST = ["Brooks", "Santos", "Nguyen", "Reyes", "Patel", "Kim", "Lopez", "Garcia", "Martinez", "Cruz", "Bautista", "Mendoza", "Ramos", "Tan", "Lim", "Villanueva", "Aquino", "Okafor", "Novak", "Lindqvist"];
const CITIES = ["Austin", "Round Rock", "Cedar Park", "Pflugerville", "Georgetown"];
const SOURCES = ["Website form", "Referral", "Google Ads", "Facebook", "Yard sign", "Repeat customer"];
const STATUSES = ["new", "contacted", "qualified", "open", "customer", "new", "unqualified", "inactive"] as const;
const TRADES = ["Roofing", "Plumbing", "Electrical", "Heating and cooling", "General repairs"];
/** 555-0100 to 555-0199 are reserved for fiction. 0100-0159 are the seeded contacts; 0170+ are form and booking visitors. */
const phone = (n: number) => `+1512555${String(n).padStart(4, "0")}`;
const isoDate = (t: number) => new Date(t).toISOString().slice(0, 10);

async function tagIdsByName(actor: CrmActor, wanted: Array<[string, string]>): Promise<Map<string, string>> {
  const out = new Map((await listTags(actor)).map((t) => [t.name, t.id] as const));
  for (const [name, color] of wanted) if (!out.has(name)) out.set(name, (await createTag(actor, { name, color })).id);
  return out;
}

// ---------------------------------------------------------------------------
// Client 1: Brightside Roofing (QA)
// ---------------------------------------------------------------------------

interface Brightside {
  org: Org;
  owner: LocalUser;
  manager: LocalUser;
  rep: LocalUser;
  ids: Record<string, string | null>;
  onboardingBlueprint: unknown;
}

async function seedBrightside(admin: SessionUser, staffId: string): Promise<Brightside> {
  const created = await createClientTenant(admin, {
    name: "Brightside Roofing (QA)", ownerEmail: "brightside.owner@example.test", industry: "Home Services", website: "", timezone: TZ, crmMode: "native",
    blueprint: { kind: "starter", starterKey: STARTER_KEY },
  });
  if (created.blueprint && created.blueprint.status === "failed") warnings.push(`Brightside starter Blueprint: ${created.blueprint.error ?? "failed"}`);
  const people = await withSystem(async (db) => ({
    owner: await createLocalUser(db, "owner", "brightside.owner@example.test", "Bailey Brightside (QA owner)"),
    manager: await createLocalUser(db, "manager", "brightside.manager@example.test", "Morgan Manager (QA)"),
    rep: await createLocalUser(db, "sales_rep", "brightside.rep@example.test", "Riley Rep (QA)"),
  }));
  writeCredentials();
  await joinByInvitation(created.orgId, people.owner, "owner", admin.id);
  await joinByInvitation(created.orgId, people.manager, "admin", admin.id);
  await joinByInvitation(created.orgId, people.rep, "sales_rep", admin.id);
  await assignStaff(admin, created.orgId, staffId, true);
  const org = await loadOrg(created.orgId);
  const ownerCtx = orgContext(people.owner, org, "owner");
  const owner = memberActor(ownerCtx);
  const ids: Record<string, string | null> = {};

  await step("Brightside onboarding answers", () =>
    saveOnboardingStep(ownerCtx, {
      answers: {
        "a.business_name": { value: "Brightside Roofing (QA)" }, "a.industry": { value: "home_services" }, "a.business_model": { value: "local" },
        "a.description": { value: "Brightside Roofing (QA) is a fictional roofing company used for local browser QA." },
        "a.contact_phone": { value: phone(100 + 99) }, "a.contact_email": { value: "hello@brightside-roofing-qa.example.test" }, "a.territories": { value: "Austin, Round Rock, Cedar Park" },
        "b.services": { value: "Roof inspections, Storm damage repair, Gutter replacement, Roof replacement" },
        "a.hours": { value: { mon: [["08:00", "17:00"]], tue: [["08:00", "17:00"]], wed: [["08:00", "17:00"]], thu: [["08:00", "17:00"]], fri: [["08:00", "17:00"]] } },
      },
    }),
  );
  await markOnboarded(org.id);

  // Configuration values used by the starter's templates.
  await step("Brightside configuration values", async () => {
    const fill: Record<string, string> = {
      service_area: "Austin, Round Rock and Cedar Park", licence_number: "TX-QA-000123", booking_link: "https://brightside-roofing-qa.example.test/book",
      warranty_link: "https://brightside-roofing-qa.example.test/warranty", payment_terms: "A 30% deposit to book; the rest when the job is done.",
    };
    for (const v of (await listCustomValues(owner)).values) if (fill[v.key] !== undefined && !v.value) await updateCustomValue(owner, v.id, { value: fill[v.key] });
  });

  // Tags (the starter's, plus any it didn't bring) and custom fields.
  const tags = await tagIdsByName(owner, [
    ["Roofing", "#475569"], ["Plumbing", "#2563eb"], ["Electrical", "#d97706"], ["Heating and cooling", "#ea580c"], ["General repairs", "#0891b2"],
    ["Estimate requested", "#7c3aed"], ["Maintenance plan member", "#65a30d"], ["Repeat customer", "#db2777"], ["Emergency call-out", "#dc2626"],
  ]);
  const fieldKeys = new Set((await listCustomFields(owner, "contact")).map((f) => f.key));
  const fields = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).filter(([k, v]) => fieldKeys.has(k) && v !== undefined));

  const companyIds: string[] = [];
  for (const [name, domain, industry, city] of [
    ["Harbor Point HOA (QA)", "harborpoint-qa.example.test", "Property management", "Austin"],
    ["Lakeside Property Group (QA)", "lakeside-qa.example.test", "Real estate", "Round Rock"],
    ["Oak & Pine Realty (QA)", "oakpine-qa.example.test", "Real estate", "Austin"],
    ["Cedar Park Schools Facilities (QA)", "cpsf-qa.example.test", "Education", "Cedar Park"],
    ["Hill Country Rentals (QA)", "hcrentals-qa.example.test", "Property management", "Georgetown"],
    ["Riverbend Office Park (QA)", "riverbend-qa.example.test", "Commercial property", "Pflugerville"],
  ] as const) {
    const c = await step(`company ${name}`, () => createCompany(owner, { name, website: `https://${domain}`, industry, city, region: "TX", country: "US", phone: phone(190 + companyIds.length) }));
    if (c) companyIds.push(c.id);
  }
  ids.company = companyIds[0] ?? null;

  const owners = [people.owner.id, people.manager.id, people.rep.id, null];
  const contactIds: string[] = [];
  for (let i = 0; i < 60; i++) {
    const first = FIRST[i % 20];
    const last = LAST[(i + Math.floor(i / 20) * 5) % 20];
    const trade = TRADES[i % 5];
    const t = [tags.get(trade)];
    if (i % 6 === 0) t.push(tags.get("Estimate requested"));
    if (i % 7 === 0) t.push(tags.get("Maintenance plan member"));
    if (i % 9 === 0) t.push(tags.get("Repeat customer"));
    if (i % 11 === 0) t.push(tags.get("Emergency call-out"));
    const c = await step(`contact ${i + 1}`, () =>
      createContact(owner, {
        firstName: first, lastName: last, email: `${first}.${last}.${i + 1}@example.test`.toLowerCase(), phone: phone(100 + i),
        city: CITIES[i % CITIES.length], region: "TX", country: "US", source: SOURCES[i % SOURCES.length], leadStatus: STATUSES[i % STATUSES.length],
        leadScore: i % 3 === 0 ? 40 + (i % 50) : null, ownerId: owners[i % owners.length], companyId: i % 8 === 0 && companyIds.length ? companyIds[(i / 8) % companyIds.length] : null,
        tagIds: t.filter((x): x is string => Boolean(x)),
        customFields: fields({
          service_needed: trade, urgency: ["Within a week", "Within a month", "Planning ahead", "Emergency today"][i % 4], property_type: ["House", "Apartment or flat", "Commercial property"][i % 3],
          ownership: ["Owner", "Tenant", "Property manager"][i % 3], preferred_visit_time: ["Mornings", "Afternoons", "Any time"][i % 3],
          maintenance_due: i % 7 === 0 ? isoDate(Date.now() + ((i % 25) + 3) * DAY) : undefined,
          job_details: i % 4 === 0 ? "Some shingles came loose in the last storm; a small leak above the garage." : undefined,
        }),
      }),
    );
    if (c) contactIds.push(c.id);
  }
  ids.contact = contactIds[0] ?? null;

  // Smart Lists, on top of the starter's.
  await step("Brightside smart lists", async () => {
    if (tags.get("Roofing")) await createSmartList(owner, { name: "Roofing leads (QA)", visibility: "team", filter: { op: "and", conditions: [{ field: "tags", op: "has_any", value: [tags.get("Roofing")] }] } });
    await createSmartList(owner, { name: "Unassigned new requests (QA)", visibility: "team", filter: { op: "and", conditions: [{ field: "owner", op: "is_unassigned" }, { field: "lead_status", op: "in", value: ["new", "open"] }] } });
    if (tags.get("Maintenance plan member")) await createSmartList(owner, { name: "Maintenance plan members (QA)", visibility: "team", filter: { op: "and", conditions: [{ field: "tags", op: "has_any", value: [tags.get("Maintenance plan member")] }] } });
  });

  // Deals across the Jobs pipeline, including won and lost.
  const pipelines = await listPipelines(owner, { ensureDefault: true });
  const jobs = pipelines.find((p) => p.name === "Jobs") ?? pipelines.find((p) => p.isDefault) ?? pipelines[0];
  ids.pipeline = jobs?.id ?? null;
  const dealIds: string[] = [];
  if (jobs) {
    const stage = (name: string) => jobs.stages.find((s) => s.name === name)?.id ?? jobs.stages[0].id;
    const plan: Array<[string, number, string, "open" | "won" | "lost"]> = [
      ["Roof inspection", 450, "New request", "open"], ["Gutter replacement", 2800, "New request", "open"], ["Storm damage repair", 6400, "New request", "open"], ["Skylight reseal", 900, "New request", "open"],
      ["Full roof replacement", 18500, "Estimate booked", "open"], ["Chimney flashing", 1200, "Estimate booked", "open"], ["Attic ventilation", 2100, "Estimate booked", "open"],
      ["HOA roof survey", 24000, "Estimate sent", "open"], ["Leak repair", 750, "Estimate sent", "open"], ["Soffit and fascia", 3300, "Estimate sent", "open"],
      ["Metal roof install", 21000, "Approved", "open"], ["Office park re-roof", 52000, "Approved", "open"],
      ["Shingle repair", 1600, "Job scheduled", "open"], ["Gutter guards", 1400, "Job scheduled", "open"],
      ["Garage roof", 4200, "Estimate sent", "won"], ["Hail damage claim", 9800, "Approved", "won"], ["Ridge vent", 650, "New request", "won"],
      ["Flat roof coating", 7300, "Estimate sent", "lost"], ["Solar-ready re-roof", 26000, "Estimate booked", "lost"],
    ];
    for (const [k, [name, value, stageName, outcome]] of plan.entries()) {
      const contactId = contactIds[(k * 3) % Math.max(1, contactIds.length)] ?? null;
      const d = await step(`deal ${name}`, async () => {
        const deal = await createOpportunity(owner, {
          name: `${name} (QA)`, pipelineId: jobs.id, stageId: stage(stageName), contactId, value, ownerId: owners[k % 3], source: SOURCES[k % SOURCES.length],
          expectedCloseDate: isoDate(Date.now() + (k + 5) * DAY), companyId: k === 7 || k === 11 ? companyIds[k === 7 ? 0 : 5] ?? null : null,
        });
        if (outcome === "won") await closeOpportunity(owner, deal.id, "won");
        if (outcome === "lost") await closeOpportunity(owner, deal.id, "lost", { lostReason: k % 2 ? "Chose another contractor" : "Postponed the project" });
        return deal;
      });
      if (d) dealIds.push(d.id);
    }
    ids.deal = dealIds[4] ?? dealIds[0] ?? null;
    const plans = pipelines.find((p) => p.name === "Maintenance plan renewals");
    if (plans) {
      for (const [k, name] of ["Yearly roof check renewal", "Gutter cleaning plan renewal"].entries()) {
        await step(`plan deal ${name}`, () => createOpportunity(owner, { name: `${name} (QA)`, pipelineId: plans.id, stageId: plans.stages[k % plans.stages.length].id, contactId: contactIds[7 * (k + 1)] ?? null, value: 240 + k * 60 }));
      }
    }
  }

  // Tasks and notes.
  await step("Brightside tasks", async () => {
    const tasks: Array<[string, number, string, "low" | "normal" | "high" | "urgent", number, boolean]> = [
      ["Call back about the replacement quote", -2, people.owner.id, "high", 4, false], ["Send the inspection checklist", 1, people.rep.id, "normal", 1, false],
      ["Confirm the HOA site visit", 0, people.manager.id, "urgent", 7, false], ["Chase the signed approval", 3, people.owner.id, "normal", 10, false],
      ["Order ridge vents", -1, people.manager.id, "low", 12, true], ["Ask for a review after the garage roof", 2, people.rep.id, "low", 14, false],
      ["Prepare maintenance plan options", 6, people.manager.id, "normal", 0, false], ["Schedule the gutter guard install", 4, people.rep.id, "high", 13, false],
    ];
    for (const [title, offset, assigneeId, priority, idx, done] of tasks) {
      const t = await createTask(owner, { title: `${title} (QA)`, dueAt: new Date(Date.now() + offset * DAY).toISOString(), assigneeId, priority, contactId: contactIds[idx] ?? null, opportunityId: dealIds[idx] ?? null });
      if (done) await setTaskStatus(owner, t.id, "done");
    }
  });
  await step("Brightside notes", async () => {
    if (contactIds[0]) await addNote(owner, "contact", contactIds[0], "Prefers a call after 4pm. Two-storey house with a steep pitch on the north side.");
    if (contactIds[1]) await addNote(owner, "contact", contactIds[1], "Referred by a neighbour on the same street.");
    if (contactIds[4]) await addNote(owner, "contact", contactIds[4], "Insurance adjuster visiting next week; wants us there.");
    if (companyIds[0]) await addNote(owner, "company", companyIds[0], "Board meets on the first Monday of each month to approve spending.");
    if (dealIds[4]) await addNote(owner, "opportunity", dealIds[4], "Customer is comparing three quotes; ours includes the 10-year warranty.");
  });

  // Scheduling: hosts with working hours, then the starter's draft calendar is verified and activated, and its booking page turned on.
  await step("Brightside calendar", async () => {
    const cal = (await listCalendars(owner)).find((c) => c.name === "Estimates and service visits") ?? (await listCalendars(owner))[0];
    if (!cal) throw new Error("The starter brought no calendar.");
    ids.calendar = cal.id;
    ids.calendarSlug = cal.slug;
    // Google Meet links need each host's connected Google Calendar, which QA never has: video assessments become phone assessments.
    for (const t of cal.types) {
      if (t.meetingProvider === "google_meet" || t.meetingProvider === "microsoft_teams") await updateAppointmentType(owner, t.id, { locationKind: "phone", meetingProvider: "none", locationDetail: "We call you on the number you give us" });
    }
    const weekdays = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 8 * 60, endMinute: 17 * 60 }));
    await setHostAvailability(owner, people.owner.id, { timezone: TZ, rules: weekdays });
    await setHostAvailability(owner, people.manager.id, { timezone: TZ, rules: [...weekdays, { weekday: 6, startMinute: 9 * 60, endMinute: 13 * 60 }] });
    await updateCalendar(owner, cal.id, { members: [{ userId: people.owner.id, priority: 60 }, { userId: people.manager.id, priority: 50 }] });
    const activated = await activateCalendar(owner, cal.id);
    if (!activated.activated && !activated.alreadyActive) {
      throw new Error(`activation refused: ${activated.verification.checks.filter((c) => !c.ok).map((c) => `${c.key} (${c.detail})`).join("; ")}`);
    }
    await setCalendarPublic(owner, cal.id, true);
    const onsite = cal.types.find((t) => t.name === "On-site estimate") ?? cal.types[0];
    ids.appointmentType = onsite.id;
    ids.appointmentTypeSlug = onsite.slug;
    const service = cal.types.find((t) => t.name === "Service visit") ?? onsite;
    // The booking questions the type asks (a choice gets its first option), as a customer or the office would answer them.
    const answersFor = (t: typeof onsite) => Object.fromEntries(t.questions.map((x) => [x.key, x.type === "select" ? (x.options?.[0] ?? "") : x.type === "textarea" ? "Park on the street; the side gate is open." : "QA answer"]));

    const slotsFor = (typeId: string, from: Date, to: Date, now: Date) =>
      withSystem(async (db) => computeSlots(db, await loadBookingContext(db, org.id, typeId), { from, to, now, ignoreNotice: true }));
    // Past appointments (with how they went): booked as staff at the time, then the outcome recorded.
    let back = 1;
    for (const [n, outcome] of [[0, "showed"], [1, "noshow"], [2, "showed"]] as const) {
      let day = new Date(Date.now() - back * DAY);
      while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day = new Date(day.getTime() - DAY);
      back = Math.round((Date.now() - day.getTime()) / DAY) + 2;
      const from = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 6));
      const then = new Date(from.getTime() - 3_600_000);
      const slots = await slotsFor(onsite.id, from, new Date(from.getTime() + DAY), then);
      const slot = slots[Math.min(2, slots.length - 1)];
      if (!slot || !contactIds[10 + n]) continue;
      const b = await bookNativeAppointment(owner, { typeId: onsite.id, startAt: new Date(slot.start), contact: { id: contactIds[10 + n] }, via: "staff", now: then, answers: answersFor(onsite), notes: "Seeded past visit (QA)." });
      await setNativeAppointmentStatus(owner, b.appointmentId, outcome);
    }
    // Upcoming appointments, and one cancelled.
    const now = new Date();
    const upcoming = await slotsFor(onsite.id, new Date(now.getTime() + DAY), new Date(now.getTime() + 12 * DAY), now);
    const picks = [0, 6, 13, 21, 9].map((i) => upcoming[Math.min(i, upcoming.length - 1)]).filter(Boolean);
    const used = new Set<string>();
    for (const [n, slot] of picks.entries()) {
      if (used.has(slot.start) || !contactIds[13 + n]) continue;
      used.add(slot.start);
      const b = await bookNativeAppointment(owner, { typeId: onsite.id, startAt: new Date(slot.start), contact: { id: contactIds[13 + n] }, via: "staff", answers: answersFor(onsite), notes: n === 0 ? "Gate code is on file with the office." : null });
      if (n === picks.length - 1) await cancelNativeAppointment(owner, b.appointmentId, { reason: "The customer asked to move it to next month.", by: "staff" });
      else ids[`appointment${n}`] = b.appointmentId;
    }
    if (service.id !== onsite.id) {
      const s = await slotsFor(service.id, new Date(now.getTime() + 2 * DAY), new Date(now.getTime() + 9 * DAY), now);
      if (s[3] && contactIds[19]) await bookNativeAppointment(owner, { typeId: service.id, startAt: new Date(s[3].start), contact: { id: contactIds[19] }, via: "staff", answers: answersFor(service) });
    }
  });

  // A published hosted form, with a few submissions sent the way a visitor's browser sends them, then processed.
  await step("Brightside form", async () => {
    const summary = (await listForms(owner)).find((f) => f.key === "estimate-request") ?? (await listForms(owner))[0];
    if (!summary) throw new Error("The starter brought no form.");
    await updateFormSettings(owner, summary.id, { hosted: true });
    await publishForm(owner, summary.id);
    const form = await getForm(owner, summary.id);
    ids.form = form.id;
    ids.formKey = form.key;
    const visitors = [["Nora", "Newhouse"], ["Felix", "Fairweather"], ["Ivy", "Ironwood"]];
    for (const [n, [first, last]] of visitors.entries()) {
      const raw = new Map<string, string[]>([["org", [org.slug]], ["key", [form.key]], ["t", [hostedFormToken(org.slug, form.key, Date.now() - 15_000)]]]);
      for (const question of form.draft.questions) {
        const k = `q.${question.key}`;
        const opts = question.options ?? [];
        const v =
          question.key === "first_name" ? first : question.key === "last_name" ? last
          : question.type === "email" ? `${first}.${last}.form@example.test`.toLowerCase()
          : question.type === "phone" ? phone(170 + n)
          : question.key === "postal_code" ? "78701"
          : question.key === "address" ? `${100 + n} Example Street`
          : question.type === "single_choice" || question.type === "multiple_choice" ? opts[n % Math.max(1, opts.length)]?.value
          : question.type === "long_text" ? "Water stain on the bedroom ceiling after the last storm."
          : question.type === "short_text" ? "QA answer"
          : question.type === "number" ? "2"
          : question.type === "date" ? isoDate(Date.now() + 7 * DAY)
          : question.type === "checkbox" ? "yes"
          : undefined;
        if (v !== undefined) raw.set(k, [v]);
      }
      if (form.draft.consent.text) raw.set("consent", ["yes"]);
      const res = await handleHostedSubmit({ origin: APP_URL, host: "localhost:3230", secFetchSite: "same-origin", ip: `203.0.113.${20 + n}`, now: new Date() }, raw);
      if (!res.ok) throw new Error(`submission ${n + 1} refused: ${res.message}${res.errors ? ` ${JSON.stringify(res.errors).slice(0, 200)}` : ""}`);
    }
    await processFormSubmissions({ limit: 50 });
  });

  // Message templates: approve the starter's wording that automations use, and add a template and a canned reply of the client's own.
  const templates = (await step("Brightside templates", async () => {
    const list = await listTemplates(owner);
    const approved: Record<string, string> = {};
    for (const name of ["Estimate request: received", "Estimate follow-up text", "Referral invitation", "Review request after a job"]) {
      const t = list.find((x) => x.name === name);
      if (!t) continue;
      const r = await step(`approve template ${name}`, () => approveTemplate(owner, t.id, { version: t.currentVersion, contentHash: t.contentHash }));
      if (r) approved[name] = r.id;
    }
    await createTemplate(owner, {
      name: "Storm damage check-in (QA)", channel: "sms", purpose: "service", category: "Storms",
      body: "Hi {{contact.first_name}}, it's {{business.name}}. After this week's storm, would you like a free roof check? Reply YES and we'll call you.",
    });
    await createCannedReply(owner, { name: "On our way (QA)", body: "We're on our way and should arrive in about 20 minutes.", channel: null, folderId: null, category: null });
    return approved;
  })) ?? {};

  // A workflow with one owner-approved published version and a newer working draft. It stays off (draft): nothing runs.
  await step("Brightside workflow", async () => {
    const tplId = templates["Estimate request: received"];
    const tpl = tplId ? (await listTemplates(owner)).find((t) => t.id === tplId) : undefined;
    const tagId = tags.get("Estimate requested");
    if (!tagId) throw new Error("No “Estimate requested” tag.");
    const task = { key: "book_visit", kind: "create_task", config: { title: "Book an estimate visit with {{contact.first_name}}", priority: "high", dueIn: { amount: 2, unit: "hours" }, assignee: "user", userId: people.owner.id } };
    const steps = tpl
      ? [{ key: "acknowledge", kind: "send_message", config: { templateId: tpl.id, contentHash: tpl.contentHash, channel: "email", sendAs: "sales_assistant", businessHoursOnly: true }, next: "book_visit" }, { ...task, next: null }]
      : [{ ...task, next: null }];
    const definition = { trigger: { type: "contact.tag_added", filters: { tagIds: [tagId] }, reentry: "once" }, steps };
    const wf = await createWorkflow(owner, { name: "New estimate request (QA)", description: "Acknowledges a new estimate request and asks the office to book the visit.", definition });
    ids.workflow = wf.id;
    const published = await publishWorkflow(owner, wf.id);
    if (published.needsApproval) {
      const req = await requestWorkflowApproval(owner, wf.id, published.versionId, { activate: false });
      if (req.approvalId && req.status === "requested") await decideApproval(ownerCtx, req.approvalId, "approve", "Approved for QA; it stays off.");
    }
    const current = await getWorkflow(owner, wf.id);
    const draftSteps = [
      ...steps.slice(0, -1).map((s) => ({ ...s, next: "wait_a_bit" })),
      { key: "wait_a_bit", kind: "wait", config: { mode: "duration", amount: 30, unit: "minutes" }, next: "book_visit" },
      { ...task, next: null },
    ];
    await saveWorkflowDraft(owner, wf.id, { definition: { ...definition, steps: draftSteps }, expectedRevision: current.draftRevision });
  });

  // Inbox history, recorded directly (never through a send path; no provider is enabled).
  await step("Brightside inbox history", async () => {
    const threads: Array<{ contact: number; channel: "sms" | "email" | "whatsapp"; subject?: string; owned: boolean; messages: Array<[("in" | "out" | "note"), string, number]> }> = [
      { contact: 20, channel: "sms", owned: true, messages: [["in", "Hi, do you have an inspection slot this week?", 30], ["out", "Hi! We have Thursday at 10am or Friday at 2pm. Which suits you?", 29], ["in", "Thursday works. What does it cost?", 2]] },
      { contact: 21, channel: "email", subject: "Quote for a full replacement", owned: false, messages: [["in", "Could you send me a quote for replacing the whole roof? It's a 1,900 sq ft single-storey house.", 50], ["note", "Asked Morgan to price this up from the satellite view first.", 49]] },
      { contact: 22, channel: "whatsapp", owned: true, messages: [["in", "Is the crew still coming on Saturday?", 8], ["out", "Yes, they'll arrive between 9 and 10am.", 7], ["in", "Great, thanks!", 6]] },
      { contact: 23, channel: "sms", owned: false, messages: [["in", "My gutters are overflowing again. Can someone take a look?", 1]] },
      { contact: 24, channel: "email", subject: "Invoice question", owned: true, messages: [["in", "I think I was invoiced twice for the ridge vent job.", 72], ["out", "Thanks for flagging it. I'm checking with the office and will reply today.", 70], ["note", "Duplicate invoice confirmed; refund requested.", 69]] },
      { contact: 25, channel: "sms", owned: false, messages: [["in", "Thanks for the info.", 120]] },
    ];
    for (const t of threads) {
      const contactId = contactIds[t.contact];
      if (!contactId) continue;
      await withSystem(async (db) => {
        const at = (h: number) => new Date(Date.now() - h * 3_600_000);
        const lastIn = t.messages.filter((m) => m[0] === "in").map((m) => m[2]);
        const lastOut = t.messages.filter((m) => m[0] === "out").map((m) => m[2]);
        const last = t.messages[t.messages.length - 1];
        const unread = t.messages[t.messages.length - 1][0] === "in" ? 1 : 0;
        const { rows } = await db.query<{ id: string }>(
          `insert into conversations (org_id, contact_id, channel, subject, owner_kind, owner_user_id, unread_count, last_inbound_at, last_outbound_at, last_message_at, last_message_preview, status)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, left($11, 200), 'open') returning id`,
          [org.id, contactId, t.channel, t.subject ?? null, t.owned ? "human" : "unassigned", t.owned ? people.owner.id : null, unread,
            lastIn.length ? at(Math.min(...lastIn)) : null, lastOut.length ? at(Math.min(...lastOut)) : null, at(last[2]), last[1]],
        );
        for (const [kind, body, hoursAgo] of t.messages) {
          if (kind === "in") {
            await db.query("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, created_at) values ($1, $2, 'inbound', 'contact', $3, 'received', $4)", [org.id, rows[0].id, body, at(hoursAgo)]);
          } else if (kind === "out") {
            await db.query(
              "insert into conversation_messages (org_id, conversation_id, direction, author_kind, author_user_id, body, status, scope, created_at, sent_at) values ($1, $2, 'outbound', 'human', $3, $4, 'sent', 'human', $5, $5)",
              [org.id, rows[0].id, people.owner.id, body, at(hoursAgo)],
            );
          } else {
            await db.query("insert into conversation_messages (org_id, conversation_id, direction, author_kind, author_user_id, body, status, created_at) values ($1, $2, 'internal', 'human', $3, $4, 'note', $5)", [org.id, rows[0].id, people.manager.id, body, at(hoursAgo)]);
          }
        }
        if (!ids.conversation) ids.conversation = rows[0].id;
      });
    }
  });

  await step("Brightside campaign draft", async () => {
    const list = (await listSmartLists(owner)).find((l) => l.name === "Roofing leads (QA)" || l.visibility === "team");
    const c = await createCampaign(owner, { name: "Spring roof check-up (QA draft)", channel: "email", smartListId: list?.id ?? null, templateId: templates["Referral invitation"] ?? null });
    ids.campaign = c.id;
  });
  await step("Brightside review destination", () => createReviewDestination(owner, { platform: "other", label: "Leave us a review", url: "https://reviews.example.test/brightside-roofing-qa" }));
  await step("Brightside calls", async () => {
    if (contactIds[30]) await logCall(owner, { contactId: contactIds[30], direction: "outbound", status: "completed", startedAt: new Date(Date.now() - 2 * DAY).toISOString(), durationSeconds: 340, summary: "Walked through the estimate; they want to think it over until Friday.", disposition: "Follow up" });
    if (contactIds[31]) await logCall(owner, { contactId: contactIds[31], direction: "inbound", status: "no_answer", startedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(), summary: null });
    if (contactIds[32]) await logCall(owner, { contactId: contactIds[32], direction: "outbound", status: "voicemail", startedAt: new Date(Date.now() - DAY).toISOString(), summary: "Left a message about the inspection time." });
  });
  await step("Brightside saved report", async () => {
    const r = await createSavedReport(owner, { name: "Weekly jobs pipeline (QA)", description: "Deals and pipeline for the last 30 days.", config: { filters: { range: "30d" }, sections: ["deals", "pipeline"] }, visibility: "team" });
    ids.report = r.id;
  });

  return { org, owner: people.owner, manager: people.manager, rep: people.rep, ids, onboardingBlueprint: created.blueprint };
}

// ---------------------------------------------------------------------------
// Client 2 (isolation check) and client 3 (GoHighLevel mode)
// ---------------------------------------------------------------------------

async function seedHaven(admin: SessionUser): Promise<{ org: Org; ids: Record<string, string | null> }> {
  const created = await createClientTenant(admin, { name: "Haven Dental (QA)", ownerEmail: "haven.owner@example.test", industry: "Healthcare & Wellness", timezone: "America/New_York", crmMode: "native", blueprint: null });
  const owner = await withSystem((db) => createLocalUser(db, "haven_owner", "haven.owner@example.test", "Harper Haven (QA owner)"));
  writeCredentials();
  await joinByInvitation(created.orgId, owner, "owner", admin.id);
  await markOnboarded(created.orgId);
  const org = await loadOrg(created.orgId);
  const actor = memberActor(orgContext(owner, org, "owner"));
  const ids: Record<string, string | null> = {};
  await step("Haven records", async () => {
    const tag = await createTag(actor, { name: "New patient (QA)", color: "#0d9488" });
    const people: Array<[string, string]> = [["Paula", "Pemberton"], ["Omar", "Oduya"], ["Lena", "Larsen"], ["Theo", "Tanaka"]];
    const contacts: string[] = [];
    for (const [i, [first, last]] of people.entries()) {
      contacts.push((await createContact(actor, { firstName: first, lastName: last, email: `${first}.${last}.haven@example.test`.toLowerCase(), phone: phone(160 + i), city: "Georgetown", region: "TX", country: "US", tagIds: i % 2 ? [] : [tag.id] })).id);
    }
    ids.contact = contacts[0];
    const pipe = (await listPipelines(actor, { ensureDefault: true }))[0];
    ids.deal = (await createOpportunity(actor, { name: "Whitening package (QA)", pipelineId: pipe.id, contactId: contacts[0], value: 450 })).id;
    await createTask(actor, { title: "Call Paula about her check-up (QA)", dueAt: new Date(Date.now() + DAY).toISOString(), assigneeId: owner.id, contactId: contacts[0] });
  });
  return { org, ids };
}

async function seedGhlClient(admin: SessionUser): Promise<{ org: Org; mapped: boolean }> {
  const created = await createClientTenant(admin, { name: "Cedar Valley Plumbing (QA, GoHighLevel)", ownerEmail: "cedar.owner@example.test", industry: "Home Services", timezone: TZ, crmMode: "ghl", blueprint: null });
  const owner = await withSystem((db) => createLocalUser(db, "ghl_owner", "cedar.owner@example.test", "Cedar Owner (QA, GoHighLevel)"));
  writeCredentials();
  await joinByInvitation(created.orgId, owner, "owner", admin.id);
  await markOnboarded(created.orgId);
  // A clearly fake location id, mapped without any token: the vault holds nothing for it, so every GoHighLevel read fails closed.
  const mapped = await step("GoHighLevel QA mapping", () => setGhlMapping(admin, created.orgId, { locationId: "QaFakeLocationNotReal0001", locationName: "Fake location (QA only, not a real GoHighLevel location)" }));
  return { org: await loadOrg(created.orgId), mapped: mapped !== null };
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

async function countsFor(orgId: string): Promise<Record<string, number>> {
  const n = async (sql: string) => Number((await q<{ n: string }>(sql, [orgId]))[0]?.n ?? 0);
  return {
    members: await n("select count(*)::text as n from organization_memberships where org_id = $1 and status = 'active'"),
    contacts: await n("select count(*)::text as n from contacts where org_id = $1 and deleted_at is null"),
    contactTags: await n("select count(*)::text as n from crm_contact_tags where org_id = $1"),
    fieldValues: await n("select count(*)::text as n from crm_field_values where org_id = $1"),
    companies: await n("select count(*)::text as n from crm_companies where org_id = $1 and deleted_at is null"),
    tags: await n("select count(*)::text as n from crm_tags where org_id = $1"),
    customFields: await n("select count(*)::text as n from crm_custom_fields where org_id = $1"),
    customValues: await n("select count(*)::text as n from crm_custom_values where org_id = $1"),
    smartLists: await n("select count(*)::text as n from crm_smart_lists where org_id = $1"),
    pipelines: await n("select count(*)::text as n from crm_pipelines where org_id = $1"),
    dealsOpen: await n("select count(*)::text as n from crm_opportunities where org_id = $1 and status = 'open'"),
    dealsWon: await n("select count(*)::text as n from crm_opportunities where org_id = $1 and status = 'won'"),
    dealsLost: await n("select count(*)::text as n from crm_opportunities where org_id = $1 and status = 'lost'"),
    tasks: await n("select count(*)::text as n from tasks where org_id = $1"),
    notes: await n("select count(*)::text as n from record_notes where org_id = $1"),
    calendarsActive: await n("select count(*)::text as n from crm_calendars where org_id = $1 and status = 'active' and archived_at is null"),
    calendarsPublic: await n("select count(*)::text as n from crm_calendars where org_id = $1 and public and archived_at is null"),
    appointmentTypes: await n("select count(*)::text as n from crm_appointment_types where org_id = $1 and archived_at is null"),
    appointmentsUpcoming: await n("select count(*)::text as n from appointment_refs where org_id = $1 and status in ('new', 'confirmed') and start_at > now()"),
    appointmentsPast: await n("select count(*)::text as n from appointment_refs where org_id = $1 and status in ('showed', 'noshow')"),
    appointmentsCancelled: await n("select count(*)::text as n from appointment_refs where org_id = $1 and status = 'cancelled'"),
    formsPublished: await n("select count(*)::text as n from crm_forms where org_id = $1 and status = 'published'"),
    formSubmissions: await n("select count(*)::text as n from crm_form_submissions where org_id = $1"),
    formSubmissionsProcessed: await n("select count(*)::text as n from crm_form_submissions where org_id = $1 and status = 'processed'"),
    templates: await n("select count(*)::text as n from crm_message_templates where org_id = $1"),
    templatesApproved: await n("select count(*)::text as n from crm_message_templates where org_id = $1 and status = 'approved'"),
    workflows: await n("select count(*)::text as n from crm_workflows where org_id = $1"),
    workflowVersionsApproved: await n("select count(*)::text as n from crm_workflow_versions where org_id = $1 and approved_at is not null"),
    workflowsActive: await n("select count(*)::text as n from crm_workflows where org_id = $1 and status = 'active'"),
    workflowRuns: await n("select count(*)::text as n from crm_workflow_runs where org_id = $1"),
    conversations: await n("select count(*)::text as n from conversations where org_id = $1"),
    messages: await n("select count(*)::text as n from conversation_messages where org_id = $1"),
    messagesQueuedOrSending: await n("select count(*)::text as n from conversation_messages where org_id = $1 and status in ('queued', 'sending')"),
    campaigns: await n("select count(*)::text as n from crm_campaigns where org_id = $1"),
    reviewDestinations: await n("select count(*)::text as n from crm_review_destinations where org_id = $1"),
    calls: await n("select count(*)::text as n from crm_call_records where org_id = $1"),
    savedReports: await n("select count(*)::text as n from crm_report_definitions where org_id = $1 and archived_at is null"),
    setupInstances: await n("select count(*)::text as n from client_setup_instances where org_id = $1"),
    blueprintApplications: await n("select count(*)::text as n from crm_blueprint_applications where org_id = $1"),
    ghlMappings: await n("select count(*)::text as n from ghl_location_mappings where org_id = $1"),
    credentials: await n("select count(*)::text as n from integration_credentials where org_id = $1"),
  };
}

// ---------------------------------------------------------------------------
// The seed
// ---------------------------------------------------------------------------

async function seed() {
  assertIsolatedDatabase();
  const existing = await q<{ id: string }>("select id from organizations where slug = $1 and kind = 'agency'", [AGENCY_SLUG]);
  if (existing.length) {
    let complete = false;
    try {
      complete = JSON.parse(fs.readFileSync(SUMMARY_FILE, "utf8")).complete === true;
    } catch {
      complete = false;
    }
    if (!complete) throw new Error("A previous CRM QA seed did not finish. Stop the QA server, delete .data/crm-qa and run node scripts/run-crm-qa-seed.mjs again.");
    console.log("[crm-qa seed] The QA agency already exists; nothing added. Delete .data/crm-qa (with the server stopped) to start over.");
    return;
  }
  if ((await q("select 1 from users where email = 'qa.admin@example.test'")).length) {
    throw new Error("Part of an earlier CRM QA seed is in this database. Stop the QA server, delete .data/crm-qa and run the seed again.");
  }

  const agencyId = await createAgencyOrg();
  const { adminUser, staffUser } = await withSystem(async (db) => ({
    adminUser: await createLocalUser(db, "agency_admin", "qa.admin@example.test", "Avery Admin (QA agency)", "agency_super_admin"),
    staffUser: await createLocalUser(db, "agency_staff", "qa.staff@example.test", "Sam Staff (QA agency)", "agency_staff"),
  }));
  writeCredentials();
  await q("insert into organization_memberships (org_id, user_id, role) values ($1, $2, 'owner')", [agencyId, adminUser.id]);
  const admin = sessionOf(adminUser, "agency_super_admin");

  const brightside = await seedBrightside(admin, staffUser.id);
  const haven = await seedHaven(admin);
  const ghl = await seedGhlClient(admin);

  // The agency library: the starter installed by onboarding, plus a Blueprint captured from Brightside and published.
  const starterId = (await step("starter lookup", async () => (await listStarters(admin)).find((s) => s.key === STARTER_KEY)?.installedId ?? null)) ?? null;
  const captured = await step("captured Blueprint", async () => {
    const res = await captureFromClient(admin, brightside.org.id, {
      name: "Brightside Roofing setup (captured, QA)", description: "Captured from the fictional QA roofing workspace for browser QA.", industry: "home_services",
      sections: ["tags", "customFields", "pipelines", "messageTemplates"], includeValues: false,
    });
    const detail = await getBlueprint(admin, res.blueprintId);
    await publishBlueprint(admin, res.blueprintId, { revision: detail.draftRevision, changeSummary: "Captured from the QA roofing workspace." });
    return res.blueprintId;
  });

  const blueprints = Number((await q<{ n: string }>("select count(*)::text as n from crm_blueprints"))[0].n);
  const summary = {
    complete: true,
    seededAt: new Date().toISOString(),
    baseUrl: APP_URL,
    note: "Fictional QA data in the isolated embedded database. Passwords are in credentials.local.json, not here.",
    agency: { id: agencyId, slug: AGENCY_SLUG, adminEmail: adminUser.email, staffEmail: staffUser.email, staffAssignedTo: [brightside.org.id] },
    clients: {
      brightside: { ...brightside.org, mode: "native", ids: brightside.ids, onboardingBlueprint: brightside.onboardingBlueprint, counts: await countsFor(brightside.org.id) },
      haven: { ...haven.org, mode: "native", ids: haven.ids, counts: await countsFor(haven.org.id) },
      ghl: { ...ghl.org, mode: "ghl", mapped: ghl.mapped, counts: await countsFor(ghl.org.id) },
    },
    blueprints: { total: blueprints, starterId, capturedId: captured },
    users: Object.fromEntries(Object.entries(credentials.users).map(([role, u]) => [role, u ? u.email : null])),
    warnings,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
  writeCredentials();
  console.log(`[crm-qa seed] Done. Counts: ${JSON.stringify({ brightside: summary.clients.brightside.counts, haven: summary.clients.haven.counts, ghl: summary.clients.ghl.counts, blueprints })}`);
  console.log(`[crm-qa seed] ${warnings.length} step(s) did not complete${warnings.length ? `: ${warnings.join(" | ")}` : ""}.`);
  console.log(`[crm-qa seed] Summary: ${path.relative(process.cwd(), SUMMARY_FILE)}. Local passwords: ${path.relative(process.cwd(), CRED_FILE)} (gitignored, not printed).`);
}

if (!crmQaDatabaseSelected) console.log("[crm-qa seed] Skipped: PGLITE_DATA_DIR is not the CRM QA database. Seed it with node scripts/run-crm-qa-seed.mjs.");
it.skipIf(!crmQaDatabaseSelected)("seeds the isolated Native CRM browser-QA database", async () => {
  try {
    await seed();
  } finally {
    await closeDb();
  }
}, 900_000);
