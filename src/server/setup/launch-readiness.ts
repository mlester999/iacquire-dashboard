import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import type { OrgContext } from "@/server/tenancy/context";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { deriveEmployeeReadiness } from "@/lib/workforce-readiness";
import {
  deriveLaunchReadiness,
  STALL_MINUTES,
  type StallMinutes,
  type CalendarCheckFact,
  type CalendarFacts,
  type ChannelFact,
  type CrmBlueprintFact,
  type EmployeeFact,
  type LaunchFacts,
  type LaunchReadiness,
  type ProvisioningFact,
  type TeamHostFact,
  type VerificationFact,
} from "@/lib/launch-readiness";
import { confirmedAnswers } from "@/lib/onboarding/engine";
import type { Answers } from "@/lib/onboarding/types";
import { loadAnswerRows, toStored } from "@/server/onboarding/answers";
import { approvedAnswersOf, channelsWithApprovedSender, readPendingAnswerChanges } from "@/server/onboarding/pending-changes";
import { isSetupPaymentCleared } from "@/server/billing/clearance";
import { activeHostsOfCalendar, hostConnectionStates, proposeCalendarHours, statedBusyAnswer, verifyCalendarInTx } from "@/server/calendars/activation";
import { calendarConnectionSettings } from "@/server/calendars/connections";
import { MAX_PROVISIONING_ATTEMPTS } from "@/lib/provisioning-failure";
import { actualDataModel, blueprintEvidence, loadBlueprintState, manifestEvidence } from "@/server/setup/native-evidence";
import { statedSenderOf } from "@/server/onboarding/connection-facts";
import { listAgents, listAgentsForSystem, type AgentInstanceRow } from "@/server/workforce/service";
import { USABLE_NATIVE_PIPELINE_SQL, loadWorkspaceFacts } from "@/server/workforce/readiness-facts";

// The facts behind "is this client ready to launch?", read from the workspace's own records and handed to the pure judge in src/lib/launch-readiness.ts. Nothing here is inferred
// from a queued job or a green badge: a calendar is a row, a host is a membership with weekly hours, an employee is its recorded readiness, a verification is a finished job.
// Read-only. Trusted code: the caller has authorized the person for this workspace (the Setup page requires `setup.view`), and every query names the workspace.

const CHANNELS = ["email", "sms", "whatsapp"] as const;

/**
 * The thresholds the judge uses on the server: the provisioning one is the same HERMES_PROVISIONER_STALL_MINUTES the provisioning watchdog alerts on, so the panel and the alert agree
 * about when a profile job has waited too long. The other two are constants (src/lib/launch-readiness.ts).
 */
export function launchStallMinutes(): StallMinutes {
  return { ...STALL_MINUTES, provisioning: env().HERMES_PROVISIONER_STALL_MINUTES };
}

/** The name of the agency notice about one long wait. The ledger writes it and the facts look for it, so the panel says "iAcquire has been alerted" only after a notice really exists. */
export function launchStallAlertKey(orgId: string, itemKey: string, since: string): string {
  return `launch-stalled:${orgId}:${itemKey}:${Math.floor(Date.parse(since) / 1000)}`;
}

/**
 * Which of these waits iAcquire was really told about: a ledger notice with the exact key, or (for a profile job still waiting in the queue) the provisioning watchdog's own
 * stalled-queue notice. The watchdog only looks at requests that had already waited past the threshold, so its notice covers a job only when it was sent after that much waiting; a
 * job that was running, or younger than that, was not what the notice was about.
 */
