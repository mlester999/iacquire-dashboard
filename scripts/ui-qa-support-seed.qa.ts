/**
 * Fictional Support & Requests data for isolated local browser QA. It writes through the application's own services into the embedded QA
 * database (.data/crm-qa/database) and sends nothing anywhere: email is captured, no AI provider or Slack webhook is configured, and
 * every name and address is made up (example.test). Run it with the QA server stopped:
 *
 *   node scripts/run-support-qa-seed.mjs
 *
 * Idempotent: when the QA support clients already exist it adds nothing. Passwords go to .data/crm-qa/support-credentials.local.json
 * (gitignored, never printed).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { it } from "vitest";
import { closeDb, withSystem } from "../src/server/db/index";
import { env } from "../src/server/env";
import { hashPassword } from "../src/server/security/crypto";
import { ensureAgentInstances } from "../src/server/workforce/service";
import { permissionsFor, roleHasPermission, type OrgRole } from "../src/lib/permissions";
import type { Membership, OrgContext } from "../src/server/tenancy/context";
import type { SessionUser } from "../src/server/auth/service";
import { submitRequest, postClientMessage } from "../src/server/support/service";
import { agencyPostMessage, assignRequest, changePriority, changeRequestStatus, escalateRequest, setFeedbackStage } from "../src/server/support/agency";
import { loadSupportSettings, updateSupportSettings } from "../src/server/support/settings";
import { stageSupportFile } from "../src/server/support/attachments";
import { createProjectRequest, decideQuote } from "../src/server/projects/client";
import { saveQuoteDraft, sendQuote, setProjectTerms, updateProjectStatus } from "../src/server/projects/agency";
import { applyInScopeRevision, classifyChangeOrder, declineChangeOrder, sendChangeQuote, submitChangeOrder } from "../src/server/projects/change-orders";
import { addPrerequisite } from "../src/server/projects/prerequisites";
import { classifyChangeRequest } from "../src/server/support/change";
import { setRequestChangesEnabled } from "../src/server/support/change-feature";

const DATA_DIR = path.resolve(".data/crm-qa");
const CRED_FILE = path.join(DATA_DIR, "support-credentials.local.json");
const TZ = "America/Chicago";

function assertIsolatedDatabase() {
  const e = env();
  const dataDir = (process.env.PGLITE_DATA_DIR ?? "").replace(/\\/g, "/");
  if (e.NODE_ENV === "production" || e.AUTH_PROVIDER !== "local" || e.DATABASE_DRIVER !== "pglite" || (e.DATABASE_URL ?? "") !== "" || !dataDir.startsWith(".data/crm-qa/")) {
    throw new Error("Refusing to seed outside the isolated QA database (local sign-in, embedded pglite in .data/crm-qa). Use node scripts/run-support-qa-seed.mjs.");
  }
}

const qaDatabaseSelected = (process.env.PGLITE_DATA_DIR ?? "").replace(/\\/g, "/").startsWith(".data/crm-qa/");
const password = () => `${crypto.randomBytes(18).toString("base64url")}-Qa9`;
const credentials: { note: string; users: Record<string, { email: string; password: string; name: string }> } = {
  note: "Local QA passwords for the isolated QA database only (.data/crm-qa). Fictional accounts. Gitignored; never commit or share.",
  users: {},
};

interface Person { id: string; email: string; name: string }

async function person(key: string, email: string, name: string, platformRole: SessionUser["platformRole"] = "none"): Promise<Person> {
  const pw = password();
  const id = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>("insert into users (email, full_name, email_verified_at, platform_role, timezone) values ($1, $2, now(), $3, $4) returning id", [email, name, platformRole, TZ]);
    await db.query("insert into auth_credentials (user_id, password_hash) values ($1, $2)", [rows[0].id, await hashPassword(pw)]);
    return rows[0].id;
  });
  credentials.users[key] = { email, password: pw, name };
  return { id, email, name };
}

async function client(name: string, slug: string) {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>("insert into organizations (name, slug, kind, status, timezone, onboarding_completed_at) values ($1, $2, 'client', 'active', $3, now()) returning id", [name, slug, TZ]);
    const id = rows[0].id;
    await db.query("insert into company_profiles (org_id, description) values ($1, 'A fictional business used for local browser QA.')", [id]);
    await db.query("insert into usage_limits (org_id) values ($1)", [id]);
    await db.query("insert into billing_accounts (org_id) values ($1)", [id]);
    await ensureAgentInstances(id, db);
    return { id, name, slug, timezone: TZ };
  });
}

const join = (orgId: string, userId: string, role: OrgRole) => withSystem((db) => db.query("insert into organization_memberships (org_id, user_id, role) values ($1, $2, $3)", [orgId, userId, role]));

function agencySession(p: Person, platformRole: SessionUser["platformRole"]): SessionUser {
  return { sessionId: crypto.randomUUID(), id: p.id, email: p.email, fullName: p.name, platformRole, timezone: TZ, preferences: {}, emailVerified: true };
}

function ctxFor(p: Person, org: { id: string; name: string; slug: string }, role: OrgRole): OrgContext {
  const membership: Membership = { orgId: org.id, name: org.name, slug: org.slug, kind: "client", status: "active", role, isDemo: false, onboardingCompletedAt: new Date().toISOString(), timezone: TZ };
  return { user: { ...agencySession(p, "none") }, org: membership, role, permissions: permissionsFor(role), can: (perm) => roleHasPermission(role, perm), memberships: [membership] };
}

const png = () => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(2048, 7)]);

/**
 * A finished AQi conversation in which the assistant could not resolve the question and offered to hand it to the team, so the
 * "Prepare support request" flow can be exercised in the browser without an AI provider. Added once; fictional text.
 */
