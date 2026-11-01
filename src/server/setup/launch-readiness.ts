import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import type { OrgContext } from "@/server/tenancy/context";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { deriveEmployeeReadiness } from "@/lib/workforce-readiness";
import {
  deriveLaunchReadiness,
  type CalendarCheckFact,
  type CalendarFacts,
  type ChannelFact,
  type CrmBlueprintFact,
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
import { MAX_PROVISIONING_ATTEMPTS } from "@/lib/provisioning-failure";
import { actualDataModel, blueprintEvidence, loadBlueprintState, manifestEvidence } from "@/server/setup/native-evidence";
import { statedSenderOf } from "@/server/onboarding/connection-facts";
import { listAgents, listAgentsForSystem, type AgentInstanceRow } from "@/server/workforce/service";
import { loadWorkspaceFacts } from "@/server/workforce/readiness-facts";

// The facts behind "is this client ready to launch?", read from the workspace's own records and handed to the pure judge in src/lib/launch-readiness.ts. Nothing here is inferred
// from a queued job or a green badge: a calendar is a row, a host is a membership with weekly hours, an employee is its recorded readiness, a verification is a finished job.
// Read-only. Trusted code: the caller has authorized the person for this workspace (the Setup page requires `setup.view`), and every query names the workspace.

const CHANNELS = ["email", "sms", "whatsapp"] as const;

/** What the questionnaire says. Only confirmed answers count: a guess from the website that the client has not looked at is not an answer. */
async function answersOf(db: Queryable, orgId: string): Promise<Answers> {
  return confirmedAnswers(toStored(await loadAnswerRows(db, orgId)));
}

type CrmFacts = Pick<LaunchFacts["crm"], "blueprint" | "blueprintSummary" | "automaticSetup" | "pipelineReady" | "records">;

/** At least two non-archived stages, one of them open, in a non-archived native pipeline. The questionnaire's employee requirements only ask for the open stage; the launch asks for a usable board. */
const USABLE_PIPELINE_SQL = `select exists (
  select 1 from crm_pipelines p
   where p.org_id = $1 and p.provider = 'native' and p.archived_at is null
     and (select count(*) from crm_pipeline_stages s where s.pipeline_id = p.id and s.org_id = p.org_id and s.archived_at is null) >= 2
     and exists (select 1 from crm_pipeline_stages s where s.pipeline_id = p.id and s.org_id = p.org_id and s.archived_at is null and s.kind = 'open')
) as ok`;

/**
 * The industry CRM setup of a native workspace, judged from the Blueprint evidence (the agency's own check): done only when the newest application of every live Blueprint
 * finished and every record it created is still in the CRM. With no application at all, the newest automatic-setup audit row says whether the automation is waiting for a person
 * or failed; any application (or a rollback) outranks an older audit row, because it is the record of what really happened to the CRM.
 */
async function crmFacts(db: Queryable, orgId: string): Promise<CrmFacts> {
  const state = await loadBlueprintState(db, orgId);
  const evidence = blueprintEvidence(state);
  const actual = await actualDataModel(db, orgId);
  const manifest = manifestEvidence(state, actual);
  const pipelineReady = (await db.query<{ ok: boolean }>(USABLE_PIPELINE_SQL, [orgId])).rows[0]?.ok === true;
  const automaticSetup = env().CLIENT_CRM_AUTO_SETUP_ENABLED;

  let blueprint: CrmBlueprintFact;
  let summary: string | null = null;
  if (!state.latest.length) {
    const last = (await db.query<{ action: string }>(
      "select action from audit_logs where org_id = $1 and action in ('crm.auto_setup_applied', 'crm.auto_setup_failed', 'crm.auto_setup_waiting_for_person') order by created_at desc, id desc limit 1",
      [orgId],
    )).rows[0]?.action;
    if (last === "crm.auto_setup_waiting_for_person") blueprint = "waiting_for_a_person";
    else if (last === "crm.auto_setup_failed") {
      blueprint = "failed";
      summary = "The automatic setup of your industry CRM did not finish. iAcquire will review it and apply it. Nothing is needed from you.";
    } else blueprint = "none";
  } else if (!state.live.length) {
    // The newest application failed or was rolled back: either way nothing from it is in the CRM, and iAcquire has to apply it again.
    blueprint = "failed";
    summary = evidence.summary;
  } else if (evidence.missing.length || manifest.status === "failed") {
    blueprint = "missing_records";
    summary = evidence.missing.length ? evidence.summary : manifest.summary;
  } else if (evidence.status !== "verified") {
    blueprint = "partial";
    summary = evidence.summary;
  } else {
    blueprint = "verified";
  }
  const recordsState = manifest.status === "failed" ? "missing" : blueprint === "verified" ? "in_place" : "pending";
  return { blueprint, blueprintSummary: summary, automaticSetup, pipelineReady, records: { state: recordsState, tags: actual.tags, contactFields: actual.contactFields, forms: actual.forms } };
}

/**
 * A failed attempt is "failed" for a person only when no retry is coming: all attempts used, or no retry time. A transient failure (the model provider or the network was
 * unavailable) is given its attempt back and retried by itself, for up to a day, so showing it as failed would tell a client to expect manual work that is not needed.
 */
function provisioningOf(status: string | null, attempts: number | null, nextRetryAt: Date | string | null): ProvisioningFact {
  if (status === "failed") return nextRetryAt !== null && (attempts ?? MAX_PROVISIONING_ATTEMPTS) < MAX_PROVISIONING_ATTEMPTS ? "retrying" : "failed";
  return status === "requested" || status === "in_progress" || status === "awaiting_health_check" || status === "succeeded" || status === "cancelled" ? status : "none";
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
  const types = (await db.query<{ total: number; video: boolean; google: boolean; microsoft: boolean }>(
    `select count(*)::int as total, coalesce(bool_or(meeting_provider in ('google_meet', 'microsoft_teams')), false) as video,
            coalesce(bool_or(meeting_provider = 'google_meet'), false) as google, coalesce(bool_or(meeting_provider = 'microsoft_teams'), false) as microsoft
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
    needsVideoConnection: types?.video === true, videoProviders: [...(types?.google ? ["google" as const] : []), ...(types?.microsoft ? ["microsoft" as const] : [])], checks, bookingPageOn: cal.public,
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

function employeeFacts(agents: AgentInstanceRow[], jobs: Map<AgentRoleKey, { status: string | null; detail: string | null; attempts: number | null; nextRetryAt: Date | string | null }>, held: Set<AgentRoleKey>, paymentCleared: boolean | null): EmployeeFact[] {
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
      provisioning: provisioningOf(job?.status ?? null, job?.attempts ?? null, job?.nextRetryAt ?? null),
      provisioningDetail: job?.detail ?? null,
      attempts: job?.attempts ?? 0,
      maxAttempts: MAX_PROVISIONING_ATTEMPTS,
      nextRetryAt: job?.nextRetryAt ? new Date(job.nextRetryAt).toISOString() : null,
      // Only a check that ran and said no: "not checked yet" (null) is waiting, not failing.
      healthFailed: agent.last_health_ok === false,
      healthDetail: agent.last_health_detail,
      readiness: { state: readiness.state, chatAvailable: readiness.chatAvailable, workReady: readiness.workReady, description: readiness.description, blocking: readiness.blocking.map((b) => b.label) },
      heldForReview: held.has(role),
      configVersion: agent.config_version,
    });
  }
  return out;
}

/** Everything the judge needs for one client workspace as the signed-in person sees it, or null for a workspace that is not a client's. */
export async function loadLaunchFacts(ctx: OrgContext): Promise<LaunchFacts | null> {
  // Most of the facts are read as trusted code, so the person is checked here too: someone who is not an active member of this workspace is refused, whatever context was built for them.
  if (ctx.user.platformRole === "none") {
    const member = await withSystem((db) => db.query("select 1 from organization_memberships where org_id = $1 and user_id = $2 and status = 'active'", [ctx.org.orgId, ctx.user.id]));
    if (!member.rows.length) throw new AppError("forbidden", "You don't have access to that workspace.");
  }
  return readLaunchFacts(ctx.org.orgId, await listAgents(ctx.user.id, ctx.org.orgId), ctx.can("billing.view"));
}

/** The same facts for trusted server code with no signed-in person (the launch sweep). */
export async function loadLaunchFactsForOrg(orgId: string): Promise<LaunchFacts | null> {
  return readLaunchFacts(orgId, await listAgentsForSystem(orgId), false);
}

async function readLaunchFacts(orgId: string, agents: AgentInstanceRow[], canOpenBilling: boolean): Promise<LaunchFacts | null> {
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
    const crm = mode === "native" ? await crmFacts(db, orgId) : null;
    const providerConnected = Number((await db.query<{ n: string }>("select count(*) as n from ghl_location_mappings where org_id = $1 and status = 'connected' and verified_at is not null", [orgId])).rows[0]?.n ?? 0) > 0;
    const calendar = mode === "ghl" ? null : await calendarFacts(db, orgId);
    const externalCalendarConnected = mode === "native"
      ? Number((await db.query<{ n: string }>("select count(*) as n from crm_calendar_connections where org_id = $1 and status = 'connected'", [orgId])).rows[0]?.n ?? 0) > 0
      : Number((await db.query<{ n: string }>("select coalesce(sum(cardinality(calendar_ids)), 0) as n from ghl_location_mappings where org_id = $1 and status = 'connected'", [orgId])).rows[0]?.n ?? 0) > 0;
    const channelRows = (await db.query<{ channel: ChannelFact["channel"]; enabled: boolean; registration_status: string; credential: boolean }>(
      `select mc.channel, mc.enabled, mc.registration_status, (c.id is not null and c.revoked_at is null) as credential
         from messaging_channels mc left join integration_credentials c on c.id = mc.credential_id where mc.org_id = $1`,
      [orgId],
    )).rows;
    const jobs = new Map<AgentRoleKey, { status: string | null; detail: string | null; attempts: number | null; nextRetryAt: Date | string | null }>();
    for (const r of (await db.query<{ role: AgentRoleKey; status: string | null; detail: string | null; attempt_count: number | null; next_retry_at: Date | string | null }>(
      `select distinct on (a.role_key) a.role_key as role, j.status, j.detail, j.attempt_count, j.next_retry_at
         from agent_instances a left join agent_provisioning_jobs j on j.agent_instance_id = a.id and j.org_id = a.org_id
        where a.org_id = $1 order by a.role_key, j.created_at desc nulls last`,
      [orgId],
    )).rows) jobs.set(r.role, { status: r.status, detail: r.detail, attempts: r.attempt_count, nextRetryAt: r.next_retry_at });
    const held = new Set<AgentRoleKey>((await db.query<{ role: AgentRoleKey }>(
      `select distinct a.role_key as role from agent_instances a join agent_config_versions v on v.agent_instance_id = a.id and v.org_id = a.org_id
        where a.org_id = $1 and v.status = 'pending_agency_review'`,
      [orgId],
    )).rows.map((r) => r.role));
    const paymentCleared = org.is_demo ? null : await isSetupPaymentCleared(db, orgId);
    const verification = await verificationFacts(db, orgId);
    return { org, answers, workspace, mode, crm, providerConnected, calendar, externalCalendarConnected, channelRows, jobs, held, paymentCleared, verification };
  });
  if (!read) return null;
  const { org, answers, workspace, mode, crm, providerConnected, calendar, externalCalendarConnected, channelRows, jobs, held, paymentCleared, verification } = read;

  const wantedChannels = Array.isArray(answers["c.channels"]) ? (answers["c.channels"] as string[]) : [];
  // A booking calendar that is already taking bookings answers "do you book appointments?" even if the questionnaire was never asked.
  const answered = typeof answers["b.appointments"] === "boolean" ? (answers["b.appointments"] as boolean) : null;
  const wantsAppointments = answered ?? (calendar?.status === "active" ? true : null);
  const timezoneAnswered = typeof answers["a.timezone"] === "string" && (answers["a.timezone"] as string).trim() !== "";
  return {
    submitted: org.submitted,
    paymentCleared,
    canOpenBilling,
    profile: {
      companyName: org.name.trim() !== "",
      industry: Boolean(org.industry?.trim()) || (typeof answers["a.industry"] === "string" && (answers["a.industry"] as string) !== ""),
      description: org.description.trim() !== "" || (typeof answers["a.description"] === "string" && (answers["a.description"] as string).trim() !== ""),
      timezone: org.timezone,
      timezoneAnswered,
    },
    knowledge: { approved: workspace.knowledge?.supplied ?? 0, pending: workspace.knowledge?.heldForReview ?? 0 },
    crm: crm ? { mode, ...crm, providerConnected } : { mode, blueprint: "none", pipelineReady: workspace.pipelineReady, providerConnected },
    appointments: { wanted: wantsAppointments, calendar, externalCalendarConnected },
    channels: CHANNELS.map((channel): ChannelFact => {
      const row = channelRows.find((r) => r.channel === channel);
      return {
        channel, wanted: wantedChannels.includes(channel), enabled: row?.enabled ?? false, registration: row?.registration_status ?? "not_started",
        statedSender: statedSenderOf(answers, channel), credentialStored: row?.credential ?? false,
      };
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