async function alertedWaits(db: Queryable, orgId: string, waits: Array<{ itemKey: string; since: string; queued: boolean }>, queueStallMinutes: number): Promise<Set<string>> {
  if (!waits.length) return new Set();
  const keys = waits.map((w) => launchStallAlertKey(orgId, w.itemKey, w.since));
  const told = new Set((await db.query<{ dedupe_key: string }>("select distinct dedupe_key from notifications where org_id = $1 and dedupe_key = any($2::text[])", [orgId, keys])).rows.map((r) => r.dedupe_key));
  if (waits.some((w) => w.queued)) {
    const noticed = (await db.query<{ at: Date | string }>("select created_at as at from notifications where org_id = $1 and dedupe_key like $2 order by created_at desc limit 50", [orgId, `provisioning-stalled:${orgId}:%`])).rows.map((r) => new Date(r.at).getTime());
    for (const w of waits) if (w.queued && noticed.some((at) => at >= Date.parse(w.since) + queueStallMinutes * 60_000)) told.add(launchStallAlertKey(orgId, w.itemKey, w.since));
  }
  return told;
}

/** Who the client said takes the appointments: themselves or a team member. Only a confirmed answer counts, and only while appointments are wanted (the answer is hidden otherwise). */
function hostChoiceOf(answers: Answers): "owner" | "team" | null {
  const choice = answers["d.appt_host"];
  return choice === "owner" || choice === "team" ? choice : null;
}

type CrmFacts = Pick<LaunchFacts["crm"], "blueprint" | "blueprintSummary" | "automaticSetup" | "pipelineReady" | "records">;

/** A usable board, by the one rule the launch panel and the employee requirements share (USABLE_NATIVE_PIPELINE_SQL): two or more non-archived stages, one of them open. */
const USABLE_PIPELINE_SQL = `select ${USABLE_NATIVE_PIPELINE_SQL} as ok`;

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

/**
 * Who is looking: their user id (for "your own account") and whether they may set up calendars. A trusted system read (the sweep) has no viewer: nothing is said about what a person
 * may do, and no list of people is read.
 */
interface Viewer {
  userId: string | null;
  canManageCalendars: boolean | null;
}

const NO_VIEWER: Viewer = { userId: null, canManageCalendars: null };

async function calendarFacts(db: Queryable, orgId: string, viewer: Viewer): Promise<CalendarFacts | null> {
  const cal = await findLaunchCalendar(db, orgId);
  if (!cal) return null;
  // The people who would take bookings: active hosts who are still active members of this workspace, as availability and activation count them.
  const hostList = await activeHostsOfCalendar(db, orgId, cal.id);
  const total = hostList.length;
  const withHours = hostList.filter((h) => h.hasHours).length;
  const typeRows = (await db.query<{ name: string; location_kind: string; meeting_provider: string; location_detail: string | null }>(
    "select name, location_kind, meeting_provider, location_detail from crm_appointment_types where calendar_id = $1 and org_id = $2 and archived_at is null order by position, lower(name)",
    [cal.id, orgId],
  )).rows;
  const google = typeRows.some((t) => t.meeting_provider === "google_meet");
  const microsoft = typeRows.some((t) => t.meeting_provider === "microsoft_teams");
  // A video appointment that tells the customer nothing about how to join (the same reading as the activation check).
  const typesWithoutJoinInfo = typeRows.filter((t) => t.location_kind === "video" && t.meeting_provider === "none" && !(t.location_detail ?? "").trim()).map((t) => t.name);
  // The activation checks are worth reading only once there is something to check (they compute real open times), and always for a calendar already taking bookings.
  let checks: CalendarCheckFact[] | null = null;
  let typesWithoutTimes: string[] | undefined;
  if (cal.status === "active" || (total > 0 && withHours >= total && typeRows.length > 0)) {
    try {
      const v = await verifyCalendarInTx(db, orgId, cal.id);
      checks = v.checks.map((c) => ({ key: c.key, ok: c.ok, detail: c.detail }));
      typesWithoutTimes = v.typesWithoutTimes;
    } catch {
      checks = null;
    }
  }
  const proposal = await proposeCalendarHours(db, orgId, cal.id);
  const connections = await hostConnectionStates(db, orgId, hostList);
  const providers = calendarConnectionSettings().providers;
  const owner = (await db.query<{ name: string }>(
    `select coalesce(nullif(u.full_name, ''), u.email::text) as name from organization_memberships m join users u on u.id = m.user_id
      where m.org_id = $1 and m.role = 'owner' and m.status = 'active' and u.status = 'active' order by m.created_at, m.user_id limit 1`,
    [orgId],
  )).rows[0];
  // Anyone who may set up calendars may choose the host: active members of this workspace, whatever their role (the CRM's own host list).
  const hostChoices = viewer.canManageCalendars
    ? (await db.query<{ id: string; name: string }>(
        `select u.id, coalesce(nullif(u.full_name, ''), u.email::text) as name from organization_memberships m join users u on u.id = m.user_id
          where m.org_id = $1 and m.status = 'active' and u.status = 'active' order by lower(coalesce(nullif(u.full_name, ''), u.email::text)), u.id`,
        [orgId],
      )).rows
    : undefined;
  return {
    id: cal.id, status: cal.status, hosts: total, hostsWithHours: withHours, hasSuggestedHours: cal.suggested, types: typeRows.length,
    needsVideoConnection: google || microsoft, videoProviders: [...(google ? ["google" as const] : []), ...(microsoft ? ["microsoft" as const] : [])], checks, bookingPageOn: cal.public,
    ...(viewer.canManageCalendars !== null ? { canManage: viewer.canManageCalendars } : {}),
    ownerName: owner?.name ?? null,
    ...(hostChoices ? { hostChoices } : {}),
    hostsNeedingHours: hostList.filter((h) => !h.hasHours).map((h) => ({ id: h.userId, name: h.name })),
    suggestedHours: proposal ? { zone: proposal.zone, summary: proposal.summary, digest: proposal.digest } : null,
    ...(typesWithoutTimes ? { typesWithoutTimes } : {}),
    typesWithoutJoinInfo,
    hostConnections: connections.map((c) => ({ userId: c.userId, name: c.name, viewer: viewer.userId !== null && c.userId === viewer.userId, meet: c.meet, busy: c.busy })),
    oauthAvailable: { google: providers.find((p) => p.key === "google")?.configured === true, microsoft: providers.find((p) => p.key === "microsoft")?.configured === true },
    busyProvider: await statedBusyAnswer(db, orgId),
  };
}