async function seedAqiConversation() {
  await withSystem(async (db) => {
    const found = await db.query<{ user_id: string; org_id: string }>(
      "select u.id as user_id, m.org_id from users u join organization_memberships m on m.user_id = u.id join organizations o on o.id = m.org_id where u.email = 'harbor.member@example.test' and o.slug = 'harbor-dental-qa' limit 1",
    );
    if (!found.rows.length) return;
    const { user_id: userId, org_id: orgId } = found.rows[0];
    const title = "Reminder texts (QA)";
    // "Saved" is what makes a conversation appear in AQi's history; a temporary chat is not listed there.
    if ((await db.query("select 1 from aqi_conversations where user_id = $1 and title = $2", [userId, title])).rows.length) {
      await db.query("update aqi_conversations set saved_at = coalesce(saved_at, now()) where user_id = $1 and title = $2", [userId, title]);
      return;
    }
    const conv = await db.query<{ id: string }>("insert into aqi_conversations (org_id, user_id, title, page_route, saved_at) values ($1, $2, $3, '/support', now()) returning id", [orgId, userId, title]);
    const id = conv.rows[0].id;
    await db.query("insert into aqi_messages (conversation_id, org_id, user_id, role, content, status) values ($1, $2, $3, 'user', $4, 'complete')", [id, orgId, userId, "Our patients stopped getting reminder texts since Tuesday. I tried the key sk-qa-only-1234567890abcdef and my password is hunter2-QA-ONLY. What is wrong?"]);
    await db.query(
      "insert into aqi_messages (conversation_id, org_id, user_id, role, content, status, context) values ($1, $2, $3, 'assistant', $4, 'complete', $5::jsonb)",
      [id, orgId, userId, "I couldn't find a setting that explains missing reminder texts. A person at iAcquire can look at your account.", JSON.stringify({ page: "/support", sources: [], citationWarning: null, guide: null, suggestedQuestions: [], suggestSupport: true })],
    );
  });
}

/**
 * Request a Change and a project's change list, for browser QA: the feature switched on for Harbor Dental, an agreed project in development with revisions and a support period
 * recorded, changes in every state a person can see (received, a quote waiting for the owner, made as a revision, declined), one thing to confirm before handover, and a change
 * request classified by the team. Nothing is sent or charged. Added once (the project's title is the marker); fictional text.
 */
