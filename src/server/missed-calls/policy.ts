import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmWrite, type CrmActor } from "@/server/crm/actor";
import { listChannelStatus } from "@/server/messaging/channels";
import {
  DEFAULT_POLICY, policyInputSchema, policyProblems, wordingProblem, type MissedCallPolicy, type PolicyInput, type RecoveryChannel,
} from "@/lib/missed-calls/policy";
import type { CallClass } from "@/lib/missed-calls/state";

// A workspace's missed-call policy: read it (anyone who can see calls), change it (owners and admins, through messaging.configure), and
// activate it (a separate, deliberate act that checks the channel). Any change that could make a text go out differently takes the
// activation back, so wording and rules are always confirmed by a person before they are used.

interface PolicyRow {
  org_id: string; enabled: boolean; mode: MissedCallPolicy["mode"]; activated_at: Date | null; activated_by: string | null; classes: CallClass[];
  abandoned_max_seconds: number; delay_minutes: number; max_attempts: number; attempt_gap_minutes: number; response_window_hours: number; case_expiry_hours: number;
  after_hours_behavior: MissedCallPolicy["afterHoursBehavior"]; action_task: boolean; task_due_minutes: number; action_notify: boolean; notify_roles: MissedCallPolicy["notifyRoles"];
  assign_user_id: string | null; action_opportunity: boolean; action_follow_up: boolean; action_message: boolean; message_channels: RecoveryChannel[];
  message_open: string | null; message_after_hours: string | null; sms_consent_basis: MissedCallPolicy["smsConsentBasis"]; consent_ack_at: Date | null;
  action_ai_callback: boolean; route_appointment_setter: boolean; version: number;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

export function rowToPolicy(r: PolicyRow): MissedCallPolicy {
  return {
    enabled: r.enabled, mode: r.mode, activatedAt: iso(r.activated_at), activatedBy: r.activated_by, classes: r.classes, abandonedMaxSeconds: r.abandoned_max_seconds,
    delayMinutes: r.delay_minutes, maxAttempts: r.max_attempts, attemptGapMinutes: r.attempt_gap_minutes, responseWindowHours: r.response_window_hours,
    caseExpiryHours: r.case_expiry_hours, afterHoursBehavior: r.after_hours_behavior, actionTask: r.action_task, taskDueMinutes: r.task_due_minutes, actionNotify: r.action_notify,
    notifyRoles: r.notify_roles, assignUserId: r.assign_user_id, actionOpportunity: r.action_opportunity, actionFollowUp: r.action_follow_up, actionMessage: r.action_message,
    messageChannels: r.message_channels, messageOpen: r.message_open, messageAfterHours: r.message_after_hours, smsConsentBasis: r.sms_consent_basis,
    consentAckAt: iso(r.consent_ack_at), actionAiCallback: r.action_ai_callback, routeAppointmentSetter: r.route_appointment_setter, version: r.version,
  };
}

/** The workspace's policy, or the safe defaults when it never saved one. */
export async function getPolicy(db: Queryable, orgId: string): Promise<MissedCallPolicy> {
  const { rows } = await db.query<PolicyRow>("select * from missed_call_policies where org_id = $1", [orgId]);
  return rows[0] ? rowToPolicy(rows[0]) : { ...DEFAULT_POLICY };
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export interface ReadinessItem {
  key: string;
  label: string;
  ok: boolean;
  /** Blocking items stop the policy from being activated for automatic texts. The rest are shown so nobody is surprised. */
  blocking: boolean;
  detail: string;
}

/** The scheduler job that works missed-call cases. Named once so the registry, the readiness check and the tests agree. */
export const RECOVERY_JOB_NAME = "missedCallRecovery";

export async function policyReadiness(db: Queryable, orgId: string, policy: MissedCallPolicy, now = new Date()): Promise<ReadinessItem[]> {
  const items: ReadinessItem[] = [];
  const wantsMessages = policy.actionMessage && policy.mode !== "manual";
  items.push({
    key: "policy_enabled", label: "Recovery is switched on", ok: policy.enabled, blocking: false,
    detail: policy.enabled ? "Missed calls are followed up under this policy." : "Missed calls are still detected and shown, but nothing happens automatically.",
  });
  const hasTeamAction = policy.actionTask || policy.actionNotify;
  items.push({
    key: "team_action", label: "Someone hears about every missed call", ok: hasTeamAction, blocking: false,
    detail: hasTeamAction ? "A call-back task or a notice is created for each case." : "Turn on a task or a notice so a person is told.",
  });
  const channels = await listChannelStatus(orgId, db);
  for (const name of policy.messageChannels) {
    const c = channels.find((x) => x.channel === name);
    const ok = Boolean(c?.enabled && c.ready);
    items.push({
      key: `channel_${name}`, label: `${name === "sms" ? "Text messaging" : "Email"} is set up and switched on`, ok: wantsMessages ? ok : true, blocking: wantsMessages,
      detail: ok ? `Connected through ${c!.providerLabel}.` : c ? (c.readinessIssues[0] ?? "Finish setting up and enable this channel in Messaging settings.") : "This channel has not been set up yet.",
    });
    if (wantsMessages && ok) {
      items.push({
        key: `sending_${name}`, label: "The platform's sending switch is on", ok: Boolean(c!.sendingAllowedHere), blocking: false,
        detail: c!.sendingAllowedHere ? "The platform's sending switch for this provider is on." : "The platform's sending switch for this provider is off, so messages are held and never sent until it is switched on.",
      });
    }
  }
  const wording = [policy.messageOpen, policy.messageAfterHours].filter((t): t is string => !!t).map(wordingProblem).find(Boolean) ?? null;
  items.push({ key: "wording", label: "The message wording is acceptable", ok: !wording, blocking: wantsMessages, detail: wording ?? "Plain text, no links." });
  items.push({
    key: "consent_basis", label: "The consent rule is confirmed", ok: policy.smsConsentBasis === "recorded" || Boolean(policy.consentAckAt), blocking: wantsMessages,
    detail: policy.smsConsentBasis === "recorded" ? "Only callers with consent on record are texted." : policy.consentAckAt ? "You confirmed the messaging rules for your callers." : "Confirm you have checked the messaging rules where your callers are.",
  });
  const { rows: hours } = await db.query<{ business_hours: Record<string, unknown> }>("select business_hours from messaging_settings where org_id = $1", [orgId]);
  const hasHours = Object.keys(hours[0]?.business_hours ?? {}).length > 0;
  items.push({
    key: "business_hours", label: "Business hours are set", ok: hasHours, blocking: false,
    detail: hasHours ? "Opening hours decide whether a caller gets the daytime or the after-hours text." : "Without opening hours the business counts as always open, so no call is treated as after hours. Set them in Messaging settings.",
  });
  const { rows: runs } = await db.query<{ last_success_at: Date | null }>("select last_success_at from worker_job_runs where job_name = $1", [RECOVERY_JOB_NAME]);
  const last = runs[0]?.last_success_at ? new Date(runs[0].last_success_at) : null;
  const running = !!last && now.getTime() - last.getTime() <= 30 * 60_000;
  items.push({
    key: "scheduler", label: "The recovery worker has run recently", ok: running, blocking: false,
    detail: running ? "The scheduled worker ran in the last 30 minutes." : "Pending: the platform's scheduler has not run the recovery worker recently, so cases are detected but not worked until it does.",
  });
  return items;
}

// ---------------------------------------------------------------------------
// Reading and changing
// ---------------------------------------------------------------------------

export async function readPolicy(actor: CrmActor): Promise<{ policy: MissedCallPolicy; readiness: ReadinessItem[] }> {
  assertCan(actor, "calls.view", "Your role doesn't include call records.");
  return withSystem(async (db) => {
    const policy = await getPolicy(db, actor.orgId);
    return { policy, readiness: await policyReadiness(db, actor.orgId, policy) };
  });
}

/** Fields that decide what a caller receives. Changing any of them takes the activation back. */
const SEND_AFFECTING: ReadonlyArray<keyof MissedCallPolicy> = ["mode", "actionMessage", "messageChannels", "messageOpen", "messageAfterHours", "smsConsentBasis", "afterHoursBehavior"];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function savePolicy(actor: CrmActor, raw: unknown): Promise<MissedCallPolicy> {
  assertCan(actor, "messaging.configure", "Only a workspace owner or manager can change the missed-call settings.");
  const parsed = policyInputSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Those settings aren't valid.");
  const input: PolicyInput = parsed.data;
  return crmWrite(actor, async (db) => {
    const { rows } = await db.query<PolicyRow>("select * from missed_call_policies where org_id = $1 for update", [actor.orgId]);
    const cur = rows[0] ? rowToPolicy(rows[0]) : { ...DEFAULT_POLICY };
    if (input.expectedVersion !== cur.version) throw new AppError("conflict", "These settings were changed by someone else. Reload and try again.");
    const next: MissedCallPolicy = { ...cur };
    const assign = <K extends keyof MissedCallPolicy>(key: K, value: MissedCallPolicy[K] | undefined) => {
      if (value !== undefined) next[key] = value;
    };
    assign("enabled", input.enabled); assign("mode", input.mode); assign("classes", input.classes); assign("abandonedMaxSeconds", input.abandonedMaxSeconds);
    assign("delayMinutes", input.delayMinutes); assign("maxAttempts", input.maxAttempts); assign("attemptGapMinutes", input.attemptGapMinutes);
    assign("responseWindowHours", input.responseWindowHours); assign("caseExpiryHours", input.caseExpiryHours); assign("afterHoursBehavior", input.afterHoursBehavior);
    assign("actionTask", input.actionTask); assign("taskDueMinutes", input.taskDueMinutes); assign("actionNotify", input.actionNotify); assign("notifyRoles", input.notifyRoles);
    assign("assignUserId", input.assignUserId); assign("actionOpportunity", input.actionOpportunity); assign("actionFollowUp", input.actionFollowUp);
    assign("actionMessage", input.actionMessage); assign("messageChannels", input.messageChannels);
    assign("messageOpen", input.messageOpen === undefined ? undefined : input.messageOpen || null);
    assign("messageAfterHours", input.messageAfterHours === undefined ? undefined : input.messageAfterHours || null);
    assign("smsConsentBasis", input.smsConsentBasis); assign("actionAiCallback", input.actionAiCallback); assign("routeAppointmentSetter", input.routeAppointmentSetter);

    const now = new Date();
    if (next.smsConsentBasis === "inbound_call") {
      if (input.acknowledgeCallerConsent === true || cur.consentAckAt) next.consentAckAt = cur.consentAckAt ?? now.toISOString();
    } else {
      next.consentAckAt = null;
    }
    const problems = policyProblems(next, { acknowledged: input.acknowledgeCallerConsent === true });
    if (problems.length) throw new AppError("invalid_input", problems[0]);
    if (next.assignUserId && next.assignUserId !== cur.assignUserId) {
      const ok = await db.query("select 1 from organization_memberships where org_id = $1 and user_id = $2 and status = 'active'", [actor.orgId, next.assignUserId]);
      if (!ok.rows.length) throw new AppError("invalid_input", "Choose someone who is an active member of this workspace.");
    }
    const changed = (Object.keys(next) as Array<keyof MissedCallPolicy>).filter((k) => k !== "version" && !same(next[k], cur[k]));
    const resetActivation = changed.some((k) => (SEND_AFFECTING as readonly string[]).includes(k));
    if (resetActivation) {
      next.activatedAt = null;
      next.activatedBy = null;
    }
    const ack = next.consentAckAt ? new Date(next.consentAckAt) : null;
    await db.query(
      `insert into missed_call_policies (org_id, enabled, mode, activated_at, activated_by, classes, abandoned_max_seconds, delay_minutes, max_attempts, attempt_gap_minutes,
         response_window_hours, case_expiry_hours, after_hours_behavior, action_task, task_due_minutes, action_notify, notify_roles, assign_user_id, action_opportunity,
         action_follow_up, action_message, message_channels, message_open, message_after_hours, sms_consent_basis, consent_ack_at, consent_ack_by, action_ai_callback,
         route_appointment_setter, version, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, 1, $30)
       on conflict (org_id) do update set enabled = excluded.enabled, mode = excluded.mode, activated_at = excluded.activated_at, activated_by = excluded.activated_by,
         classes = excluded.classes, abandoned_max_seconds = excluded.abandoned_max_seconds, delay_minutes = excluded.delay_minutes, max_attempts = excluded.max_attempts,
         attempt_gap_minutes = excluded.attempt_gap_minutes, response_window_hours = excluded.response_window_hours, case_expiry_hours = excluded.case_expiry_hours,
         after_hours_behavior = excluded.after_hours_behavior, action_task = excluded.action_task, task_due_minutes = excluded.task_due_minutes, action_notify = excluded.action_notify,
         notify_roles = excluded.notify_roles, assign_user_id = excluded.assign_user_id, action_opportunity = excluded.action_opportunity, action_follow_up = excluded.action_follow_up,
         action_message = excluded.action_message, message_channels = excluded.message_channels, message_open = excluded.message_open, message_after_hours = excluded.message_after_hours,
         sms_consent_basis = excluded.sms_consent_basis, consent_ack_at = excluded.consent_ack_at,
         consent_ack_by = case when excluded.consent_ack_at is null then null when missed_call_policies.consent_ack_at is null then excluded.consent_ack_by else missed_call_policies.consent_ack_by end,
         action_ai_callback = excluded.action_ai_callback, route_appointment_setter = excluded.route_appointment_setter, version = missed_call_policies.version + 1, updated_by = excluded.updated_by`,
      [
        actor.orgId, next.enabled, next.mode, next.activatedAt, next.activatedBy, next.classes, next.abandonedMaxSeconds, next.delayMinutes, next.maxAttempts, next.attemptGapMinutes,
        next.responseWindowHours, next.caseExpiryHours, next.afterHoursBehavior, next.actionTask, next.taskDueMinutes, next.actionNotify, next.notifyRoles, next.assignUserId,
        next.actionOpportunity, next.actionFollowUp, next.actionMessage, next.messageChannels, next.messageOpen, next.messageAfterHours, next.smsConsentBasis, ack,
        ack ? actor.userId : null, next.actionAiCallback, next.routeAppointmentSetter, actor.userId,
      ],
    );
    await recordAudit({
      orgId: actor.orgId, ...auditActor(actor), action: "missed_call.policy_saved", targetType: "missed_call_policy", targetId: actor.orgId, result: "success",
      // Field names only: the wording itself never goes into the audit trail.
      metadata: { changed, activationReset: resetActivation && cur.activatedAt !== null },
    }, db);
    return getPolicy(db, actor.orgId);
  });
}

/** A person confirms the channel, the wording and the rules. Until then no text is drafted or sent. */
export async function activatePolicy(actor: CrmActor, expectedVersion: number): Promise<MissedCallPolicy> {
  assertCan(actor, "messaging.configure", "Only a workspace owner or manager can activate the missed-call settings.");
  if (!actor.userId) throw new AppError("forbidden", "A person has to activate the settings.");
  return crmWrite(actor, async (db) => {
    const { rows } = await db.query<PolicyRow>("select * from missed_call_policies where org_id = $1 for update", [actor.orgId]);
    if (!rows[0]) throw new AppError("invalid_input", "Save the settings first.");
    const cur = rowToPolicy(rows[0]);
    if (expectedVersion !== cur.version) throw new AppError("conflict", "These settings were changed by someone else. Reload and try again.");
    if (!cur.enabled) throw new AppError("invalid_input", "Switch missed-call recovery on first.");
    if (cur.mode === "manual" || !cur.actionMessage) throw new AppError("invalid_input", "Only the text follow-up needs activating. Choose \"Draft for approval\" or \"Send automatically\" and turn on the text follow-up first.");
    const blocking = (await policyReadiness(db, actor.orgId, cur)).filter((i) => i.blocking && !i.ok);
    if (blocking.length) throw new AppError("invalid_input", `Not ready yet: ${blocking[0].label}. ${blocking[0].detail}`);
    await db.query("update missed_call_policies set activated_at = now(), activated_by = $2, version = version + 1, updated_by = $2 where org_id = $1", [actor.orgId, actor.userId]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "missed_call.policy_activated", targetType: "missed_call_policy", targetId: actor.orgId, result: "success", metadata: { mode: cur.mode, channels: cur.messageChannels } }, db);
    return getPolicy(db, actor.orgId);
  });
}