/**
 * The team members the client marked as taking appointments, and how far each one is: a member already, invited and not yet accepted, or not invited. Matched on the email the
 * client typed. Names only go to the judge; an email never does.
 */
async function teamHostFacts(db: Queryable, orgId: string, answers: Answers): Promise<TeamHostFact[]> {
  const rows = Array.isArray(answers["d.team"]) ? (answers["d.team"] as Array<Record<string, unknown>>) : [];
  const marked = rows
    .filter((r) => r?.hosts === "yes" && typeof r.email === "string" && r.email.trim() !== "")
    .slice(0, 12)
    .map((r) => ({ name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 80) : "A team member", email: (r.email as string).trim().toLowerCase() }));
  if (!marked.length) return [];
  const emails = marked.map((m) => m.email);
  const members = new Set((await db.query<{ email: string }>(
    "select lower(u.email::text) as email from organization_memberships m join users u on u.id = m.user_id where m.org_id = $1 and m.status = 'active' and u.status = 'active' and lower(u.email::text) = any($2::text[])",
    [orgId, emails],
  )).rows.map((r) => r.email));
  const invited = new Set((await db.query<{ email: string }>(
    "select lower(email::text) as email from invitations where org_id = $1 and accepted_at is null and revoked_at is null and expires_at > now() and lower(email::text) = any($2::text[])",
    [orgId, emails],
  )).rows.map((r) => r.email));
  return marked.map((m): TeamHostFact => ({ name: m.name, state: members.has(m.email) ? "member" : invited.has(m.email) ? "invited" : "not_invited" }));
}