async function seedChangeRequests() {
  const people = await withSystem((db) => db.query<{ id: string; email: string; full_name: string }>(
    "select id, email::text as email, full_name from users where email = any($1::text[])",
    [["support.admin@example.test", "support.staff@example.test", "harbor.owner@example.test"]],
  ));
  const byEmail = new Map(people.rows.map((r) => [r.email, { id: r.id, email: r.email, name: r.full_name }]));
  const org = (await withSystem((db) => db.query<{ id: string; name: string; slug: string }>("select id, name, slug from organizations where slug = 'harbor-dental-qa'"))).rows[0];
  const adminP = byEmail.get("support.admin@example.test");
  const staffP = byEmail.get("support.staff@example.test");
  const ownerP = byEmail.get("harbor.owner@example.test");
  if (!org || !adminP || !staffP || !ownerP) return;
  const admin = agencySession(adminP, "agency_super_admin");
  const staff = agencySession(staffP, "agency_staff");
  const cOwner = ctxFor(ownerP, org, "owner");
  await setRequestChangesEnabled(admin, org.id, true);
  const title = "Appointment reminder follow-ups (QA)";
  if ((await withSystem((db) => db.query("select 1 from client_project_requests where org_id = $1 and title = $2", [org.id, title]))).rows.length) return;

  const { id: projectId } = await createProjectRequest(cOwner, {
    title, problem: "Patients forget appointments and our front desk spends hours phoning them.", currentProcess: "The front desk phones every patient the day before.",
    desiredOutcome: "An automatic text reminder with a reply to confirm or reschedule.", tools: ["Google Calendar"],
  });
  await updateProjectStatus(staff, projectId, { status: "under_review" });
  const draft = await saveQuoteDraft(staff, projectId, {
    projectName: title, scope: "Build the appointment reminder and confirmation flow, including replies that confirm or ask to reschedule, and connect it to the practice calendar.",
    deliverables: ["Reminder flow", "Confirmation replies", "Short usage guide"], timelineText: "3 to 4 weeks", estimatedWeeksMin: 3, estimatedWeeksMax: 4, oneTimeCents: 180000,
    revisionTerms: "Two rounds of revisions are included.", paymentTerms: "50% to begin, 50% on delivery.", warrantyTerms: "30 days of post-launch fixes.",
  });
  await sendQuote(staff, projectId, draft.id);
  await decideQuote(cOwner, draft.id, "accepted");
  await updateProjectStatus(staff, projectId, { status: "in_development" });
  await setProjectTerms(staff, projectId, { revisionsIncluded: 2, warrantyDays: 30 });

  // 1. Received and waiting for the team.
  await submitChangeOrder(cOwner, projectId, { title: "Add a Spanish version of the reminder", description: "About a third of our patients read Spanish. Could the reminder also go out in Spanish?" });
  // 2. Outside what was agreed, with a quote waiting for the owner.
  const quoted = await submitChangeOrder(cOwner, projectId, { title: "Second location calendar", description: "We opened a second office and its appointments live in another Google calendar." });
  await classifyChangeOrder(staff, quoted.id, { classification: "out_of_scope", internalNotes: "QA: they will probably ask for a discount." });
  const validUntil = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  await sendChangeQuote(staff, quoted.id, { additionalMinor: 45000, currency: "USD", weeksMin: 1, weeksMax: 2, validUntil, termsText: "Reads the second office's calendar and sends its reminders from the same flow. Includes one test with the front desk.", prerequisiteLabel: "Deposit for the second location received" });
  // 3. A revision the agreement includes, already made.
  const revision = await submitChangeOrder(cOwner, projectId, { title: "Warmer wording in the first reminder", description: "The first reminder sounds stiff. Could it say hello to the patient by first name?" });
  await classifyChangeOrder(staff, revision.id, { classification: "in_scope_revision" });
  await applyInScopeRevision(staff, revision.id, "Wording updated in the next build.");
  // 4. Declined by the team.
  const declined = await submitChangeOrder(cOwner, projectId, { title: "Build us a patient mobile app", description: "Could you also build a mobile app where patients see their appointments?" });
  await declineChangeOrder(staff, declined.id, "That is a new project, so please request it as one and we will scope it properly.");
  // Something a person confirms before the handover.
  await addPrerequisite(staff, projectId, { kind: "content", label: "Final reminder wording signed off by the practice manager", blocks: "handover" });

  // A change request on its own, classified by the team.
  const request = await submitRequest(cOwner, { requestType: "change", subject: "Greet patients by first name on the phone", message: "Our AI receptionist says hello but never uses the patient's name. Can it do that when it knows who is calling?", category: "change_ai_employee" });
  await classifyChangeRequest(staff, request.id, { classification: "covered", note: "QA: part of the receptionist's own settings." });
}

