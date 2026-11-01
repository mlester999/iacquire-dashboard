import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import type { OrgContext } from "@/server/tenancy/context";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { deriveEmployeeReadiness } from "@/lib/workforce-readiness";
import {
  deriveLaunchReadiness,
  type CalendarCheckFact,
  type CalendarFacts,
  type ChannelFact,
  type EmployeeFact,
  type LaunchFacts,
  type LaunchReadiness,
  type ProvisioningFact,
  type VerificationFact,
} from "@/lib/launch-readiness";
import { confirmedAnswers } from "@/lib/onboarding/engine";
import type { Answers } from "@/lib/onboarding/types";
import { loadAnswerRows, toStored } from "@/server/onboarding/answers";
import { isSetupPaymentCleared } from "@/server/billing/clearance";
import { verifyCalendarInTx } from "@/server/calendars/activation";
import { listAgents, type AgentInstanceRow } from "@/server/workforce/service";
import { loadWorkspaceFacts } from "@/server/workforce/readiness-facts";

// The facts behind "is this client ready to launch?", read from the workspace's own records and handed to the pure judge in src/lib/launch-readiness.ts. Nothing here is inferred
// from a queued job or a green badge: a calendar is a row, a host is a membership with weekly hours, an employee is its recorded readiness, a verification is a finished job.
// Read-only. Trusted code: the caller has authorized the person for this workspace (the Setup page requires `setup.view`), and every query names the workspace.

const CHANNELS = ["email", "sms", "whatsapp"] as const;

/** What the questionnaire says. Only confirmed answers count: a guess from the website that the client has not looked at is not an answer. */
async function answersOf(db: Queryable, orgId: string): Promise<Answers> {
  return confirmedAnswers(toStored(await loadAnswerRows(db, orgId)));
}

function provisioningOf(status: string | null): ProvisioningFact {
  return status === "requested" || status === "in_progress" || status === "awaiting_health_check" || status === "succeeded" || status === "failed" || status === "cancelled" ? status : "none";
}

/**
 * The calendar the launch steps are about: the one that takes bookings if there is one, otherwise the default, otherwise the first the workspace made (the onboarding draft).
 * The facts and the buttons that act on a calendar name it the same way, so a button can never change a different calendar from the one the panel describes.
 */
export async function findLaunchCalendar(db: Queryable, orgId: string): Promise<{ id: string; status: "draft" | "active"; public: boolean; suggested: boolean } | null> {
  const row = (await db.query<{ id: string; status: "draft" | "active"; public: boolean; suggested: boolean }>(
    `select id, status, public, jsonb_array_length(coalesce(hours_template, '[]'::jsonb)) > 0 as suggested
       from crm_calendars where org_id = $1 and archived_at is null
      order by (status = 'active') desc, is_default desc, created_at limit 1`,
    [orgId],
  )).rows[0];
  return row ?? null;
}

async function calendarFacts(db: Queryable, orgId: string): Promise<CalendarFacts | null> {
  const cal = await findLaunchCalendar(db, orgId);
  if (!cal) return null;
  // The people who would take bookings: active hosts who are still active members of this workspace, as availability and activation count them.
  const hosts = (await db.query<{ total: number; with_hours: number }>(
    `select count(*)::int as total,
            (count(*) filter (where exists (select 1 from crm_availability_rules r where r.org_id = cm.org_id and r.user_id = cm.user_id)))::int as with_hours
       from crm_calendar_members cm
       join organization_memberships m on m.org_id = cm.org_id and m.user_id = cm.user_id and m.status = 'active'
       join users u on u.id = cm.user_id and u.status = 'active'
      where cm.calendar_id = $1 and cm.org_id = $2 and cm.active`,
    [cal.id, orgId],
  )).rows[0];
  const types = (await db.query<{ total: number; video: boolean }>(
    `select count(*)::int as total, coalesce(bool_or(meeting_provider in ('google_meet', 'microsoft_teams')), false) as video
       from crm_appointment_types where calendar_id = $1 and org_id = $2 and archived_at is null`,
    [cal.id, orgId],
  )).rows[0];
  const total = hosts?.total ?? 0;
  const withHours = hosts?.with_hours ?? 0;
  // The activation checks are worth reading only once there is something to check (they compute real open times), and always for a calendar already taking bookings.
  let checks: CalendarCheckFact[] | null = null;
  if (cal.status === "active" || (total > 0 && withHours >= total && (types?.total ?? 0) > 0)) {
    try {
      const v = await verifyCalendarInTx(db, orgId, cal.id);
      checks = v.checks.map((c) => ({ key: c.key, ok: c.ok, detail: c.detail }));
    } catch {
      checks = null;
    }
  }
  return {
    id: cal.id, status: cal.status, hosts: total, hostsWithHours: withHours, hasSuggestedHours: cal.suggested, types: types?.total ?? 0,
    needsVideoConnection: types?.video === true, checks, bookingPageOn: cal.public,
  };
}