/** The latest read-only check run for each role, as the launch panel started it (input.launchVerification). */
async function verificationFacts(db: Queryable, orgId: string): Promise<VerificationFact[]> {
  const { rows } = await db.query<{ role: AgentRoleKey; status: string; result_count: number; failure_message: string | null; result_summary: string | null; config_version: string | null; reason: string | null; since: Date | string; lease_expired: boolean }>(
    `select distinct on (a.role_key) a.role_key as role, j.status, j.result_count, j.failure_message, j.result_summary,
            j.input ->> 'configVersion' as config_version, j.result -> 'availability' ->> 'reason' as reason, j.created_at as since,
            (j.status = 'running' and not (j.lease_owner is not null and j.lease_expires_at is not null and j.lease_expires_at > now())) as lease_expired
       from ai_work_jobs j join agent_instances a on a.id = j.agent_instance_id and a.org_id = j.org_id
      where j.org_id = $1 and j.input ->> 'launchVerification' = 'true'
      order by a.role_key, j.created_at desc`,
    [orgId],
  );
  return rows.map((r): VerificationFact => {
    const configVersion = r.config_version !== null && Number.isFinite(Number(r.config_version)) ? Number(r.config_version) : null;
    // A check held for a person's approval waits on that review: it is not running, and it is not a failure.
    if (r.status === "waiting_for_approval") return { role: r.role, state: "awaiting_review" };
    if (r.status === "queued" || r.status === "running") return { role: r.role, state: "running", since: new Date(r.since).toISOString(), leaseExpired: r.lease_expired };
    if (r.status !== "completed") return { role: r.role, state: "failed", configVersion, detail: (r.failure_message ?? r.result_summary ?? "The check did not complete.").slice(0, 300) };
    // The Appointment Setter is only proven when a real open time was found: a calendar that cannot offer one is not a working scheduler.
    if (r.role === "appointment_setter" && (r.reason || r.result_count < 1)) {
      return { role: r.role, state: "failed", configVersion, detail: (r.reason ?? "No bookable time was found in the next seven days. Check the host's weekly hours and the appointment type's notice.").slice(0, 300) };
    }
    return { role: r.role, state: "passed", configVersion, detail: r.result_summary ? r.result_summary.slice(0, 300) : null };
  });
}

interface ProvisioningJobRead { status: string | null; detail: string | null; attempts: number | null; nextRetryAt: Date | string | null; since: Date | string | null; leaseExpired: boolean }

function employeeFacts(agents: AgentInstanceRow[], jobs: Map<AgentRoleKey, ProvisioningJobRead>, held: Set<AgentRoleKey>, paymentCleared: boolean | null, told: Set<string>, orgId: string): EmployeeFact[] {
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
      startedAt: job?.since ? new Date(job.since).toISOString() : null,
      leaseExpired: job?.leaseExpired ?? false,
      stallAlerted: job?.since ? told.has(launchStallAlertKey(orgId, `employees.${role}`, new Date(job.since).toISOString())) : false,
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
  return readLaunchFacts(ctx.org.orgId, await listAgents(ctx.user.id, ctx.org.orgId), ctx.can("billing.view"), { userId: ctx.user.id, canManageCalendars: ctx.can("calendars.manage") });
}

/** The same facts for trusted server code with no signed-in person (the launch sweep). */
export async function loadLaunchFactsForOrg(orgId: string): Promise<LaunchFacts | null> {
  return readLaunchFacts(orgId, await listAgentsForSystem(orgId), false, NO_VIEWER);
}

