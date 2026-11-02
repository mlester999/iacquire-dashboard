// The launch-readiness facts, read from a real (test) database: a client's own records decide every line of the answer, a drafted calendar is not a calendar that takes bookings, and
// another client's work never moves this client's state. Test database only; no Hermes writes, nothing sent, nobody booked.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The Setup page and its notice action read the signed-in workspace and the cookie jar: here they are a fixture's context and a map. Nothing is rendered by a browser.
const mocks = vi.hoisted(() => ({ ctx: null as unknown, jar: new Map<string, string>(), deleted: [] as Array<{ name: string; path?: string }> }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (mocks.jar.has(name) ? { name, value: mocks.jar.get(name)! } : undefined),
    delete: (target: string | { name: string; path?: string }) => {
      const { name, path } = typeof target === "string" ? { name: target, path: undefined } : target;
      mocks.jar.delete(name);
      mocks.deleted.push({ name, path });
    },
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/setup" }));
vi.mock("@/server/tenancy/context", async (original) => ({ ...(await original<typeof import("@/server/tenancy/context")>()), requireOrgContext: async () => mocks.ctx, requireOrgContextOrThrow: async () => mocks.ctx }));

import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { fingerprintOf, type LaunchItem, type LaunchReadiness } from "@/lib/launch-readiness";
import type { OrgContext } from "@/server/tenancy/context";
import { LaunchReadinessPanel } from "@/components/setup/launch-readiness-panel";
import SetupPage from "@/app/(portal)/setup/page";
import { dismissCalendarNoticeAction, getLaunchReadinessAction } from "@/app/actions/launch-readiness";
import { CALENDAR_NOTICE_COOKIE, CALENDAR_NOTICE_COOKIE_OPTIONS, calendarNoticeFor, encodeCalendarNotice, noticeSurfaceOf } from "@/server/calendars/connections";
import { getLaunchReadiness, loadLaunchFacts } from "@/server/setup/launch-readiness";
import { startLaunchVerification } from "@/server/setup/launch-intents";
import { activateCalendar, applyCalendarHoursTemplate, verifyCalendar } from "@/server/calendars/activation";
import { updateCalendar } from "@/server/calendars/setup";
import { getWorkspace } from "@/server/crm/workspace";
import { recordAudit } from "@/server/audit";
import { statedSender } from "@/server/onboarding/connection-facts";
import { listChannelStatus } from "@/server/messaging/channels";
import { AgencyChannelSetup } from "@/components/crm/communications/agency-channel-setup";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { crmOrg } from "./support/crm";
import { clearSetupPayment, submitRealOnboarding } from "./support/billing";
import { makeRuntimeReady } from "./support/runtime-ready";
import { applyRealBlueprint, readyClient, settled } from "./support/launch";

const itemOf = (r: LaunchReadiness, key: string) => r.steps.flatMap((s) => s.items).find((i) => i.key === key)!;
const stepOf = (r: LaunchReadiness, key: string) => r.steps.find((s) => s.key === key)!;

/** A client workspace that has submitted its questionnaire and paid, with a DRAFT booking calendar of the kind onboarding makes: no host, suggested weekdays 9 to 5. */
async function clientWithDraftCalendar(opts: { name: string; timezone: string; template?: boolean }) {
  const c = await crmOrg({ name: opts.name, timezone: opts.timezone });
  await withSystem((db) => db.query("update organizations set onboarding_completed_at = now() where id = $1", [c.org.id]));
  await clearSetupPayment(c.org.id);
  // The client's own answers, as the questionnaire stores them: they book appointments, in this time zone.
  await withSystem(async (db) => {
    await db.query("insert into onboarding_answers (org_id, question_id, value) values ($1, 'b.appointments', 'true'::jsonb), ($1, 'a.timezone', to_jsonb($2::text))", [c.org.id, opts.timezone]);
  });
  const hours = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
  const calendarId = (await withSystem((db) => db.query<{ id: string }>(
    `insert into crm_calendars (org_id, name, slug, status, origin, timezone, hours_template, is_default, public)
     values ($1, 'Consultations', 'consultations', 'draft', 'onboarding', $2, $3::jsonb, false, false) returning id`,
    [c.org.id, opts.timezone, JSON.stringify(opts.template === false ? [] : hours)],
  ))).rows[0].id;
  // The type is made by an owner who can manage calendars; it belongs to the draft calendar, which has no host yet.
  await withSystem((db) => db.query(
    `insert into crm_appointment_types (org_id, calendar_id, name, slug, duration_minutes, min_notice_minutes, location_kind) values ($1, $2, 'Free consultation', 'free-consultation', 30, 60, 'phone')`,
    [c.org.id, calendarId],
  ));
  return { ...c, calendarId, ownerCtx: ctxFor(c.people.owner, c.org, "owner") };
}

describe("the launch facts are read from the workspace's own records", () => {
  it("says the questionnaire is submitted, and starts nothing, while the setup payment is not confirmed", async () => {
    const c = await submitRealOnboarding({ name: "Unpaid Roofing" });
    const r = (await getLaunchReadiness(c.ctx))!;
    expect(r.state).toBe("questionnaire_submitted");
    expect(r.label).toBe("Questionnaire submitted");
    // Nothing was queued, so nothing may read as in progress or done: the employees wait for the payment.
    const jobs = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from agent_provisioning_jobs where org_id = $1", [c.org.id]));
    expect(jobs.rows[0].n).toBe(0);
    expect(AGENT_ROLE_KEYS.every((role) => itemOf(r, `employees.${role}`).state === "action_required" && itemOf(r, `employees.${role}`).detail.includes("setup payment"))).toBe(true);
    expect(r.percent).toBeLessThan(100);
  }, 120_000);

  it("after payment, a queued profile is in progress and never counted as ready: six employees are registered, none are done", async () => {
    const c = await submitRealOnboarding({ name: "Paid Roofing", clearPayment: true });
    const r = (await getLaunchReadiness(c.ctx))!;
    expect(["provisioning", "action_required"]).toContain(r.state);
    expect(r.state).not.toBe("ready_to_launch");
    for (const role of AGENT_ROLE_KEYS) {
      const item = itemOf(r, `employees.${role}`);
      expect(item.state, role).not.toBe("done");
      expect(item.required).toBe(true);
    }
    // The company profile the client typed is read back from the workspace, not assumed.
    expect(itemOf(r, "profile.company").state).toBe("done");
    expect(itemOf(r, "profile.timezone")).toMatchObject({ state: "done", detail: expect.stringContaining("America/Chicago") });
    expect(stepOf(r, "verification").state).not.toBe("done");
  }, 120_000);

  it("walks a drafted calendar to an active one through the real services, and a draft never counts as taking bookings", async () => {
    const c = await clientWithDraftCalendar({ name: "Walk Dental", timezone: "Asia/Manila" });
    const actor = c.actor("owner");
    let r = (await getLaunchReadiness(c.ownerCtx))!;
    expect(itemOf(r, "calendar.host")).toMatchObject({ state: "action_required", action: { intent: "assign_host" } });
    expect(itemOf(r, "calendar.hours").state).toBe("in_progress");
    expect(itemOf(r, "calendar.types").state).toBe("done");
    expect(itemOf(r, "calendar.active").state).toBe("in_progress");
    expect((await loadLaunchFacts(c.ownerCtx))!.appointments.calendar).toMatchObject({ status: "draft", hosts: 0, hasSuggestedHours: true, types: 1, checks: null, bookingPageOn: false });

    // The client picks a host (themselves). Hours still do not exist, and the suggested ones are offered, not applied.
    await updateCalendar(actor, c.calendarId, { members: [{ userId: c.people.owner.id }] });
    r = (await getLaunchReadiness(c.ownerCtx))!;
    expect(itemOf(r, "calendar.host").state).toBe("done");
    expect(itemOf(r, "calendar.hours")).toMatchObject({ state: "action_required", action: { intent: "apply_hours" } });
    expect(itemOf(r, "calendar.verified").state).toBe("in_progress");
    expect(itemOf(r, "calendar.active").state).toBe("in_progress");

    // Approving the suggested hours gives the host the weekly hours; the checks can then run, and activation is the client's click.
    expect((await applyCalendarHoursTemplate(actor, c.calendarId)).applied).toEqual([c.people.owner.id]);
    r = (await getLaunchReadiness(c.ownerCtx))!;
    expect(itemOf(r, "calendar.hours").state).toBe("done");
    expect(itemOf(r, "calendar.active")).toMatchObject({ state: "action_required", action: { intent: "activate_calendar" } });
    expect(stepOf(r, "calendar").state).toBe("action_required");

    const activation = await activateCalendar(actor, c.calendarId);
    expect(activation.activated).toBe(true);
    r = (await getLaunchReadiness(c.ownerCtx))!;
    expect(itemOf(r, "calendar.active").state).toBe("done");
    expect(itemOf(r, "calendar.verified")).toMatchObject({ state: "done" });
    // The public booking page was never turned on by any of this.
    expect(itemOf(r, "calendar.public")).toMatchObject({ required: false, detail: expect.stringContaining("off") });
    expect(stepOf(r, "calendar").state).toBe("done");
  }, 120_000);

  it("never invents hours: with no suggested hours the host must set their own", async () => {
    const c = await clientWithDraftCalendar({ name: "No Template Clinic", timezone: "Europe/London", template: false });
    await updateCalendar(c.actor("owner"), c.calendarId, { members: [{ userId: c.people.owner.id }] });
    const r = (await getLaunchReadiness(c.ownerCtx))!;
    expect(itemOf(r, "calendar.hours")).toMatchObject({ state: "action_required", action: { href: "/crm/availability" } });
    expect(itemOf(r, "calendar.hours").action?.intent).toBeUndefined();
    await expect(applyCalendarHoursTemplate(c.actor("owner"), c.calendarId)).rejects.toThrow(/no suggested hours/i);
    expect(((await verifyCalendar(c.actor("owner"), c.calendarId)).checks.find((k) => k.key === "hours"))?.ok).toBe(false);
  }, 120_000);

  it("marks the calendar not applicable when the client said they do not book appointments, and keeps the Appointment Setter out of the way", async () => {
    const c = await submitRealOnboarding({ name: "No Booking Plumbing", clearPayment: true });
    await withSystem((db) => db.query("update onboarding_answers set value = 'false'::jsonb where org_id = $1 and question_id = 'b.appointments'", [c.org.id]));
    const r = (await getLaunchReadiness(c.ctx))!;
    expect(stepOf(r, "calendar").state).toBe("not_applicable");
    expect(itemOf(r, "employees.appointment_setter").state).toBe("not_applicable");
    expect(itemOf(r, "verification.appointment_setter").state).toBe("not_applicable");
    expect(r.blocking.map((i) => i.key)).not.toContain("calendar.host");
  }, 120_000);

  it("keeps a client's state its own: another client's calendar, employees and checks never change it", async () => {
    const a = await clientWithDraftCalendar({ name: "Isolation A", timezone: "Asia/Manila" });
    const b = await clientWithDraftCalendar({ name: "Isolation B", timezone: "America/Denver" });
    await updateCalendar(b.actor("owner"), b.calendarId, { members: [{ userId: b.people.owner.id }] });
    await applyCalendarHoursTemplate(b.actor("owner"), b.calendarId);
    await activateCalendar(b.actor("owner"), b.calendarId);
    for (const role of AGENT_ROLE_KEYS) {
      const agent = (await withSystem((db) => db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = $2", [b.org.id, role]))).rows[0];
      await makeRuntimeReady(agent.id, b.org.id, b.people.owner.id);
    }
    const ra = (await getLaunchReadiness(a.ownerCtx))!;
    const rb = (await getLaunchReadiness(b.ownerCtx))!;
    expect(itemOf(ra, "calendar.host").state).toBe("action_required");
    expect(itemOf(rb, "calendar.host").state).toBe("done");
    expect(itemOf(rb, "calendar.active").state).toBe("done");
    for (const role of AGENT_ROLE_KEYS) expect((ra.steps.find((s) => s.key === "employees")!.items.find((i) => i.key === `employees.${role}`)!.state), role).not.toBe("done");
    // The facts name this workspace's time zone, not the other one's.
    expect((await loadLaunchFacts(a.ownerCtx))!.profile.timezone).toBe("Asia/Manila");
    expect((await loadLaunchFacts(b.ownerCtx))!.profile.timezone).toBe("America/Denver");
  }, 120_000);

  it("returns nothing for the agency's own workspace", async () => {
    const ctx = await withSystem(async (db) => (await db.query<{ id: string }>("select id from organizations where kind = 'agency' limit 1")).rows[0]);
    if (!ctx) return; // a test database without the agency workspace has nothing to refuse
    const user = await crmOrg({ name: "Not the agency" });
    const asAgency = ctxFor(user.people.owner, { id: ctx.id, name: "Agency", slug: "agency" }, "owner");
    expect(await loadLaunchFacts(asAgency)).toBeNull();
  }, 120_000);
});

/** A submitted, paid client with its CRM workspace and no industry setup yet: what the CRM, channel and employee facts are read from. */
async function submittedCrmClient(name: string, over: { channels?: string[]; senders?: Record<string, string> } = {}) {
  const c = await crmOrg({ name, timezone: "America/Chicago" });
  await withSystem((db) => db.query("update organizations set onboarding_completed_at = now(), industry = 'home_services' where id = $1", [c.org.id]));
  await clearSetupPayment(c.org.id);
  const answers: Record<string, unknown> = { "a.timezone": "America/Chicago", "b.appointments": false, ...(over.channels ? { "c.channels": over.channels } : {}), ...over.senders };
  await withSystem(async (db) => {
    for (const [id, value] of Object.entries(answers)) await db.query("insert into onboarding_answers (org_id, question_id, value) values ($1, $2, $3::jsonb)", [c.org.id, id, JSON.stringify(value)]);
  });
  await getWorkspace(c.actor("owner"));
  return { ...c, ctx: ctxFor(c.people.owner, c.org, "owner") };
}
type CrmClient = Awaited<ReturnType<typeof submittedCrmClient>>;
const crmOf = async (c: CrmClient) => (await getLaunchReadiness(c.ctx))!;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(sql, params))).rows;

describe("the CRM setup is judged from the Blueprint evidence in the workspace's own records", () => {
  it("is being set up while nothing has been applied and nothing has failed, and is not done", async () => {
    const c = await submittedCrmClient("Nothing Applied Roofing");
    const facts = (await loadLaunchFacts(c.ctx))!;
    expect(facts.crm).toMatchObject({ mode: "native", blueprint: "none" });
    const r = await crmOf(c);
    expect(itemOf(r, "crm.blueprint")).toMatchObject({ state: "in_progress", owner: "iacquire" });
    expect(itemOf(r, "crm.blueprint").detail).toContain("being set up");
  }, 120_000);

  it("is verified, and done, only after a real Blueprint was applied and everything it created is in the CRM", async () => {
    const c = await submittedCrmClient("Verified Roofing");
    await applyRealBlueprint(c.org.id);
    const facts = (await loadLaunchFacts(c.ctx))!;
    expect(facts.crm).toMatchObject({ blueprint: "verified", pipelineReady: true, records: { state: "in_place" } });
    expect(facts.crm.records!.tags).toBeGreaterThan(0);
    const r = await crmOf(c);
    expect(itemOf(r, "crm.blueprint")).toMatchObject({ state: "done", owner: "iacquire" });
    expect(itemOf(r, "crm.pipeline").state).toBe("done");
    expect(itemOf(r, "crm.records")).toMatchObject({ state: "done", required: false });
    expect(stepOf(r, "crm").state).toBe("done");
  }, 120_000);

  it("drops out of done when a stage the Blueprint created is deleted, and names it as iAcquire's to review", async () => {
    const c = await submittedCrmClient("Deleted Stage Roofing");
    await applyRealBlueprint(c.org.id);
    const stage = (await q<{ native_id: string }>("select native_id from crm_blueprint_links where org_id = $1 and asset_type = 'stage' order by asset_id limit 1", [c.org.id]))[0];
    expect(stage).toBeTruthy();
    await withSystem((db) => db.query("delete from crm_pipeline_stages where org_id = $1 and id = $2", [c.org.id, stage.native_id]));
    const facts = (await loadLaunchFacts(c.ctx))!;
    expect(facts.crm.blueprint).toBe("missing_records");
    expect(facts.crm.records!.state).toBe("missing");
    const r = await crmOf(c);
    expect(itemOf(r, "crm.blueprint")).toMatchObject({ state: "action_required", owner: "iacquire" });
    expect(itemOf(r, "crm.blueprint").detail).toContain("no longer in the CRM");
    expect(r.blocking.map((i) => i.key)).toContain("crm.blueprint");
    expect(r.state).toBe("action_required");
    // The pipeline still has stages, so it is not the pipeline that fails.
    expect(itemOf(r, "crm.pipeline").state).toBe("done");
  }, 120_000);

  it("is partial when the application only partly applied, and failed when it did not apply", async () => {
    const partial = await submittedCrmClient("Partial Roofing");
    await applyRealBlueprint(partial.org.id);
    await withSystem((db) => db.query("update crm_blueprint_applications set status = 'partially_applied' where org_id = $1", [partial.org.id]));
    expect((await loadLaunchFacts(partial.ctx))!.crm.blueprint).toBe("partial");
    expect(itemOf(await crmOf(partial), "crm.blueprint")).toMatchObject({ state: "action_required", owner: "iacquire", detail: expect.stringContaining("partly applied") });

    const failed = await submittedCrmClient("Failed Roofing");
    await applyRealBlueprint(failed.org.id);
    await withSystem((db) => db.query("update crm_blueprint_applications set status = 'failed', error = 'The apply stopped.' where org_id = $1", [failed.org.id]));
    expect((await loadLaunchFacts(failed.ctx))!.crm.blueprint).toBe("failed");
    const r = await crmOf(failed);
    expect(itemOf(r, "crm.blueprint")).toMatchObject({ state: "action_required", owner: "iacquire", detail: expect.stringContaining("didn't finish") });
    expect(r.state).toBe("action_required");
  }, 120_000);

  it("waits for a person when the automatic setup could not run, says so, and is overtaken by any real application", async () => {
    const c = await submittedCrmClient("Waiting Roofing");
    await withSystem((db) => recordAudit({ orgId: c.org.id, actorKind: "system", action: "crm.auto_setup_waiting_for_person", targetType: "workspace", targetId: c.org.id, result: "denied", metadata: { starterKey: "home-services", mapping: "matched" } }, db));
    expect((await loadLaunchFacts(c.ctx))!.crm.blueprint).toBe("waiting_for_a_person");
    const waiting = itemOf(await crmOf(c), "crm.blueprint");
    expect(waiting).toMatchObject({ state: "action_required", owner: "iacquire" });
    expect(waiting.detail).toContain("A person at iAcquire has to apply your industry starter");
    // The agency applies it by hand: the record of what really happened outranks the older note.
    await applyRealBlueprint(c.org.id);
    expect((await loadLaunchFacts(c.ctx))!.crm.blueprint).toBe("verified");
  }, 120_000);

  it("reads the newest automatic-setup note: a failed run is iAcquire's to look at and never done", async () => {
    const c = await submittedCrmClient("Auto Failed Roofing");
    await withSystem((db) => recordAudit({ orgId: c.org.id, actorKind: "system", action: "crm.auto_setup_failed", targetType: "workspace", targetId: c.org.id, result: "failure", metadata: { starterKey: "home-services", mapping: "closest", reason: "internal detail that must not reach the client" } }, db));
    expect((await loadLaunchFacts(c.ctx))!.crm.blueprint).toBe("failed");
    const r = await crmOf(c);
    expect(itemOf(r, "crm.blueprint")).toMatchObject({ state: "action_required", owner: "iacquire" });
    expect(JSON.stringify(r.steps)).not.toContain("internal detail");
  }, 120_000);

  it("keeps another client's setup out of this client's state", async () => {
    const a = await submittedCrmClient("Isolated CRM A");
    const b = await submittedCrmClient("Isolated CRM B");
    await applyRealBlueprint(a.org.id);
    expect((await loadLaunchFacts(a.ctx))!.crm.blueprint).toBe("verified");
    expect((await loadLaunchFacts(b.ctx))!.crm.blueprint).toBe("none");
    expect(itemOf(await crmOf(b), "crm.blueprint").state).toBe("in_progress");
  }, 120_000);

  it("needs a pipeline with at least two stages, one of them open: one stage, archived stages and a board of only closed stages are not enough", async () => {
    const pipelineWith = async (c: CrmClient, stages: Array<{ kind: string; archived?: boolean }>) => {
      const id = (await q<{ id: string }>("insert into crm_pipelines (org_id, name, provider, is_default, position) values ($1, 'Hand made', 'native', true, 0) returning id", [c.org.id]))[0].id;
      for (const [i, s] of stages.entries()) {
        await withSystem((db) => db.query("insert into crm_pipeline_stages (org_id, pipeline_id, name, kind, position, archived_at) values ($1, $2, $3, $4, $5, $6)", [c.org.id, id, `Stage ${i}`, s.kind, i, s.archived ? new Date() : null]));
      }
    };
    const pipelineReady = async (c: CrmClient) => (await loadLaunchFacts(c.ctx))!.crm.pipelineReady;
    const one = await submittedCrmClient("One Stage Roofing");
    await pipelineWith(one, [{ kind: "open" }]);
    expect(await pipelineReady(one)).toBe(false);
    expect(itemOf(await crmOf(one), "crm.pipeline").state).not.toBe("done");
    const archived = await submittedCrmClient("Archived Stage Roofing");
    await pipelineWith(archived, [{ kind: "open" }, { kind: "open", archived: true }]);
    expect(await pipelineReady(archived)).toBe(false);
    const closed = await submittedCrmClient("Closed Only Roofing");
    await pipelineWith(closed, [{ kind: "won" }, { kind: "lost" }]);
    expect(await pipelineReady(closed)).toBe(false);
    const good = await submittedCrmClient("Two Stage Roofing");
    await pipelineWith(good, [{ kind: "open" }, { kind: "won" }]);
    expect(await pipelineReady(good)).toBe(true);
    expect(itemOf(await crmOf(good), "crm.pipeline").state).toBe("done");
  }, 120_000);
});

describe("channels are read with the client's own words kept apart from what is verified", () => {
  it("shows the sender the client gave, owner iAcquire, no button, and a channel that has no credential is never connected", async () => {
    const c = await submittedCrmClient("Channels Roofing", { channels: ["sms", "email"], senders: { "c.sms_sender": "+1 512 555 0100", "c.email_sender": "hello@channels-roofing.example" } });
    const facts = (await loadLaunchFacts(c.ctx))!;
    expect(facts.channels.find((f) => f.channel === "sms")).toMatchObject({ wanted: true, enabled: false, statedSender: "+1 512 555 0100", credentialStored: false });
    expect(facts.channels.find((f) => f.channel === "whatsapp")).toMatchObject({ wanted: false, statedSender: null });
    const r = await crmOf(c);
    for (const channel of ["sms", "email"] as const) {
      const i = itemOf(r, `integrations.${channel}`);
      expect(i, channel).toMatchObject({ state: "in_progress", owner: "iacquire" });
      expect(i.action, channel).toBeUndefined();
    }
    expect(itemOf(r, "integrations.sms").detail).toContain("+1 512 555 0100");
    expect(itemOf(r, "integrations.email").detail).toContain("hello@channels-roofing.example");
    expect(stepOf(r, "integrations").state).not.toBe("done");
  }, 120_000);

  it("asks the client for the sender only when an email address or WhatsApp number was not given, and reads a pending registration as iAcquire's wait", async () => {
    const c = await submittedCrmClient("Missing Sender Roofing", { channels: ["email", "sms"] });
    await withSystem((db) => db.query("insert into messaging_channels (org_id, channel, enabled, registration_status) values ($1, 'sms', false, 'pending')", [c.org.id]));
    const r = await crmOf(c);
    expect(itemOf(r, "integrations.email")).toMatchObject({ state: "action_required", owner: "you", action: { href: "/onboarding" } });
    expect(itemOf(r, "integrations.sms")).toMatchObject({ state: "in_progress", owner: "iacquire" });
    expect(itemOf(r, "integrations.sms").detail).toContain("registration is with the carrier");
  }, 120_000);

  it("shows the agency what the client said beside the channel, marked not verified, and nothing when the client said nothing", async () => {
    const c = await submittedCrmClient("Card Hint Roofing", { channels: ["sms", "email"], senders: { "c.sms_sender": "+1 512 555 0100" } });
    const webhooks = { email: { url: "https://p.example/api/webhooks/resend", ready: true, note: "n" }, sms: { url: "https://p.example/api/webhooks/twilio/inbound", ready: true, note: "n" }, whatsapp: { url: "https://p.example/api/webhooks/meta-whatsapp", ready: true, note: "n" } };
    const render = async (statedSenders?: Record<string, string | null>) => renderToStaticMarkup(React.createElement(AgencyChannelSetup, { orgId: c.org.id, channels: await listChannelStatus(c.org.id), webhooks, superAdmin: true, timeZone: "UTC", statedSenders }));
    const hinted = await render({ sms: await withSystem((db) => statedSender(db, c.org.id, "sms")), email: await withSystem((db) => statedSender(db, c.org.id, "email")) });
    expect(hinted).toContain("Client said");
    expect(hinted).toContain("+1 512 555 0100");
    expect(hinted).toContain("Not verified");
    expect(hinted.match(/Client said/g)).toHaveLength(1);
    expect(await render()).not.toContain("Client said");
    // Showing it saved nothing: the channel still has no sender and is not verified.
    expect(await q("select 1 from messaging_channels where org_id = $1 and (sender_identity is not null or sender_verified_at is not null)", [c.org.id])).toHaveLength(0);
  }, 120_000);

  it("reads the stated sender for the agency's channel setup from confirmed answers only, and never sets a sender itself", async () => {
    const c = await submittedCrmClient("Hint Roofing", { channels: ["sms", "whatsapp"], senders: { "c.sms_sender": "  +63 917 123 4567  " } });
    expect(await withSystem((db) => statedSender(db, c.org.id, "sms"))).toBe("+63 917 123 4567");
    expect(await withSystem((db) => statedSender(db, c.org.id, "whatsapp"))).toBeNull();
    const other = await submittedCrmClient("Other Hint Roofing", { channels: ["sms"] });
    expect(await withSystem((db) => statedSender(db, other.org.id, "sms"))).toBeNull();
    // Reading the hint changed nothing: no channel row was written.
    expect(await q("select 1 from messaging_channels where org_id = $1", [c.org.id])).toHaveLength(0);
  }, 120_000);
});

describe("employees show their real provisioning and health state", () => {
  it("turns a failing connection check into action required for iAcquire, and an awaiting job with no failed check stays in progress", async () => {
    const c = await submitRealOnboarding({ name: "Health Roofing", clearPayment: true });
    const agent = await agentId(c.org.id, "sales_assistant");
    await withSystem((db) => db.query("update agent_provisioning_jobs set status = 'awaiting_health_check' where agent_instance_id = $1 and kind = 'provision'", [agent]));
    let r = (await getLaunchReadiness(c.ctx))!;
    expect(itemOf(r, "employees.sales_assistant")).toMatchObject({ state: "in_progress", owner: "system" });
    // A check that ran and failed. The recorded words are for iAcquire: the client never reads them.
    await withSystem((db) => db.query("update agent_instances set last_health_ok = false, last_health_detail = 'Hermes could not be reached at 10.9.8.7', last_health_check_at = now() where id = $1", [agent]));
    const facts = (await loadLaunchFacts(c.ctx))!;
    expect(facts.employees.find((e) => e.role === "sales_assistant")).toMatchObject({ healthFailed: true, healthDetail: "Hermes could not be reached at 10.9.8.7", provisioning: "awaiting_health_check" });
    r = (await getLaunchReadiness(c.ctx))!;
    expect(itemOf(r, "employees.sales_assistant")).toMatchObject({ state: "action_required", owner: "iacquire" });
    expect(itemOf(r, "employees.sales_assistant").detail).not.toContain("being verified");
    expect(JSON.stringify(r.steps)).not.toContain("10.9.8.7");
    expect(r.state).toBe("action_required");
    // When the check passes it is no longer a failure. It is done only once the employee is really ready for work (the Sales Assistant also waits for what its role needs), never before.
    await makeRuntimeReady(agent, c.org.id, c.owner.id);
    expect((await loadLaunchFacts(c.ctx))!.employees.find((e) => e.role === "sales_assistant")!.healthFailed).toBe(false);
    expect(itemOf((await getLaunchReadiness(c.ctx))!, "employees.sales_assistant").state).not.toBe("action_required");
  }, 120_000);

  it("reads 'Attempt n of 3' for a failed job that will be retried, and failed with iAcquire as the owner once the attempts are used", async () => {
    const c = await submitRealOnboarding({ name: "Attempts Roofing", clearPayment: true });
    const agent = await agentId(c.org.id, "lead_hunter");
    await withSystem((db) => db.query("update agent_provisioning_jobs set status = 'failed', attempt_count = 1, next_retry_at = now() + interval '5 minutes', detail = 'worker said no' where agent_instance_id = $1 and kind = 'provision'", [agent]));
    let r = (await getLaunchReadiness(c.ctx))!;
    expect(itemOf(r, "employees.lead_hunter")).toMatchObject({ state: "in_progress", owner: "system", detail: expect.stringContaining("Attempt 2 of 3") });
    const fact = (await loadLaunchFacts(c.ctx))!.employees.find((e) => e.role === "lead_hunter")!;
    expect(fact).toMatchObject({ provisioning: "retrying", attempts: 1, maxAttempts: 3 });
    expect(fact.nextRetryAt).not.toBeNull();
    await withSystem((db) => db.query("update agent_provisioning_jobs set attempt_count = 3 where agent_instance_id = $1 and kind = 'provision'", [agent]));
    r = (await getLaunchReadiness(c.ctx))!;
    expect(itemOf(r, "employees.lead_hunter")).toMatchObject({ state: "failed", owner: "iacquire", detail: expect.stringContaining("iAcquire can review it and retry") });
    expect(JSON.stringify(r.steps)).not.toContain("worker said no");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The Setup page after a calendar sign-in: the notice is shown once
// ---------------------------------------------------------------------------

type El = { type: unknown; props: Record<string, unknown> };
const isEl = (n: unknown): n is El => Boolean(n) && typeof n === "object" && "props" in (n as object) && "type" in (n as object);
function elementsOf(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => elementsOf(n, out));
  else if (isEl(node)) {
    out.push(node);
    elementsOf(node.props.children, out);
  }
  return out;
}
/** The context a fixture built before the questionnaire was submitted, as the page sees it after: the checklist only appears once the company information is in. */
const submitted = (ctx: OrgContext): OrgContext => ({ ...ctx, org: { ...ctx.org, onboardingCompletedAt: new Date().toISOString() } });
const panelOf = (tree: unknown) => elementsOf(tree).find((e) => e.type === LaunchReadinessPanel);

describe("the Setup page shows the calendar sign-in notice once", () => {
  it("hands the notice a calendar sign-in left to the panel, as success or as a problem, and nothing when there is none", async () => {
    const c = await submitRealOnboarding({ name: "Notice Roofing", clearPayment: true });
    mocks.ctx = submitted(c.ctx);
    mocks.jar.clear();
    expect(panelOf(await SetupPage({ searchParams: Promise.resolve({}) }))?.props.calendarNotice).toBeNull();
    mocks.jar.set(CALENDAR_NOTICE_COOKIE, encodeCalendarNotice({ kind: "success", provider: "google", message: "Google is connected.", from: "setup" }));
    expect(panelOf(await SetupPage({ searchParams: Promise.resolve({}) }))?.props.calendarNotice).toEqual({ ok: true, text: "Google is connected." });
    mocks.jar.set(CALENDAR_NOTICE_COOKIE, encodeCalendarNotice({ kind: "error", provider: "google", message: "Google isn't set up by iAcquire yet.", from: "setup" }));
    expect(panelOf(await SetupPage({ searchParams: Promise.resolve({}) }))?.props.calendarNotice).toEqual({ ok: false, text: "Google isn't set up by iAcquire yet." });
    mocks.jar.set(CALENDAR_NOTICE_COOKIE, "not a notice");
    expect(panelOf(await SetupPage({ searchParams: Promise.resolve({}) }))?.props.calendarNotice).toBeNull();
  }, 120_000);

  it("lists what the submission kept, held or skipped only when the person has just submitted, and only this workspace's", async () => {
    const c = await submitRealOnboarding({ name: "Outcome Notes Roofing", clearPayment: true });
    mocks.ctx = submitted(c.ctx);
    mocks.jar.clear();
    const notesOf = (tree: unknown) => elementsOf(tree).find((e) => e.props["data-testid"] === "outcome-notes");
    await withSystem((db) => db.query(
      "insert into audit_logs (org_id, actor_kind, action, result, metadata) values ($1, 'system', 'onboarding.completed', 'success', $2::jsonb)",
      [c.org.id, JSON.stringify({ notes: [{ key: "messaging.kept", message: "Left as set in Messaging settings: opening hours." }, { key: "profile.kept", message: "Left as edited in Settings: industry." }] })],
    ));
    // Landing after a submission shows the notes, in the person's own words.
    const after = notesOf(await SetupPage({ searchParams: Promise.resolve({ onboarded: "1" }) }));
    expect(after).toBeDefined();
    const text = JSON.stringify(after!.props.children);
    expect(text).toContain("Left as set in Messaging settings: opening hours.");
    expect(text).toContain("Left as edited in Settings: industry.");
    // Opening the page any other way does not repeat them.
    expect(notesOf(await SetupPage({ searchParams: Promise.resolve({}) }))).toBeUndefined();
    expect(notesOf(await SetupPage({ searchParams: Promise.resolve({ onboarded: "0" }) }))).toBeUndefined();
    // Another workspace's submission is never shown here.
    const other = await submitRealOnboarding({ name: "Other Outcome Roofing", clearPayment: true });
    mocks.ctx = submitted(other.ctx);
    const others = notesOf(await SetupPage({ searchParams: Promise.resolve({ onboarded: "1" }) }));
    expect(others ? JSON.stringify(others.props.children) : "").not.toContain("opening hours");
  }, 120_000);

  it("does not show a notice that a CRM page's sign-in left, and leaves it for that page", async () => {
    const c = await submitRealOnboarding({ name: "Other Page Roofing", clearPayment: true });
    mocks.ctx = submitted(c.ctx);
    mocks.deleted.length = 0;
    const left = encodeCalendarNotice({ kind: "success", provider: "google", message: "Google is connected.", from: noticeSurfaceOf("/crm/calendar-connections") });
    mocks.jar.set(CALENDAR_NOTICE_COOKIE, left);
    expect(panelOf(await SetupPage({ searchParams: Promise.resolve({}) }))?.props.calendarNotice).toBeNull();
    // Nothing was handed to the panel, so nothing forgets it: the CRM page can still show it.
    expect(mocks.jar.get(CALENDAR_NOTICE_COOKIE)).toBe(left);
    expect(calendarNoticeFor(left, "crm")).toMatchObject({ message: "Google is connected.", from: "crm" });
    expect(calendarNoticeFor(left, "setup")).toBeNull();
    // An older notice that names no page was a CRM one, and a Setup notice is not shown on the CRM page.
    expect(calendarNoticeFor(encodeURIComponent(JSON.stringify({ kind: "info", provider: "google", message: "Cancelled." })), "crm")).toMatchObject({ message: "Cancelled." });
    expect(calendarNoticeFor(encodeCalendarNotice({ kind: "info", provider: "google", message: "Cancelled.", from: noticeSurfaceOf("/setup?connected=calendar") }), "crm")).toBeNull();
  }, 120_000);

  it("forgets the notice once the panel has shown it, so the page shows it only the one time", async () => {
    const c = await submitRealOnboarding({ name: "Once Roofing", clearPayment: true });
    mocks.ctx = submitted(c.ctx);
    mocks.deleted.length = 0;
    mocks.jar.set(CALENDAR_NOTICE_COOKIE, encodeCalendarNotice({ kind: "success", provider: "microsoft", message: "Microsoft is connected.", from: "setup" }));
    expect(panelOf(await SetupPage({ searchParams: Promise.resolve({}) }))?.props.calendarNotice).toMatchObject({ text: "Microsoft is connected." });
    expect(await dismissCalendarNoticeAction()).toMatchObject({ ok: true });
    // Removed on the path it was set on (every page), not only the page that happens to be open.
    expect(mocks.deleted).toEqual([{ name: CALENDAR_NOTICE_COOKIE, path: CALENDAR_NOTICE_COOKIE_OPTIONS.path }]);
    expect(CALENDAR_NOTICE_COOKIE_OPTIONS.path).toBe("/");
    expect(panelOf(await SetupPage({ searchParams: Promise.resolve({}) }))?.props.calendarNotice).toBeNull();
  }, 120_000);

  it("renders the notice, a channel's guidance and the provider sign-in as a plain link the browser loads", () => {
    const item = (over: Partial<LaunchItem>): LaunchItem => ({ key: "x", label: "X", state: "action_required", required: true, detail: "Detail.", owner: "you", ...over });
    const readiness: LaunchReadiness = {
      state: "action_required", label: "Action required", headline: "Action required", detail: "One thing needs you.", percent: 50, passed: 1, total: 2, blocking: [],
      steps: [
        { key: "calendar", title: "Calendar and availability", state: "action_required", summary: "0 of 1 checks passed.", items: [item({ key: "calendar.connection", label: "Google connection", action: { label: "Connect Google", href: "/api/crm/calendar-oauth/google/start?return=/setup" } })] },
        { key: "integrations", title: "Required integrations", state: "in_progress", summary: "0 of 1 checks passed.", items: [item({ key: "integrations.email", label: "Email", state: "in_progress", owner: "iacquire", guidance: ["iAcquire sends you the DNS records for your sending domain."], action: { label: "See channel status", href: "/settings/messaging" } })] },
      ],
    };
    const html = renderToStaticMarkup(React.createElement(LaunchReadinessPanel, { readiness, calendarNotice: { ok: true, text: "Google is connected." } }));
    expect(html).toContain("Google is connected.");
    expect(html).toContain("iAcquire sends you the DNS records for your sending domain.");
    // The sign-in start is a route handler, so it is a plain anchor; the status screen is a page and stays an app link.
    expect(html).toMatch(/<a [^>]*href="\/api\/crm\/calendar-oauth\/google\/start\?return=\/setup"/);
    expect(html).toContain('href="/settings/messaging"');
    expect(renderToStaticMarkup(React.createElement(LaunchReadinessPanel, { readiness }))).not.toContain("Google is connected.");
  });
});

describe("a final check that waits for a person or runs too long is read from its own job", () => {
  /** A final-check job of the kind the panel starts, in the state a test needs, with its own age and lease. */
  async function checkJob(orgId: string, role: "crm_manager" | "sales_assistant" | "lead_hunter", over: { status: string; minutesOld: number; lease: "live" | "expired" | "none" }) {
    const id = await agentId(orgId, role);
    const version = (await withSystem((db) => db.query<{ version: number }>("select v.version from agent_config_versions v join agent_instances a on a.active_config_version_id = v.id where a.id = $1", [id]))).rows[0].version;
    await withSystem((db) => db.query(
      `insert into ai_work_jobs (org_id, agent_instance_id, capability, title, status, input, idempotency_key, created_at, lease_owner, lease_expires_at)
       values ($1, $2, 'lead_search', 'Launch check', $3, $4::jsonb, $5, now() - make_interval(mins => $6), $7, $8)`,
      [
        orgId, id, over.status, JSON.stringify({ launchVerification: true, configVersion: version }), `test-check-${role}-${orgId}`, over.minutesOld,
        over.lease === "none" ? null : "worker-test", over.lease === "none" ? null : over.lease === "live" ? new Date(Date.now() + 10 * 60_000) : new Date(Date.now() - 10 * 60_000),
      ],
    ));
  }

  it("calls a check held for approval a review, a young running one in progress, and an old one whose lease ran out iAcquire's to look at", async () => {
    const c = await readyClient({ name: "Waiting Checks Roofing", timezone: "America/Chicago" });
    await checkJob(c.org.id, "sales_assistant", { status: "waiting_for_approval", minutesOld: 1, lease: "none" });
    await checkJob(c.org.id, "lead_hunter", { status: "running", minutesOld: 1, lease: "live" });
    await checkJob(c.org.id, "crm_manager", { status: "running", minutesOld: 30, lease: "expired" });
    const facts = (await loadLaunchFacts(c.ctx))!;
    const verification = (role: string) => facts.verification.find((v) => v.role === role)!;
    expect(verification("sales_assistant")).toEqual({ role: "sales_assistant", state: "awaiting_review" });
    expect(verification("lead_hunter")).toMatchObject({ state: "running", leaseExpired: false, alerted: false });
    expect(verification("crm_manager")).toMatchObject({ state: "running", leaseExpired: true });

    const r = (await getLaunchReadiness(c.ctx))!;
    expect(itemOf(r, "verification.sales_assistant")).toMatchObject({ state: "awaiting_review", owner: "iacquire", required: true });
    expect(itemOf(r, "verification.lead_hunter")).toMatchObject({ state: "in_progress", owner: "system" });
    expect(itemOf(r, "verification.lead_hunter").stalled).toBeUndefined();
    expect(itemOf(r, "verification.crm_manager")).toMatchObject({ state: "action_required", owner: "iacquire", stalled: true });
    expect(itemOf(r, "verification.crm_manager").detail).toContain("Nothing is running it right now");
    // Nothing has told iAcquire yet, so nothing says it was.
    expect(itemOf(r, "verification.crm_manager").detail).not.toContain("has been alerted");
    // A waiting review is not a blocker the client must clear, and a held check is not started a second time.
    expect(r.blocking.map((i) => i.key)).not.toContain("verification.sales_assistant");
    const started = await startLaunchVerification(c.ctx);
    expect(started.started).not.toContain("sales_assistant");
    expect(started.skipped?.map((s) => s.role)).toEqual(expect.arrayContaining(["sales_assistant", "lead_hunter"]));
  }, 180_000);
});

describe("reading the Setup page writes nothing", () => {
  it("shows the panel any number of times without a ledger row or a notice", async () => {
    const c = await submitRealOnboarding({ name: "Read Page Roofing", clearPayment: true });
    mocks.ctx = submitted(c.ctx);
    mocks.jar.clear();
    const writes = async () => (await withSystem((db) => db.query<{ n: string }>(
      "select (select count(*) from audit_logs where org_id = $1 and action = 'setup.launch_state_changed') + (select count(*) from notifications where org_id = $1 and kind like 'setup_%') as n", [c.org.id],
    ))).rows[0].n;
    const before = await writes();
    for (let i = 0; i < 3; i += 1) expect(panelOf(await SetupPage({ searchParams: Promise.resolve({}) }))).toBeDefined();
    expect(await writes()).toBe(before);
  }, 120_000);
});

describe("the customer-facing switches are read from the workspace's own rows", () => {
  const controlOf = (r: LaunchReadiness, key: string) => r.controls!.find((c) => c.key === key)!;

  it("lists every switch off for a new client, every row not required, and shows one on only because a person turned it on", async () => {
    const c = await readyClient({ name: "Controls Roofing", timezone: "America/Chicago" });
    const r = (await getLaunchReadiness(c.ctx))!;
    expect(r.controls!.map((x) => x.key)).toEqual(["booking_page", "ai_booking", "auto_reply", "channel.email", "channel.sms", "channel.whatsapp"]);
    expect(r.controls!.every((x) => x.required === false && x.on === false)).toBe(true);
    expect(controlOf(r, "booking_page")).toMatchObject({ wanted: true, href: `/crm/calendars/${c.calendarId}` });
    expect(controlOf(r, "auto_reply").href).toBe("/settings/messaging");
    expect(controlOf(r, "ai_booking").href).toBe("/appointments");

    // The switches are flipped by a person in their own screens; the panel only reports them.
    await withSystem(async (db) => {
      await db.query("update crm_calendars set public = true where id = $1", [c.calendarId]);
      await db.query("insert into messaging_settings (org_id, auto_reply_enabled) values ($1, true) on conflict (org_id) do update set auto_reply_enabled = true", [c.org.id]);
      await db.query("insert into appointment_settings (org_id, ai_booking_enabled) values ($1, true) on conflict (org_id) do update set ai_booking_enabled = true", [c.org.id]);
    });
    const on = (await getLaunchReadiness(c.ctx))!;
    for (const key of ["booking_page", "auto_reply", "ai_booking"]) expect(controlOf(on, key), key).toMatchObject({ on: true, detail: "On." });
    expect(controlOf(on, "channel.email").on).toBe(false);
    // Not one of them is a check: the state and the percentage are what they were.
    expect([on.state, on.percent, on.passed, on.total]).toEqual([r.state, r.percent, r.passed, r.total]);
    // The booking summary says what the saved rules are, in words, and it is not required.
    expect(itemOf(on, "calendar.booking_settings")).toMatchObject({ state: "done", required: false });
    expect(itemOf(on, "calendar.booking_settings").detail).toContain("may book on its own, because you turned that on");
  }, 120_000);

  it("leaves another workspace's switches alone, and has no calendar control for a workspace with no calendar", async () => {
    const a = await readyClient({ name: "Controls Apart A", timezone: "America/Chicago" });
    const b = await crmOrg({ name: "Controls Apart B", timezone: "America/Chicago" });
    await withSystem((db) => db.query("update organizations set onboarding_completed_at = now() where id = $1", [b.org.id]));
    await withSystem((db) => db.query("update crm_calendars set public = true where id = $1", [a.calendarId]));
    const rb = (await getLaunchReadiness(ctxFor(b.people.owner, b.org, "owner")))!;
    expect(rb.controls!.some((x) => x.key === "booking_page" || x.key === "ai_booking")).toBe(false);
    expect(rb.controls!.every((x) => x.on === false)).toBe(true);
  }, 120_000);

  it("shows the website as a switch only when the workspace has one, and on only when it is published", async () => {
    const c = await readyClient({ name: "Controls Website Roofing", timezone: "America/Chicago" });
    expect(((await getLaunchReadiness(c.ctx))!).controls!.some((x) => x.key === "website")).toBe(false);
    await withSystem((db) => db.query(
      "insert into websites (org_id, name, kind, template_key, subdomain, draft_content) values ($1, 'Main site', 'website', 'local.services', $2, '{}'::jsonb)",
      [c.org.id, `controls-${c.org.id.slice(0, 8)}`],
    ));
    expect(controlOf((await getLaunchReadiness(c.ctx))!, "website")).toMatchObject({ on: false, wanted: false, href: "/website", required: false });
  }, 120_000);
});

describe("a person to take over customer conversations, read from the staff profiles", () => {
  it("reads a member who has no profile row as their role's defaults, and never creates the rows by reading", async () => {
    const c = await readyClient({ name: "Handoff Roofing", timezone: "America/Chicago" });
    const profiles = async () => Number((await withSystem((db) => db.query<{ n: string }>("select count(*) as n from staff_profiles where org_id = $1", [c.org.id]))).rows[0].n);
    const before = await profiles();
    const facts = (await loadLaunchFacts(c.ctx))!;
    // Owner, admin, sales, support and appointment setter can respond and are on by default; the viewer cannot respond.
    expect(facts.handoff).toEqual({ ownerHasNotifyChannel: true, eligibleStaff: 5 });
    await getLaunchReadiness(c.ctx);
    expect(await profiles()).toBe(before);
    // No customer channel is wanted yet, so the line says it does not apply.
    expect(itemOf((await getLaunchReadiness(c.ctx))!, "knowledge.handoff")).toMatchObject({ state: "not_applicable", required: false });
  }, 120_000);

  it("is done for a wanted channel when someone is set up, and needs setting up (without blocking launch) when nobody can be told", async () => {
    const c = await readyClient({ name: "Handoff Wanted Roofing", timezone: "America/Chicago" });
    await withSystem((db) => db.query("insert into onboarding_answers (org_id, question_id, value) values ($1, 'c.channels', '[\"email\"]'::jsonb)", [c.org.id]));
    const covered = (await getLaunchReadiness(c.ctx))!;
    expect(itemOf(covered, "knowledge.handoff")).toMatchObject({ state: "done", required: false });
    expect(itemOf(covered, "knowledge.handoff").detail).toContain("5 people are set up");

    // Everyone's notifications are off and nobody is authorized for a customer asking for a person.
    await withSystem(async (db) => {
      await db.query("insert into staff_profiles (org_id, user_id, escalation_categories, notify_email, notify_sms, notify_whatsapp) select org_id, user_id, '{}', false, false, false from organization_memberships where org_id = $1", [c.org.id]);
    });
    const nobody = (await getLaunchReadiness(c.ctx))!;
    expect((await loadLaunchFacts(c.ctx))!.handoff).toEqual({ ownerHasNotifyChannel: false, eligibleStaff: 0 });
    expect(itemOf(nobody, "knowledge.handoff")).toMatchObject({ state: "action_required", required: false, action: { href: "/settings/escalations" } });
    expect(nobody.blocking.map((i) => i.key)).not.toContain("knowledge.handoff");
    expect([nobody.passed, nobody.total]).toEqual([covered.passed, covered.total]);

    // Another workspace's profiles do not count for this one.
    const other = await readyClient({ name: "Handoff Other Roofing", timezone: "America/Chicago" });
    expect((await loadLaunchFacts(other.ctx))!.handoff!.eligibleStaff).toBe(5);
  }, 180_000);
});

describe("a check that read nothing, and one that read something", () => {
  it("says Nothing to check yet for an empty CRM and keeps it a pass, and reads a check that examined records as an ordinary pass", async () => {
    const c = await readyClient({ name: "Nothing Yet Roofing", timezone: "Asia/Manila" });
    await startLaunchVerification(c.ctx);
    await settled(c.org.id, 6);
    const r = (await getLaunchReadiness(c.ctx))!;
    expect(r).toMatchObject({ state: "ready_to_launch", percent: 100 });
    expect(itemOf(r, "verification.crm_manager")).toMatchObject({ state: "done", required: true, detail: expect.stringContaining("Nothing to check yet") });

    // The same check, had it found records: not the empty wording, and the words the check itself recorded.
    const crm = await agentId(c.org.id, "crm_manager");
    await withSystem((db) => db.query(
      `update ai_work_jobs set result = jsonb_set(result, '{examined}', '[{"label":"contacts","count":3},{"label":"companies","count":0}]'::jsonb)
        where org_id = $1 and agent_instance_id = $2 and input ->> 'launchVerification' = 'true'`, [c.org.id, crm]));
    const seen = itemOf((await getLaunchReadiness(c.ctx))!, "verification.crm_manager");
    expect(seen.state).toBe("done");
    expect(seen.detail).not.toContain("Nothing to check yet");

    // A result that carries no counts at all is not "empty": it keeps its own words.
    await withSystem((db) => db.query(
      `update ai_work_jobs set result = result - 'examined' where org_id = $1 and agent_instance_id = $2 and input ->> 'launchVerification' = 'true'`, [c.org.id, crm]));
    expect(itemOf((await getLaunchReadiness(c.ctx))!, "verification.crm_manager").detail).not.toContain("Nothing to check yet");
  }, 180_000);
});

describe("the polling action", () => {
  it("returns the readiness with a fingerprint that is stable, moves with a required change, and writes nothing", async () => {
    const c = await readyClient({ name: "Poll Roofing", timezone: "America/Chicago" });
    mocks.ctx = submitted(c.ctx);
    const writes = async () => (await withSystem((db) => db.query<{ n: string }>(
      "select (select count(*) from audit_logs where org_id = $1) + (select count(*) from notifications where org_id = $1) as n", [c.org.id],
    ))).rows[0].n;
    const before = await writes();
    const one = await getLaunchReadinessAction();
    const two = await getLaunchReadinessAction();
    expect(one.fingerprint).toBe(fingerprintOf(one.readiness));
    expect(one.fingerprint).toBe(two.fingerprint);
    expect(one.readiness).toMatchObject({ state: "action_required" });
    expect(await writes()).toBe(before);

    await startLaunchVerification(c.ctx);
    await settled(c.org.id, 6);
    const done = await getLaunchReadinessAction();
    expect(done.readiness.state).toBe("ready_to_launch");
    expect(done.fingerprint).not.toBe(one.fingerprint);
  }, 180_000);

  it("is refused for a workspace that is not a client's", async () => {
    const agency = await createOrg({ name: "Poll Agency", kind: "agency" });
    const user = await createUser();
    await addMember(agency.id, user.id, "owner");
    mocks.ctx = submitted(ctxFor(user, agency, "owner"));
    await expect(getLaunchReadinessAction()).rejects.toThrow(/client workspace/i);
  }, 60_000);
});

describe("the employees that do not run what the client approved, read from the workspace", () => {
  it("lists nobody for a client whose employees were built from its answers, and every employee once the business information moved on", async () => {
    const c = await readyClient({ name: "Behind Facts Roofing", timezone: "America/Chicago" });
    const clean = (await loadLaunchFacts(c.ctx))!;
    expect(clean.employeesBehind).toBeUndefined();
    expect((await getLaunchReadiness(c.ctx))!.steps.flatMap((s) => s.items).map((i) => i.key)).not.toContain("employees.in_sync");

    await withSystem((db) => db.query("update company_profiles set services = 'Metal roofing and gutters' where org_id = $1", [c.org.id]));
    const facts = (await loadLaunchFacts(c.ctx))!;
    expect(facts.employeesBehind!.map((b) => b.role).sort()).toEqual([...AGENT_ROLE_KEYS].sort());
    expect(facts.employeesBehind!.every((b) => /business information/i.test(b.reason))).toBe(true);
    expect(facts.canSyncEmployees).toBe(true);
    const r = (await getLaunchReadiness(c.ctx))!;
    expect(itemOf(r, "employees.in_sync")).toMatchObject({ state: "action_required", required: true, owner: "you", action: { intent: "sync_employees" } });
    expect(r.state).toBe("action_required");
    expect(r.percent).toBeLessThan(100);
  }, 180_000);

  it("tells a person who may not manage the profile that only an owner or admin can update them, and gives them no step", async () => {
    const c = await readyClient({ name: "Behind Viewer Roofing", timezone: "America/Chicago" });
    await withSystem((db) => db.query("update company_profiles set services = 'Metal roofing and gutters' where org_id = $1", [c.org.id]));
    const viewer = ctxFor(c.people.viewer, c.org, "viewer");
    expect((await loadLaunchFacts(viewer))!.canSyncEmployees).toBe(false);
    const item = itemOf((await getLaunchReadiness(viewer))!, "employees.in_sync");
    expect(item.action).toBeUndefined();
    expect(item.detail).toContain("Only an owner or admin can update them.");
  }, 180_000);

  it("does not call an employee with no configuration at all behind (the employee's own line says that), and keeps two clients apart", async () => {
    const a = await readyClient({ name: "Behind Apart A", timezone: "America/Chicago" });
    const b = await readyClient({ name: "Behind Apart B", timezone: "Asia/Manila" });
    await withSystem(async (db) => {
      await db.query("update company_profiles set services = 'Metal roofing and gutters' where org_id = $1", [a.org.id]);
      await db.query("update agent_instances set active_config_version_id = null where org_id = $1 and role_key = 'lead_hunter'", [a.org.id]);
    });
    const facts = (await loadLaunchFacts(a.ctx))!;
    expect(facts.employeesBehind!.map((x) => x.role)).not.toContain("lead_hunter");
    expect(facts.employeesBehind!.length).toBe(AGENT_ROLE_KEYS.length - 1);
    expect((await loadLaunchFacts(b.ctx))!.employeesBehind).toBeUndefined();
  }, 240_000);

  it("says nothing before the questionnaire is submitted", async () => {
    const early = await crmOrg({ name: "Behind Early Roofing", timezone: "UTC" });
    expect((await loadLaunchFacts(ctxFor(early.people.owner, early.org, "owner")))!.employeesBehind).toBeUndefined();
  }, 120_000);
});

describe("what the calendar's re-check recorded, read into the facts", () => {
  const drift = { at: "2026-10-26T06:00:00.000Z", failing: ["hours"], digest: "d", seq: 1, reason: "host_hours_changed", checks: [{ key: "hours", detail: "Dana has no weekly hours." }, { key: "connections", detail: "Dana's Google account needs a new sign-in." }] };

  it("reads the recorded failing checks of an active calendar, and the judge leaves the live read in charge", async () => {
    const c = await readyClient({ name: "Drift Facts Roofing", timezone: "America/Chicago" });
    expect((await loadLaunchFacts(c.ctx))!.appointments.calendar!.drift).toBeUndefined();
    await withSystem((db) => db.query("update crm_calendars set verification = verification || jsonb_build_object('drift', $2::jsonb) where id = $1", [c.calendarId, JSON.stringify(drift)]));
    const facts = (await loadLaunchFacts(c.ctx))!;
    expect(facts.appointments.calendar!.drift).toEqual({ checks: drift.checks });
    // The checks were read live and pass, so a stored record from earlier adds no line and does not hold the client back.
    const r = (await getLaunchReadiness(c.ctx))!;
    expect(r.steps.flatMap((s) => s.items).map((i) => i.key).filter((k) => k.startsWith("calendar.drift"))).toEqual([]);
    expect(itemOf(r, "calendar.verified").state).toBe("done");
  }, 180_000);

  it("ignores a stored value that is not the shape the re-check writes, and another client's record", async () => {
    const a = await readyClient({ name: "Drift Shape A", timezone: "America/Chicago" });
    const b = await readyClient({ name: "Drift Shape B", timezone: "America/Chicago" });
    await withSystem((db) => db.query("update crm_calendars set verification = verification || jsonb_build_object('drift', $2::jsonb) where id = $1", [a.calendarId, JSON.stringify({ checks: "nope" })]));
    expect((await loadLaunchFacts(a.ctx))!.appointments.calendar!.drift).toBeUndefined();
    await withSystem((db) => db.query("update crm_calendars set verification = verification || jsonb_build_object('drift', $2::jsonb) where id = $1", [a.calendarId, JSON.stringify({ checks: [{ key: 5 }, { key: "hours" }, { key: "types", detail: "Nothing to book." }] })]));
    expect((await loadLaunchFacts(a.ctx))!.appointments.calendar!.drift).toEqual({ checks: [{ key: "types", detail: "Nothing to book." }] });
    expect((await loadLaunchFacts(b.ctx))!.appointments.calendar!.drift).toBeUndefined();
  }, 240_000);
});