/** The latest read-only check run for each role, as the launch panel started it (input.launchVerification). */
async function verificationFacts(db: Queryable, orgId: string): Promise<VerificationFact[]> {
  const { rows } = await db.query<{ role: AgentRoleKey; status: string; result_count: number; failure_message: string | null; result_summary: string | null; config_version: string | null; reason: string | null }>(
    `select distinct on (a.role_key) a.role_key as role, j.status, j.result_count, j.failure_message, j.result_summary,
            j.input ->> 'configVersion' as config_version, j.result -> 'availability' ->> 'reason' as reason
       from ai_work_jobs j join agent_instances a on a.id = j.agent_instance_id and a.org_id = j.org_id
      where j.org_id = $1 and j.input ->> 'launchVerification' = 'true'
      order by a.role_key, j.created_at desc`,
    [orgId],
  );
  return rows.map((r): VerificationFact => {
    const configVersion = r.config_version !== null && Number.isFinite(Number(r.config_version)) ? Number(r.config_version) : null;
    if (r.status === "queued" || r.status === "running" || r.status === "waiting_for_approval") return { role: r.role, state: "running" };
    if (r.status !== "completed") return { role: r.role, state: "failed", configVersion, detail: (r.failure_message ?? r.result_summary ?? "The check did not complete.").slice(0, 300) };
    // The Appointment Setter is only proven when a real open time was found: a calendar that cannot offer one is not a working scheduler.
    if (r.role === "appointment_setter" && (r.reason || r.result_count < 1)) {
      return { role: r.role, state: "failed", configVersion, detail: (r.reason ?? "No bookable time was found in the next seven days. Check the host's weekly hours and the appointment type's notice.").slice(0, 300) };
    }
    return { role: r.role, state: "passed", configVersion, detail: r.result_summary ? r.result_summary.slice(0, 300) : null };
  });
}

function employeeFacts(agents: AgentInstanceRow[], jobs: Map<AgentRoleKey, { status: string | null; detail: string | null }>, held: Set<AgentRoleKey>, paymentCleared: boolean | null): EmployeeFact[] {
  const out: EmployeeFact[] = [];
  for (const role of AGENT_ROLE_KEYS) {
    const agent = agents.find((a) => a.role_key === role);
    if (!agent) continue; // the judge reports a missing record as something iAcquire must look at
    const readiness = deriveEmployeeReadiness({
      displayName: agent.display_name, enabled: agent.enabled, status: agent.status,
      configVersion: agent.config_version, lastHealthCheckAt: agent.last_health_check_at?.toISOString() ?? null,
      lastHealthOk: agent.last_health_ok, lastHealthDetail: agent.last_health_detail,
      inventoryContract: agent.tool_inventory_contract, inventoryDigest: agent.tool_inventory_digest,
      inventoryVerifiedAt: agent.tool_inventory_verified_at?.toISOString() ?? null,
      inventoryExpiresAt: agent.tool_inventory_expires_at?.toISOString() ?? null,
      inventoryToolCount: agent.tool_inventory_tool_count, credentialCurrent: agent.credential_ready,
      paymentCleared: paymentCleared ?? undefined, extras: agent.readiness_extras,
    });
    const job = jobs.get(role);
    out.push({
      role,
      // The plan decides which employees are switched on for this workspace; the rest are registered but not started.
      entitled: agent.enabled,
      provisioning: provisioningOf(job?.status ?? null),
      provisioningDetail: job?.detail ?? null,
      readiness: { state: readiness.state, chatAvailable: readiness.chatAvailable, workReady: readiness.workReady, description: readiness.description, blocking: readiness.blocking.map((b) => b.label) },
      heldForReview: held.has(role),
      configVersion: agent.config_version,
    });
  }
  return out;
}