async function readLaunchFacts(orgId: string, agents: AgentInstanceRow[], canOpenBilling: boolean, viewer: Viewer): Promise<LaunchFacts | null> {
  const read = await withSystem(async (db) => {
    const org = (await db.query<{ kind: string; name: string; industry: string | null; timezone: string; submitted: boolean; is_demo: boolean; description: string; waiting_since: Date | string | null }>(
      `select o.kind, o.name, o.industry, o.timezone, o.onboarding_completed_at is not null as submitted, o.is_demo, coalesce(p.description, '') as description,
              greatest(o.onboarding_completed_at, b.paid_at, b.waived_at) as waiting_since
         from organizations o left join company_profiles p on p.org_id = o.id left join billing_accounts b on b.org_id = o.id where o.id = $1`,
      [orgId],
    )).rows[0];
    if (!org || org.kind !== "client") return null;
    // Edits saved after the last approval are not the live setup. The two facts that decide what is required (appointments and channels) read the answers as last approved, so an
    // unapproved edit cannot switch a requirement off; every other fact reads what is saved now.
    const answerRows = await loadAnswerRows(db, orgId);
    const change = await readPendingAnswerChanges(db, orgId, answerRows);
    const answers = confirmedAnswers(toStored(answerRows));
    const approved = change.pending ? approvedAnswersOf(answerRows, change) : answers;
    const workspace = await loadWorkspaceFacts(db, orgId);
    const mode = (await db.query<{ mode: "native" | "ghl" | "hybrid" }>("select mode from crm_workspaces where org_id = $1", [orgId])).rows[0]?.mode ?? "native";
    const crm = mode === "native" ? await crmFacts(db, orgId) : null;
    const providerConnected = Number((await db.query<{ n: string }>("select count(*) as n from ghl_location_mappings where org_id = $1 and status = 'connected' and verified_at is not null", [orgId])).rows[0]?.n ?? 0) > 0;
    const calendar = mode === "ghl" ? null : await calendarFacts(db, orgId, viewer);
    const teamHosts = hostChoiceOf(answers) === "team" ? await teamHostFacts(db, orgId, answers) : [];
    const externalCalendarConnected = mode === "native"
      ? Number((await db.query<{ n: string }>("select count(*) as n from crm_calendar_connections where org_id = $1 and status = 'connected'", [orgId])).rows[0]?.n ?? 0) > 0
      : Number((await db.query<{ n: string }>("select coalesce(sum(cardinality(calendar_ids)), 0) as n from ghl_location_mappings where org_id = $1 and status = 'connected'", [orgId])).rows[0]?.n ?? 0) > 0;
    const channelRows = (await db.query<{ channel: ChannelFact["channel"]; enabled: boolean; registration_status: string; credential: boolean }>(
      `select mc.channel, mc.enabled, mc.registration_status, (c.id is not null and c.revoked_at is null) as credential
         from messaging_channels mc left join integration_credentials c on c.id = mc.credential_id where mc.org_id = $1`,
      [orgId],
    )).rows;
    const jobs = new Map<AgentRoleKey, ProvisioningJobRead>();
    for (const r of (await db.query<{ role: AgentRoleKey; status: string | null; detail: string | null; attempt_count: number | null; next_retry_at: Date | string | null; since: Date | string | null; lease_expired: boolean | null }>(
      `select distinct on (a.role_key) a.role_key as role, j.status, j.detail, j.attempt_count, j.next_retry_at, j.created_at as since,
              (j.status = 'in_progress' and (j.lease_expires_at is null or j.lease_expires_at <= now())) as lease_expired
         from agent_instances a left join agent_provisioning_jobs j on j.agent_instance_id = a.id and j.org_id = a.org_id
        where a.org_id = $1 order by a.role_key, j.created_at desc nulls last`,
      [orgId],
    )).rows) jobs.set(r.role, { status: r.status, detail: r.detail, attempts: r.attempt_count, nextRetryAt: r.next_retry_at, since: r.since, leaseExpired: r.lease_expired === true });
    const held = new Set<AgentRoleKey>((await db.query<{ role: AgentRoleKey }>(
      `select distinct a.role_key as role from agent_instances a join agent_config_versions v on v.agent_instance_id = a.id and v.org_id = a.org_id
        where a.org_id = $1 and v.status = 'pending_agency_review'`,
      [orgId],
    )).rows.map((r) => r.role));
    const paymentCleared = org.is_demo ? null : await isSetupPaymentCleared(db, orgId);
    const verification = await verificationFacts(db, orgId);
    // Which long waits iAcquire was really told about, so the panel claims an alert only when one exists.
    // The automatic setup waits for BOTH the submitted questionnaire and the cleared setup fee (src/server/onboarding/crm-provisioning.ts), so the wait has not begun until both are
    // true: `greatest` alone would give a time when only one of them happened, and an unpaid or unsubmitted client would be called stalled on iAcquire.
    const waitingSince = crm && crm.blueprint === "none" && org.waiting_since && org.submitted && paymentCleared === true ? new Date(org.waiting_since).toISOString() : null;
    const waits = [
      ...[...jobs.entries()].filter(([, j]) => j.since).map(([role, j]) => ({ itemKey: `employees.${role}`, since: new Date(j.since as Date | string).toISOString(), queued: j.status === "requested" })),
      ...verification.flatMap((v) => (v.state === "running" && v.since ? [{ itemKey: `verification.${v.role}`, since: v.since, queued: false }] : [])),
      ...(waitingSince ? [{ itemKey: "crm.blueprint", since: waitingSince, queued: false }] : []),
    ];
    const told = await alertedWaits(db, orgId, waits, launchStallMinutes().provisioning);
    return { org, answers, answerRows, approved, change, workspace, mode, crm, providerConnected, calendar, teamHosts, externalCalendarConnected, channelRows, jobs, held, paymentCleared, verification, told, waitingSince };
  });
  if (!read) return null;
  const { org, answers, answerRows, approved, change, workspace, mode, crm, providerConnected, calendar, teamHosts, externalCalendarConnected, channelRows, jobs, held, paymentCleared, verification: verified, told, waitingSince } = read;
  // The alert is a fact of the check itself: a running check carries whether iAcquire was told it is taking long.
  const verification = verified.map((v): VerificationFact => (v.state === "running" && v.since ? { ...v, alerted: told.has(launchStallAlertKey(orgId, `verification.${v.role}`, v.since)) } : v));

  // What the last approval produced for a channel: a switched-on channel, one with a registration under way or decided, a stored credential, or a sender the client gave before the
  // edits. The list of channels itself, once edited, no longer says what was approved (the value is overwritten in place).
  const senderGiven = channelsWithApprovedSender(answerRows, change);
  const appliedChannel = (channel: ChannelFact["channel"]) => {
    const row = channelRows.find((r) => r.channel === channel);
    return Boolean((row && (row.enabled || row.credential || row.registration_status !== "not_started")) || senderGiven.includes(channel));
  };
  const wantedChannels: string[] = change.editedIds.includes("c.channels")
    ? CHANNELS.filter(appliedChannel)
    : Array.isArray(approved["c.channels"]) ? (approved["c.channels"] as string[]) : [];
  // A booking calendar that is already taking bookings answers "do you book appointments?" even if the questionnaire was never asked. An answer edited since the last approval is not
  // that answer: what was approved is what exists (a calendar, or a connected calendar for a provider-managed workspace), and not wanting appointments only counts once it is approved.
  const answered = typeof approved["b.appointments"] === "boolean" ? (approved["b.appointments"] as boolean) : null;
  const wantsAppointments = change.editedIds.includes("b.appointments")
    ? calendar !== null || externalCalendarConnected
    : answered ?? (calendar?.status === "active" ? true : null);
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
    crm: crm ? { mode, ...crm, providerConnected, waitingSince, waitingAlerted: waitingSince ? told.has(launchStallAlertKey(orgId, "crm.blueprint", waitingSince)) : false } : { mode, blueprint: "none", pipelineReady: workspace.pipelineReady, providerConnected },
    appointments: { wanted: wantsAppointments, calendar, externalCalendarConnected, hostChoice: hostChoiceOf(answers), teamHosts },
    channels: CHANNELS.map((channel): ChannelFact => {
      const row = channelRows.find((r) => r.channel === channel);
      return {
        channel, wanted: wantedChannels.includes(channel), enabled: row?.enabled ?? false, registration: row?.registration_status ?? "not_started",
        statedSender: statedSenderOf(answers, channel), credentialStored: row?.credential ?? false,
      };
    }),
    employees: employeeFacts(agents, jobs, held, paymentCleared, told, orgId),
    verification,
    ...(change.pending ? { pendingAnswerChanges: true } : {}),
  };
}

/** The honest launch state of the viewer's client workspace, or null for a workspace that is not a client's. */
export async function getLaunchReadiness(ctx: OrgContext): Promise<LaunchReadiness | null> {
  const facts = await loadLaunchFacts(ctx);
  return facts ? deriveLaunchReadiness(facts, new Date(), launchStallMinutes()) : null;
}
