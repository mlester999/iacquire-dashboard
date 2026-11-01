// Two different paying clients, from the questionnaire to "100% Ready to Launch", through the product's own code: a roofing company in Chicago that books appointments with all six
// employees, and a dental practice in Manila that does not book appointments and whose plan leaves out the Sales Assistant. What it proves: the payment starts provisioning once and only
// for the plan, every employee has its own identity and instructions from its own business, nothing crosses from one client to the other, the calendar is built from the client's own
// answers and goes live only through the checks, the final checks start by themselves and change nothing, a half-failed provisioning shows honestly and recovers, and no message is sent
// and nobody is booked on the way. Test database only; the Hermes runtime is simulated by the recorded state a verified employee has.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import type { LaunchReadiness } from "@/lib/launch-readiness";
import { memberActor } from "@/server/crm/actor";
import { getWorkspace } from "@/server/crm/workspace";
import { listPipelines } from "@/server/crm/pipelines";
import { saveOnboardingStep, submitOnboarding } from "@/server/onboarding/service";
import { afterSetupCleared } from "@/server/billing/after-clearing";
import { getProvisioningBundle } from "@/server/workforce/provisioning";
import { agentSettingsSchema } from "@/lib/agent-settings";
import { createConfigVersion, isReservedProfile } from "@/server/workforce/service";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { getLaunchReadiness, loadLaunchFacts } from "@/server/setup/launch-readiness";
import { runLaunchIntent } from "@/server/setup/launch-intents";
import { pickUpSetupEvidence } from "@/server/setup/evidence-pickup";
import { sweepLaunchVerification } from "@/server/setup/launch-sweep";
import { nativeAvailability } from "@/server/calendars/native-availability";
import { bookNativeAppointment } from "@/server/calendars/booking";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { clearSetupPayment } from "./support/billing";
import { makeRuntimeReady } from "./support/runtime-ready";
import { checkJobs, count, itemOf, markBlueprintApplied, settled } from "./support/launch";

const OFFICE_HOURS = { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]], thu: [["09:00", "17:00"]], fri: [["09:00", "17:00"]] };

interface Spec {
  name: string;
  industry: string;
  timezone: string;
  description: string;
  services: string;
  territories: string;
  customers: string;
  appointments: boolean;
  entitled: readonly AgentRoleKey[];
  booking?: Record<string, unknown>;
}

async function onboard(spec: Spec) {
  const org = await createOrg({ name: spec.name });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  // The plan: every role is registered, only the roles in the plan are switched on.
  await withSystem((db) => db.query("update agent_instances set enabled = (role_key = any($2::text[])) where org_id = $1", [org.id, [...spec.entitled]]));
  const ctx = ctxFor(owner, org, "owner");
  const answers: Record<string, unknown> = {
    "a.business_name": spec.name, "a.industry": spec.industry, "a.business_model": "local", "a.description": spec.description, "a.timezone": spec.timezone, "a.contact_email": owner.email,
    "a.territories": spec.territories, "a.target_customers": spec.customers, "b.goals": ["more_leads"], "b.services": spec.services, "b.ideal_customer": spec.customers,
    "b.appointments": spec.appointments, "b.website_need": "have", "d.pricing_policy": "never", "f.review": true, ...spec.booking,
  };
  const saved = await saveOnboardingStep(ctx, { answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { value }])), currentQuestionId: "f.review" });
  expect(saved.rejected).toEqual({});
  await submitOnboarding(ctx);
  return { org, owner, ctx, spec };
}
type Client = Awaited<ReturnType<typeof onboard>>;

const roofing: Spec = {
  name: "Brightside Roofing Co", industry: "home_services", timezone: "America/Chicago", description: "We repair residential roofs after hail and storm damage.",
  services: "Roof repair and inspection", territories: "Austin, Texas", customers: "Austin homeowners with hail damage", appointments: true, entitled: AGENT_ROLE_KEYS,
  booking: {
    "d.appt_types": [{ name: "Free inspection", minutes: "45", mode: "in_person" }, { name: "Video estimate", minutes: "30", mode: "video" }],
    "d.appt_availability": OFFICE_HOURS, "d.appt_notice": "2h", "d.appt_buffer": "15m", "d.appt_confirmation": "manual", "d.appt_changes": "24h", "d.appt_video": "own",
    "d.appt_cancellation": "Free to reschedule up to 24 hours before.",
  },
};
const dental: Spec = {
  name: "Harbor Smile Dental", industry: "healthcare", timezone: "Asia/Manila", description: "We provide orthodontic braces and clear aligners.",
  services: "Orthodontic braces", territories: "Makati; Taguig", customers: "Parents of teenagers in Metro Manila", appointments: false,
  entitled: AGENT_ROLE_KEYS.filter((role) => role !== "sales_assistant"),
};

