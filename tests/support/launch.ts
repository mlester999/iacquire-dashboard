// Fixtures for the launch-readiness tests: a client whose setup is finished in every way but the final checks, and the small readers the tests share. Nothing here talks to a provider.
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import type { LaunchReadiness } from "@/lib/launch-readiness";
import { getWorkspace } from "@/server/crm/workspace";
import { applyBlueprint, previewApplication } from "@/server/crm/blueprints/apply";
import { createAppointmentType, createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { loadLaunchFacts } from "@/server/setup/launch-readiness";
import { runLaunchIntent } from "@/server/setup/launch-intents";
import type { OrgContext } from "@/server/tenancy/context";
import { agentId, ctxFor } from "./fixtures";
import { agencyPeople, crmOrg } from "./crm";
import { clearSetupPayment } from "./billing";
import { makeRuntimeReady } from "./runtime-ready";
import { confirmation, insertPublishedBlueprint, smallContent } from "./blueprints";

export const itemOf = (r: LaunchReadiness, key: string) => r.steps.flatMap((s) => s.items).find((i) => i.key === key)!;
export const WEEKDAYS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));

/**
 * Applies a REAL small Blueprint (a pipeline with stages, tags, a contact field, a configuration value, a template and a workflow) the way an agency Super Admin does: preview, then
 * the confirmed apply. The launch panel judges the CRM from what this leaves in the workspace, so a test that uses it proves the real evidence, not a hand-made row. Needs the
 * workspace's CRM to exist (getWorkspace) and must run before any employee is ready for work, because an apply starts the final checks of employees that already are.
 */
export async function applyRealBlueprint(orgId: string) {
  const { superAdmin } = await agencyPeople();
  const bp = await insertPublishedBlueprint(smallContent());
  const options = { strategy: "add_missing" as const };
  const preview = await previewApplication(superAdmin, orgId, { blueprintId: bp.blueprintId, version: bp.version, options });
  const { application } = await applyBlueprint(superAdmin, orgId, { blueprintId: bp.blueprintId, version: bp.version, options, planDigest: preview.plan.digest, idempotencyKey: confirmation() });
  return { blueprintId: bp.blueprintId, applicationId: application.id, status: application.status };
}

/** An EMPTY applied-Blueprint record, for the pure-panel tests that need "an application exists" and nothing more. The launch tests that prove the CRM use applyRealBlueprint. */
export async function markBlueprintApplied(orgId: string) {
  const bp = await insertPublishedBlueprint(smallContent());
  await withSystem((db) => db.query(
    `insert into crm_blueprint_applications (org_id, blueprint_id, version_id, version, blueprint_name, mode, strategy, status, plan_digest, idempotency_key)
     values ($1, $2, $3, 1, 'Test blueprint', 'initial', 'add_missing', 'applied', $4, $5)`,
    [orgId, bp.blueprintId, bp.versionId, "a".repeat(64), `launch-test-${orgId}`],
  ));
}

/** A client whose setup is finished in every way but the final checks: submitted, paid, CRM and calendar in place, six employees ready for authorized work. */
export async function readyClient(opts: { name: string; timezone: string; noticeMinutes?: number }) {
  const c = await crmOrg({ name: opts.name, timezone: opts.timezone });
  const owner = c.people.owner;
  await withSystem(async (db) => {
    await db.query("update organizations set onboarding_completed_at = now(), industry = 'home_services' where id = $1", [c.org.id]);
    await db.query("insert into company_profiles (org_id, description) values ($1, 'We repair roofs after storms.') on conflict (org_id) do update set description = excluded.description", [c.org.id]);
    await db.query("insert into onboarding_answers (org_id, question_id, value) values ($1, 'b.appointments', 'true'::jsonb), ($1, 'a.timezone', to_jsonb($2::text))", [c.org.id, opts.timezone]);
    await db.query("insert into company_knowledge (org_id, section, content) values ($1, 'business_description', 'We repair residential roofs after storm damage.')", [c.org.id]);
    await db.query("insert into lead_targeting_profiles (org_id, criteria) values ($1, $2)", [c.org.id, JSON.stringify({ industries: ["Homeowners"], countries: ["US"] })]);
  });
  await clearSetupPayment(c.org.id);
  const actor = c.actor("owner");
  await getWorkspace(actor);
  await applyRealBlueprint(c.org.id);
  await setHostAvailability(actor, owner.id, { timezone: opts.timezone, rules: WEEKDAYS });
  const calendar = await createCalendar(actor, { name: "Consultations", members: [{ userId: owner.id }], isDefault: true });
  await createAppointmentType(actor, calendar.id, { name: "Free consultation", durationMinutes: 30, minNoticeMinutes: opts.noticeMinutes ?? 60, maxDaysAhead: 30 });
  for (const role of AGENT_ROLE_KEYS) await makeRuntimeReady(await agentId(c.org.id, role), c.org.id, owner.id);
  return { ...c, calendarId: calendar.id, ctx: ctxFor(owner, c.org, "owner") };
}