it("seeds fictional Support & Requests data for local browser QA", async () => {
  if (!qaDatabaseSelected) {
    console.log("[support-qa seed] skipped: this run is not using the isolated QA database.");
    return;
  }
  assertIsolatedDatabase();
  try {
    const existing = await withSystem((db) => db.query("select 1 from organizations where slug = 'harbor-dental-qa'"));
    if (existing.rows.length) {
      await seedAqiConversation();
      await seedChangeRequests();
      console.log("[support-qa seed] Harbor Dental (QA) already exists; only the AQi conversation and the Request a Change data were ensured.");
      return;
    }
    const adminP = await person("agency_super_admin", "support.admin@example.test", "Sam Superadmin (QA)", "agency_super_admin");
    const managerP = await person("agency_manager", "support.manager@example.test", "Maya Manager (QA)", "agency_manager");
    const staffP = await person("agency_staff", "support.staff@example.test", "Stan Staff (QA)", "agency_staff");
    const staff2P = await person("agency_staff_unassigned", "support.staff2@example.test", "Olga Outside (QA)", "agency_staff");
    const harbor = await client("Harbor Dental (QA)", "harbor-dental-qa");
    const other = await client("Northwind Bakery (QA)", "northwind-bakery-qa");
    const owner = await person("owner", "harbor.owner@example.test", "Olivia Harbor (QA owner)");
    const manager = await person("client_manager", "harbor.manager@example.test", "Marcus Harbor (QA manager)");
    const member = await person("member", "harbor.member@example.test", "Mia Harbor (QA team member)");
    const viewer = await person("viewer", "harbor.viewer@example.test", "Victor Harbor (QA viewer)");
    const otherOwner = await person("other_owner", "northwind.owner@example.test", "Nora Northwind (QA owner)");
    await join(harbor.id, owner.id, "owner"); await join(harbor.id, manager.id, "admin"); await join(harbor.id, member.id, "member"); await join(harbor.id, viewer.id, "viewer");
    await join(other.id, otherOwner.id, "owner");
    await withSystem(async (db) => {
      await db.query("insert into staff_assignments (org_id, user_id, assigned_by) values ($1, $2, $3), ($4, $5, $3)", [harbor.id, staffP.id, adminP.id, other.id, staff2P.id]);
    });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CRED_FILE, JSON.stringify(credentials, null, 2));

    const admin = agencySession(adminP, "agency_super_admin");
    const mgr = agencySession(managerP, "agency_manager");
    const staff = agencySession(staffP, "agency_staff");
    const cMember = ctxFor(member, harbor, "member");
    const cOwner = ctxFor(owner, harbor, "owner");
    const cManager = ctxFor(manager, harbor, "admin");
    const cOther = ctxFor(otherOwner, other, "owner");

    // Response targets, shown to clients, in the agency's time zone.
    await updateSupportSettings(admin, {
      timezone: TZ, targetsEnabled: true, showTargetsToClients: true, businessHoursOnly: true,
      firstResponseMinutes: { urgent: 60, high: 240, normal: 480, low: 960 }, followUpMinutes: { urgent: 30, high: 120, normal: 240, low: 480 },
      overdueEscalationMinutes: 240, autoCloseResolvedDays: 30,
    }, (await loadSupportSettings()).revision);

    // 1. An integration question with a full conversation and a private note.
    const calendar = await submitRequest(cMember, { subject: "Google calendar isn't syncing our appointments", message: "Since Monday our Google calendar shows no new appointments, but the portal says they were booked. We have two dentists using it.", category: "integrations", affectedFeature: "appointments", pageContext: "/crm/calendar" });
    await assignRequest(mgr, calendar.id, staffP.id);
    await agencyPostMessage(staff, calendar.id, { body: "INTERNAL: connection shows read-only scope. Likely needs re-consent.", internal: true });
    await agencyPostMessage(staff, calendar.id, { body: "Thanks for the detail. Which Google account is connected: the practice's shared one, or a personal account?", status: "waiting_for_client" });
    await postClientMessage(cMember, calendar.id, { body: "It's the practice's shared account, front-desk@harbor-dental-qa.example.test." });
    await changeRequestStatus(staff, calendar.id, "in_progress");

    // 2. An issue report with technical details and a screenshot.
    const shot = await stageSupportFile(member.id, harbor.id, { name: "contacts-spinner.png", bytes: png() });
    await submitRequest(cMember, {
      requestType: "issue", subject: "Contacts page keeps spinning", category: "performance", affectedFeature: "crm", clientUrgency: "soon",
      issue: { happened: "Opening Contacts shows a loading spinner that never finishes.", expected: "A list of our patients' contact records.", steps: "1. Click Contacts\n2. Wait" },
      shareDiagnostics: true, diagnostics: { page: "/crm/contacts", browser: "Chrome 129", os: "Windows", appVersion: "qa", capturedAt: new Date().toISOString(), timezone: TZ, screen: "1440x900", language: "en-US" },
      attachmentIds: [shot.id],
    });

    // 3. Feedback at different stages.
    const planned = await submitRequest(cOwner, { requestType: "feedback", subject: "Let us tag messages in the inbox", message: "It would help our front desk sort patient messages. Tags like 'billing' and 'reschedule'.", category: "feature_suggestion", affectedFeature: "inbox" });
    await setFeedbackStage(staff, planned.id, "under_review");
    await setFeedbackStage(staff, planned.id, "planned", "On the product team's list for a future release.");
    await submitRequest(cMember, { requestType: "feedback", subject: "The new dashboard is great", message: "Really like seeing appointments and approvals together. Thank you!", category: "positive_feedback" });

    // 4. A resolved request the client may still reopen.
    const billing = await submitRequest(cMember, { subject: "Question about this month's credits", message: "Our credits dropped faster than expected. Can someone explain what used them?", category: "billing", affectedFeature: "billing" });
    await agencyPostMessage(staff, billing.id, { body: "Your credits covered 412 AI messages and two lead research runs this month. The usage page lists each one.", status: "resolved" });

    // 5. A new, unassigned, high-priority request that is already late.
    const late = await submitRequest(cOwner, { subject: "We can't invite a new hygienist", message: "The invite button says I don't have permission, but I'm the owner.", category: "account", affectedFeature: "settings", clientUrgency: "blocking" });
    await changePriority(mgr, late.id, "high", "Blocks onboarding a new employee");
    await withSystem((db) => db.query("update support_ticket_ops set response_due_at = now() - interval '3 hours', response_started_at = now() - interval '11 hours' where ticket_id = $1", [late.id]));

    // 6. An escalated issue.
    const down = await submitRequest(cManager, { requestType: "issue", subject: "Patient reminders stopped going out", category: "feature_not_working", affectedFeature: "appointments", clientUrgency: "blocking", issue: { happened: "No appointment reminders have been sent since Tuesday and patients are no-showing." } });
    await changePriority(mgr, down.id, "urgent", "Revenue impact");
    await escalateRequest(staff, down.id, "Possible messaging outage: three clients report the same.");
    await agencyPostMessage(staff, down.id, { body: "We're looking at this now and will update you within the hour.", status: "in_progress" });

    // 7. Another client's request, for the isolation checks.
    await submitRequest(cOther, { subject: "Oven schedule not appearing in the calendar", message: "Our bakery production schedule isn't showing up.", category: "crm" });

    await seedAqiConversation();
    await seedChangeRequests();

    const settings = await loadSupportSettings();
    console.log(`[support-qa seed] done. Targets ${settings.targetsEnabled ? "on" : "off"}; credentials written to ${path.relative(process.cwd(), CRED_FILE)}.`);
  } finally {
    await closeDb();
  }
}, 120_000);