const roleSet = (jobs: Array<{ role_key: string }>) => jobs.map((j) => j.role_key).sort();
async function provisioningRoles(orgId: string) {
  return roleSet((await withSystem((db) => db.query<{ role_key: string }>(
    "select a.role_key from agent_provisioning_jobs j join agent_instances a on a.id = j.agent_instance_id where j.org_id = $1 and j.kind = 'provision'", [orgId]))).rows);
}
const readiness = async (c: Client) => (await getLaunchReadiness(c.ctx)) as LaunchReadiness;

/** The recorded state a verified employee has once the restricted worker has built its profile (the worker is not live; this is what it would leave). */
async function simulateVerifiedProfiles(c: Client) {
  for (const role of c.spec.entitled) {
    const id = await agentId(c.org.id, role);
    await makeRuntimeReady(id, c.org.id, c.owner.id);
    await withSystem((db) => db.query("update agent_provisioning_jobs set status = 'succeeded' where org_id = $1 and agent_instance_id = $2 and status <> 'succeeded'", [c.org.id, id]));
  }
}

describe("two clients from the questionnaire to ready to launch", () => {
  let a: Client;
  let b: Client;

  it("takes both questionnaires without starting anything the clients have not paid for", async () => {
    a = await onboard(roofing);
    b = await onboard(dental);
    for (const c of [a, b]) {
      const r = await readiness(c);
      expect(r).toMatchObject({ state: "questionnaire_submitted", label: "Questionnaire submitted" });
      expect(await provisioningRoles(c.org.id)).toEqual([]);
      expect(await checkJobs(c.org.id)).toBe(0);
    }
  }, 180_000);

  it("builds each client's calendar and targeting from that client's own answers only", async () => {
    // The roofing company's drafted calendar carries its booking policy; nothing is live and nobody is a host.
    const calendar = (await loadLaunchFacts(a.ctx))!.appointments.calendar!;
    expect(calendar).toMatchObject({ status: "draft", hosts: 0, hasSuggestedHours: true, types: 2, bookingPageOn: false });
    const types = (await withSystem((db) => db.query<Record<string, unknown>>(
      "select name, duration_minutes, location_kind, buffer_after_minutes, requires_confirmation, allow_customer_changes, change_cutoff_minutes, meeting_provider, min_notice_minutes from crm_appointment_types where org_id = $1 order by position", [a.org.id]))).rows;
    expect(types).toEqual([
      { name: "Free inspection", duration_minutes: 45, location_kind: "in_person", buffer_after_minutes: 15, requires_confirmation: true, allow_customer_changes: true, change_cutoff_minutes: 1440, meeting_provider: "none", min_notice_minutes: 120 },
      { name: "Video estimate", duration_minutes: 30, location_kind: "video", buffer_after_minutes: 15, requires_confirmation: true, allow_customer_changes: true, change_cutoff_minutes: 1440, meeting_provider: "none", min_notice_minutes: 120 },
    ]);
    const draft = (await withSystem((db) => db.query<{ timezone: string }>("select timezone from crm_calendars where org_id = $1", [a.org.id]))).rows;
    expect(draft).toEqual([{ timezone: "America/Chicago" }]);
    // The dental practice said it does not book appointments: no calendar, and the step says it does not apply.
    expect((await withSystem((db) => db.query("select 1 from crm_calendars where org_id = $1", [b.org.id]))).rows).toHaveLength(0);
    expect((await readiness(b)).steps.find((s) => s.key === "calendar")!.state).toBe("not_applicable");

    for (const [c, regions, other] of [[a, ["Austin", "Texas"], "Makati"], [b, ["Makati", "Taguig"], "Austin"]] as const) {
      const row = (await withSystem((db) => db.query<{ criteria: { regions: string[]; servicesNeeded: string[] } }>("select criteria from lead_targeting_profiles where org_id = $1", [c.org.id]))).rows[0];
      expect(row.criteria.regions).toEqual(regions);
      expect(JSON.stringify(row.criteria)).not.toContain(other);
    }
  }, 180_000);

  it("opens provisioning once, for the plan only, however often the payment event is replayed", async () => {
    for (const c of [a, b]) await clearSetupPayment(c.org.id);
    for (const attempt of [1, 2, 3]) {
      for (const c of [a, b]) await withSystem((db) => afterSetupCleared(db, c.org.id, { actorUserId: null, how: "waiver", eventKey: `acceptance-${c.org.id}-${attempt}` }));
    }
    expect(await provisioningRoles(a.org.id)).toEqual([...AGENT_ROLE_KEYS].sort());
    expect(await provisioningRoles(b.org.id)).toEqual(dental.entitled.slice().sort());
    // The Sales Assistant is registered for the dental practice but not started, and it does not hold up launch.
    expect((await withSystem((db) => db.query("select 1 from agent_instances where org_id = $1 and role_key = 'sales_assistant' and not enabled", [b.org.id]))).rows).toHaveLength(1);
    expect(itemOf(await readiness(b), "employees.sales_assistant")).toMatchObject({ state: "not_applicable", required: false });
    // Queued is not ready: nothing is done, and the state says provisioning is under way.
    const r = await readiness(a);
    expect(r.state).not.toBe("ready_to_launch");
    for (const role of AGENT_ROLE_KEYS) expect(itemOf(r, `employees.${role}`).state).not.toBe("done");
  }, 180_000);

  it("gives every employee its own identity and its own business's instructions, and nothing from the other client", async () => {
    const names = new Set<string>();
    const souls: Array<{ org: string; soul: string; profile: string }> = [];
    for (const c of [a, b]) {
      for (const role of c.spec.entitled) {
        const bundle = await getProvisioningBundle(await agentId(c.org.id, role));
        expect(isReservedProfile(bundle.profile), bundle.profile).toBe(false);
        expect(bundle.profile).toMatch(/^c-[a-z0-9-]+-[0-9a-f]{12}-[a-z-]+$/);
        names.add(bundle.profile);
        souls.push({ org: c.org.name, soul: bundle.soul, profile: bundle.profile });
      }
    }
    expect(names.size).toBe(AGENT_ROLE_KEYS.length + dental.entitled.length);
    for (const s of souls) {
      const other = s.org === roofing.name ? dental.name : roofing.name;
      expect(s.soul).toContain(s.org);
      expect(s.soul).not.toContain(other);
    }
    // Their knowledge and compiled instructions come from their own answers.
    for (const [c, mine, theirs] of [[a, "hail", "orthodontic"], [b, "orthodontic", "hail"]] as const) {
      const knowledge = (await withSystem((db) => db.query<{ content: string }>("select content from company_knowledge where org_id = $1", [c.org.id]))).rows.map((r) => r.content).join(" ");
      expect(knowledge.toLowerCase()).toContain(mine);
      expect(knowledge.toLowerCase()).not.toContain(theirs);
      const compiled = (await withSystem((db) => db.query<{ compiled_instructions: string }>("select compiled_instructions from agent_config_versions where org_id = $1", [c.org.id]))).rows;
      expect(compiled.length).toBeGreaterThan(0);
      for (const row of compiled) {
        expect(row.compiled_instructions).toContain(c.org.name);
        expect(row.compiled_instructions.toLowerCase()).not.toContain(theirs);
      }
    }
    // The Appointment Setter of the roofing company is told the policy the client gave.
    const setter = (await withSystem((db) => db.query<{ settings: { operatingProcedures?: string } }>(
      "select v.settings from agent_config_versions v join agent_instances i on i.id = v.agent_instance_id where i.org_id = $1 and i.role_key = 'appointment_setter' order by v.version desc limit 1", [a.org.id]))).rows[0];
    expect(JSON.stringify(setter.settings)).toMatch(/15 minutes|team member confirms/i);
  }, 180_000);

  it("shows a half-failed provisioning as it is, names who must act, and recovers without touching the others", async () => {
    const hunter = await agentId(a.org.id, "lead_hunter");
    await withSystem((db) => db.query("update agent_provisioning_jobs set status = 'failed', detail = 'The host did not answer', attempt_count = 1 where agent_instance_id = $1 and kind = 'provision'", [hunter]));
    const failed = await readiness(a);
    expect(failed.state).toBe("action_required");
    expect(itemOf(failed, "employees.lead_hunter")).toMatchObject({ state: "failed", owner: "iacquire" });
    for (const role of AGENT_ROLE_KEYS.filter((k) => k !== "lead_hunter")) expect(itemOf(failed, `employees.${role}`).state).not.toBe("failed");
    // Asking for provisioning again makes no second job for the failed employee.
    await withSystem((db) => afterSetupCleared(db, a.org.id, { actorUserId: null, how: "waiver", eventKey: `acceptance-retry-${a.org.id}` }));
    expect((await withSystem((db) => db.query("select 1 from agent_provisioning_jobs where agent_instance_id = $1 and kind = 'provision'", [hunter]))).rows).toHaveLength(1);
    // The worker retries it and the profile is verified.
    await withSystem((db) => db.query("update agent_provisioning_jobs set status = 'requested', detail = null where agent_instance_id = $1 and kind = 'provision'", [hunter]));
    expect(itemOf(await readiness(a), "employees.lead_hunter").state).toBe("in_progress");
  }, 180_000);

  it("reaches 100% Ready to Launch for both, with the calendar built through its own checks and the final checks started by themselves", async () => {
    await simulateVerifiedProfiles(a);
    await simulateVerifiedProfiles(b);
    for (const c of [a, b]) {
      const actor = memberActor(c.ctx);
      await getWorkspace(actor);
      await listPipelines(actor, { ensureDefault: true });
      await markBlueprintApplied(c.org.id);
    }
    // Everything is in place for both except what only the roofing company can do (choose its host), the Appointment Setter that waits for a calendar that takes bookings, and the
    // checks that have not run. Hours and activation wait behind the host: they are in progress, not blocking, until there is one.
    const before = await readiness(a);
    expect(before.state).toBe("action_required");
    expect(before.blocking.map((i) => i.key)).toEqual(expect.arrayContaining(["calendar.host", "employees.appointment_setter"]));
    expect(itemOf(before, "calendar.hours").state).toBe("in_progress");
    expect(itemOf(before, "calendar.active").state).toBe("in_progress");
    // The dental practice needs no calendar, so the event that starts its checks is not a calendar one.
    await pickUpSetupEvidence(b.org.id, "a Blueprint apply");

    // The roofing company walks the guided steps. Activation is the last of them, and it starts the final checks by itself.
    await runLaunchIntent(a.ctx, "assign_host");
    await runLaunchIntent(a.ctx, "apply_hours");
    const hostSettings = (await withSystem((db) => db.query<{ timezone: string }>("select timezone from crm_host_settings where org_id = $1 and user_id = $2", [a.org.id, a.owner.id]))).rows;
    expect(hostSettings).toEqual([{ timezone: "America/Chicago" }]);
    expect(await checkJobs(a.org.id)).toBe(0);
    expect(await runLaunchIntent(a.ctx, "activate_calendar")).toMatchObject({ ok: true });

    // The dental practice does not book appointments, so its Appointment Setter has no check to run.
    const dentalChecks = dental.entitled.length - 1;
    await settled(a.org.id, AGENT_ROLE_KEYS.length);
    await settled(b.org.id, dentalChecks);
    const ra = await readiness(a);
    const rb = await readiness(b);
    expect(ra).toMatchObject({ state: "ready_to_launch", label: "100% Ready to Launch", percent: 100, blocking: [] });
    expect(rb).toMatchObject({ state: "ready_to_launch", percent: 100, blocking: [] });
    expect(ra.passed).toBe(ra.total);
    // The dental practice's plan and answers leave out the Sales Assistant, the Appointment Setter's checks and the calendar; they are shown as not applicable, never as done.
    expect(itemOf(rb, "employees.sales_assistant").state).toBe("not_applicable");
    expect(itemOf(rb, "verification.sales_assistant").state).toBe("not_applicable");
    expect(itemOf(rb, "verification.appointment_setter").state).toBe("not_applicable");
    expect(rb.steps.find((s) => s.key === "calendar")!.state).toBe("not_applicable");
    expect(await checkJobs(a.org.id)).toBe(AGENT_ROLE_KEYS.length);
    expect(await checkJobs(b.org.id)).toBe(dentalChecks);
    // Each client's checks ran on that client's own employees.
    const crossed = await withSystem((db) => db.query("select 1 from ai_work_jobs j join agent_instances i on i.id = j.agent_instance_id where i.org_id <> j.org_id"));
    expect(crossed.rows).toHaveLength(0);
  }, 240_000);

  it("did all of it without sending a message, booking anyone or turning on a public page", async () => {
    for (const c of [a, b]) {
      expect(await count(c.org.id, "appointment_bookings")).toBe(0);
      expect(await count(c.org.id, "appointment_refs")).toBe(0);
      const outbound = await withSystem((db) => db.query<{ n: string }>("select count(*) as n from conversation_messages where org_id = $1 and direction = 'outbound'", [c.org.id]));
      expect(Number(outbound.rows[0].n)).toBe(0);
    }
    const outbox = await withSystem((db) => db.query<{ n: string }>("select count(*) as n from email_outbox"));
    expect(Number(outbox.rows[0].n)).toBe(0);
    const pages = await withSystem((db) => db.query("select 1 from crm_calendars where org_id = $1 and public", [a.org.id]));
    expect(pages.rows).toHaveLength(0);
  }, 180_000);

  it("keeps the clients apart and holds each employee to its own role", async () => {
    // A person who is not a member of the other workspace is refused, whatever context is built for them.
    await expect(loadLaunchFacts(ctxFor(a.owner, b.org, "owner"))).rejects.toThrow(/access/i);
    await expect(loadLaunchFacts(ctxFor(b.owner, a.org, "owner"))).rejects.toThrow(/access/i);
    // An employee only does its own role's reviewed work.
    await expect(dispatchCapabilityJob(a.ctx, { agentRole: "performance_analyst", capability: "appointment_availability", title: "Not mine" })).rejects.toThrow(/role/i);
    const denied = await withSystem((db) => db.query("select 1 from audit_logs where org_id = $1 and action = 'agent.action_denied'", [a.org.id]));
    expect(denied.rows.length).toBeGreaterThan(0);
  }, 180_000);

  it("offers the roofing company's real times in its own time zone, and never the same time twice", async () => {
    const now = new Date();
    const result = await nativeAvailability(a.org.id, { from: now, to: new Date(now.getTime() + 7 * 86_400_000), timeZone: "America/Chicago", limit: 400 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots.length).toBeGreaterThan(20);
    const local = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false, weekday: "short" });
    for (const slot of result.slots.slice(0, 80)) {
      const parts = Object.fromEntries(local.formatToParts(new Date(slot.start)).map((p) => [p.type, p.value]));
      expect(["Mon", "Tue", "Wed", "Thu", "Fri"]).toContain(parts.weekday);
      expect(Number(parts.hour)).toBeGreaterThanOrEqual(9);
      expect(Number(parts.hour)).toBeLessThan(17);
    }
    // Booking is a person's act, not the launch's: one staff booking at the first open time works, and the same time cannot be taken again.
    const typeId = (await withSystem((db) => db.query<{ id: string }>("select id from crm_appointment_types where org_id = $1 order by position limit 1", [a.org.id]))).rows[0].id;
    const startAt = new Date(result.slots[0].start);
    const actor = memberActor(a.ctx);
    await bookNativeAppointment(actor, { typeId, startAt, contact: { firstName: "Ana", lastName: "Reyes", email: "ana@example.test" }, via: "staff" });
    await expect(bookNativeAppointment(actor, { typeId, startAt, contact: { firstName: "Ben", lastName: "Cruz", email: "ben@example.test" }, via: "staff" })).rejects.toThrow();
    expect(await count(a.org.id, "appointment_refs")).toBe(1);
  }, 180_000);
});