export async function settled(orgId: string, expected: number) {
  for (let i = 0; i < 600; i += 1) {
    const { rows } = await withSystem((db) => db.query<{ status: string }>("select status from ai_work_jobs where org_id = $1 and input ->> 'launchVerification' = 'true'", [orgId]));
    if (rows.length >= expected && rows.every((r) => ["completed", "failed", "blocked", "cancelled"].includes(r.status))) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the launch checks did not settle");
}
export const checkJobs = async (orgId: string) => Number((await withSystem((db) => db.query<{ n: string }>("select count(*) as n from ai_work_jobs where org_id = $1 and input ->> 'launchVerification' = 'true'", [orgId]))).rows[0].n);
export const count = async (orgId: string, table: string) => Number((await withSystem((db) => db.query<{ n: string }>(`select count(*) as n from ${table} where org_id = $1`, [orgId]))).rows[0].n);

/**
 * Approves exactly the hours the panel shows, the way the client's button does: the digest comes off the facts that were read for the person, and the intent runs with it. When
 * nothing is waiting for hours there is no digest, and the intent is run without one (which changes nothing).
 */
export async function approveHours(ctx: OrgContext) {
  const digest = (await loadLaunchFacts(ctx))?.appointments.calendar?.suggestedHours?.digest;
  return runLaunchIntent(ctx, "apply_hours", digest ? { hoursDigest: digest } : {});
}

/**
 * A client that has submitted and paid, with a DRAFT booking calendar of the kind the onboarding makes: suggested weekdays 9 to 5 in its zone, one phone appointment type, and
 * nobody as the host. The questionnaire answers it stores are the ones the launch steps read (it books appointments, in this zone).
 */
export async function draftClient(name: string, timezone: string) {
  const c = await crmOrg({ name, timezone });
  await withSystem(async (db) => {
    await db.query("update organizations set onboarding_completed_at = now() where id = $1", [c.org.id]);
    await db.query("insert into onboarding_answers (org_id, question_id, value) values ($1, 'b.appointments', 'true'::jsonb), ($1, 'a.timezone', to_jsonb($2::text))", [c.org.id, timezone]);
  });
  await clearSetupPayment(c.org.id);
  const calendarId = (await withSystem((db) => db.query<{ id: string }>(
    `insert into crm_calendars (org_id, name, slug, status, origin, timezone, hours_template) values ($1, 'Consultations', 'consultations', 'draft', 'onboarding', $2, $3::jsonb) returning id`,
    [c.org.id, timezone, JSON.stringify(WEEKDAYS)],
  ))).rows[0].id;
  await withSystem((db) => db.query("insert into crm_appointment_types (org_id, calendar_id, name, slug, duration_minutes, min_notice_minutes, location_kind) values ($1, $2, 'Free consultation', 'free-consultation', 30, 60, 'phone')", [c.org.id, calendarId]));
  return { ...c, calendarId, ctx: ctxFor(c.people.owner, c.org, "owner") };
}