/** Everything the judge needs for one client workspace, or null for a workspace that is not a client's. */
export async function loadLaunchFacts(ctx: OrgContext): Promise<LaunchFacts | null> {
  const orgId = ctx.org.orgId;
  const agents = await listAgents(ctx.user.id, orgId);
  const read = await withSystem(async (db) => {
    const org = (await db.query<{ kind: string; name: string; industry: string | null; timezone: string; submitted: boolean; is_demo: boolean; description: string }>(
      `select o.kind, o.name, o.industry, o.timezone, o.onboarding_completed_at is not null as submitted, o.is_demo, coalesce(p.description, '') as description
         from organizations o left join company_profiles p on p.org_id = o.id where o.id = $1`,
      [orgId],
    )).rows[0];
    if (!org || org.kind !== "client") return null;
    const answers = await answersOf(db, orgId);
    const workspace = await loadWorkspaceFacts(db, orgId);
    const mode = (await db.query<{ mode: "native" | "ghl" | "hybrid" }>("select mode from crm_workspaces where org_id = $1", [orgId])).rows[0]?.mode ?? "native";
    const blueprint = Number((await db.query<{ n: string }>("select count(*) as n from crm_blueprint_applications where org_id = $1 and status in ('applied', 'partially_applied')", [orgId])).rows[0]?.n ?? 0) > 0;
    const providerConnected = Number((await db.query<{ n: string }>("select count(*) as n from ghl_location_mappings where org_id = $1 and status = 'connected' and verified_at is not null", [orgId])).rows[0]?.n ?? 0) > 0;
    const calendar = mode === "ghl" ? null : await calendarFacts(db, orgId);
    const externalCalendarConnected = mode === "native"
      ? Number((await db.query<{ n: string }>("select count(*) as n from crm_calendar_connections where org_id = $1 and status = 'connected'", [orgId])).rows[0]?.n ?? 0) > 0
      : Number((await db.query<{ n: string }>("select coalesce(sum(cardinality(calendar_ids)), 0) as n from ghl_location_mappings where org_id = $1 and status = 'connected'", [orgId])).rows[0]?.n ?? 0) > 0;
    const channelRows = (await db.query<{ channel: ChannelFact["channel"]; enabled: boolean; registration_status: string }>("select channel, enabled, registration_status from messaging_channels where org_id = $1", [orgId])).rows;
    const jobs = new Map<AgentRoleKey, { status: string | null; detail: string | null }>();
    for (const r of (await db.query<{ role: AgentRoleKey; status: string | null; detail: string | null }>(
      `select distinct on (a.role_key) a.role_key as role, j.status, j.detail
         from agent_instances a left join agent_provisioning_jobs j on j.agent_instance_id = a.id and j.org_id = a.org_id
        where a.org_id = $1 order by a.role_key, j.created_at desc nulls last`,
      [orgId],
    )).rows) jobs.set(r.role, { status: r.status, detail: r.detail });
    const held = new Set<AgentRoleKey>((await db.query<{ role: AgentRoleKey }>(
      `select distinct a.role_key as role from agent_instances a join agent_config_versions v on v.agent_instance_id = a.id and v.org_id = a.org_id
        where a.org_id = $1 and v.status = 'pending_agency_review'`,
      [orgId],
    )).rows.map((r) => r.role));
    const paymentCleared = org.is_demo ? null : await isSetupPaymentCleared(db, orgId);
    const verification = await verificationFacts(db, orgId);
    return { org, answers, workspace, mode, blueprint, providerConnected, calendar, externalCalendarConnected, channelRows, jobs, held, paymentCleared, verification };
  });
  if (!read) return null;
  const { org, answers, workspace, mode, blueprint, providerConnected, calendar, externalCalendarConnected, channelRows, jobs, held, paymentCleared, verification } = read;

  const wantedChannels = Array.isArray(answers["c.channels"]) ? (answers["c.channels"] as string[]) : [];
  // A booking calendar that is already taking bookings answers "do you book appointments?" even if the questionnaire was never asked.
  const answered = typeof answers["b.appointments"] === "boolean" ? (answers["b.appointments"] as boolean) : null;
  const wantsAppointments = answered ?? (calendar?.status === "active" ? true : null);
  const timezoneAnswered = typeof answers["a.timezone"] === "string" && (answers["a.timezone"] as string).trim() !== "";
  return {
    submitted: org.submitted,
    paymentCleared,
    canOpenBilling: ctx.can("billing.view"),
    profile: {
      companyName: org.name.trim() !== "",
      industry: Boolean(org.industry?.trim()) || (typeof answers["a.industry"] === "string" && (answers["a.industry"] as string) !== ""),
      description: org.description.trim() !== "" || (typeof answers["a.description"] === "string" && (answers["a.description"] as string).trim() !== ""),
      timezone: org.timezone,
      timezoneAnswered,
    },
    knowledge: { approved: workspace.knowledge?.supplied ?? 0, pending: workspace.knowledge?.heldForReview ?? 0 },
    crm: { mode, blueprintApplied: blueprint, pipelineReady: workspace.pipelineReady, providerConnected },
    appointments: { wanted: wantsAppointments, calendar, externalCalendarConnected },
    channels: CHANNELS.map((channel): ChannelFact => {
      const row = channelRows.find((r) => r.channel === channel);
      return { channel, wanted: wantedChannels.includes(channel), enabled: row?.enabled ?? false, registration: row?.registration_status ?? "not_started" };
    }),
    employees: employeeFacts(agents, jobs, held, paymentCleared),
    verification,
  };
}

/** The honest launch state of the viewer's client workspace, or null for a workspace that is not a client's. */
export async function getLaunchReadiness(ctx: OrgContext): Promise<LaunchReadiness | null> {
  const facts = await loadLaunchFacts(ctx);
  return facts ? deriveLaunchReadiness(facts) : null;
}