describe("a booking tool that needs a connection keeps the client honest", () => {
  it("does not reach 100% while a video appointment needs a Google or Microsoft account that is not connected", async () => {
    const c = await onboard({ ...roofing, name: "Needs Google Roofing", booking: { ...roofing.booking, "d.appt_video": "google_meet" } });
    await clearSetupPayment(c.org.id);
    await runLaunchIntent(c.ctx, "assign_host");
    await runLaunchIntent(c.ctx, "apply_hours");
    const refused = await runLaunchIntent(c.ctx, "activate_calendar");
    expect(refused.ok).toBe(false);
    const r = await readiness(c);
    expect(itemOf(r, "calendar.connection")).toMatchObject({ state: "action_required", owner: "you", action: { href: "/crm/calendar-connections" } });
    expect(r.state).toBe("action_required");
    expect((await loadLaunchFacts(c.ctx))!.appointments.calendar!.status).toBe("draft");
  }, 180_000);
});

describe("a change the client makes later", () => {
  it("keeps the client's own edits, updates the employees the change touches, and re-checks only those", async () => {
    const c = await onboard({ ...dental, name: "Change Later Dental", entitled: AGENT_ROLE_KEYS });
    await clearSetupPayment(c.org.id);
    await simulateVerifiedProfiles(c);
    const actor = memberActor(c.ctx);
    await getWorkspace(actor);
    await listPipelines(actor, { ensureDefault: true });
    await markBlueprintApplied(c.org.id);
    await pickUpSetupEvidence(c.org.id, "a Blueprint apply");
    const roles = AGENT_ROLE_KEYS.filter((role) => role !== "appointment_setter"); // this client books no appointments
    await settled(c.org.id, roles.length);
    expect(await readiness(c)).toMatchObject({ state: "ready_to_launch", percent: 100 });

    // The client rewrites one employee's personality themselves.
    const crm = await agentId(c.org.id, "crm_manager");
    const own = "Our own wording, written by the practice.";
    const active = (await withSystem((db) => db.query<{ settings: Record<string, unknown> }>(
      "select v.settings from agent_config_versions v join agent_instances a on a.active_config_version_id = v.id where a.id = $1", [crm]))).rows[0].settings;
    await withSystem((db) => createConfigVersion(db, { orgId: c.org.id, agentId: crm, settings: agentSettingsSchema.parse({ ...active, personality: own }), source: "client_edit", userId: c.owner.id, apply: true }));
    expect((await sweepLaunchVerification(c.org.id)).queued).toEqual(["crm_manager"]);
    await settled(c.org.id, roles.length + 1);

    const versions = async () => new Map((await withSystem((db) => db.query<{ role_key: string; version: number }>(
      "select a.role_key, v.version from agent_instances a join agent_config_versions v on v.id = a.active_config_version_id where a.org_id = $1", [c.org.id]))).rows.map((r) => [r.role_key, Number(r.version)]));
    const before = await versions();
    // Later they change what they sell and submit again.
    const saved = await saveOnboardingStep(c.ctx, { answers: { "b.services": { value: "Orthodontic braces, clear aligners and retainers" } }, currentQuestionId: "f.review" });
    expect(saved.rejected).toEqual({});
    // A change to what the business says needs the client's approval again before it reaches their employees: nothing changes until they give it.
    await expect(submitOnboarding(c.ctx)).rejects.toThrow(/approve this setup/i);
    expect(await versions()).toEqual(before);
    expect((await saveOnboardingStep(c.ctx, { answers: { "f.review": { value: true } }, currentQuestionId: "f.review" })).rejected).toEqual({});
    await submitOnboarding(c.ctx);
    const after = await versions();
    const changed = [...after.keys()].filter((role) => after.get(role) !== before.get(role)) as AgentRoleKey[];
    expect(changed.length).toBeGreaterThan(0);
    // Their own edit survived the synchronisation.
    const kept = (await withSystem((db) => db.query<{ settings: { personality?: string } }>(
      "select v.settings from agent_config_versions v join agent_instances a on a.active_config_version_id = v.id where a.id = $1", [crm]))).rows[0].settings;
    expect(kept.personality).toBe(own);
    // Each change is a recorded, attributed version, never a silent overwrite.
    const sources = await withSystem((db) => db.query<{ source: string }>("select distinct v.source from agent_config_versions v join agent_instances a on a.active_config_version_id = v.id where a.org_id = $1 and a.role_key = any($2::text[])", [c.org.id, changed]));
    expect(sources.rows.every((r) => ["onboarding", "client_edit"].includes(r.source))).toBe(true);

    // The launch state notices: exactly the employees that changed and have a check to run need a new one, and the sweep starts exactly those. (This client books no appointments, so
    // the Appointment Setter's new version has no check to repeat.)
    const checked = changed.filter((role) => role !== "appointment_setter");
    expect(checked.length).toBeGreaterThan(0);
    const stale = await readiness(c);
    expect(stale.state).toBe("action_required");
    expect(stale.blocking.map((i) => i.key).sort()).toEqual(checked.map((role) => `verification.${role}`).sort());
    expect((await sweepLaunchVerification(c.org.id)).queued.sort()).toEqual([...checked].sort());
    await settled(c.org.id, roles.length + 1 + checked.length);
    expect(await readiness(c)).toMatchObject({ state: "ready_to_launch", percent: 100 });
  }, 240_000);
});
