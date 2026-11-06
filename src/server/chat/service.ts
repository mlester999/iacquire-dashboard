import "server-only";
import crypto from "node:crypto";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { env } from "@/server/env";
import { recordAudit } from "@/server/audit";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { assertWithinLimits, recordUsage } from "@/server/usage";
import { notifyOrgRoles } from "@/server/notifications";
import { canChat, AGENT_BY_KEY, isAgentRoleKey, isWorkforceRoleKey, type AgentStatus, type WorkforceRoleKey, workforceRoleShortName } from "@/lib/agents";
import {
  getCapabilities,
  getRunStatus,
  HermesError,
  startAgentRun,
  assertAgentRunPreflight,
  AgentRunNotReadyError,
  stopRun,
  streamRunEvents,
  toolActivityLabel,
  type HermesConnection,
  type StartRunInput,
} from "@/server/integrations/hermes/client";
import { buildRunInstructions, loadConnection, markAgentDegraded, runHealthCheck } from "@/server/workforce/service";
import { prepareInternalEmployeeContext } from "@/server/workforce/internal-capability-context";
import { prepareEmployeeEvidence } from "@/server/workforce/employee-evidence";
import { insertEvidenceBlock } from "@/lib/employee-evidence";
import { fitClientChatInstructions, fitRecord, type ClientPromptFitRecord } from "@/server/workforce/client-prompt";
import { findUnbackedActionClaims, withActionClaimCorrection } from "@/lib/action-claims";
import { classifyBookingResult, classifyModelTurn, parseEvidenceMarker, serverMarker, systemNoticeMarker, type EvidenceMarker, type ServerEvidenceMarker } from "@/lib/evidence-class";
import { parseGrowthPartnerMemoryCommand } from "@/lib/ai-growth-partner-memory";
import { forgetGrowthPartnerMemoryFromChat, rememberGrowthPartnerMemoryFromChat } from "@/server/ai-growth-partner/memory";
import { markEmployeeKnowledgeUsed } from "@/server/workforce/knowledge";
import { kickWorkJob } from "@/server/workforce/work-kick";
import { createResearchRequest, getTargeting, saveTargeting } from "@/server/leads/service";
import { parseResearchAssignment, researchClarification } from "@/lib/research-intent";
import { targetingSchema } from "@/lib/leads-targeting";
import { parseWorkforceChatCrmIntent } from "@/lib/workforce-chat-crm-intent";
import { parseWorkforceChatAppointmentPolicyIntent, type WorkforceChatAppointmentPolicyIntent } from "@/lib/workforce-chat-appointment-policy-intent";
import { parseWorkforceChatCalendarCreateIntent, type WorkforceChatCalendarCreateIntent } from "@/lib/workforce-chat-calendar-create-intent";
import { parseWorkforceChatBookingIntent, type WorkforceChatBookingIntent } from "@/lib/workforce-chat-booking-intent";
import { parseWorkforceChatAppointmentChangeIntent, type WorkforceChatAppointmentChangeIntent } from "@/lib/workforce-chat-appointment-change-intent";
import { parseWorkforceChatTargetingIntent } from "@/lib/workforce-chat-targeting-intent";
import { parseWorkforceChatPreferencesIntent } from "@/lib/workforce-chat-preferences-intent";
import { parseWorkforceChatAssignment } from "@/lib/workforce-chat-assignment";
import { workforceChatRefusal } from "@/lib/workforce-chat-guardrail";
import { explicitlyAddressedWorkforceRole, isAutomationBuilderRequest, parseNamedWorkforceHandoff } from "@/lib/workforce-chat-routing";
import { capabilityDefinition, isCapabilityKey, type CapabilityKey } from "@/lib/workforce-capabilities";
import {
  isScheduleConfirmation,
  parseWorkforceChatScheduleIntent,
  type WorkforceChatScheduleIntent,
  type WorkforceScheduleCadence,
  type WorkforceScheduleWindow,
} from "@/lib/workforce-chat-schedule-intent";
import { nextWorkforceScheduleOccurrence, validateWorkforceScheduleRule, type WorkforceScheduleRule } from "@/lib/workforce-schedule-recurrence";
import { validateBusinessHours, type Weekday } from "@/lib/messaging";
import { formatSlot } from "@/lib/appointments";
import { saveScheduleInTransaction, type ScheduleCadence } from "@/server/workforce/schedules";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { getAvailability } from "@/server/appointments/availability";
import { requestBooking, type BookingResult } from "@/server/appointments/booking";
import { appointmentChangeExpected, customerChangePolicyNote } from "@/server/appointments/changes";
import { bookedAppointmentStatus } from "@/server/calendars/agent-booking";
import { bookingIsNative } from "@/server/calendars/agent-booking";
import { createAppointmentType, createCalendar, listCalendars, listSchedulingPeople, updateAppointmentType } from "@/server/calendars/setup";
import { getPolicyView, savePolicy } from "@/server/appointments/settings";
import { createContact, DuplicateContactError } from "@/server/crm/contacts";
import { memberActor } from "@/server/crm/actor";
import type { BookedAppointmentStatus } from "@/server/appointments/confirmation-watch";
import { createApproval } from "@/server/approvals/service";
import { createWorkforceChatHandoff } from "@/server/chat/workforce-handoff";
import { toolInventoryReady } from "@/lib/hermes-tool-inventory";
import { abortChannel, openChannel, publish } from "@/server/chat/hub";
import type { OrgContext } from "@/server/tenancy/context";
import { enforceAgentAction, recordActionDenied } from "@/server/workforce/action-policy";
import { abilityRefusal, capabilityNeed, type AbilityNeed } from "@/server/workforce/abilities";
import { CHAT_ACTION_ABILITIES } from "@/lib/employee-tool-policy";
import { HERMES_INFERENCE_ONLY_CHAT_CANARY } from "@/lib/hermes-inference-only";
import { requestInferenceOnly } from "@/server/integrations/hermes/inference-only";
import { agentSettingsSchema, aiPreferencesSchema } from "@/lib/agent-settings";
import { getProfile, updateAiPreferences } from "@/server/settings/service";

const MAX_MESSAGE = 8000;
const HISTORY_TURNS = 20;
const HEALTH_MAX_AGE_MS = 10 * 60 * 1000;
const SCHEDULE_PREVIEW_TTL_MS = 15 * 60 * 1000;
const BOOKING_PREVIEW_TTL_MS = 15 * 60 * 1000;
const APPOINTMENT_CHANGE_PREVIEW_TTL_MS = 15 * 60 * 1000;

type PendingChatSchedule = {
  version: 1;
  proposalId: string;
  status: "pending" | "accepted" | "cancelled" | "expired";
  requestedBy: string;
  agentInstanceId: string;
  agentRole: WorkforceRoleKey;
  capability: CapabilityKey;
  title: string;
  cadence: WorkforceScheduleCadence;
  recurrenceRule: WorkforceScheduleRule | null;
  timezone: string;
  payload: Record<string, unknown>;
  businessHours: Record<string, unknown>;
  updateExisting: boolean;
  enabledAfterSave: boolean;
  expectedExistingSchedule: { id: string; updatedAt: string } | null;
  expiresAt: string;
  scheduleId?: string | null;
  acceptedAt?: string;
};

type PendingChatBooking = {
  version: 1;
  proposalId: string;
  status: "pending" | "processing" | "accepted" | "cancelled" | "expired";
  requestedBy: string;
  agentInstanceId: string;
  contactId: string;
  contactName: string;
  contactTimeZone: string | null;
  workspaceTimeZone: string;
  timeZone: string;
  calendarId: string;
  startAt: string;
  expiresAt: string;
  processingAt?: string;
  bookingId?: string | null;
  bookingStatus?: BookingResult["status"];
  acceptedAt?: string;
};

type PendingChatAppointmentChange = {
  version: 1;
  proposalId: string;
  status: "pending" | "processing" | "accepted" | "cancelled" | "expired";
  requestedBy: string;
  agentInstanceId: string;
  operation: "cancel" | "reschedule";
  appointmentId: string;
  contactId: string;
  contactName: string;
  provider: "ghl" | "native";
  timeZone: string;
  expected: { version: number; contactId: string; startAt: string; endAt: string; status: "new" | "confirmed"; provider: "ghl" | "native"; lastEventAt: string | null };
  newStartAt: string | null;
  expiresAt: string;
  processingAt?: string;
  approvalId?: string | null;
  acceptedAt?: string;
};

type ChatScheduleAction =
  | { kind: "confirm" | "cancel" }
  | Exclude<WorkforceChatScheduleIntent, { kind: "none" }>;

function parsePendingChatSchedule(value: unknown): PendingChatSchedule | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    item.version !== 1
    || !uuid.test(String(item.proposalId ?? ""))
    || !["pending", "accepted", "cancelled", "expired"].includes(String(item.status))
    || typeof item.requestedBy !== "string"
    || !uuid.test(String(item.agentInstanceId ?? ""))
    || typeof item.agentRole !== "string"
    || !isWorkforceRoleKey(item.agentRole)
    || !isCapabilityKey(String(item.capability ?? ""))
    || typeof item.title !== "string"
    || !["hourly", "daily", "weekly"].includes(String(item.cadence))
    || typeof item.timezone !== "string"
    || item.timezone.length < 1
    || item.timezone.length > 64
    || typeof item.expiresAt !== "string"
    || !Number.isFinite(Date.parse(item.expiresAt))
    || typeof item.payload !== "object"
    || item.payload === null
    || Array.isArray(item.payload)
    || (item.updateExisting !== undefined && typeof item.updateExisting !== "boolean")
    || (item.enabledAfterSave !== undefined && typeof item.enabledAfterSave !== "boolean")
  ) return null;

  const cadence = item.cadence as WorkforceScheduleCadence;
  const recurrenceRule = item.recurrenceRule === null ? null : validateWorkforceScheduleRule(item.recurrenceRule);
  if ((cadence === "hourly" && item.recurrenceRule !== null) || (cadence !== "hourly" && !recurrenceRule)) return null;
  if (recurrenceRule && ((recurrenceRule.kind === "daily" && cadence !== "daily") || (recurrenceRule.kind === "weekly" && cadence !== "weekly"))) return null;
  let expectedExistingSchedule: PendingChatSchedule["expectedExistingSchedule"] = null;
  if (item.expectedExistingSchedule !== null) {
    if (typeof item.expectedExistingSchedule !== "object" || item.expectedExistingSchedule === null || Array.isArray(item.expectedExistingSchedule)) return null;
    const existing = item.expectedExistingSchedule as Record<string, unknown>;
    if (!uuid.test(String(existing.id ?? "")) || typeof existing.updatedAt !== "string" || !Number.isFinite(Date.parse(existing.updatedAt))) return null;
    expectedExistingSchedule = { id: existing.id as string, updatedAt: existing.updatedAt };
  }
  const businessHours = validateBusinessHours(item.businessHours);
  if (!businessHours) return null;
  if (item.status === "accepted" && !uuid.test(String(item.scheduleId ?? ""))) return null;

  return {
    version: 1,
    proposalId: item.proposalId as string,
    status: item.status as PendingChatSchedule["status"],
    requestedBy: item.requestedBy,
    agentInstanceId: item.agentInstanceId as string,
    agentRole: item.agentRole,
    capability: item.capability as CapabilityKey,
    title: item.title,
    cadence,
    recurrenceRule,
    timezone: item.timezone,
    payload: item.payload as Record<string, unknown>,
    businessHours: businessHours as unknown as Record<string, unknown>,
    updateExisting: item.updateExisting === true,
    enabledAfterSave: item.enabledAfterSave === true,
    expectedExistingSchedule,
    expiresAt: item.expiresAt,
    scheduleId: typeof item.scheduleId === "string" ? item.scheduleId : null,
    acceptedAt: typeof item.acceptedAt === "string" ? item.acceptedAt : undefined,
  };
}

function parsePendingChatBooking(value: unknown): PendingChatBooking | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const validZone = (zone: unknown): zone is string => {
    if (typeof zone !== "string" || zone.length < 1 || zone.length > 64) return false;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  };
  const bookingStatuses: readonly string[] = ["booked", "awaiting_approval", "needs_manual", "unavailable", "failed"];
  if (
    item.version !== 1
    || !uuid.test(String(item.proposalId ?? ""))
    || !["pending", "processing", "accepted", "cancelled", "expired"].includes(String(item.status))
    || typeof item.requestedBy !== "string"
    || !uuid.test(String(item.agentInstanceId ?? ""))
    || !uuid.test(String(item.contactId ?? ""))
    || typeof item.contactName !== "string"
    || item.contactName.length < 1
    || item.contactName.length > 200
    || (item.contactTimeZone !== null && !validZone(item.contactTimeZone))
    || !validZone(item.workspaceTimeZone)
    || !validZone(item.timeZone)
    || typeof item.calendarId !== "string"
    || !/^[A-Za-z0-9_-]{1,80}$/.test(item.calendarId)
    || typeof item.startAt !== "string"
    || !Number.isFinite(Date.parse(item.startAt))
    || new Date(item.startAt).toISOString() !== item.startAt
    || typeof item.expiresAt !== "string"
    || !Number.isFinite(Date.parse(item.expiresAt))
    || (item.processingAt !== undefined && (typeof item.processingAt !== "string" || !Number.isFinite(Date.parse(item.processingAt))))
    || (item.bookingId !== undefined && item.bookingId !== null && !uuid.test(String(item.bookingId)))
    || (item.bookingStatus !== undefined && !bookingStatuses.includes(String(item.bookingStatus)))
    || (item.acceptedAt !== undefined && (typeof item.acceptedAt !== "string" || !Number.isFinite(Date.parse(item.acceptedAt))))
  ) return null;
  if (item.status === "accepted" && (!uuid.test(String(item.bookingId ?? "")) || !bookingStatuses.includes(String(item.bookingStatus ?? "")))) return null;
  return {
    version: 1,
    proposalId: item.proposalId as string,
    status: item.status as PendingChatBooking["status"],
    requestedBy: item.requestedBy,
    agentInstanceId: item.agentInstanceId as string,
    contactId: item.contactId as string,
    contactName: item.contactName,
    contactTimeZone: item.contactTimeZone as string | null,
    workspaceTimeZone: item.workspaceTimeZone,
    timeZone: item.timeZone,
    calendarId: item.calendarId as string,
    startAt: item.startAt,
    expiresAt: item.expiresAt,
    processingAt: typeof item.processingAt === "string" ? item.processingAt : undefined,
    bookingId: typeof item.bookingId === "string" ? item.bookingId : null,
    bookingStatus: item.bookingStatus as BookingResult["status"] | undefined,
    acceptedAt: typeof item.acceptedAt === "string" ? item.acceptedAt : undefined,
  };
}

function parsePendingChatAppointmentChange(value: unknown): PendingChatAppointmentChange | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const validInstant = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
  const validZone = (v: unknown): v is string => {
    if (typeof v !== "string" || v.length < 1 || v.length > 64) return false;
    try { new Intl.DateTimeFormat("en-US", { timeZone: v }); return true; } catch { return false; }
  };
  if (
    item.version !== 1
    || !uuid.test(String(item.proposalId ?? ""))
    || !["pending", "processing", "accepted", "cancelled", "expired"].includes(String(item.status))
    || typeof item.requestedBy !== "string" || !uuid.test(String(item.agentInstanceId ?? ""))
    || (item.operation !== "cancel" && item.operation !== "reschedule")
    || !uuid.test(String(item.appointmentId ?? "")) || !uuid.test(String(item.contactId ?? ""))
    || typeof item.contactName !== "string" || item.contactName.length < 1 || item.contactName.length > 200
    || (item.provider !== "ghl" && item.provider !== "native") || !validZone(item.timeZone)
    || typeof item.expected !== "object" || item.expected === null || Array.isArray(item.expected)
    || (item.newStartAt !== null && !validInstant(item.newStartAt))
    || (item.operation === "cancel" && item.newStartAt !== null)
    || (item.operation === "reschedule" && item.newStartAt === null)
    || typeof item.expiresAt !== "string" || !Number.isFinite(Date.parse(item.expiresAt))
    || (item.processingAt !== undefined && (typeof item.processingAt !== "string" || !Number.isFinite(Date.parse(item.processingAt))))
    || (item.approvalId !== undefined && item.approvalId !== null && !uuid.test(String(item.approvalId)))
    || (item.acceptedAt !== undefined && (typeof item.acceptedAt !== "string" || !Number.isFinite(Date.parse(item.acceptedAt))))
  ) return null;
  const expected = item.expected as Record<string, unknown>;
  if (
    !Number.isInteger(expected.version)
    || !uuid.test(String(expected.contactId ?? ""))
    || !validInstant(expected.startAt) || !validInstant(expected.endAt)
    || (expected.status !== "new" && expected.status !== "confirmed")
    || expected.provider !== item.provider
    || (expected.lastEventAt !== null && !validInstant(expected.lastEventAt))
  ) return null;
  if (item.status === "accepted" && !uuid.test(String(item.approvalId ?? ""))) return null;
  return {
    version: 1,
    proposalId: item.proposalId as string,
    status: item.status as PendingChatAppointmentChange["status"],
    requestedBy: item.requestedBy,
    agentInstanceId: item.agentInstanceId as string,
    operation: item.operation,
    appointmentId: item.appointmentId as string,
    contactId: item.contactId as string,
    contactName: item.contactName,
    provider: item.provider as PendingChatAppointmentChange["provider"],
    timeZone: item.timeZone as string,
    expected: {
      version: expected.version as number,
      contactId: expected.contactId as string,
      startAt: expected.startAt as string,
      endAt: expected.endAt as string,
      status: expected.status,
      provider: expected.provider as PendingChatAppointmentChange["provider"],
      lastEventAt: expected.lastEventAt as string | null,
    },
    newStartAt: item.newStartAt as string | null,
    expiresAt: item.expiresAt,
    processingAt: typeof item.processingAt === "string" ? item.processingAt : undefined,
    approvalId: typeof item.approvalId === "string" ? item.approvalId : null,
    acceptedAt: typeof item.acceptedAt === "string" ? item.acceptedAt : undefined,
  };
}

function schedulePermissionAllowed(ctx: OrgContext, role: WorkforceRoleKey, capability: string): boolean {
  const definition = capabilityDefinition(capability);
  return Boolean(
    definition
    && definition.allowedRoles.includes(role)
    && ctx.can("agents.use")
    && ctx.can("agents.configure")
    && ctx.can(definition.requiredPermission)
    && (definition.additionalPermissions ?? []).every((permission) => ctx.can(permission)),
  );
}

function scheduleCadenceLabel(cadence: WorkforceScheduleCadence, rule: WorkforceScheduleRule | null): string {
  if (cadence === "hourly") return "every hour";
  if (cadence === "daily") return `daily at ${rule?.localTime ?? "the selected time"}`;
  const weekdays = rule?.kind === "weekly" ? rule.weekdays : [];
  const names: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
  return `every ${weekdays.map((day) => names[day]).join(" and ")} at ${rule?.localTime ?? "the selected time"}`;
}

function scheduleWorkWindow(businessHours: unknown, rule: WorkforceScheduleRule | null): WorkforceScheduleWindow | null {
  if (!rule) return null;
  const activeDays: Weekday[] = rule.kind === "daily" ? ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] : rule.weekdays;
  if (!activeDays.length) return null;
  const hours = validateBusinessHours(businessHours);
  if (!hours) return null;
  const windows = activeDays.map((day) => hours[day] ?? []);
  if (windows.some((dayWindows) => dayWindows.length !== 1)) return null;
  const first = windows[0][0];
  if (!first || windows.some((dayWindows) => dayWindows[0][0] !== first[0] || dayWindows[0][1] !== first[1])) return null;
  return { startTime: first[0], endTime: first[1] };
}

function formatScheduleClock(time: string): string {
  const [hourText, minute] = time.split(":");
  const hour = Number(hourText);
  return `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
}

function scheduleWorkWindowNotice(businessHours: unknown, rule: WorkforceScheduleRule | null): string {
  const window = scheduleWorkWindow(businessHours, rule);
  if (!window || !rule) return "";
  return ` The allowed work window is ${formatScheduleClock(window.startTime)}–${formatScheduleClock(window.endTime)} on scheduled days, with one run at ${formatScheduleClock(rule.localTime)}.`;
}

/**
 * What is stored with a reply the server wrote. A reply nobody marked is a system notice, and a server-composed reply is never a model response whatever a caller passes: only the
 * run's own placeholder row (inserted where the run starts) carries that class.
 */
function serverEvidenceJson(marker?: ServerEvidenceMarker): string {
  const cls: string | undefined = marker?.class;
  return JSON.stringify(!marker || cls === "model_response" ? systemNoticeMarker() : marker);
}

/**
 * The class of a booking reply from what the calendar service returned, naming the row that backs it. A booking that waits for the host's confirmation is an approved write (it is on
 * the calendar), not a completed action, until a person confirms it.
 */
function bookingResultEvidence(status: BookingResult["status"], ids: { bookingId?: string | null; approvalId?: string | null }, appointmentStatus?: BookedAppointmentStatus): ServerEvidenceMarker {
  const cls = classifyBookingResult(status, appointmentStatus);
  if (cls === "system_notice") return serverMarker(cls);
  if (status === "awaiting_approval" && ids.approvalId) return serverMarker(cls, { kind: "approval", id: ids.approvalId });
  return ids.bookingId ? serverMarker(cls, { kind: "appointment_booking", id: ids.bookingId }) : serverMarker(cls);
}

async function insertChatScheduleReply(
  db: Queryable,
  ctx: OrgContext,
  input: { conversationId: string; agentId: string; content: string; evidence?: ServerEvidenceMarker },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into chat_messages (conversation_id, org_id, role, content, status, evidence)
     values ($1, $2, 'assistant', $3, 'complete', $4::jsonb) returning id`,
    [input.conversationId, ctx.org.orgId, input.content, serverEvidenceJson(input.evidence)],
  );
  await db.query("update chat_conversations set last_message_at = now() where id = $1 and org_id = $2", [input.conversationId, ctx.org.orgId]);
  await recordUsage(db, { orgId: ctx.org.orgId, userId: ctx.user.id, agentId: input.agentId, kind: "agent_message" });
  return rows[0].id;
}

async function handleChatScheduleAction(
  ctx: OrgContext,
  input: { agentId: string; agentRole: WorkforceRoleKey; conversationId: string; userMessageId: string | null; action: ChatScheduleAction },
): Promise<SendResult> {
  return withSystem(async (db) => {
    const { rows: conversations } = await db.query<{
      id: string;
      pending_workforce_schedule: unknown;
    }>(
      `select id, pending_workforce_schedule from chat_conversations
        where id = $1 and org_id = $2 and agent_instance_id = $3 and deleted_at is null
          and (user_id = $4 or ($5::boolean and exists (
            select 1 from ai_growth_partners p
             where p.id = chat_conversations.growth_partner_id
               and p.org_id = chat_conversations.org_id
               and p.runtime_agent_instance_id = chat_conversations.agent_instance_id
          )))
        for update`,
      [input.conversationId, ctx.org.orgId, input.agentId, ctx.user.id, input.agentRole === "growth_partner"],
    );
    const conversation = conversations[0];
    if (!conversation) throw new AppError("not_found", "Conversation not found.");

    const reply = async (content: string, evidence?: ServerEvidenceMarker) => {
      const assistantMessageId = await insertChatScheduleReply(db, ctx, {
        conversationId: input.conversationId,
        agentId: input.agentId,
        content,
        evidence,
      });
      return { conversationId: input.conversationId, userMessageId: input.userMessageId, assistantMessageId, runId: null, jobId: null };
    };

    const rawPending = conversation.pending_workforce_schedule;
    const pending = parsePendingChatSchedule(rawPending);
    if (rawPending !== null && !pending) {
      await db.query("update chat_conversations set pending_workforce_schedule = null where id = $1 and org_id = $2", [input.conversationId, ctx.org.orgId]);
      return reply("I couldn't verify the saved schedule preview, so I discarded it. No schedule was saved. Please request a fresh preview.");
    }

    if (input.action.kind === "clarification") return reply(input.action.message);

    if (input.action.kind === "proposal" || input.action.kind === "update_existing") {
      const action = input.action;
      const updateExisting = action.kind === "update_existing";
      const capability = action.capability;
      const definition = capabilityDefinition(capability);
      if (!definition || !schedulePermissionAllowed(ctx, input.agentRole, capability)) {
        return reply("Your current workspace role can't create this AI schedule. No schedule was saved.");
      }
      const switchedOff = await chatAbilityRefusal(ctx, { agentId: input.agentId, agentRole: input.agentRole, actionId: `capability:${capability}`, need: capabilityNeed(capability) }, db);
      if (switchedOff) return reply(switchedOff);

      const { rows: orgRows } = await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [ctx.org.orgId]);
      const timezone = orgRows[0]?.timezone;
      if (!timezone || timezone !== ctx.org.timezone) {
        return reply("The workspace timezone changed while this request was being prepared. Refresh and request a new schedule preview.");
      }
      const { rows: scheduleRows } = await db.query<{
        id: string;
        updated_at: string;
        enabled: boolean;
        business_hours: unknown;
        cadence: WorkforceScheduleCadence;
        recurrence_rule: unknown;
        payload: unknown;
      }>(
        `select s.id, s.updated_at::text as updated_at, s.enabled, s.business_hours, s.cadence, s.recurrence_rule, s.payload
           from ai_work_schedules s
           join agent_instances a on a.id = s.agent_instance_id and a.org_id = s.org_id
          where s.org_id = $1 and a.role_key = $2 and s.capability = $3
          limit 1`,
        [ctx.org.orgId, input.agentRole, capability],
      );
      const existing = scheduleRows[0] ?? null;
      if (updateExisting && !existing) {
        return reply("I couldn't find a saved lead research schedule to change. No schedule was changed. Ask me to schedule a complete research assignment first.");
      }
      const existingHours = existing ? validateBusinessHours(existing.business_hours) : {};
      let cadence: WorkforceScheduleCadence;
      let recurrenceRule: WorkforceScheduleRule | null;
      let payload: Record<string, unknown>;
      let enabledAfterSave = false;
      let proposedBusinessHours: unknown = existingHours ?? {};
      if (action.kind === "update_existing") {
        const currentRule = validateWorkforceScheduleRule(existing?.recurrence_rule);
        if (!currentRule) return reply("The saved lead research schedule doesn't have a valid daily or weekday run time, so I couldn't change it safely. Review it in Work Board → Schedules. No schedule was changed.");
        if (action.cadence === "daily") {
          recurrenceRule = { kind: "daily", localTime: action.localTime };
        } else if (action.cadence === "weekly") {
          const weekdays = action.weekdays ?? (currentRule.kind === "weekly" ? currentRule.weekdays : []);
          if (!weekdays.length) return reply("I couldn't determine which weekdays to use. No schedule was changed.");
          recurrenceRule = { kind: "weekly", localTime: action.localTime, weekdays };
        } else {
          recurrenceRule = { ...currentRule, localTime: action.localTime };
        }
        cadence = recurrenceRule.kind;
        if (action.window) {
          const activeDays: Weekday[] = recurrenceRule.kind === "daily"
            ? ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
            : recurrenceRule.weekdays;
          proposedBusinessHours = Object.fromEntries(activeDays.map((day) => [day, [[action.window!.startTime, action.window!.endTime]]]));
        }
        const storedPayload = typeof existing?.payload === "object" && existing.payload !== null && !Array.isArray(existing.payload)
          ? existing.payload as Record<string, unknown>
          : {};
        const assignment = typeof storedPayload.prompt === "string" ? parseResearchAssignment(storedPayload.prompt) : null;
        if (!assignment || assignment.missing.length || !assignment.target || !assignment.location || !assignment.quantity) {
          return reply("The saved research assignment couldn't be verified, so I didn't change its schedule. Review its targeting and quantity in Work Board → Schedules.");
        }
        payload = { prompt: assignment.prompt, target: assignment.target, location: assignment.location, quantity: assignment.quantity };
        enabledAfterSave = existing?.enabled === true;
      } else {
        cadence = action.cadence;
        recurrenceRule = action.recurrenceRule;
        payload = action.payload;
      }
      let nextRun: Date;
      try {
        nextRun = recurrenceRule
          ? nextWorkforceScheduleOccurrence(recurrenceRule, timezone, new Date())
          : new Date(Date.now() + 60 * 60 * 1000);
      } catch {
        return reply("I couldn't calculate the next time in the workspace timezone. No schedule was saved; check the timezone and try again.");
      }
      let nextLabel: string;
      try {
        nextLabel = new Intl.DateTimeFormat("en-US", {
          weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: timezone,
        }).format(nextRun);
      } catch {
        return reply("The workspace timezone is invalid, so I can't prepare a schedule preview. No schedule was saved.");
      }

      const proposal: PendingChatSchedule = {
        version: 1,
        proposalId: crypto.randomUUID(),
        status: "pending",
        requestedBy: ctx.user.id,
        agentInstanceId: input.agentId,
        agentRole: input.agentRole,
        capability,
        title: definition.label,
        cadence,
        recurrenceRule,
        timezone,
        payload,
        businessHours: (proposedBusinessHours ?? {}) as Record<string, unknown>,
        updateExisting,
        enabledAfterSave,
        expectedExistingSchedule: existing ? { id: existing.id, updatedAt: existing.updated_at } : null,
        expiresAt: new Date(Date.now() + SCHEDULE_PREVIEW_TTL_MS).toISOString(),
      };
      await db.query("update chat_conversations set pending_workforce_schedule = $3::jsonb where id = $1 and org_id = $2", [
        input.conversationId,
        ctx.org.orgId,
        JSON.stringify(proposal),
      ]);
      const existingNotice = updateExisting
        ? ` The existing schedule will be updated in place, with its research assignment preserved. It is currently ${existing?.enabled ? "enabled" : "paused"} and will remain ${enabledAfterSave ? "enabled" : "paused"}.`
        : existing
          ? ` An existing schedule for this review${existing.enabled ? " is currently enabled" : ""} will be replaced and saved paused if it hasn't changed.`
        : "";
      const activationNotice = updateExisting && enabledAfterSave
        ? " After confirmation it will stay enabled in Schedules; workspace schedule automation must also be enabled."
        : updateExisting
          ? " It will stay paused after confirmation."
          : " It will be saved paused and won't run until you enable it in Schedules; workspace schedule automation must also be enabled.";
      const content = `Schedule preview for ${definition.label}: ${scheduleCadenceLabel(proposal.cadence, proposal.recurrenceRule)} in ${timezone}.${scheduleWorkWindowNotice(proposal.businessHours, proposal.recurrenceRule)} The next planned time is ${nextLabel} (${timezone}).${existingNotice}${activationNotice} Reply exactly “confirm schedule” to save it, or “cancel schedule” to discard it. This preview expires in 15 minutes.`;
      return reply(content, serverMarker("proposed_change"));
    }

    if (!pending) {
      return reply(input.action.kind === "confirm"
        ? "There is no pending schedule preview to confirm. No schedule was saved."
        : "There is no pending schedule preview to discard. No schedule was saved.");
    }
    if (pending.requestedBy !== ctx.user.id || pending.agentInstanceId !== input.agentId || pending.agentRole !== input.agentRole) {
      return reply("I couldn't match this preview to the current employee and requester. No schedule was saved; request a new preview.");
    }

    if (input.action.kind === "cancel") {
      if (pending.status === "accepted" && pending.scheduleId) {
        const { rows: savedRows } = await db.query<{ enabled: boolean }>(
          "select enabled from ai_work_schedules where id = $1 and org_id = $2",
          [pending.scheduleId, ctx.org.orgId],
        );
        if (!savedRows[0]) return reply("This preview was already used, but its saved schedule no longer exists. No new schedule was created.");
        return reply(`This preview was already used. Its schedule is currently ${savedRows[0].enabled ? "enabled" : "paused"}; canceling the preview does not change it.`);
      }
      if (pending.status === "pending") {
        pending.status = "cancelled";
        await db.query("update chat_conversations set pending_workforce_schedule = $3::jsonb where id = $1 and org_id = $2", [
          input.conversationId, ctx.org.orgId, JSON.stringify(pending),
        ]);
      }
      return reply(pending.status === "expired"
        ? "This schedule preview has expired. No schedule was saved."
        : "Schedule preview discarded. No schedule was saved.");
    }

    const definition = capabilityDefinition(pending.capability);
    if (!definition || !schedulePermissionAllowed(ctx, input.agentRole, pending.capability)) {
      return reply("Your current workspace role can't create this AI schedule. No schedule was saved.");
    }
    if (pending.status === "accepted" && pending.scheduleId) {
      const { rows: savedRows } = await db.query<{ enabled: boolean }>(
        "select enabled from ai_work_schedules where id = $1 and org_id = $2",
        [pending.scheduleId, ctx.org.orgId],
      );
      if (!savedRows[0]) return reply("This preview was already used, but its saved schedule no longer exists. Request a new preview; no duplicate was created.");
      return reply(`This schedule was already saved. It is currently ${savedRows[0].enabled ? "enabled" : "paused"}; no duplicate was created.`);
    }
    if (pending.status === "cancelled") return reply("This schedule preview was discarded. No schedule was saved.");
    if (pending.status === "expired" || Date.parse(pending.expiresAt) <= Date.now()) {
      pending.status = "expired";
      await db.query("update chat_conversations set pending_workforce_schedule = $3::jsonb where id = $1 and org_id = $2", [
        input.conversationId, ctx.org.orgId, JSON.stringify(pending),
      ]);
      return reply("This schedule preview has expired. No schedule was saved; request a fresh preview.");
    }
    // A switch-off after the preview blocks the confirmation: the preview stays and nothing is saved.
    const switchedOffNow = await chatAbilityRefusal(ctx, { agentId: input.agentId, agentRole: input.agentRole, actionId: `capability:${pending.capability}`, need: capabilityNeed(pending.capability) }, db);
    if (switchedOffNow) return reply(switchedOffNow);
    if (!validateWorkforceScheduleRule(pending.recurrenceRule) && pending.cadence !== "hourly") {
      return reply("I couldn't verify the recurrence in this preview. No schedule was saved; request a fresh preview.");
    }
    const { rows: orgRows } = await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [ctx.org.orgId]);
    if (!orgRows[0]?.timezone || orgRows[0].timezone !== pending.timezone || ctx.org.timezone !== pending.timezone) {
      pending.status = "expired";
      await db.query("update chat_conversations set pending_workforce_schedule = $3::jsonb where id = $1 and org_id = $2", [
        input.conversationId, ctx.org.orgId, JSON.stringify(pending),
      ]);
      return reply("The workspace timezone changed after this preview. No schedule was saved; request a fresh preview.");
    }

    let saved: { id: string; enabled: boolean };
    try {
      saved = await saveScheduleInTransaction(db, ctx, {
        capability: pending.capability,
        agentRole: pending.agentRole,
        cadence: pending.cadence as ScheduleCadence,
        enabled: pending.enabledAfterSave,
        businessHours: pending.businessHours,
        payload: pending.payload,
        recurrenceRule: pending.recurrenceRule,
        expectedExistingSchedule: pending.expectedExistingSchedule,
      });
    } catch (error) {
      if (!(error instanceof AppError) || !["conflict", "agent_unavailable", "forbidden", "invalid_input", "not_found"].includes(error.code)) throw error;
      pending.status = "expired";
      await db.query("update chat_conversations set pending_workforce_schedule = $3::jsonb where id = $1 and org_id = $2", [
        input.conversationId, ctx.org.orgId, JSON.stringify(pending),
      ]);
      const reason = error.code === "conflict"
        ? "The saved schedule changed after this preview. No changes were made; request a fresh preview."
        : `I couldn't save this schedule: ${error.message} No schedule was changed.`;
      return reply(reason);
    }

    pending.status = "accepted";
    pending.scheduleId = saved.id;
    pending.acceptedAt = new Date().toISOString();
    await db.query("update chat_conversations set pending_workforce_schedule = $3::jsonb where id = $1 and org_id = $2", [
      input.conversationId, ctx.org.orgId, JSON.stringify(pending),
    ]);
    let nextLabel = "the planned time shown in the preview";
    try {
      const nextRun = pending.recurrenceRule
        ? nextWorkforceScheduleOccurrence(pending.recurrenceRule, pending.timezone, new Date())
        : new Date(Date.now() + 60 * 60 * 1000);
      nextLabel = new Intl.DateTimeFormat("en-US", {
        weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: pending.timezone,
      }).format(nextRun);
    } catch {
      // Saving is already durable in this transaction; the prior preview contains the exact time.
    }
    const content = pending.updateExisting
      ? `Updated ${definition.label} to ${scheduleCadenceLabel(pending.cadence, pending.recurrenceRule)} in ${pending.timezone}.${scheduleWorkWindowNotice(pending.businessHours, pending.recurrenceRule)} The next planned time is ${nextLabel} (${pending.timezone}). The schedule is ${saved.enabled ? "still enabled" : "paused"}; workspace schedule automation must also be enabled for it to run.`
      : `Saved ${definition.label} ${scheduleCadenceLabel(pending.cadence, pending.recurrenceRule)} in ${pending.timezone}, paused. The next planned time is ${nextLabel} (${pending.timezone}). It won't run until you enable it in Schedules, and workspace schedule automation must also be enabled.`;
    return reply(content, serverMarker("approved_write", { kind: "schedule", id: saved.id }));
  });
}

export interface ConversationSummary {
  id: string;
  title: string;
  last_message_at: Date | null;
  created_at: Date;
}

export interface ChatMessageRow {
  id: string;
  role: "user" | "assistant" | "notice";
  author_user_id: string | null;
  content: string;
  status: "streaming" | "complete" | "failed" | "cancelled" | "superseded";
  run_id: string | null;
  work_job_id: string | null;
  error_code: string | null;
  /** What kind of reply this is. Null for a row written before the marker existed, and for any marker that does not parse. */
  evidence: EvidenceMarker | null;
  created_at: Date;
}

async function persistChatAssistantMessage(
  input: {
    orgId: string; userId: string; agentId: string; conversationId: string; content: string; workJobId?: string | null;
    refusal?: { role: WorkforceRoleKey; reason: string };
    /** Defaults to a system notice. */
    evidence?: ServerEvidenceMarker;
  },
): Promise<string> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into chat_messages (conversation_id, org_id, role, content, status, work_job_id, evidence)
       values ($1, $2, 'assistant', $3, 'complete', $4, $5::jsonb) returning id`,
      [input.conversationId, input.orgId, input.content, input.workJobId ?? null, serverEvidenceJson(input.evidence)],
    );
    await db.query("update chat_conversations set last_message_at = now() where id = $1 and org_id = $2", [input.conversationId, input.orgId]);
    await recordUsage(db, { orgId: input.orgId, userId: input.userId, agentId: input.agentId, kind: "agent_message" });
    if (input.refusal) {
      await recordAudit({
        orgId: input.orgId,
        actorUserId: input.userId,
        actorKind: "user",
        action: "workforce.chat_request_refused",
        targetType: "agent_instance",
        targetId: input.agentId,
        result: "denied",
        metadata: { role: input.refusal.role, reason: input.refusal.reason },
      }, db);
    }
    return rows[0].id;
  });
}

function appointmentBookingPermissionsAllowed(ctx: OrgContext): boolean {
  return ctx.can("agents.use") && ctx.can("contacts.view") && ctx.can("appointments.view") && ctx.can("appointments.book");
}

function chatSafeText(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, "\\$&");
}

/**
 * What a staff member is told about a booking that landed, by the appointment's own state. "Confirmed" is said only when the appointment is confirmed; one that waits for the host is
 * on the calendar but not confirmed, and an unreadable state is never described as either.
 */
function bookedReplyText(contactName: string, slot: string, appointmentStatus: BookedAppointmentStatus | undefined): string {
  if (appointmentStatus === "new") return `${slot} for ${contactName} is on the calendar but the host has not confirmed it yet. The host can confirm it in [Appointments](/appointments).`;
  if (appointmentStatus === "confirmed") return `The calendar confirmed ${contactName} for ${slot}. [View Appointments](/appointments).`;
  return `${contactName}'s booking for ${slot} was recorded, but I couldn't read its current state. Check [Appointments](/appointments) before telling the customer anything.`;
}

function bookingResultReply(result: BookingResult, pending: PendingChatBooking): string {
  const slot = formatSlot(pending.startAt, pending.timeZone);
  const contactName = chatSafeText(pending.contactName);
  if (result.status === "booked") return bookedReplyText(contactName, slot, result.appointmentStatus);
  if (result.status === "awaiting_approval") {
    return `I submitted ${contactName}'s appointment request for ${slot}. It is not booked yet; an owner or admin must approve it. [Review approvals](/approvals).`;
  }
  if (result.status === "needs_manual") {
    return `The calendar could not complete ${contactName}'s booking automatically. A person needs to add it manually before it is confirmed. [Open Appointments](/appointments).`;
  }
  if (result.status === "unavailable") {
    return `I couldn't submit that appointment for ${contactName}: ${chatSafeText(result.detail.slice(0, 500))} No appointment was confirmed.`;
  }
  return `The calendar could not complete that booking: ${chatSafeText(result.reason.slice(0, 500))}. No appointment was confirmed.`;
}

/**
 * The refusal text when the employee's "Allowed actions" no longer cover what this chat action needs, or null when it may go ahead. It is asked where the work starts (the preview) and
 * again where it is applied (the confirmation), so a switch-off after the preview blocks the confirmation. The denial is recorded on the connection the caller gives (inside the
 * caller's transaction, where the refusal reply is also written) or on its own. An unreadable setting refuses: work the owner may have switched off is never started on a guess.
 */
async function chatAbilityRefusal(ctx: OrgContext, input: { agentId: string; agentRole: WorkforceRoleKey; actionId: string; need: AbilityNeed }, db?: Queryable): Promise<string | null> {
  const run = async (q: Queryable) => {
    const refusal = await abilityRefusal(q, { orgId: ctx.org.orgId, agentId: input.agentId, roleKey: input.agentRole, need: input.need });
    if (!refusal) return null;
    await recordActionDenied({
      orgId: ctx.org.orgId, agentId: input.agentId, actionId: input.actionId, actorUserId: ctx.user.id, actorKind: "user", role: input.agentRole, reason: `${refusal.reason}: ${refusal.abilities.join(", ")}`,
    }, q);
    return refusal.message;
  };
  return db ? run(db) : withSystem(run);
}

const chatActionNeed = (actionId: string): AbilityNeed => ({ anyOf: CHAT_ACTION_ABILITIES[actionId] ?? [] });

/** Whether the employee's role (read from its row) may take this chat action. A refusal is recorded by the policy; nothing is thrown into the conversation. */
async function chatActionAllowed(ctx: OrgContext, agentId: string, actionId: string): Promise<boolean> {
  try {
    await enforceAgentAction({ orgId: ctx.org.orgId, agentId, actionId, actorUserId: ctx.user.id, actorKind: "user" });
    return true;
  } catch {
    return false;
  }
}

async function handleChatTargetingIntent(
  ctx: OrgContext,
  input: { agentId: string; conversationId: string; userMessageId: string | null; intent: ReturnType<typeof parseWorkforceChatTargetingIntent> },
): Promise<SendResult> {
  const reply = async (content: string, evidence?: ServerEvidenceMarker) => {
    const assistantMessageId = await persistChatAssistantMessage({
      orgId: ctx.org.orgId, userId: ctx.user.id, agentId: input.agentId,
      conversationId: input.conversationId, content, evidence,
    });
    return { conversationId: input.conversationId, userMessageId: input.userMessageId, assistantMessageId, runId: null, jobId: null };
  };

  if (input.intent.kind === "clarification") return reply(input.intent.message);
  if (input.intent.kind !== "update") return reply("I couldn't identify a safe lead-targeting change. No settings were changed.");
  if (!(await chatActionAllowed(ctx, input.agentId, "chat:targeting_update"))) {
    return reply("The AI Growth Partner's research permission is switched off, so I couldn't change lead targeting. No settings were changed.");
  }
  if (!ctx.can("leads.research")) {
    return reply("Only a workspace owner or admin can change saved lead-targeting rules. No settings were changed.");
  }

  try {
    const current = await getTargeting(ctx);
    const next = targetingSchema.parse({ ...current, industries: [input.intent.industry], regions: [input.intent.region] });
    await saveTargeting(ctx, next);
    const saved = await getTargeting(ctx);
    if (JSON.stringify(saved.industries) !== JSON.stringify(next.industries) || JSON.stringify(saved.regions) !== JSON.stringify(next.regions)) {
      return reply("I couldn't verify the saved targeting rules after the update, so I can't confirm the change. Please check Partner Settings before starting research.");
    }
    const unchanged = JSON.stringify(current.industries) === JSON.stringify(next.industries) && JSON.stringify(current.regions) === JSON.stringify(next.regions);
    const state = unchanged ? "Those lead-targeting rules were already saved" : "Saved lead targeting";
    return reply(`${state}: industry ${chatSafeText(input.intent.industry)}; region ${chatSafeText(input.intent.region)}. New lead research and scheduled research will use these workspace rules.`, serverMarker("approved_write"));
  } catch (error) {
    const message = error instanceof AppError ? error.message : "The targeting service could not save the change just now.";
    return reply(`I couldn't update saved lead targeting: ${chatSafeText(message)} No settings were confirmed as changed.`);
  }
}

async function handleChatPreferencesIntent(
  ctx: OrgContext,
  input: { agentId: string; conversationId: string; userMessageId: string | null; intent: ReturnType<typeof parseWorkforceChatPreferencesIntent> },
): Promise<SendResult> {
  const reply = async (content: string, evidence?: ServerEvidenceMarker) => {
    const assistantMessageId = await persistChatAssistantMessage({
      orgId: ctx.org.orgId, userId: ctx.user.id, agentId: input.agentId,
      conversationId: input.conversationId, content, evidence,
    });
    return { conversationId: input.conversationId, userMessageId: input.userMessageId, assistantMessageId, runId: null, jobId: null };
  };

  if (input.intent.kind === "clarification") return reply(input.intent.message);
  if (input.intent.kind !== "update") return reply("I couldn't identify a supported persistent preference. No settings were changed.");
  if (!(await chatActionAllowed(ctx, input.agentId, "chat:partner_preferences_update"))) {
    return reply("This Growth Partner can't change persistent preferences from chat right now. No settings were changed.");
  }
  if (!ctx.can("agents.configure")) {
    return reply("Only a workspace owner or admin can change persistent AI Growth Partner preferences. No settings were changed.");
  }

  const preferences = input.intent.preferences;
  const preferenceKeys = Object.keys(preferences) as Array<keyof typeof preferences>;
  const summary = () => [
    preferences.tone ? `${preferences.tone} tone` : null,
    preferences.replyLength ? `${preferences.replyLength} replies` : null,
    preferences.language ? `${preferences.language} replies` : null,
  ].filter(Boolean).join(", ");

  try {
    const profile = await getProfile(ctx);
    const current = aiPreferencesSchema.parse(profile?.ai_preferences ?? {});
    const result = await updateAiPreferences(
      ctx,
      { ...current, ...preferences, applyToEmployees: true },
      { growthPartnerOnly: true },
    );
    const active = await withSystem(async (db) => (await db.query<{ settings: unknown }>(
      `select v.settings from agent_instances a
       join agent_config_versions v on v.id = a.active_config_version_id and v.org_id = a.org_id
       where a.org_id = $1 and a.role_key = 'growth_partner' and a.enabled limit 1`,
      [ctx.org.orgId],
    )).rows[0] ?? null);
    if (!active) return reply(`Saved ${summary()} as workspace defaults, but the AI Growth Partner has no active settings version yet. Finish Partner setup before relying on this change.`, serverMarker("approved_write"));

    if (result.held.includes("growth_partner")) {
      return reply(`Saved ${summary()}, but the new Growth Partner settings are waiting for review. Current behavior remains active until they are approved.`, systemNoticeMarker());
    }
    const parsed = agentSettingsSchema.safeParse(active.settings);
    if (!parsed.success) return reply("The Growth Partner settings could not be verified after saving. Please check Partner Settings before relying on the change.", systemNoticeMarker());
    const appliedKeys = preferenceKeys.filter((key) => parsed.data[key] === preferences[key]);
    const kept = result.skipped.some((item) => item.role === "growth_partner" && item.why === "client_edit");
    if (appliedKeys.length === preferenceKeys.length) {
      const message = result.updated.includes("growth_partner")
        ? `Saved and applied ${summary()} for future conversations.${kept ? " Other client-edited settings were kept." : ""}`
        : `Those preferences are already saved and active for the AI Growth Partner.`;
      return reply(message, result.updated.includes("growth_partner") ? serverMarker("approved_write") : undefined);
    }
    if (appliedKeys.length > 0) {
      const applied = [
        preferences.tone && appliedKeys.includes("tone") ? `${preferences.tone} tone` : null,
        preferences.replyLength && appliedKeys.includes("replyLength") ? `${preferences.replyLength} replies` : null,
        preferences.language && appliedKeys.includes("language") ? `${preferences.language} replies` : null,
      ].filter(Boolean).join(", ");
      return reply(`Applied ${applied}. The Growth Partner's own wording for another requested preference was kept; update it in Partner Settings if you want to replace it.`, serverMarker("approved_write"));
    }
    return reply("I saved the workspace defaults, but the Growth Partner's own settings were kept. Change the client-edited values in Partner Settings if you want to replace them.", systemNoticeMarker());
  } catch (error) {
    const message = error instanceof AppError ? error.message : "The settings service could not save the change just now.";
    return reply(`I didn't change the Growth Partner's persistent preferences. ${chatSafeText(message)}`, systemNoticeMarker());
  }
}

async function handleChatCrmIntent(
  ctx: OrgContext,
  input: { agentId: string; conversationId: string; userMessageId: string | null; intent: ReturnType<typeof parseWorkforceChatCrmIntent> },
): Promise<SendResult> {
  const intent = input.intent;
  const reply = async (content: string, evidence?: ServerEvidenceMarker) => {
    const assistantMessageId = await persistChatAssistantMessage({
      orgId: ctx.org.orgId, userId: ctx.user.id, agentId: input.agentId,
      conversationId: input.conversationId, content, evidence,
    });
    return { conversationId: input.conversationId, userMessageId: input.userMessageId, assistantMessageId, runId: null, jobId: null };
  };

  if (intent.kind === "clarification") return reply(intent.message);
  if (intent.kind !== "create_contact") return reply("I couldn't identify a safe CRM contact request. No record was changed.");
  if (!(await chatActionAllowed(ctx, input.agentId, "chat:crm_contact_create"))) {
    return reply("The AI Growth Partner's CRM contact permission is switched off, so I couldn't create a contact. No record was changed.");
  }
  const switchedOff = await chatAbilityRefusal(ctx, {
    agentId: input.agentId, agentRole: "growth_partner", actionId: "chat:crm_contact_create", need: chatActionNeed("chat:crm_contact_create"),
  });
  if (switchedOff) return reply(switchedOff);
  if (!ctx.can("contacts.view") || !ctx.can("contacts.create")) {
    return reply("Your workspace role needs permission to view and create CRM contacts before I can check for duplicates. No record was changed.");
  }

  try {
    const matches = await withUser(ctx.user.id, async (db) => (await db.query<{ id: string; name: string }>(
      `select id, coalesce(nullif(display_name, ''), nullif(concat_ws(' ', first_name, last_name), '')) as name
         from contacts
        where org_id = $1 and deleted_at is null and archived_at is null
          and lower(btrim(coalesce(nullif(display_name, ''), nullif(concat_ws(' ', first_name, last_name), '')))) = lower($2)
        order by id limit 2`,
      [ctx.org.orgId, intent.displayName],
    )).rows);
    if (matches.length > 1) {
      return reply(`More than one active CRM contact is named “${chatSafeText(intent.displayName)}”. No contact was created; use a more specific name before trying again.`);
    }
    if (matches[0]) {
      return reply(`A contact named “${chatSafeText(matches[0].name)}” is already in the CRM, so I didn't create another. [Open the contact](/crm/contacts/${matches[0].id}).`);
    }

    const actor = memberActor(ctx);
    const created = await createContact(actor, {
      displayName: intent.displayName,
      email: intent.email,
      phone: intent.phone,
      source: "AI Growth Partner chat",
    });
    if (!created.created) {
      return reply("That email or phone already belongs to an existing contact. No new contact was created; check CRM before deciding whether to update it.");
    }
    const verified = await withUser(ctx.user.id, async (db) => (await db.query<{ id: string; name: string }>(
      `select id, coalesce(nullif(display_name, ''), nullif(concat_ws(' ', first_name, last_name), '')) as name
         from contacts where id = $1 and org_id = $2 and deleted_at is null and archived_at is null`,
      [created.id, ctx.org.orgId],
    )).rows[0] ?? null);
    if (!verified || verified.id !== created.id) {
      return reply("The CRM accepted the contact, but I couldn't verify the saved record in your workspace. Please check CRM before relying on it.");
    }
    return reply(`Added ${chatSafeText(verified.name)} to the CRM. No message was sent. [Open the contact](/crm/contacts/${verified.id}).`, serverMarker("approved_write"));
  } catch (error) {
    if (error instanceof DuplicateContactError) {
      return reply(`That email or phone already belongs to a CRM contact. No duplicate was created. [Open the existing contact](/crm/contacts/${error.existingContactId}).`);
    }
    const message = error instanceof AppError ? error.message : "The CRM couldn't save this contact just now.";
    return reply(`I couldn't create the CRM contact: ${chatSafeText(message)} No successful change was confirmed.`);
  }
}

function normalizeSchedulingName(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

async function handleChatCalendarCreateIntent(
  ctx: OrgContext,
  input: { agentId: string; conversationId: string; userMessageId: string | null; intent: WorkforceChatCalendarCreateIntent },
): Promise<SendResult> {
  const intent = input.intent;
  const reply = async (content: string, evidence?: ServerEvidenceMarker) => {
    const assistantMessageId = await persistChatAssistantMessage({
      orgId: ctx.org.orgId, userId: ctx.user.id, agentId: input.agentId,
      conversationId: input.conversationId, content, evidence,
    });
    return { conversationId: input.conversationId, userMessageId: input.userMessageId, assistantMessageId, runId: null, jobId: null };
  };

  if (intent.kind === "clarification") return reply(intent.message);
  if (intent.kind !== "create") return reply("I couldn't identify a safe calendar-creation request. No calendar settings were changed.");
  if (!(await chatActionAllowed(ctx, input.agentId, "chat:calendar_create"))) {
    return reply("The AI Growth Partner's calendar-creation permission is switched off, so I couldn't create a calendar. No settings were changed.");
  }
  const switchedOff = await chatAbilityRefusal(ctx, {
    agentId: input.agentId, agentRole: "growth_partner", actionId: "chat:calendar_create", need: chatActionNeed("chat:calendar_create"),
  });
  if (switchedOff) return reply(switchedOff);
  if (!ctx.can("calendars.manage")) return reply("Your workspace role needs calendar-management permission to create a calendar. No settings were changed.");
  if (!ctx.can("appointments.view")) return reply("Your workspace role needs permission to view scheduling members before I can safely assign calendar hosts. No settings were changed.");

  let createdCalendarId: string | null = null;
  try {
    const actor = memberActor(ctx);
    const people = await listSchedulingPeople(actor);
    if (!intent.hostTarget) {
      const available = people.slice(0, 12).map((person) => person.name).join(", ");
      return reply(`Which active team members should host “${chatSafeText(intent.calendarName)}”?${available ? ` I can assign: ${chatSafeText(available)}.` : " I couldn't find active scheduling members."} No calendar settings were changed.`);
    }

    const target = intent.hostTarget.replace(/^(?:our|the)\s+/i, "").trim();
    const teamMatch = target.match(/^(.+?)\s+(?:team|department)$/i);
    let hosts: typeof people = [];
    if (teamMatch) {
      const group = normalizeSchedulingName(teamMatch[1]);
      hosts = people.filter((person) => {
        const role = normalizeSchedulingName(person.role);
        return role === group || role.startsWith(`${group} `);
      });
      if (!hosts.length) {
        const available = people.slice(0, 12).map((person) => `${person.name} (${person.role})`).join(", ");
        return reply(`I couldn't match “${chatSafeText(target)}” to an active workspace team role. Please name the hosts${available ? `; active members include ${chatSafeText(available)}` : ""}. No calendar settings were changed.`);
      }
    } else {
      const names = target.split(/\s*,\s*|\s+and\s+/i).map((name) => name.trim()).filter(Boolean);
      if (!names.length || names.length > 20) return reply("Please name one to twenty active team members who should host this calendar. No settings were changed.");
      for (const name of names) {
        const matches = people.filter((person) => normalizeSchedulingName(person.name) === normalizeSchedulingName(name));
        if (matches.length !== 1) {
          const reason = matches.length > 1 ? `“${name}” matches more than one active member` : `I couldn't find an active member named “${name}”`;
          return reply(`${reason}. Please use each host's exact workspace name. No calendar settings were changed.`);
        }
        hosts.push(matches[0]);
      }
    }
    hosts = [...new Map(hosts.map((person) => [person.id, person])).values()];

    const calendars = await listCalendars(actor);
    const duplicate = calendars.find((calendar) => normalizeSchedulingName(calendar.name) === normalizeSchedulingName(intent.calendarName));
    if (duplicate) {
      return reply(`A calendar named “${chatSafeText(duplicate.name)}” already exists, so I didn't create a duplicate. Review it in [Calendar & Types](/work/calendar).`);
    }

    const calendar = await createCalendar(actor, {
      name: intent.calendarName,
      members: hosts.map((person) => ({ userId: person.id })),
      assignment: hosts.length > 1 ? "round_robin" : "single",
      roundRobinMode: "balanced",
      public: false,
    });
    createdCalendarId = calendar.id;
    const type = await createAppointmentType(actor, calendar.id, {
      name: intent.appointmentTypeName,
      durationMinutes: intent.durationMinutes,
      minNoticeMinutes: 120,
      maxDaysAhead: 60,
      locationKind: "none",
      requiresConfirmation: true,
      public: false,
    });
    const refreshed = await listCalendars(actor);
    const verified = refreshed.find((item) => item.id === calendar.id);
    const verifiedType = verified?.types.find((item) => item.id === type.id);
    if (!verified || verified.public || !verifiedType || verifiedType.public || verifiedType.durationMinutes !== intent.durationMinutes) {
      return reply(`The calendar service created “${chatSafeText(intent.calendarName)}”, but I couldn't verify its private appointment setup. Check [Calendar & Types](/work/calendar) before using it.`);
    }
    const hostNames = hosts.map((person) => chatSafeText(person.name)).join(", ");
    const defaultNote = verified.isDefault ? " It is the workspace's default calendar." : "";
    return reply(`Created the private “${chatSafeText(verified.name)}” calendar for ${hostNames}, with a hidden ${chatSafeText(verifiedType.name)} appointment type (${verifiedType.durationMinutes} minutes). The booking page and appointment type are both hidden, existing host hours were left unchanged, and new bookings require confirmation.${defaultNote} Review it in [Calendar & Types](/work/calendar).`, serverMarker("approved_write"));
  } catch (error) {
    const message = error instanceof AppError ? error.message : "The calendar service couldn't complete that change just now.";
    if (createdCalendarId) {
      return reply(`The private calendar was created, but I couldn't finish or verify its appointment type: ${chatSafeText(message)} Check [Calendar & Types](/work/calendar) before using it.`);
    }
    return reply(`I couldn't create the calendar: ${chatSafeText(message)} No successful calendar change was confirmed.`);
  }
}

function appointmentPolicyValue(type: { durationMinutes: number; minNoticeMinutes: number; maxDaysAhead: number }, field: "durationMinutes" | "minNoticeMinutes" | "maxDaysAhead"): number {
  return type[field];
}

function appointmentPolicyLabel(field: "durationMinutes" | "minNoticeMinutes" | "maxDaysAhead"): string {
  return field === "durationMinutes" ? "appointment duration" : field === "minNoticeMinutes" ? "minimum notice" : "booking window";
}

function appointmentPolicyPhrase(field: "durationMinutes" | "minNoticeMinutes" | "maxDaysAhead", value: number): string {
  if (field === "durationMinutes") return `${value} minutes`;
  if (field === "minNoticeMinutes") return value % 1440 === 0 ? `${value / 1440} days` : value % 60 === 0 ? `${value / 60} hours` : `${value} minutes`;
  return `${value} days`;
}

async function handleChatAppointmentPolicyIntent(
  ctx: OrgContext,
  input: { agentId: string; conversationId: string; userMessageId: string | null; intent: WorkforceChatAppointmentPolicyIntent },
): Promise<SendResult> {
  const intent = input.intent;
  const reply = async (content: string, evidence?: ServerEvidenceMarker) => {
    const assistantMessageId = await persistChatAssistantMessage({
      orgId: ctx.org.orgId, userId: ctx.user.id, agentId: input.agentId,
      conversationId: input.conversationId, content, evidence,
    });
    return { conversationId: input.conversationId, userMessageId: input.userMessageId, assistantMessageId, runId: null, jobId: null };
  };

  if (intent.kind === "clarification") return reply(intent.message);
  if (intent.kind !== "update") return reply("I couldn't identify a supported appointment booking rule. No calendar settings were changed.");
  if (!(await chatActionAllowed(ctx, input.agentId, "chat:appointment_policy_update"))) {
    return reply("The AI Growth Partner's appointment-settings permission is switched off, so I couldn't change booking rules. No calendar settings were changed.");
  }
  const switchedOff = await chatAbilityRefusal(ctx, {
    agentId: input.agentId, agentRole: "growth_partner", actionId: "chat:appointment_policy_update", need: chatActionNeed("chat:appointment_policy_update"),
  });
  if (switchedOff) return reply(switchedOff);

  try {
    const native = await withSystem((db) => bookingIsNative(db, ctx.org.orgId));
    if (native) {
      if (!ctx.can("calendars.manage")) return reply("Your workspace role needs calendar-management permission to change appointment type rules. No calendar settings were changed.");
      const actor = memberActor(ctx);
      const calendars = await listCalendars(actor);
      const allTypes = calendars.flatMap((calendar) => calendar.types.map((type) => ({ calendar, type })));
      const matches = intent.appointmentTypeName
        ? allTypes.filter(({ type }) => type.name.trim().toLocaleLowerCase("en-US") === intent.appointmentTypeName!.trim().toLocaleLowerCase("en-US"))
        : allTypes;
      if (intent.appointmentTypeName && matches.length === 0) {
        return reply(`I couldn't find an appointment type named “${chatSafeText(intent.appointmentTypeName)}”. No calendar settings were changed; check [Calendar & Types](/work/calendar) and use the exact type name.`);
      }
      const candidates = intent.appointmentTypeName ? matches : allTypes.filter(({ calendar }) => calendar.status === "active");
      if (candidates.length === 0) return reply("There isn't an active appointment type to update yet. Create and activate one in [Calendar & Types](/work/calendar), then try again.");
      if (candidates.length > 1) {
        const choices = candidates.slice(0, 5).map(({ calendar, type }) => `“${chatSafeText(type.name)}” in ${chatSafeText(calendar.name)}`).join(", ");
        return reply(`Which appointment type should I update? I found ${choices}${candidates.length > 5 ? ", and others" : ""}. No calendar settings were changed.`);
      }

      const selected = candidates[0];
      const patch = intent.field === "durationMinutes" ? { durationMinutes: intent.value }
        : intent.field === "minNoticeMinutes" ? { minNoticeMinutes: intent.value }
          : { maxDaysAhead: intent.value };
      await updateAppointmentType(actor, selected.type.id, patch);
      const refreshed = await listCalendars(actor);
      const verified = refreshed.flatMap((calendar) => calendar.types.map((type) => ({ calendar, type }))).find(({ type }) => type.id === selected.type.id);
      if (!verified || appointmentPolicyValue(verified.type, intent.field) !== intent.value) {
        return reply("The calendar service returned, but I couldn't verify the saved appointment rule. Check [Calendar & Types](/work/calendar) before relying on it.");
      }
      const draftNote = verified.calendar.status === "draft" ? " The calendar is still a draft, so customer booking availability changes after it is activated." : " New availability checks use this rule; existing bookings weren't changed.";
      return reply(`Updated ${chatSafeText(verified.type.name)} ${appointmentPolicyLabel(intent.field)} to ${appointmentPolicyPhrase(intent.field, intent.value)} in ${chatSafeText(verified.calendar.name)}.${draftNote} [Open Calendar & Types](/work/calendar).`, serverMarker("approved_write"));
    }

    if (!ctx.can("appointments.manage")) return reply("Your workspace role needs appointment-management permission to change booking rules. No calendar settings were changed.");
    if (intent.appointmentTypeName) {
      return reply("This workspace uses booking rules for the connected calendar as a whole, not per appointment type. Rephrase the request for the workspace-wide rule; no settings were changed.");
    }
    const current = await getPolicyView(ctx);
    if (!current.calendars.length) return reply("I couldn't find an active connected booking calendar for this workspace. Connect one before changing its booking rules; no settings were changed.");
    if (intent.field === "durationMinutes" && intent.value > 480) return reply("This connected calendar accepts appointment lengths up to 8 hours. No settings were changed.");
    if (intent.field === "minNoticeMinutes" && intent.value > 20160) return reply("This connected calendar accepts minimum notice up to 14 days. No settings were changed.");
    if (intent.field === "maxDaysAhead" && intent.value > 31) return reply("This connected calendar accepts booking windows up to 31 days. No settings were changed.");
    const save = intent.field === "durationMinutes" ? { slotMinutes: intent.value }
      : intent.field === "minNoticeMinutes" ? { minNoticeMinutes: intent.value }
        : { maxDaysAhead: intent.value };
    await savePolicy(ctx, save);
    const saved = await getPolicyView(ctx);
    const actual = intent.field === "durationMinutes" ? saved.slotMinutes
      : intent.field === "minNoticeMinutes" ? saved.minNoticeMinutes
        : saved.maxDaysAhead;
    if (actual !== intent.value) return reply("The booking service returned, but I couldn't verify the saved rule. Check [Appointments](/appointments) before relying on it.");
    return reply(`Updated workspace-wide ${appointmentPolicyLabel(intent.field)} to ${appointmentPolicyPhrase(intent.field, intent.value)}. New availability checks use this rule; existing bookings weren't changed. [Open Appointments](/appointments).`, serverMarker("approved_write"));
  } catch (error) {
    const message = error instanceof AppError ? error.message : "The calendar settings service couldn't save that change just now.";
    return reply(`I couldn't update the appointment rule: ${chatSafeText(message)} No successful change was confirmed.`);
  }
}

async function handleChatBookingIntent(
  ctx: OrgContext,
  input: { agentId: string; agentRole: WorkforceRoleKey; conversationId: string; userMessageId: string | null; intent: WorkforceChatBookingIntent },
): Promise<SendResult> {
  const reply = async (content: string, evidence?: ServerEvidenceMarker) => {
    const assistantMessageId = await persistChatAssistantMessage({
      orgId: ctx.org.orgId,
      userId: ctx.user.id,
      agentId: input.agentId,
      conversationId: input.conversationId,
      content,
      evidence,
    });
    return { conversationId: input.conversationId, userMessageId: input.userMessageId, assistantMessageId, runId: null, jobId: null };
  };

  // The parser already limits this to the Appointment Setter; the policy table decides again here, from the employee's own database row, and records a refusal.
  if (!(await chatActionAllowed(ctx, input.agentId, "chat:booking_request"))) return reply("This employee's role can't prepare appointment requests. No booking was made.");
  if (input.intent.kind === "none") return reply("I couldn't prepare that appointment request. No booking was made.");
  if (input.intent.kind === "clarification") return reply(input.intent.message);
  if (!appointmentBookingPermissionsAllowed(ctx)) {
    return reply("To prepare or submit an appointment request, your workspace role needs permission to view contacts and calendars and book appointments. No booking was made.");
  }

  if (input.intent.kind === "proposal") {
    const proposalIntent = input.intent;
    const switchedOff = await chatAbilityRefusal(ctx, { agentId: input.agentId, agentRole: input.agentRole, actionId: "chat:booking_request", need: chatActionNeed("chat:booking_request") });
    if (switchedOff) return reply(switchedOff);
    const matches = await withUser(ctx.user.id, async (db) => {
      const { rows } = await db.query<{ id: string; name: string; timezone: string | null }>(
        `select id, coalesce(nullif(display_name, ''), nullif(concat_ws(' ', first_name, last_name), '')) as name, timezone
           from contacts
          where org_id = $1 and deleted_at is null and archived_at is null
            and lower(btrim(coalesce(nullif(display_name, ''), nullif(concat_ws(' ', first_name, last_name), '')))) = lower($2)
          order by id limit 2`,
        [ctx.org.orgId, proposalIntent.contactName],
      );
      return rows;
    });
    if (matches.length === 0) return reply(`I couldn't find an active CRM contact named “${chatSafeText(proposalIntent.contactName)}” exactly. Check the contact's display name and try again. No booking preview was created.`);
    if (matches.length > 1) return reply(`More than one active contact is named “${chatSafeText(proposalIntent.contactName)}”. Use a unique CRM display name before requesting a booking. No preview was created.`);

    const contact = matches[0];
    const timeZone = contact.timezone ?? ctx.org.timezone;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(proposalIntent.startAt));
    } catch {
      return reply("That contact or workspace has an invalid timezone. Update the contact or workspace timezone, then request a new preview. No booking was created.");
    }
    const startAt = new Date(proposalIntent.startAt);
    let availability;
    try {
      availability = await getAvailability(ctx.org.orgId, {
        from: new Date(startAt.getTime() - 60_000),
        to: new Date(startAt.getTime() + 60_000),
        timeZone,
        limit: 200,
      });
    } catch {
      return reply("I couldn't verify the requested time against the live calendar, so I didn't create a preview. Check the calendar connection and try again.");
    }
    if (!availability.ok) return reply(`I couldn't prepare a booking preview: ${chatSafeText(availability.detail.slice(0, 500))} No booking was made.`);
    const slot = availability.slots.find((candidate) => new Date(candidate.start).getTime() === startAt.getTime());
    if (!slot) return reply(`The calendar does not currently offer ${formatSlot(proposalIntent.startAt, timeZone)}. I did not reserve or book a time. Ask for a listed available slot and try again.`);

    const proposal: PendingChatBooking = {
      version: 1,
      proposalId: crypto.randomUUID(),
      status: "pending",
      requestedBy: ctx.user.id,
      agentInstanceId: input.agentId,
      contactId: contact.id,
      contactName: contact.name,
      contactTimeZone: contact.timezone,
      workspaceTimeZone: ctx.org.timezone,
      timeZone,
      calendarId: availability.calendarId,
      startAt: startAt.toISOString(),
      expiresAt: new Date(Date.now() + BOOKING_PREVIEW_TTL_MS).toISOString(),
    };
    const stored = await withSystem(async (db) => {
      const { rows } = await db.query<{ id: string; pending_workforce_booking: unknown }>(
        `select id, pending_workforce_booking from chat_conversations
          where id = $1 and org_id = $2 and agent_instance_id = $3 and (growth_partner_id is not null or user_id = $4) and deleted_at is null
          for update`,
        [input.conversationId, ctx.org.orgId, input.agentId, ctx.user.id],
      );
      if (!rows[0]) throw new AppError("not_found", "Conversation not found.");
      const existing = parsePendingChatBooking(rows[0].pending_workforce_booking);
      if (existing?.status === "processing") return false;
      await db.query("update chat_conversations set pending_workforce_booking = $3::jsonb where id = $1 and org_id = $2", [
        input.conversationId, ctx.org.orgId, JSON.stringify(proposal),
      ]);
      await recordAudit({
        orgId: ctx.org.orgId,
        actorUserId: ctx.user.id,
        actorKind: "user",
        action: "workforce.chat_booking_previewed",
        targetType: "contact",
        targetId: contact.id,
        result: "success",
        metadata: { agentRole: input.agentRole, startAt: proposal.startAt, timeZone },
      }, db);
      return true;
    });
    if (!stored) return reply("A booking request is already being processed in this conversation. Check Appointments before requesting another one.");
    return reply(`Appointment preview for ${chatSafeText(contact.name)}: ${formatSlot(proposal.startAt, timeZone)}. This does not hold or book the slot. Reply “confirm booking” to submit it; the calendar will be checked again and the workspace approval rules still apply. This preview expires in 15 minutes.`, serverMarker("proposed_change"));
  }

  const initial = await withSystem(async (db) => {
    const { rows } = await db.query<{ pending_workforce_booking: unknown }>(
      `select pending_workforce_booking from chat_conversations
        where id = $1 and org_id = $2 and agent_instance_id = $3 and (growth_partner_id is not null or user_id = $4) and deleted_at is null`,
      [input.conversationId, ctx.org.orgId, input.agentId, ctx.user.id],
    );
    return rows[0]?.pending_workforce_booking ?? null;
  });
  const pending = parsePendingChatBooking(initial);
  if (initial !== null && !pending) {
    await withSystem((db) => db.query(
      "update chat_conversations set pending_workforce_booking = null where id = $1 and org_id = $2",
      [input.conversationId, ctx.org.orgId],
    ));
    return reply("I couldn't verify the saved appointment preview, so I discarded it. No booking was made. Please request a fresh preview.");
  }
  if (!pending) return reply(input.intent.kind === "confirm"
    ? "There is no pending appointment preview to confirm. No booking was made."
    : "There is no pending appointment preview to discard. No appointment was changed.");
  if (pending.requestedBy !== ctx.user.id || pending.agentInstanceId !== input.agentId || (input.agentRole !== "appointment_setter" && input.agentRole !== "growth_partner")) {
    return reply("I couldn't match this preview to the current employee and requester. No booking was made; request a fresh preview.");
  }

  if (input.intent.kind === "cancel") {
    if (pending.status === "accepted") return reply("This preview was already submitted. It cannot cancel or change that appointment. Use Appointments to review the booking.");
    if (pending.status === "processing") return reply("The booking request is already being processed, so I can't discard it now. Check Appointments before taking further action.");
    if (pending.status === "pending") {
      pending.status = "cancelled";
      await withSystem((db) => db.query("update chat_conversations set pending_workforce_booking = $3::jsonb where id = $1 and org_id = $2", [
        input.conversationId, ctx.org.orgId, JSON.stringify(pending),
      ]));
    }
    return reply(pending.status === "expired"
      ? "This appointment preview has expired. No booking was made."
      : "Appointment preview discarded. No booking was made.");
  }

  if (pending.status === "accepted" && pending.bookingId && pending.bookingStatus) {
    // The state is read now: the host may have confirmed it since, and an appointment waiting for the host is never repeated as confirmed.
    const appointmentStatus = pending.bookingStatus === "booked" ? await bookedAppointmentStatus(ctx.org.orgId, pending.bookingId) : undefined;
    const earlier = bookingResultEvidence(pending.bookingStatus, { bookingId: pending.bookingId }, appointmentStatus);
    if (pending.bookingStatus === "booked") {
      const when = formatSlot(pending.startAt, pending.timeZone);
      if (appointmentStatus === "new") return reply(`This appointment was already submitted. ${when} for ${chatSafeText(pending.contactName)} is on the calendar but the host has not confirmed it yet. [View Appointments](/appointments).`, earlier);
      if (appointmentStatus === "confirmed") return reply(`This appointment was already submitted and the calendar confirmed it for ${when}. [View Appointments](/appointments).`, earlier);
      return reply("This appointment was already submitted, but I couldn't read its current state. Check Appointments before telling the customer anything.", earlier);
    }
    if (pending.bookingStatus === "awaiting_approval") return reply(`This appointment request is already waiting for an owner or admin's approval; it is not booked yet. [Review approvals](/approvals).`, earlier);
    if (pending.bookingStatus === "needs_manual") return reply("This appointment request was already submitted and still needs a person to add it to the calendar. [Open Appointments](/appointments).", earlier);
    return reply("This appointment preview was already used. Check Appointments before requesting a new time.");
  }
  if (pending.status === "cancelled") return reply("This appointment preview was discarded. No booking was made.");
  if (pending.status === "expired" || Date.parse(pending.expiresAt) <= Date.now()) {
    pending.status = "expired";
    await withSystem((db) => db.query("update chat_conversations set pending_workforce_booking = $3::jsonb where id = $1 and org_id = $2", [
      input.conversationId, ctx.org.orgId, JSON.stringify(pending),
    ]));
    return reply("This appointment preview has expired. No booking was made; request a fresh preview.");
  }
  if (pending.status === "processing") {
    const processingAt = Date.parse(pending.processingAt ?? "");
    if (Number.isFinite(processingAt) && Date.now() - processingAt > 10 * 60_000) {
      pending.status = "expired";
      await withSystem((db) => db.query("update chat_conversations set pending_workforce_booking = $3::jsonb where id = $1 and org_id = $2", [
        input.conversationId, ctx.org.orgId, JSON.stringify(pending),
      ]));
      return reply("I couldn't confirm the result of the earlier booking request. Check Appointments before retrying so you don't create a duplicate.");
    }
    return reply("The booking request is still being processed. Check Appointments before sending another request.");
  }

  // A switch-off after the preview blocks the confirmation: the preview stays, nothing is booked and no approval is created.
  const switchedOffNow = await chatAbilityRefusal(ctx, { agentId: input.agentId, agentRole: input.agentRole, actionId: "chat:booking_request", need: chatActionNeed("chat:booking_request") });
  if (switchedOffNow) return reply(switchedOffNow);

  const currentContact = await withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ name: string; timezone: string | null }>(
      `select coalesce(nullif(display_name, ''), nullif(concat_ws(' ', first_name, last_name), '')) as name, timezone
         from contacts where id = $1 and org_id = $2 and deleted_at is null and archived_at is null`,
      [pending.contactId, ctx.org.orgId],
    );
    return rows[0] ?? null;
  });
  const workspaceTimeZone = await withSystem(async (db) => {
    const { rows } = await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [ctx.org.orgId]);
    return rows[0]?.timezone ?? null;
  });
  const currentTimeZone = currentContact?.timezone ?? workspaceTimeZone;
  if (
    !currentContact
    || currentContact.name !== pending.contactName
    || currentContact.timezone !== pending.contactTimeZone
    || workspaceTimeZone !== pending.workspaceTimeZone
    || currentTimeZone !== pending.timeZone
  ) {
    pending.status = "expired";
    await withSystem((db) => db.query("update chat_conversations set pending_workforce_booking = $3::jsonb where id = $1 and org_id = $2", [
      input.conversationId, ctx.org.orgId, JSON.stringify(pending),
    ]));
    return reply("The contact or workspace timezone changed after this preview. No booking was made; request a fresh preview.");
  }

  const claimed = await withSystem(async (db) => {
    const { rows } = await db.query<{ pending_workforce_booking: unknown }>(
      `select pending_workforce_booking from chat_conversations
        where id = $1 and org_id = $2 and agent_instance_id = $3 and (growth_partner_id is not null or user_id = $4) and deleted_at is null
        for update`,
      [input.conversationId, ctx.org.orgId, input.agentId, ctx.user.id],
    );
    const current = parsePendingChatBooking(rows[0]?.pending_workforce_booking);
    if (!current || current.proposalId !== pending.proposalId || current.status !== "pending") return null;
    current.status = "processing";
    current.processingAt = new Date().toISOString();
    await db.query("update chat_conversations set pending_workforce_booking = $3::jsonb where id = $1 and org_id = $2", [
      input.conversationId, ctx.org.orgId, JSON.stringify(current),
    ]);
    return current;
  });
  if (!claimed) return reply("This appointment preview changed while I was confirming it. No second booking was submitted; request a fresh preview or check Appointments.");

  let result: BookingResult;
  try {
    result = await requestBooking({
      orgId: ctx.org.orgId,
      contactId: claimed.contactId,
      calendarId: claimed.calendarId,
      startAt: new Date(claimed.startAt),
      title: `Appointment with ${claimed.contactName}`,
      actor: { kind: "ai", agentId: input.agentId },
      requestSource: "staff_chat",
      requestedByUserId: ctx.user.id,
    });
  } catch {
    claimed.status = "expired";
    await withSystem((db) => db.query("update chat_conversations set pending_workforce_booking = $3::jsonb where id = $1 and org_id = $2 and pending_workforce_booking->>'proposalId' = $4", [
      input.conversationId, ctx.org.orgId, JSON.stringify(claimed), claimed.proposalId,
    ]));
    return reply("I couldn't confirm the calendar result. Check Appointments before retrying so you don't create a duplicate.");
  }

  claimed.bookingId = "bookingId" in result && typeof result.bookingId === "string" ? result.bookingId : null;
  claimed.bookingStatus = result.status;
  const accepted = result.status === "booked" || result.status === "awaiting_approval" || result.status === "needs_manual";
  claimed.status = accepted && claimed.bookingId ? "accepted" : "expired";
  claimed.acceptedAt = accepted ? new Date().toISOString() : undefined;
  await withSystem((db) => db.query("update chat_conversations set pending_workforce_booking = $3::jsonb where id = $1 and org_id = $2 and pending_workforce_booking->>'proposalId' = $4", [
    input.conversationId, ctx.org.orgId, JSON.stringify(claimed), claimed.proposalId,
  ]));
  return reply(bookingResultReply(result, claimed), bookingResultEvidence(result.status, {
    bookingId: "bookingId" in result ? result.bookingId : null,
    approvalId: result.status === "awaiting_approval" ? result.approvalId : null,
  }, result.status === "booked" ? result.appointmentStatus : undefined));
}

function appointmentChangePermissionsAllowed(ctx: OrgContext): boolean {
  return ctx.can("agents.use") && ctx.can("contacts.view") && ctx.can("appointments.view") && ctx.can("appointments.book");
}

/** A change request is only ever a proposal here: the appointment changes when an owner or admin approves it, and the Approval Center says what happened then. */
function appointmentChangeEvidence(pending: PendingChatAppointmentChange): ServerEvidenceMarker {
  return pending.approvalId ? serverMarker("proposed_change", { kind: "approval", id: pending.approvalId }) : serverMarker("proposed_change");
}

function appointmentChangeReplyText(pending: PendingChatAppointmentChange): string {
  const who = chatSafeText(pending.contactName);
  const original = formatSlot(pending.expected.startAt, pending.timeZone);
  if (pending.status === "accepted" && pending.approvalId) {
    return `I submitted the ${pending.operation === "cancel" ? "cancellation" : "reschedule"} request for ${who}. The appointment has not changed yet; an owner or admin must approve it. [Review approvals](/approvals).`;
  }
  if (pending.operation === "cancel") {
    return `Cancellation preview for ${who}: ${original}. Reply “confirm appointment change” to submit it for owner or admin approval. No appointment will change unless it is approved. This preview expires in 15 minutes.`;
  }
  return `Reschedule preview for ${who}: ${original} → ${formatSlot(pending.newStartAt as string, pending.timeZone)}. The replacement time is not held. Reply “confirm appointment change” to submit it for owner or admin approval; the calendar will be checked again before any change. This preview expires in 15 minutes.`;
}

async function handleChatAppointmentChangeIntent(
  ctx: OrgContext,
  input: { agentId: string; agentRole: WorkforceRoleKey; conversationId: string; userMessageId: string | null; intent: WorkforceChatAppointmentChangeIntent },
): Promise<SendResult> {
  const reply = async (content: string, evidence?: ServerEvidenceMarker) => {
    const assistantMessageId = await persistChatAssistantMessage({
      orgId: ctx.org.orgId,
      userId: ctx.user.id,
      agentId: input.agentId,
      conversationId: input.conversationId,
      content,
      evidence,
    });
    return { conversationId: input.conversationId, userMessageId: input.userMessageId, assistantMessageId, runId: null, jobId: null };
  };

  if (!(await chatActionAllowed(ctx, input.agentId, "chat:appointment_change"))) return reply("This employee's role can't prepare appointment changes. No appointment was changed.");
  if (input.intent.kind === "none") return reply("I couldn't identify one exact appointment change request. No appointment was changed.");
  if (input.intent.kind === "clarification") return reply(input.intent.message);
  if (!appointmentChangePermissionsAllowed(ctx)) {
    return reply("To prepare an appointment change request, your workspace role needs permission to view contacts and appointments and request bookings. An owner or admin must approve any change. No appointment was changed.");
  }

  if (input.intent.kind === "proposal") {
    const intent = input.intent;
    const switchedOff = await chatAbilityRefusal(ctx, { agentId: input.agentId, agentRole: input.agentRole, actionId: "chat:appointment_change", need: chatActionNeed("chat:appointment_change") });
    if (switchedOff) return reply(switchedOff);
    const matches = await withUser(ctx.user.id, async (db) => {
      const { rows } = await db.query<{
        id: string; contact_id: string; contact_name: string; status: "new" | "confirmed"; start_at: Date; end_at: Date; timezone: string;
        provider: "ghl" | "native"; version: number; last_event_at: Date | null; ghl_calendar_id: string | null; appointment_type_id: string | null;
      }>(
        `select a.id, a.contact_id,
                coalesce(nullif(c.display_name, ''), nullif(concat_ws(' ', c.first_name, c.last_name), ''), a.contact_label) as contact_name,
                a.status, a.start_at, a.end_at, coalesce(a.timezone, c.timezone, $4) as timezone,
                a.provider, a.version, a.last_event_at, a.ghl_calendar_id, a.appointment_type_id
           from appointment_refs a
           join contacts c on c.id = a.contact_id and c.org_id = a.org_id
          where a.org_id = $1 and a.start_at = $2 and a.status in ('new', 'confirmed') and a.start_at > now()
            and c.deleted_at is null and c.archived_at is null
            and lower(btrim(coalesce(nullif(c.display_name, ''), nullif(concat_ws(' ', c.first_name, c.last_name), '')))) = lower(btrim($3))
          order by a.id limit 2`,
        [ctx.org.orgId, intent.appointmentAt, intent.contactName, ctx.org.timezone],
      );
      return rows;
    });
    if (matches.length === 0) return reply(`I couldn't find one upcoming appointment for “${chatSafeText(intent.contactName)}” at ${chatSafeText(intent.appointmentAt)}. Check the exact CRM contact name and appointment start time. No appointment was changed.`);
    if (matches.length > 1) return reply(`More than one appointment matches “${chatSafeText(intent.contactName)}” at that time. Open Appointments and use the exact appointment there so I don't change the wrong one.`);
    const appointment = matches[0];
    if (appointment.status !== "new" && appointment.status !== "confirmed") return reply("Only a new or confirmed upcoming appointment can be changed. No appointment was changed.");
    const timeZone = appointment.timezone || ctx.org.timezone;
    try { new Intl.DateTimeFormat("en-US", { timeZone }).format(appointment.start_at); }
    catch { return reply("The appointment timezone is invalid. Correct it in Appointments before preparing a change request. No appointment was changed."); }

    let calendarId: string | null = null;
    if (appointment.provider === "native") calendarId = appointment.appointment_type_id;
    else if (appointment.provider === "ghl") calendarId = appointment.ghl_calendar_id;
    if (!calendarId) return reply("The appointment's connected calendar could not be verified. No change request was prepared.");

    if (intent.operation === "reschedule") {
      const newStartAt = intent.newStartAt as string;
      if (new Date(newStartAt).getTime() === new Date(appointment.start_at).getTime()) return reply("That is already the appointment's current time. Give a different available start time; no change request was created.");
      const durationMs = new Date(appointment.end_at).getTime() - new Date(appointment.start_at).getTime();
      let availability;
      try {
        availability = await getAvailability(ctx.org.orgId, {
          calendarId,
          from: new Date(Date.parse(newStartAt) - 60_000),
          to: new Date(Date.parse(newStartAt) + 60_000),
          timeZone,
          limit: 200,
        });
      } catch {
        return reply("I couldn't verify the replacement time against the connected calendar, so no change request was prepared.");
      }
      if (!availability.ok) return reply(`I couldn't prepare a reschedule request: ${chatSafeText(availability.detail.slice(0, 400))} No appointment was changed.`);
      if (durationMs !== availability.slotMinutes * 60_000) return reply("This appointment's duration doesn't match the calendar's available slot length. Review it in the calendar before changing it.");
      if (!availability.slots.some((slot) => new Date(slot.start).getTime() === Date.parse(newStartAt))) {
        return reply(`The calendar doesn't currently offer ${formatSlot(newStartAt, timeZone)}. The replacement time isn't held and no change request was created.`);
      }
    }

    const proposal: PendingChatAppointmentChange = {
      version: 1,
      proposalId: crypto.randomUUID(),
      status: "pending",
      requestedBy: ctx.user.id,
      agentInstanceId: input.agentId,
      operation: intent.operation,
      appointmentId: appointment.id,
      contactId: appointment.contact_id,
      contactName: appointment.contact_name,
      provider: appointment.provider,
      timeZone,
      expected: appointmentChangeExpected(appointment),
      newStartAt: intent.newStartAt,
      expiresAt: new Date(Date.now() + APPOINTMENT_CHANGE_PREVIEW_TTL_MS).toISOString(),
    };
    const stored = await withSystem(async (db) => {
      const { rows } = await db.query<{ pending_workforce_appointment_change: unknown }>(
        `select pending_workforce_appointment_change from chat_conversations
          where id = $1 and org_id = $2 and agent_instance_id = $3 and (growth_partner_id is not null or user_id = $4) and deleted_at is null for update`,
        [input.conversationId, ctx.org.orgId, input.agentId, ctx.user.id],
      );
      if (!rows[0]) throw new AppError("not_found", "Conversation not found.");
      const existing = parsePendingChatAppointmentChange(rows[0].pending_workforce_appointment_change);
      if (existing?.status === "processing") return false;
      await db.query("update chat_conversations set pending_workforce_appointment_change = $3::jsonb where id = $1 and org_id = $2", [
        input.conversationId, ctx.org.orgId, JSON.stringify(proposal),
      ]);
      await recordAudit({
        orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", agentInstanceId: input.agentId,
        action: "workforce.chat_appointment_change_previewed", targetType: "appointment", targetId: appointment.id, result: "success",
        metadata: { operation: proposal.operation, startAt: proposal.expected.startAt, newStartAt: proposal.newStartAt, timeZone },
      }, db);
      return true;
    });
    if (!stored) return reply("An appointment change request is already being submitted in this conversation. Check Approvals before trying again.");
    return reply(appointmentChangeReplyText(proposal), appointmentChangeEvidence(proposal));
  }

  const initial = await withSystem(async (db) => {
    const { rows } = await db.query<{ pending_workforce_appointment_change: unknown }>(
      `select pending_workforce_appointment_change from chat_conversations
        where id = $1 and org_id = $2 and agent_instance_id = $3 and (growth_partner_id is not null or user_id = $4) and deleted_at is null`,
      [input.conversationId, ctx.org.orgId, input.agentId, ctx.user.id],
    );
    return rows[0]?.pending_workforce_appointment_change ?? null;
  });
  const pending = parsePendingChatAppointmentChange(initial);
  if (initial !== null && !pending) {
    await withSystem((db) => db.query("update chat_conversations set pending_workforce_appointment_change = null where id = $1 and org_id = $2", [input.conversationId, ctx.org.orgId]));
    return reply("I couldn't verify the saved appointment change preview, so I discarded it. No appointment was changed. Prepare a fresh request.");
  }
  if (!pending) return reply(input.intent.kind === "confirm" ? "There is no appointment change preview to confirm. No appointment was changed." : "There is no appointment change preview to discard. No appointment was changed.");
  if (pending.requestedBy !== ctx.user.id || pending.agentInstanceId !== input.agentId || (input.agentRole !== "appointment_setter" && input.agentRole !== "growth_partner")) {
    return reply("I couldn't match this preview to the current employee and requester. No appointment was changed; prepare a fresh request.");
  }
  if (input.intent.kind === "discard") {
    if (pending.status === "accepted") return reply("This request was already submitted for review. Use Approvals to review it; no appointment has changed yet.");
    if (pending.status === "processing") return reply("The request is already being submitted. Check Approvals before taking another action.");
    if (pending.status === "pending") {
      pending.status = "cancelled";
      await withSystem((db) => db.query("update chat_conversations set pending_workforce_appointment_change = $3::jsonb where id = $1 and org_id = $2", [
        input.conversationId, ctx.org.orgId, JSON.stringify(pending),
      ]));
    }
    return reply(pending.status === "expired" ? "This appointment change preview expired. No appointment was changed." : "Appointment change preview discarded. No appointment was changed.");
  }
  if (pending.status === "accepted" && pending.approvalId) return reply(appointmentChangeReplyText(pending), appointmentChangeEvidence(pending));
  if (pending.status === "cancelled") return reply("This appointment change preview was discarded. No appointment was changed.");
  if (pending.status === "expired" || Date.parse(pending.expiresAt) <= Date.now()) {
    pending.status = "expired";
    await withSystem((db) => db.query("update chat_conversations set pending_workforce_appointment_change = $3::jsonb where id = $1 and org_id = $2", [
      input.conversationId, ctx.org.orgId, JSON.stringify(pending),
    ]));
    return reply("This appointment change preview expired. Prepare a fresh request; no appointment was changed.");
  }
  if (pending.status === "processing") return reply("This appointment change request is already being submitted. Check Approvals before retrying.");

  // A switch-off after the preview blocks the confirmation: no approval request is created.
  const switchedOffNow = await chatAbilityRefusal(ctx, { agentId: input.agentId, agentRole: input.agentRole, actionId: "chat:appointment_change", need: chatActionNeed("chat:appointment_change") });
  if (switchedOffNow) return reply(switchedOffNow);

  if (pending.operation === "reschedule") {
    const row = await withUser(ctx.user.id, async (db) => {
      const { rows } = await db.query<{ id: string; status: string; start_at: Date; end_at: Date; provider: string; version: number; last_event_at: Date | null; timezone: string; appointment_type_id: string | null; ghl_calendar_id: string | null }>(
        `select id, status, start_at, end_at, provider, version, last_event_at, timezone, appointment_type_id, ghl_calendar_id
           from appointment_refs where id = $1 and org_id = $2`,
        [pending.appointmentId, ctx.org.orgId],
      );
      return rows[0] ?? null;
    });
    if (!row || row.version !== pending.expected.version || new Date(row.start_at).toISOString() !== pending.expected.startAt || new Date(row.end_at).toISOString() !== pending.expected.endAt || row.status !== pending.expected.status || row.provider !== pending.expected.provider || (row.last_event_at ? new Date(row.last_event_at).toISOString() : null) !== pending.expected.lastEventAt) {
      pending.status = "expired";
      await withSystem((db) => db.query("update chat_conversations set pending_workforce_appointment_change = $3::jsonb where id = $1 and org_id = $2", [input.conversationId, ctx.org.orgId, JSON.stringify(pending)]));
      return reply("This appointment changed after the preview. Prepare a fresh request; no appointment was changed.");
    }
    const calendarId = row.provider === "native" ? row.appointment_type_id : row.ghl_calendar_id;
    const replacementStartAt = pending.newStartAt;
    if (!calendarId || !replacementStartAt) return reply("The appointment calendar could not be verified. No change request was submitted.");
    let availability;
    try {
      availability = await getAvailability(ctx.org.orgId, {
        calendarId,
        from: new Date(Date.parse(replacementStartAt) - 60_000),
        to: new Date(Date.parse(replacementStartAt) + 60_000),
        timeZone: pending.timeZone,
        limit: 200,
      });
    } catch {
      return reply("I couldn't recheck the replacement time. No change request was submitted; check the calendar and prepare a fresh request.");
    }
    const durationMs = new Date(row.end_at).getTime() - new Date(row.start_at).getTime();
    if (!availability.ok || durationMs !== availability.slotMinutes * 60_000 || !availability.slots.some((slot) => new Date(slot.start).getTime() === Date.parse(replacementStartAt))) {
      pending.status = "expired";
      await withSystem((db) => db.query("update chat_conversations set pending_workforce_appointment_change = $3::jsonb where id = $1 and org_id = $2", [input.conversationId, ctx.org.orgId, JSON.stringify(pending)]));
      return reply("The replacement time is no longer available under the calendar's current rules. Prepare a fresh request; no appointment was changed.");
    }
  }

  const request = await withSystem(async (db) => {
    const { rows } = await db.query<{ pending_workforce_appointment_change: unknown }>(
      `select pending_workforce_appointment_change from chat_conversations
        where id = $1 and org_id = $2 and agent_instance_id = $3 and (growth_partner_id is not null or user_id = $4) and deleted_at is null for update`,
      [input.conversationId, ctx.org.orgId, input.agentId, ctx.user.id],
    );
    const current = parsePendingChatAppointmentChange(rows[0]?.pending_workforce_appointment_change);
    if (!current || current.proposalId !== pending.proposalId || current.status !== "pending") return { status: "changed" as const };
    const { rows: appointmentRows } = await db.query<{ contact_id: string | null; status: string; start_at: Date; end_at: Date; provider: string; version: number; last_event_at: Date | null }>(
      `select contact_id, status, start_at, end_at, provider, version, last_event_at from appointment_refs where id = $1 and org_id = $2 for update`,
      [current.appointmentId, ctx.org.orgId],
    );
    const live = appointmentRows[0];
    if (!live || live.contact_id !== current.expected.contactId || live.status !== current.expected.status || live.provider !== current.expected.provider || live.version !== current.expected.version
      || new Date(live.start_at).toISOString() !== current.expected.startAt || new Date(live.end_at).toISOString() !== current.expected.endAt
      || (live.last_event_at ? new Date(live.last_event_at).toISOString() : null) !== current.expected.lastEventAt
      || new Date(live.start_at).getTime() <= Date.now()) {
      current.status = "expired";
      await db.query("update chat_conversations set pending_workforce_appointment_change = $3::jsonb where id = $1 and org_id = $2", [input.conversationId, ctx.org.orgId, JSON.stringify(current)]);
      return { status: "stale" as const };
    }
    const title = current.operation === "cancel"
      ? `Cancel ${current.contactName}'s appointment for ${formatSlot(current.expected.startAt, current.timeZone)}`
      : `Reschedule ${current.contactName}'s appointment to ${formatSlot(current.newStartAt as string, current.timeZone)}`;
    // What the appointment type lets customers do themselves, so the approver sees the policy the request is being made against.
    const policy = await customerChangePolicyNote(db, ctx.org.orgId, current.appointmentId);
    const reason = `A team member explicitly confirmed this appointment change proposal in AI Employee Chat. The appointment is not changed until an owner or admin approves it. ${policy}`;
    const expectedEffect = current.operation === "cancel"
      ? `Cancel the appointment scheduled for ${formatSlot(current.expected.startAt, current.timeZone)} on its connected calendar. No customer message will be sent by iAcquire.`
      : `Move the appointment from ${formatSlot(current.expected.startAt, current.timeZone)} to ${formatSlot(current.newStartAt as string, current.timeZone)} on its connected calendar. The replacement time is checked again when approved. No customer message will be sent by iAcquire.`;
    const idempotencyKey = `appointment-change:${current.proposalId}`;
    let approvalId = await createApproval(db, {
      orgId: ctx.org.orgId,
      agentId: input.agentId,
      requestedBy: ctx.user.id,
      kind: "appointment_change",
      title,
      action: {
        version: 1,
        proposalId: current.proposalId,
        appointmentId: current.appointmentId,
        operation: current.operation,
        expected: current.expected,
        newStartAt: current.newStartAt,
      },
      targetType: "appointment",
      targetId: current.appointmentId,
      targetLabel: current.contactName,
      reason,
      expectedEffect,
      risk: "medium",
      expiresInHours: 48,
      idempotencyKey,
      actorKind: "user",
    });
    if (!approvalId) {
      const prior = await db.query<{ id: string }>("select id from approval_requests where org_id = $1 and idempotency_key = $2", [ctx.org.orgId, idempotencyKey]);
      approvalId = prior.rows[0]?.id ?? null;
    }
    if (!approvalId) return { status: "failed" as const };
    current.status = "accepted";
    current.approvalId = approvalId;
    current.acceptedAt = new Date().toISOString();
    await db.query("update chat_conversations set pending_workforce_appointment_change = $3::jsonb where id = $1 and org_id = $2", [input.conversationId, ctx.org.orgId, JSON.stringify(current)]);
    await notifyOrgRoles(db, ctx.org.orgId, ["owner", "admin"], {
      kind: "approval_requested", severity: "info", title,
      body: `${formatSlot(current.expected.startAt, current.timeZone)}${current.newStartAt ? ` → ${formatSlot(current.newStartAt, current.timeZone)}` : ""}`,
      link: "/approvals", dedupeKey: `appointment-change:${current.proposalId}`,
    });
    await recordAudit({
      orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", agentInstanceId: input.agentId,
      action: "workforce.chat_appointment_change_requested", targetType: "appointment", targetId: current.appointmentId,
      approvalId, result: "success", metadata: { operation: current.operation, from: current.expected.startAt, to: current.newStartAt },
    }, db);
    return { status: "created" as const, pending: current };
  });

  if (request.status === "changed") return reply("This appointment preview changed while I was confirming it. No change request was submitted; prepare a fresh preview.");
  if (request.status === "stale") return reply("This appointment changed before I could submit the approval request. No appointment was changed; prepare a fresh request.");
  if (request.status === "failed") return reply("I couldn't save the approval request. No appointment was changed; check Approvals before trying again.");
  return reply(appointmentChangeReplyText(request.pending), appointmentChangeEvidence(request.pending));
}

// ---------------------------------------------------------------------------
// Reads (row-level security restricts these to the signed-in user's own conversations)
// ---------------------------------------------------------------------------

/**
 * Retention cleanup used to run on every chat load: a trusted transaction plus two UPDATEs even
 * when the workspace has no retention setting. It is a housekeeping job, not part of reading the
 * conversation list, so remember when it last ran per workspace and keep it off the critical path
 * for the next ten minutes. A failure clears the timestamp so the next load retries.
 */
const RETENTION_CHECK_MS = 10 * 60 * 1000;
const retentionCheckedAt = new Map<string, number>();

async function applyRetentionIfDue(orgId: string): Promise<void> {
  const now = Date.now();
  if (now - (retentionCheckedAt.get(orgId) ?? 0) < RETENTION_CHECK_MS) return;
  retentionCheckedAt.set(orgId, now);
  try {
    await applyRetention(orgId);
  } catch (err) {
    retentionCheckedAt.delete(orgId);
    throw err;
  }
}

export async function listConversations(ctx: OrgContext, agentId: string, search?: string): Promise<ConversationSummary[]> {
  await applyRetentionIfDue(ctx.org.orgId);
  return withUser(ctx.user.id, async (db) => {
    const q = search?.trim().slice(0, 100);
    const { rows } = await db.query<ConversationSummary>(
      `select c.id, c.title, c.last_message_at, c.created_at from chat_conversations c
       where c.org_id = $1 and c.agent_instance_id = $2 and c.growth_partner_id is null and c.deleted_at is null
         and ($3::text is null or c.title ilike '%' || $3 || '%'
              or exists (select 1 from chat_messages m where m.conversation_id = c.id and m.content ilike '%' || $3 || '%'))
       order by coalesce(c.last_message_at, c.created_at) desc limit 100`,
      [ctx.org.orgId, agentId, q || null],
    );
    return rows;
  });
}

export async function getConversation(ctx: OrgContext, conversationId: string, before?: string) {
  return withUser(ctx.user.id, async (db) => {
    const { rows: conv } = await db.query<{ id: string; title: string; agent_instance_id: string }>(
      "select id, title, agent_instance_id from chat_conversations where id = $1 and org_id = $2 and growth_partner_id is null and deleted_at is null",
      [conversationId, ctx.org.orgId],
    );
    if (!conv[0]) return null;
    const { rows } = await db.query<Omit<ChatMessageRow, "evidence"> & { evidence: unknown }>(
      `select * from (
         select id, role, author_user_id, content, status, run_id, work_job_id, error_code, evidence, created_at from chat_messages
         where conversation_id = $1 and status <> 'superseded' and ($2::timestamptz is null or created_at < $2::timestamptz)
         order by created_at desc limit 60
       ) t order by created_at asc`,
      [conversationId, before ?? null],
    );
    // A marker is read strictly: a row from before the marker existed, or one that does not parse, has none and shows no chip.
    const messages: ChatMessageRow[] = rows.map((row) => ({ ...row, evidence: parseEvidenceMarker(row.evidence) }));
    return { conversation: conv[0], messages, hasMore: rows.length === 60 };
  });
}

export async function renameConversation(ctx: OrgContext, conversationId: string, title: string) {
  const clean = title.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!clean) throw new AppError("invalid_input", "Give the conversation a name.");
  const res = await withUser(ctx.user.id, (db) =>
    db.query("update chat_conversations set title = $2 where id = $1 and growth_partner_id is null and deleted_at is null", [conversationId, clean]),
  );
  if (!res.rowCount) throw new AppError("not_found", "Conversation not found.");
}

export async function deleteConversation(ctx: OrgContext, conversationId: string) {
  const res = await withUser(ctx.user.id, (db) =>
    db.query("update chat_conversations set deleted_at = now() where id = $1 and growth_partner_id is null and deleted_at is null", [conversationId]),
  );
  if (!res.rowCount) throw new AppError("not_found", "Conversation not found.");
  // Message bodies are removed now; the conversation shell is kept only for referential integrity.
  await withSystem(async (db) => {
    await db.query("update chat_messages set content = '' where conversation_id = $1", [conversationId]);
    await recordAudit(
      { orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "chat.conversation_deleted", targetType: "chat_conversation", targetId: conversationId, result: "success" },
      db,
    );
  });
}

/** Applies the workspace's conversation retention setting. */
export async function applyRetention(orgId: string) {
  await withSystem(async (db) => {
    const { rows } = await db.query<{ days: string | null }>(
      "select ai_preferences->>'chatRetentionDays' as days from company_profiles where org_id = $1",
      [orgId],
    );
    const days = Number(rows[0]?.days);
    if (!Number.isFinite(days) || days <= 0) return;
    await db.query(
      `update chat_messages set content = '' where org_id = $1 and content <> '' and conversation_id in (
         select id from chat_conversations where org_id = $1 and growth_partner_id is null
           and coalesce(last_message_at, created_at) < now() - make_interval(days => $2))`,
      [orgId, days],
    );
    await db.query(
      `update chat_conversations set deleted_at = now() where org_id = $1 and growth_partner_id is null and deleted_at is null
         and coalesce(last_message_at, created_at) < now() - make_interval(days => $2)`,
      [orgId, days],
    );
  });
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendInput {
  agentRole: WorkforceRoleKey;
  conversationId?: string | null;
  content?: string;
  clientMessageId?: string;
  regenerateMessageId?: string;
  inferenceOnly?: boolean;
}

export interface SendResult {
  conversationId: string;
  userMessageId: string | null;
  assistantMessageId: string;
  /** Null when the employee accepted a research assignment as a durable job instead of a chat run. */
  runId: string | null;
  jobId?: string | null;
}

async function ensureAgentReady(ctx: OrgContext, role: WorkforceRoleKey) {
  if (role === "growth_partner" && ctx.org.kind !== "client") {
    throw new AppError("forbidden", "The AI Growth Partner is available in client workspaces.");
  }
  const agent = await withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{
      id: string; org_id: string; display_name: string; status: AgentStatus; enabled: boolean; active_config_version_id: string | null;
      last_health_check_at: Date | null; last_health_ok: boolean | null; tool_inventory_contract: string | null;
      tool_inventory_digest: string | null; tool_inventory_verified_at: Date | null; tool_inventory_expires_at: Date | null;
      tool_inventory_tool_count: number | null;
    }>(
      `select id,org_id,display_name,status,enabled,active_config_version_id,last_health_check_at,last_health_ok,
              tool_inventory_contract,tool_inventory_digest,tool_inventory_verified_at,tool_inventory_expires_at,tool_inventory_tool_count
         from agent_instances where org_id=$1 and role_key=$2`,
      [ctx.org.orgId, role],
    );
    return rows[0];
  });
  if (!agent || agent.org_id !== ctx.org.orgId) throw new AppError("not_found", "AI employee not found.");
  const roleName = workforceRoleShortName(role);
  if (!agent.enabled) throw new AppError("agent_unavailable", `${roleName} isn't enabled for your workspace.`);
  try {
    // Check non-refreshable run authorization first. A stale internal acknowledgement or identity
    // must not trigger a provider diagnostic as a side effect of an ineligible chat request.
    await assertAgentRunPreflight(agent.id, ctx.org.orgId, { allowMissingInventory: true });
  } catch (err) {
    if (err instanceof AgentRunNotReadyError) throw new AppError("agent_unavailable", err.message);
    throw err;
  }
  let status = agent.status;
  const healthStale = !agent.last_health_check_at || Date.now() - new Date(agent.last_health_check_at).getTime() > HEALTH_MAX_AGE_MS;
  const inventoryStale = !toolInventoryReady(agent);
  if (canChat(status) && (healthStale || inventoryStale)) {
    // Refresh the short-lived saved attestation before this request persists a message or run.
    // runHealthCheck compares against the saved digest and fails closed if runtime tools changed.
    const check = await runHealthCheck(agent.id, { userId: ctx.user.id, kind: "system" }, { skipSetupSync: true });
    status = check.status;
    if (!check.ok) throw new AppError("agent_unavailable", check.detail);
  }
  if (!canChat(status)) {
    const msg =
      status === "setup_required" || status === "provisioning"
        ? `${roleName} is still being set up by the iAcquire team. You'll be notified when it's ready.`
        : `${roleName} is offline right now. Please try again shortly.`;
    throw new AppError("agent_unavailable", msg);
  }
  try {
    await assertAgentRunPreflight(agent.id, ctx.org.orgId, { requireFreshInventory: true });
  } catch (err) {
    if (err instanceof AgentRunNotReadyError) throw new AppError("agent_unavailable", err.message);
    throw err;
  }
  return agent;
}

interface PreparedChatTurn {
  conversationId: string;
  userMessageId: string | null;
  userContent: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  sessionId: string;
}

async function createInferenceOnlyChatRun(
  ctx: OrgContext,
  agent: NonNullable<Awaited<ReturnType<typeof ensureAgentReady>>>,
  role: WorkforceRoleKey,
  prepared: PreparedChatTurn,
) {
  return withSystem(async (db) => {
    const runInstructions = await buildRunInstructions(db, ctx.org.orgId, agent.id);
    // The verification turn uses only the applied employee configuration and approved agency
    // knowledge. It deliberately omits dynamic Operations Manager task context and chat history.
    const conn = await loadConnection(db, agent.id);
    if (!conn || conn.orgKind !== "agency" || conn.roleKey !== role) {
      throw new AppError("agent_unavailable", "This internal employee connection could not be verified.");
    }
    const { rows: msg } = await db.query<{ id: string }>(
      "insert into chat_messages (conversation_id, org_id, role, content, status, evidence) values ($1, $2, 'assistant', '', 'streaming', $3::jsonb) returning id",
      // The restricted check hands the model no workspace records, so nothing was read for this reply.
      [prepared.conversationId, ctx.org.orgId, JSON.stringify(classifyModelTurn([], new Date().toISOString()))],
    );
    const idempotencyKey = `chat:${msg[0].id}`;
    const { rows: run } = await db.query<{ id: string }>(
      `insert into agent_runs (org_id, agent_instance_id, conversation_id, assistant_message_id, user_id, purpose,
         idempotency_key, status, config_version_id)
       values ($1, $2, $3, $4, $5, 'chat', $6, 'queued', $7) returning id`,
      [ctx.org.orgId, agent.id, prepared.conversationId, msg[0].id, ctx.user.id, idempotencyKey, runInstructions.versionId],
    );
    await db.query("update chat_messages set run_id = $2 where id = $1", [msg[0].id, run[0].id]);
    await db.query("update chat_conversations set last_message_at = now() where id = $1", [prepared.conversationId]);
    await recordUsage(db, { orgId: ctx.org.orgId, userId: ctx.user.id, agentId: agent.id, kind: "agent_message" });
    return {
      assistantMessageId: msg[0].id,
      runId: run[0].id,
      instructions: runInstructions.instructions,
      conn,
      versionId: runInstructions.versionId,
      knowledgeEntryIds: runInstructions.knowledgeEntryIds,
      knowledgeDocumentIds: runInstructions.knowledgeDocumentIds,
      idempotencyKey,
    };
  });
}

/** Writes `workforce.employee_evidence_attached`: which run, reply and configuration version a workspace read was handed to. Never stops the chat, and holds no record content. */
async function recordEvidenceAttached(input: {
  orgId: string; userId: string; agentId: string; role: WorkforceRoleKey; runId: string; messageId: string; configVersionId: string | null;
  sections: ReadonlyArray<{ id: string; state: string }>;
}): Promise<void> {
  try {
    await recordAudit({
      orgId: input.orgId,
      actorUserId: input.userId,
      actorKind: "agent",
      agentInstanceId: input.agentId,
      action: "workforce.employee_evidence_attached",
      targetType: "agent_run",
      targetId: input.runId,
      result: "success",
      metadata: {
        role: input.role,
        messageId: input.messageId,
        configVersionId: input.configVersionId,
        sections: Object.fromEntries(input.sections.map((section) => [section.id, section.state])),
      },
    });
  } catch {
    // The read and the run already happened; a missing audit row must not stop the person's chat.
  }
}

/** What a person is told when asking again would have skipped a reviewed step. Fixed wording, no part of the question is echoed. */
const REGENERATE_REVIEWED_STEP_NOTICE = "That request is handled by a reviewed step. Send it again as a new message.";

/**
 * Whether the server, not the model, answers this question: the same list of guards a new message passes before any model is called. A reply to such a question was never a model
 * reply, and asking the model to answer it again would be a way around those guards.
 */
function isReviewedStepRequest(role: WorkforceRoleKey, content: string, displayName: string): boolean {
  return Boolean(
    isAutomationBuilderRequest(content)
      || workforceChatRefusal(role, content, displayName)
      || explicitlyAddressedWorkforceRole(role, content)
      || parseWorkforceChatCrmIntent(role, content).kind !== "none"
      || parseWorkforceChatCalendarCreateIntent(role, content).kind !== "none"
      || parseWorkforceChatAppointmentPolicyIntent(role, content).kind !== "none"
      || parseWorkforceChatBookingIntent(role, content).kind !== "none"
      || parseWorkforceChatAppointmentChangeIntent(role, content).kind !== "none"
      || parseWorkforceChatTargetingIntent(role, content).kind !== "none"
      || parseWorkforceChatPreferencesIntent(role, content).kind !== "none"
      || isScheduleConfirmation(content)
      || parseWorkforceChatScheduleIntent(role, content).kind !== "none"
      || parseNamedWorkforceHandoff(role, content)
      || ((role === "lead_hunter" || role === "growth_partner") && parseResearchAssignment(content))
      || parseWorkforceChatAssignment(role, content),
  );
}

export async function sendChatMessage(ctx: OrgContext, input: SendInput): Promise<SendResult> {
  if (!ctx.can("agents.use")) throw new AppError("forbidden", "Your role can't chat with AI employees.");
  if (ctx.org.kind === "client" && input.agentRole !== "growth_partner") {
    // Once a tenant has its provisioned Partner identity, compatibility calls from retained-role
    // controls must use that one runtime and its permanent conversation. Tenants that have not
    // completed Partner provisioning yet keep their current role path until onboarding migrates
    // them; a missing Partner conversation after provisioning still fails closed below.
    const { rows } = await withSystem((db) => db.query<{ id: string }>(
      `select p.id
         from ai_growth_partners p
         join agent_instances a on a.id = p.runtime_agent_instance_id and a.org_id = p.org_id
        where p.org_id = $1 and a.role_key = 'growth_partner'
        limit 1`,
      [ctx.org.orgId],
    ));
    if (rows[0]) input = { ...input, agentRole: "growth_partner" };
  }
  const inferenceOnly = input.inferenceOnly === true;
  if (input.agentRole === "growth_partner" && inferenceOnly) {
    throw new AppError("forbidden", "Restricted employee inference is available to internal Super Admins only.");
  }
  if (inferenceOnly) {
    const config = env();
    if (!config.HERMES_INFERENCE_WORKER_ENABLED) throw new AppError("forbidden", "Restricted employee inference is not enabled.");
    if (ctx.org.kind !== "agency" || ctx.user.platformRole !== "agency_super_admin") {
      throw new AppError("forbidden", "Restricted employee inference is available to internal Super Admins only.");
    }
    if (input.regenerateMessageId || (input.content ?? "").trim() !== HERMES_INFERENCE_ONLY_CHAT_CANARY) {
      throw new AppError("invalid_input", "Restricted Chat accepts only the fixed no-tool verification message.");
    }
    if (input.conversationId) {
      throw new AppError("invalid_input", "Start a new empty chat before running the restricted Chat check.");
    }
  }
  const limit = await consumeRateLimit(inferenceOnly ? RATE_LIMITS.agentInferenceOnlyByUser : RATE_LIMITS.agentMessageByUser, ctx.user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "You're sending messages quickly. Please wait a moment.", { retryAfterSeconds: limit.retryAfterSeconds });
  await assertWithinLimits(ctx.org.orgId, "agent_message");
  const agent = await ensureAgentReady(ctx, input.agentRole);
  try {
    // Recheck immediately before persisting the turn/run so stale state cannot be accepted based
    // only on the earlier health check or UI status.
    await assertAgentRunPreflight(agent.id, ctx.org.orgId, { requireFreshInventory: true });
  } catch (err) {
    if (err instanceof AgentRunNotReadyError) throw new AppError("agent_unavailable", err.message);
    throw err;
  }

  // Unified chat may use only the one verified tenant thread. It never falls through to the
  // legacy path that creates role-private conversations.
  const growthPartnerThread = input.agentRole === "growth_partner"
    ? await withUser(ctx.user.id, async (db) => (await db.query<{ partnerId: string; conversationId: string }>(
      `select p.id as "partnerId", c.id as "conversationId"
       from ai_growth_partners p
       join chat_conversations c on c.growth_partner_id = p.id and c.org_id = p.org_id
       join agent_instances a on a.id = p.runtime_agent_instance_id and a.org_id = p.org_id
       where p.org_id = $1 and p.runtime_agent_instance_id = $2 and c.agent_instance_id = $2
         and a.role_key = 'growth_partner' and c.deleted_at is null
       limit 1`,
      [ctx.org.orgId, agent.id],
    )).rows[0] ?? null)
    : null;
  if (input.agentRole === "growth_partner" && !growthPartnerThread) {
    throw new AppError("agent_unavailable", "The permanent AI Growth Partner conversation is not connected to a verified profile yet.");
  }
  if (growthPartnerThread && input.conversationId && input.conversationId !== growthPartnerThread.conversationId) {
    throw new AppError("not_found", "Conversation not found.");
  }

  // 1. Persist the user's turn under row-level security.
  const prepared = await withUser(ctx.user.id, async (db) => {
    let conversationId = input.conversationId ?? growthPartnerThread?.conversationId ?? null;
    let userContent: string;
    let userMessageId: string | null = null;
    let anchorTime: Date | null = null;

    if (input.regenerateMessageId) {
      // Only a reply a model wrote (it has a run) can be asked again. A refusal, a preview, a saved schedule or a job acknowledgement was written by the server and has no run:
      // asking the model to answer that question again would skip the reviewed step that handled it the first time.
      const { rows } = await db.query<{ conversation_id: string; created_at: Date }>(
        `select m.conversation_id, m.created_at from chat_messages m
         join chat_conversations c on c.id = m.conversation_id
         where m.id = $1 and m.role = 'assistant' and m.run_id is not null and m.status in ('complete', 'failed', 'cancelled')
           and m.org_id = $3 and c.agent_instance_id = $2 and c.growth_partner_id is not distinct from $4 and c.deleted_at is null`,
        [input.regenerateMessageId, agent.id, ctx.org.orgId, growthPartnerThread?.partnerId ?? null],
      );
      if (!rows[0]) throw new AppError("not_found", "That response can't be regenerated.");
      conversationId = rows[0].conversation_id;
      const { rows: prev } = await db.query<{ id: string; content: string; created_at: Date }>(
        `select id, content, created_at from chat_messages where conversation_id = $1 and role = 'user' and created_at <= $2
         order by created_at desc limit 1`,
        [conversationId, rows[0].created_at],
      );
      if (!prev[0]) throw new AppError("not_found", "There's no question to answer again.");
      userContent = prev[0].content;
      anchorTime = new Date(prev[0].created_at);
    } else {
      const content = (input.content ?? "").trim();
      if (!content) throw new AppError("invalid_input", "Type a message first.");
      if (content.length > MAX_MESSAGE) throw new AppError("invalid_input", `Messages can be up to ${MAX_MESSAGE.toLocaleString()} characters.`);
      userContent = content;
      if (conversationId) {
        const { rows } = await db.query<{ id: string }>(
          "select id from chat_conversations where id = $1 and agent_instance_id = $2 and org_id = $3 and growth_partner_id is not distinct from $4 and deleted_at is null",
          [conversationId, agent.id, ctx.org.orgId, growthPartnerThread?.partnerId ?? null],
        );
        if (!rows[0]) throw new AppError("not_found", "Conversation not found.");
      } else {
        if (input.agentRole === "growth_partner") {
          throw new AppError("agent_unavailable", "The permanent AI Growth Partner conversation is not connected to a verified profile yet.");
        }
        const title = content.replace(/\s+/g, " ").slice(0, 60) + (content.length > 60 ? "…" : "");
        const { rows } = await db.query<{ id: string }>(
          `insert into chat_conversations (org_id, agent_instance_id, user_id, title, hermes_session_id)
           values ($1, $2, $3, $4, $5) returning id`,
          [ctx.org.orgId, agent.id, ctx.user.id, title, `iaq-${crypto.randomUUID()}`],
        );
        conversationId = rows[0].id;
      }
      const clientMessageId = input.clientMessageId?.slice(0, 64) || crypto.randomUUID();
      const { rows: existing } = await db.query<{ id: string }>(
        "select id from chat_messages where conversation_id = $1 and client_message_id = $2",
        [conversationId, clientMessageId],
      );
      if (existing[0]) throw new AppError("conflict", "This message was already sent.");
      const { rows } = await db.query<{ id: string; created_at: Date }>(
        `insert into chat_messages (conversation_id, org_id, role, content, client_message_id, author_user_id)
         values ($1, $2, 'user', $3, $4, $5) returning id, created_at`,
        [conversationId, ctx.org.orgId, content, clientMessageId, ctx.user.id],
      );
      userMessageId = rows[0].id;
      anchorTime = new Date(rows[0].created_at);
    }

    const { rows: hist } = await db.query<{ role: "user" | "assistant"; content: string }>(
      `select role, content from (
         select role, content, created_at from chat_messages
         where conversation_id = $1 and status = 'complete' and role in ('user', 'assistant') and created_at < $2
         order by created_at desc limit $3
       ) t order by created_at asc`,
      [conversationId, anchorTime, HISTORY_TURNS],
    );
    const { rows: conv } = await db.query<{ hermes_session_id: string }>("select hermes_session_id from chat_conversations where id = $1", [conversationId]);
    return {
      conversationId: conversationId as string,
      userMessageId,
      userContent,
      // The commands stay in the visible transcript, but must not re-enter future model context.
      history: hist
        .filter((turn) => input.agentRole !== "growth_partner" || turn.role !== "user" || parseGrowthPartnerMemoryCommand(turn.content).kind === "none")
        .map((turn) => ({ role: turn.role, content: turn.content.slice(0, 4000) })),
      sessionId: conv[0].hermes_session_id,
    };
  });

  if (inferenceOnly) {
    const setup = await createInferenceOnlyChatRun(ctx, agent, input.agentRole, prepared);
    const abort = new AbortController();
    openChannel(setup.runId, ctx.user.id, abort);
    publish(setup.runId, {
      type: "ready",
      conversationId: prepared.conversationId,
      userMessageId: prepared.userMessageId,
      assistantMessageId: setup.assistantMessageId,
      runId: setup.runId,
      evidence: classifyModelTurn([], new Date().toISOString()),
    });
    void executeRun({
      runId: setup.runId,
      orgId: ctx.org.orgId,
      agentId: agent.id,
      configVersionId: setup.versionId,
      agentRole: input.agentRole,
      userId: ctx.user.id,
      assistantMessageId: setup.assistantMessageId,
      conversationId: prepared.conversationId,
      conn: setup.conn,
      abort,
      inferenceOnly: true,
      knowledgeEntryIds: setup.knowledgeEntryIds,
      knowledgeDocumentIds: setup.knowledgeDocumentIds,
      request: {
        input: HERMES_INFERENCE_ONLY_CHAT_CANARY,
        instructions: setup.instructions,
        sessionId: prepared.sessionId,
        conversationHistory: [],
        idempotencyKey: setup.idempotencyKey,
        memoryScope: `iaq:${ctx.org.orgId}:${input.agentRole}`,
      },
    });
    return {
      conversationId: prepared.conversationId,
      userMessageId: prepared.userMessageId,
      assistantMessageId: setup.assistantMessageId,
      runId: setup.runId,
    };
  }

  // Asking again re-runs the same deterministic guards a new message goes through. If one of them now owns this question (a refusal, a preview, a schedule, a job), the model is not
  // asked and the earlier reply is left as it was: the person sends the question as a new message so the reviewed step can handle it.
  if (input.regenerateMessageId && isReviewedStepRequest(input.agentRole, prepared.userContent, agent.display_name)) {
    const assistantMessageId = await persistChatAssistantMessage({
      orgId: ctx.org.orgId,
      userId: ctx.user.id,
      agentId: agent.id,
      conversationId: prepared.conversationId,
      content: REGENERATE_REVIEWED_STEP_NOTICE,
      evidence: systemNoticeMarker(),
    });
    return { conversationId: prepared.conversationId, userMessageId: null, assistantMessageId, runId: null, jobId: null };
  }

  if (input.agentRole === "growth_partner" && !input.regenerateMessageId) {
    const memoryCommand = parseGrowthPartnerMemoryCommand(prepared.userContent);
    if (memoryCommand.kind !== "none") {
      let content: string;
      if (memoryCommand.kind === "clarify") {
        content = "To change saved Partner memory, use “Remember: [one note]” or “Forget: [the full saved note]”. Only a full saved note can be removed.";
      } else if (!ctx.can("agents.configure")) {
        content = "Your workspace role can use the AI Growth Partner but can't change its shared memory. No memory was saved or removed; ask an owner or admin.";
      } else {
        try {
          if (memoryCommand.kind === "remember") {
            const saved = await rememberGrowthPartnerMemoryFromChat(ctx, memoryCommand.content, prepared.userMessageId!);
            content = saved.duplicate
              ? "That note is already in the AI Growth Partner's workspace memory. You can review, correct or remove it in Partner Controls. This app-owned memory is separate from Hermes runtime memory."
              : "Saved that note to the AI Growth Partner's workspace memory. You can review, correct or remove it in Partner Controls. This app-owned memory is separate from Hermes runtime memory.";
          } else {
            const removed = await forgetGrowthPartnerMemoryFromChat(ctx, memoryCommand.content);
            content = removed.deleted
              ? "Removed the matching note from AI Growth Partner workspace memory. Its original message remains in the permanent conversation. Hermes runtime memory is separate."
              : "No full saved note matched, so nothing was removed. Use “Forget:” followed by the complete saved note.";
          }
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          content = "I didn't change saved memory. " + error.message;
        }
      }
      const assistantMessageId = await persistChatAssistantMessage({
        orgId: ctx.org.orgId,
        userId: ctx.user.id,
        agentId: agent.id,
        conversationId: prepared.conversationId,
        content,
        evidence: systemNoticeMarker(),
      });
      return { conversationId: prepared.conversationId, userMessageId: prepared.userMessageId, assistantMessageId, runId: null, jobId: null };
    }
  }

  // Guard clear external, out-of-role and unsupported write requests in application code. Do not
  // depend on an unenforced Hermes approval preference or let a generic run claim an action.
  if (!input.regenerateMessageId && isAutomationBuilderRequest(prepared.userContent)
    && parseWorkforceChatCalendarCreateIntent(input.agentRole, prepared.userContent).kind === "none") {
    let content: string;
    if (!ctx.can("workflows.view")) {
      content = "Building automations belongs in Automation Studio, but your workspace role can't open it. Ask an owner or admin for workflow access. No workflow was created and no email was sent.";
    } else if (ctx.org.kind !== "client") {
      content = "Native workflow building is handled in Automation Studio for client workspaces. This internal workspace doesn't have that builder. I haven't created or activated a workflow, and no email was sent.";
    } else if (!ctx.can("workflows.manage")) {
      content = "You can view Automation Studio, but your workspace role can't create or change workflows. Ask an owner or admin to prepare this automation. [Open Automation Studio](/automation-studio) to view workflows available to you. No workflow was created or activated, and no email was sent.";
    } else {
      content = "Building automations belongs in the AI Automation Builder in Automation Studio. I won't create or activate a workflow from this employee chat. [Open Automation Studio](/automation-studio) to review access, build a draft and test it, then follow the normal approval process before activation. This doesn't block supported AI Employee work or schedule settings. No workflow was created or activated, and no email was sent.";
    }
    const assistantMessageId = await persistChatAssistantMessage({
      orgId: ctx.org.orgId,
      userId: ctx.user.id,
      agentId: agent.id,
      conversationId: prepared.conversationId,
      content,
    });
    return { conversationId: prepared.conversationId, userMessageId: prepared.userMessageId, assistantMessageId, runId: null, jobId: null };
  }

  const refusal = !input.regenerateMessageId && input.content
    ? workforceChatRefusal(input.agentRole, input.content, agent.display_name)
    : null;
  const namedOtherRole = (ctx.org.kind !== "client" || input.agentRole !== "growth_partner") && !input.regenerateMessageId
    ? explicitlyAddressedWorkforceRole(input.agentRole, prepared.userContent)
    : null;
  const calendarCreateIntent = !input.regenerateMessageId && !namedOtherRole
    ? parseWorkforceChatCalendarCreateIntent(input.agentRole, prepared.userContent)
    : { kind: "none" as const };
  if (calendarCreateIntent.kind !== "none") {
    return handleChatCalendarCreateIntent(ctx, {
      agentId: agent.id,
      conversationId: prepared.conversationId,
      userMessageId: prepared.userMessageId,
      intent: calendarCreateIntent,
    });
  }
  const crmIntent = !input.regenerateMessageId && !namedOtherRole
    ? parseWorkforceChatCrmIntent(input.agentRole, prepared.userContent)
    : { kind: "none" as const };
  if (crmIntent.kind !== "none") {
    return handleChatCrmIntent(ctx, {
      agentId: agent.id,
      conversationId: prepared.conversationId,
      userMessageId: prepared.userMessageId,
      intent: crmIntent,
    });
  }
  const appointmentPolicyIntent = !input.regenerateMessageId && !namedOtherRole
    ? parseWorkforceChatAppointmentPolicyIntent(input.agentRole, prepared.userContent)
    : { kind: "none" as const };
  if (appointmentPolicyIntent.kind !== "none") {
    return handleChatAppointmentPolicyIntent(ctx, {
      agentId: agent.id,
      conversationId: prepared.conversationId,
      userMessageId: prepared.userMessageId,
      intent: appointmentPolicyIntent,
    });
  }
  const bookingIntent = !input.regenerateMessageId && !namedOtherRole
    ? parseWorkforceChatBookingIntent(input.agentRole, prepared.userContent)
    : { kind: "none" as const };
  if (bookingIntent.kind !== "none") {
    return handleChatBookingIntent(ctx, {
      agentId: agent.id,
      agentRole: input.agentRole,
      conversationId: prepared.conversationId,
      userMessageId: prepared.userMessageId,
      intent: bookingIntent,
    });
  }
  const appointmentChangeIntent = !input.regenerateMessageId && !namedOtherRole
    ? parseWorkforceChatAppointmentChangeIntent(input.agentRole, prepared.userContent)
    : { kind: "none" as const };
  if (appointmentChangeIntent.kind !== "none") {
    return handleChatAppointmentChangeIntent(ctx, {
      agentId: agent.id,
      agentRole: input.agentRole,
      conversationId: prepared.conversationId,
      userMessageId: prepared.userMessageId,
      intent: appointmentChangeIntent,
    });
  }
  const targetingIntent = !input.regenerateMessageId && !namedOtherRole
    ? parseWorkforceChatTargetingIntent(input.agentRole, prepared.userContent)
    : { kind: "none" as const };
  if (targetingIntent.kind !== "none") {
    return handleChatTargetingIntent(ctx, {
      agentId: agent.id,
      conversationId: prepared.conversationId,
      userMessageId: prepared.userMessageId,
      intent: targetingIntent,
    });
  }
  const preferencesIntent = !input.regenerateMessageId && !namedOtherRole
    ? parseWorkforceChatPreferencesIntent(input.agentRole, prepared.userContent)
    : { kind: "none" as const };
  if (preferencesIntent.kind !== "none" && !refusal) {
    return handleChatPreferencesIntent(ctx, {
      agentId: agent.id,
      conversationId: prepared.conversationId,
      userMessageId: prepared.userMessageId,
      intent: preferencesIntent,
    });
  }
  const scheduleConfirmation = !input.regenerateMessageId && !namedOtherRole ? isScheduleConfirmation(prepared.userContent) : null;
  const scheduleIntent = !input.regenerateMessageId && !namedOtherRole
    ? parseWorkforceChatScheduleIntent(input.agentRole, prepared.userContent)
    : { kind: "none" as const };
  if (scheduleConfirmation) {
    return handleChatScheduleAction(ctx, {
      agentId: agent.id,
      agentRole: input.agentRole,
      conversationId: prepared.conversationId,
      userMessageId: prepared.userMessageId,
      action: { kind: scheduleConfirmation },
    });
  }
  if ((scheduleIntent.kind === "proposal" || scheduleIntent.kind === "update_existing") && (!refusal || refusal.reason === "appointment_write")) {
    return handleChatScheduleAction(ctx, {
      agentId: agent.id,
      agentRole: input.agentRole,
      conversationId: prepared.conversationId,
      userMessageId: prepared.userMessageId,
      action: scheduleIntent,
    });
  }
  if (scheduleIntent.kind === "clarification" && !refusal) {
    return handleChatScheduleAction(ctx, {
      agentId: agent.id,
      agentRole: input.agentRole,
      conversationId: prepared.conversationId,
      userMessageId: prepared.userMessageId,
      action: scheduleIntent,
    });
  }
  if (!refusal && scheduleIntent.kind === "none" && !input.regenerateMessageId && prepared.userMessageId) {
    const handoff = parseNamedWorkforceHandoff(input.agentRole, prepared.userContent);
    if (handoff) {
      const definition = capabilityDefinition(handoff.assignment.capability);
      if (!definition || !definition.allowedRoles.includes(handoff.targetRole)) {
        throw new AppError("forbidden", "That employee handoff is not available.");
      }
      if (![definition.requiredPermission, ...(definition.additionalPermissions ?? [])].every((permission) => ctx.can(permission))) {
        const assistantMessageId = await persistChatAssistantMessage({
          orgId: ctx.org.orgId,
          userId: ctx.user.id,
          agentId: agent.id,
          conversationId: prepared.conversationId,
          content: ctx.org.kind === "client"
            ? `Your workspace role does not have permission to start this ${definition.label.toLocaleLowerCase("en-US")} with the AI Growth Partner. No work job was created.`
            : `Your workspace role does not have permission to start this ${definition.label.toLocaleLowerCase("en-US")} with ${AGENT_BY_KEY[handoff.targetRole].shortName}. No handoff or work job was created.`,
        });
        return { conversationId: prepared.conversationId, userMessageId: prepared.userMessageId, assistantMessageId, runId: null, jobId: null };
      }

      if (ctx.org.kind === "client" && input.agentRole === "growth_partner") {
        if (!definition.allowedRoles.includes("growth_partner")) {
          throw new AppError("forbidden", "The AI Growth Partner cannot perform that capability.");
        }
        const routed = await dispatchCapabilityJob(ctx, {
          agentRole: "growth_partner",
          capability: handoff.assignment.capability,
          title: handoff.assignment.title,
          input: {
            ...handoff.assignment.input,
            capabilityRoute: {
              requestedRole: handoff.targetRole,
              requestedByMessageId: prepared.userMessageId,
            },
          },
          idempotencyKey: `chat-capability-route:${prepared.userMessageId}`,
          conversationId: prepared.conversationId,
          deferKick: true,
        });
        const assistantMessageId = await persistChatAssistantMessage({
          orgId: ctx.org.orgId,
          userId: ctx.user.id,
          agentId: routed.agentId,
          conversationId: prepared.conversationId,
          content: `I’ve queued ${definition.label.toLocaleLowerCase("en-US")} in our permanent conversation. [Track it on the AI Work Board](/work?job=${encodeURIComponent(routed.jobId)}). The usual permissions and approval steps still apply.`,
          workJobId: routed.jobId,
        });
        kickWorkJob(routed.jobId);
        return {
          conversationId: prepared.conversationId,
          userMessageId: prepared.userMessageId,
          assistantMessageId,
          runId: null,
          jobId: routed.jobId,
        };
      }

      let created: Awaited<ReturnType<typeof createWorkforceChatHandoff>> | null = null;
      let unavailableMessage: string | null = null;
      try {
        created = await createWorkforceChatHandoff(ctx, {
          sourceRole: input.agentRole,
          sourceAgentId: agent.id,
          sourceConversationId: prepared.conversationId,
          sourceMessageId: prepared.userMessageId,
          targetRole: handoff.targetRole,
          assignment: handoff.assignment,
        });
      } catch (error) {
        if (error instanceof AppError && ["agent_unavailable", "not_found"].includes(error.code)) {
          unavailableMessage = `${AGENT_BY_KEY[handoff.targetRole].shortName} is not available for authorized work right now. No handoff or work job was created.`;
        } else {
          throw error;
        }
      }
      if (!created) {
        const assistantMessageId = await persistChatAssistantMessage({
          orgId: ctx.org.orgId,
          userId: ctx.user.id,
          agentId: agent.id,
          conversationId: prepared.conversationId,
          content: unavailableMessage ?? "I couldn't create that handoff. No work job was created.",
        });
        return { conversationId: prepared.conversationId, userMessageId: prepared.userMessageId, assistantMessageId, runId: null, jobId: null };
      }

      const target = AGENT_BY_KEY[created.targetRole];
      const assistantMessageId = await persistChatAssistantMessage({
        orgId: ctx.org.orgId,
        userId: ctx.user.id,
        agentId: agent.id,
        conversationId: prepared.conversationId,
        content: `I've queued this supported work with ${target.shortName}. [Open ${target.shortName}'s chat](/chat/${target.slug}?c=${encodeURIComponent(created.targetConversationId)}) · [Track it on the AI Work Board](/work?job=${encodeURIComponent(created.jobId)}). ${target.shortName}'s own permissions and availability still apply.`,
        workJobId: created.jobId,
      });
      kickWorkJob(created.jobId);
      return {
        conversationId: prepared.conversationId,
        userMessageId: prepared.userMessageId,
        assistantMessageId,
        runId: null,
        jobId: created.jobId,
      };
    }
  }
  if (refusal) {
    const assistantMessageId = await persistChatAssistantMessage({
      orgId: ctx.org.orgId,
      userId: ctx.user.id,
      agentId: agent.id,
      conversationId: prepared.conversationId,
      content: refusal.message,
      refusal: { role: input.agentRole, reason: refusal.reason },
    });
    return { conversationId: prepared.conversationId, userMessageId: prepared.userMessageId, assistantMessageId, runId: null, jobId: null };
  }

  if (namedOtherRole && !input.regenerateMessageId) {
    const target = AGENT_BY_KEY[namedOtherRole];
    const assistantMessageId = await persistChatAssistantMessage({
      orgId: ctx.org.orgId,
      userId: ctx.user.id,
      agentId: agent.id,
      conversationId: prepared.conversationId,
      content: `That request needs to go through ${target.shortName}'s employee chat so that employee-specific permissions and any schedule preview or confirmation apply. No handoff, schedule, or work job was created. [Open ${target.shortName}'s chat](/chat/${target.slug}).`,
    });
    return { conversationId: prepared.conversationId, userMessageId: prepared.userMessageId, assistantMessageId, runId: null, jobId: null };
  }

  // 1b. A Growth Partner or legacy Lead Hunter research assignment becomes a durable job, not a generic chat answer.
  // The parser is deterministic and the job is created before any provider call. Missing details
  // produce a focused question; nothing is invented to make the request look complete.
  const research = (input.agentRole === "lead_hunter" || input.agentRole === "growth_partner") && !input.regenerateMessageId
    ? parseResearchAssignment(prepared.userContent)
    : null;
  if (research) {
    if (!ctx.can("leads.research")) {
      const assistantMessageId = await persistChatAssistantMessage({
        orgId: ctx.org.orgId,
        userId: ctx.user.id,
        agentId: agent.id,
        conversationId: prepared.conversationId,
        content: `Your workspace role does not have permission to start ${workforceRoleShortName(input.agentRole)} research. No research job was created.`,
      });
      return { conversationId: prepared.conversationId, userMessageId: prepared.userMessageId, assistantMessageId, runId: null, jobId: null };
    }
    if (research.missing.length) {
      const clarificationId = await persistChatAssistantMessage({
        orgId: ctx.org.orgId,
        userId: ctx.user.id,
        agentId: agent.id,
        conversationId: prepared.conversationId,
        content: researchClarification(research),
      });
      return { conversationId: prepared.conversationId, userMessageId: prepared.userMessageId, assistantMessageId: clarificationId, runId: null, jobId: null };
    }

    const created = await createResearchRequest(
      ctx,
      { prompt: research.prompt, campaignType: research.campaignType },
      { conversationId: prepared.conversationId, deferKick: true, agentRole: input.agentRole },
    );
    const content = created.jobId
        ? `I've started a research job for up to ${research.quantity} ${research.target} in ${research.location}. I'll record each verified stage here, including what I could and could not confirm. You can leave this page and come back; the job runs independently of this tab.`
        : `I couldn't start the research job yet because I'm not connected for authorized work. The request is saved and can be run once the connection is restored.`;
    const assistantMessageId = await persistChatAssistantMessage({
      orgId: ctx.org.orgId,
      userId: ctx.user.id,
      agentId: agent.id,
      conversationId: prepared.conversationId,
      content,
      workJobId: created.jobId,
    });
    if (created.jobId) kickWorkJob(created.jobId);
    return { conversationId: prepared.conversationId, userMessageId: prepared.userMessageId, assistantMessageId, runId: null, jobId: created.jobId };
  }

  // Clear, read-only role requests use the reviewed native job handlers instead of asking a
  // language model to claim that it inspected business data. The created job is exact and the
  // worker kick below names only that job; it never enables or drains the shared queue.
  const assignment = !input.regenerateMessageId && input.content
    ? parseWorkforceChatAssignment(input.agentRole, input.content)
    : null;
  if (assignment) {
    const definition = capabilityDefinition(assignment.capability);
    if (!definition || !definition.allowedRoles.includes(input.agentRole)) {
      throw new AppError("forbidden", "This employee cannot run that review.");
    }
    if (![definition.requiredPermission, ...(definition.additionalPermissions ?? [])].every((permission) => ctx.can(permission))) {
      const assistantMessageId = await persistChatAssistantMessage({
        orgId: ctx.org.orgId,
        userId: ctx.user.id,
        agentId: agent.id,
        conversationId: prepared.conversationId,
        content: `Your workspace role does not have all required permissions for ${definition.label.toLowerCase()}. No work was created.`,
      });
      return { conversationId: prepared.conversationId, userMessageId: prepared.userMessageId, assistantMessageId, runId: null, jobId: null };
    }
    const dispatched = await dispatchCapabilityJob(ctx, {
      agentRole: input.agentRole,
      capability: assignment.capability,
      title: assignment.title,
      input: assignment.input,
      idempotencyKey: `chat-assignment:${prepared.userMessageId}`,
      conversationId: prepared.conversationId,
      deferKick: true,
    });
    const assistantMessageId = await persistChatAssistantMessage({
      orgId: ctx.org.orgId,
      userId: ctx.user.id,
      agentId: dispatched.agentId,
      conversationId: prepared.conversationId,
      content: assignment.acknowledgement,
      workJobId: dispatched.jobId,
    });
    kickWorkJob(dispatched.jobId);
    return {
      conversationId: prepared.conversationId,
      userMessageId: prepared.userMessageId,
      assistantMessageId,
      runId: null,
      jobId: dispatched.jobId,
    };
  }

  // 2. Create the assistant placeholder and run record (trusted server writes).
  type ChatSetupResult =
    | { blockedReason: "invalid_scope" | "unsupported_role" | "employee_gate" | "user_permission" | "configuration_changed" }
    | {
        blockedReason: null;
        assistantMessageId: string;
        runId: string;
        instructions: string;
        conn: HermesConnection;
        idempotencyKey: string;
        versionId: string | null;
        knowledgeEntryIds: string[];
        knowledgeDocumentIds: string[];
        promptFit: ClientPromptFitRecord | null;
      };

  // Read the facts this role needs as the signed-in person, outside the setup transaction (these are separate, row-level-security reads). The employee has no way to call
  // iAcquireOS itself, so every run is handed a verified snapshot instead of being left to guess. It never throws: a section that cannot be read says so.
  const workspaceEvidence = await prepareEmployeeEvidence(ctx, { agentId: agent.id, roleKey: input.agentRole });
  // The reply is a language model's. The marker lists only the areas that were really read for it, taken from the same object that built the snapshot the model was handed.
  const modelEvidence = classifyModelTurn(workspaceEvidence.evidence.sections, workspaceEvidence.evidence.generatedAt);

  const setup: ChatSetupResult = await withSystem(async (db) => {
    if (input.regenerateMessageId) {
      await db.query("update chat_messages set status = 'superseded' where id = $1 and conversation_id = $2", [
        input.regenerateMessageId,
        prepared.conversationId,
      ]);
    }
    const runInstructions = await buildRunInstructions(db, ctx.org.orgId, agent.id, input.agentRole === "growth_partner" ? prepared.userContent : "");
    let instructions: string;
    let knowledgeEntryIds = runInstructions.knowledgeEntryIds;
    let knowledgeDocumentIds = runInstructions.knowledgeDocumentIds;
    let promptFit: ClientPromptFitRecord | null = null;
    if (runInstructions.clientParts) {
      // A client employee's message is held to the restricted path's budgets by priority: the snapshot's record samples are shortened first, then the knowledge, and the policy, the
      // employee's configuration and the person's own message never are. Nothing changes when it already fits.
      const fitted = fitClientChatInstructions(runInstructions.clientParts, workspaceEvidence, prepared.userContent);
      instructions = fitted.instructions;
      knowledgeEntryIds = fitted.knowledgeEntryIds;
      knowledgeDocumentIds = fitted.knowledgeDocumentIds;
      promptFit = fitRecord(fitted.fit);
    } else {
      instructions = insertEvidenceBlock(runInstructions.instructions, workspaceEvidence.block);
    }
    if (ctx.org.kind === "agency" && input.agentRole === "operations_manager") {
      const capabilityContext = await prepareInternalEmployeeContext(db, {
        orgId: ctx.org.orgId,
        agentId: agent.id,
        userId: ctx.user.id,
        roleKey: input.agentRole,
        configVersionId: runInstructions.versionId,
        instructions,
      });
      if (!capabilityContext.allowed) return { blockedReason: capabilityContext.reason };
      instructions = capabilityContext.instructions;
    }
    const conn = await loadConnection(db, agent.id);
    if (!conn) throw new AppError("agent_unavailable", "This employee isn't connected yet.");
    const { rows: msg } = await db.query<{ id: string }>(
      "insert into chat_messages (conversation_id, org_id, role, content, status, evidence) values ($1, $2, 'assistant', '', 'streaming', $3::jsonb) returning id",
      [prepared.conversationId, ctx.org.orgId, JSON.stringify(modelEvidence)],
    );
    const idempotencyKey = `chat:${msg[0].id}`;
    const { rows: run } = await db.query<{ id: string }>(
      `insert into agent_runs (org_id, agent_instance_id, conversation_id, assistant_message_id, user_id, purpose,
         idempotency_key, status, config_version_id)
       values ($1, $2, $3, $4, $5, 'chat', $6, 'queued', $7) returning id`,
      [ctx.org.orgId, agent.id, prepared.conversationId, msg[0].id, ctx.user.id, idempotencyKey, runInstructions.versionId],
    );
    await db.query("update chat_messages set run_id = $2 where id = $1", [msg[0].id, run[0].id]);
    await db.query("update chat_conversations set last_message_at = now() where id = $1", [prepared.conversationId]);
    await recordUsage(db, { orgId: ctx.org.orgId, userId: ctx.user.id, agentId: agent.id, kind: "agent_message" });
    return {
      blockedReason: null,
      assistantMessageId: msg[0].id,
      runId: run[0].id,
      instructions,
      conn,
      idempotencyKey,
      versionId: runInstructions.versionId,
      knowledgeEntryIds,
      knowledgeDocumentIds,
      promptFit,
    };
  });
  if (setup.blockedReason) {
    const isUserPermission = setup.blockedReason === "user_permission";
    throw new AppError(
      isUserPermission ? "forbidden" : "agent_unavailable",
      isUserPermission
        ? "Your agency role doesn't have access to all internal tasks, approvals, and workforce activity needed for this chat."
        : "The internal Operations Manager's approved configuration could not be verified. No run was started.",
    );
  }

  // When a client's message had to be shortened to fit the restricted path's budgets, say so in the audit trail: which parts and by how much (sizes only, never text), so a reply that
  // lacks a detail can be explained. A message that fit leaves no row.
  if (setup.promptFit && (setup.promptFit.shortened.length > 0 || !setup.promptFit.fits)) {
    try {
      await recordAudit({
        orgId: ctx.org.orgId,
        actorUserId: ctx.user.id,
        actorKind: "system",
        agentInstanceId: agent.id,
        action: "workforce.client_prompt_fitted",
        targetType: "agent_run",
        targetId: setup.runId,
        result: setup.promptFit.fits ? "success" : "failure",
        metadata: { role: input.agentRole, fits: setup.promptFit.fits, chars: setup.promptFit.chars, bytes: setup.promptFit.bytes, shortened: setup.promptFit.shortened },
      });
    } catch {
      // The audit row explains a reply; losing it must not stop the person's chat.
    }
  }

  // The read happened before this run existed, so its own audit row (workforce.employee_evidence_read) names only the workspace. This second row ties that read to the run, the reply
  // and the configuration version it was handed to, with the same area names and states and nothing else.
  await recordEvidenceAttached({
    orgId: ctx.org.orgId,
    userId: ctx.user.id,
    agentId: agent.id,
    role: input.agentRole,
    runId: setup.runId,
    messageId: setup.assistantMessageId,
    configVersionId: setup.versionId,
    sections: workspaceEvidence.evidence.sections,
  });

  const abort = new AbortController();
  openChannel(setup.runId, ctx.user.id, abort);
  publish(setup.runId, {
    type: "ready",
    conversationId: prepared.conversationId,
    userMessageId: prepared.userMessageId,
    assistantMessageId: setup.assistantMessageId,
    runId: setup.runId,
    evidence: modelEvidence,
  });

  // 3. Start the Hermes run and consume it in the background.
  void executeRun({
    runId: setup.runId,
    orgId: ctx.org.orgId,
    agentId: agent.id,
    configVersionId: setup.versionId,
    agentRole: input.agentRole,
    userId: ctx.user.id,
    assistantMessageId: setup.assistantMessageId,
    conversationId: prepared.conversationId,
    conn: setup.conn,
    abort,
    knowledgeEntryIds: setup.knowledgeEntryIds,
    knowledgeDocumentIds: setup.knowledgeDocumentIds,
    request: {
      input: prepared.userContent,
      instructions: setup.instructions,
      sessionId: prepared.sessionId,
      conversationHistory: prepared.history,
      idempotencyKey: setup.idempotencyKey,
      memoryScope: `iaq:${ctx.org.orgId}:${input.agentRole}`,
    },
  });

  return {
    conversationId: prepared.conversationId,
    userMessageId: prepared.userMessageId,
    assistantMessageId: setup.assistantMessageId,
    runId: setup.runId,
  };
}

interface ExecuteRunInput {
  runId: string;
  orgId: string;
  agentId: string;
  configVersionId: string | null;
  agentRole: WorkforceRoleKey;
  userId: string;
  assistantMessageId: string;
  conversationId: string;
  conn: HermesConnection;
  abort: AbortController;
  inferenceOnly?: boolean;
  /** Sources that were actually included in the instructions. Recorded only after the provider accepts the run. */
  knowledgeEntryIds?: string[];
  knowledgeDocumentIds?: string[];
  request: StartRunInput;
}

const FRIENDLY_FAILURE: Record<string, string> = {
  start_failed: "The employee couldn't start working on this. Please try again.",
  inference_only_unavailable: "The restricted DeepSeek Chat check couldn't finish. No tools or business actions were run.",
  connection_lost: "The connection to your AI employee dropped before it finished.",
  timeout: "This took longer than expected, so it was stopped.",
  run_failed: "Your AI employee couldn't finish this request.",
  interrupted: "The AI service restarted while answering. Please try again.",
  stream_ended: "The response ended unexpectedly.",
};

async function safeDb(fn: (db: Queryable) => Promise<unknown>) {
  try {
    await withSystem(fn);
  } catch (err) {
    if (process.env.NODE_ENV !== "test") console.error("[iacquire] chat persistence error", err);
  }
}

export async function executeRun(r: ExecuteRunInput): Promise<void> {
  const timeout = setTimeout(() => r.abort.abort(new Error("timeout")), env().HERMES_RUN_TIMEOUT_MS);
  let content = "";
  let lastPersist = Date.now();
  let hermesRunId: string | null = null;
  const openTools: Array<{ id: string; tool: string; callId?: string; started: number }> = [];

  const finish = async (
    status: "completed" | "failed" | "cancelled" | "timeout" | "interrupted",
    opts: { content?: string; errorCode?: string; usage?: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } | null },
  ) => {
    const modelText = opts.content ?? content;
    // A client's employee cannot book, send or change anything, so a finished reply that says it did is wrong. Its words are kept; a plain line says nothing was done, and the
    // kinds of action it claimed (never the sentence) are recorded. The agency's own employees are left to their real tools and approvals.
    let correctedMarker = undefined as EvidenceMarker | undefined;
    const claimed = status === "completed" && !r.inferenceOnly && r.conn.orgKind === "client" ? findUnbackedActionClaims(modelText) : [];
    const finalContent = claimed.length ? withActionClaimCorrection(modelText) : modelText;
    const messageStatus = status === "completed" ? "complete" : status === "cancelled" ? "cancelled" : "failed";
    await safeDb(async (db) => {
      await db.query("update chat_messages set content = $2, status = $3, error_code = $4 where id = $1", [
        r.assistantMessageId,
        finalContent.slice(0, 64000),
        messageStatus,
        opts.errorCode ?? null,
      ]);
      if (claimed.length) {
        // The marker was stored with the placeholder row and the application role cannot change it; this is the server's own connection.
        const { rows: stored } = await db.query<{ evidence: unknown }>("select evidence from chat_messages where id = $1 and org_id = $2", [r.assistantMessageId, r.orgId]);
        const current = parseEvidenceMarker(stored[0]?.evidence);
        const base = current?.class === "model_response" ? current : classifyModelTurn([], new Date().toISOString());
        await db.query("update chat_messages set evidence = $3::jsonb where id = $1 and org_id = $2", [
          r.assistantMessageId,
          r.orgId,
          JSON.stringify({ ...base, claims: "unbacked_action_claim" } satisfies EvidenceMarker),
        ]);
        correctedMarker = { ...base, claims: "unbacked_action_claim" };
        await recordAudit({
          orgId: r.orgId,
          actorUserId: r.userId,
          actorKind: "agent",
          agentInstanceId: r.agentId,
          action: "workforce.chat_unbacked_claim",
          targetType: "agent_run",
          targetId: r.runId,
          result: "denied",
          metadata: { role: r.agentRole, messageId: r.assistantMessageId, categories: claimed },
        }, db);
      }
      await db.query(
        `update agent_runs set status = $2, finished_at = now(), error_code = $3, error_message = $4,
           input_tokens = $5, output_tokens = $6, total_tokens = $7 where id = $1`,
        [
          r.runId,
          status,
          opts.errorCode ?? null,
          opts.errorCode ? FRIENDLY_FAILURE[opts.errorCode] ?? null : null,
          opts.usage?.inputTokens ?? null,
          opts.usage?.outputTokens ?? null,
          opts.usage?.totalTokens ?? null,
        ],
      );
      await db.query("update tool_executions set status = 'failed', finished_at = now() where run_id = $1 and status = 'started'", [r.runId]);
      await db.query("update chat_conversations set last_message_at = now() where id = $1", [r.conversationId]);
      if (opts.usage && (opts.usage.inputTokens || opts.usage.outputTokens)) {
        await db.query(
          `update usage_events set input_tokens = $2, output_tokens = $3 where id = (
             select id from usage_events where org_id = $1 and agent_instance_id = $4 and kind = 'agent_message'
             and input_tokens is null order by created_at desc limit 1)`,
          [r.orgId, opts.usage.inputTokens, opts.usage.outputTokens, r.agentId],
        );
      }
      if (status !== "completed" && status !== "cancelled") {
        await recordUsage(db, { orgId: r.orgId, userId: r.userId, agentId: r.agentId, kind: "agent_run_failed" });
      }
    });
    if (status === "completed") publish(r.runId, { type: "done", content: finalContent, ...(correctedMarker ? { evidence: correctedMarker } : {}) });
    else if (status === "cancelled") publish(r.runId, { type: "cancelled", content: finalContent });
    else
      publish(r.runId, {
        type: "error",
        code: opts.errorCode ?? "run_failed",
        message: FRIENDLY_FAILURE[opts.errorCode ?? "run_failed"] ?? FRIENDLY_FAILURE.run_failed,
        retryable: true,
      });
  };

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        r.abort.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      r.abort.signal.addEventListener("abort", done, { once: true });
    });

  if (r.inferenceOnly) {
    try {
      await safeDb((db) => db.query("update agent_runs set status = 'running' where id = $1", [r.runId]));
      if (!isAgentRoleKey(r.agentRole)) throw new Error("Restricted inference requires a legacy internal employee role.");
      if (typeof r.request.instructions !== "string" || !r.request.instructions.trim()) {
        throw new Error("Restricted inference instructions are unavailable.");
      }
      const result = await requestInferenceOnly(r.conn, {
        actorId: r.userId,
        role: r.agentRole,
        instructions: r.request.instructions,
        input: HERMES_INFERENCE_ONLY_CHAT_CANARY,
        history: [],
        signal: r.abort.signal,
      });
      content = result.content;
      if (r.abort.signal.aborted) {
        const reason = String((r.abort.signal.reason as Error | undefined)?.message ?? "");
        await finish(reason === "timeout" ? "timeout" : "cancelled", reason === "timeout" ? { errorCode: "timeout" } : {});
        return;
      }
      publish(r.runId, { type: "delta", text: content });
      await safeDb(async (db) => {
        if (r.knowledgeEntryIds?.length || r.knowledgeDocumentIds?.length) {
          await markEmployeeKnowledgeUsed(db, r.orgId, r.agentId, r.knowledgeEntryIds ?? [], r.knowledgeDocumentIds ?? []);
        }
      });
      await recordAudit({
        orgId: r.orgId,
        actorUserId: r.userId,
        actorKind: "user",
        agentInstanceId: r.agentId,
        action: "hermes.inference_only_chat",
        targetType: "agent_run",
        targetId: r.runId,
        result: "success",
        metadata: {
          role: r.agentRole,
          profile: r.conn.profile,
          provider: result.provider,
          model: result.model,
          usageUnit: "tokens",
          actualUsage: {
            input: result.usage.inputTokens,
            output: result.usage.outputTokens,
            total: result.usage.totalTokens,
          },
          toolSchemas: 0,
          toolCalls: 0,
        },
      });
      await finish("completed", { content, usage: result.usage });
      return;
    } catch {
      const reason = r.abort.signal.aborted ? String((r.abort.signal.reason as Error | undefined)?.message ?? "") : "";
      if (reason === "stopped_by_user" || reason === "timeout") {
        await finish(reason === "timeout" ? "timeout" : "cancelled", reason === "timeout" ? { errorCode: "timeout" } : {});
        return;
      }
      await recordAudit({
        orgId: r.orgId,
        actorUserId: r.userId,
        actorKind: "user",
        agentInstanceId: r.agentId,
        action: "hermes.inference_only_chat",
        targetType: "agent_run",
        targetId: r.runId,
        result: "failure",
        metadata: { role: r.agentRole, provider: "deepseek", error: "inference_only_unavailable", toolSchemas: 0, toolCalls: 0 },
      }).catch(() => undefined);
      await finish("failed", { errorCode: "inference_only_unavailable" });
      return;
    }
  }

  // Providers that do not advertise SSE still expose GET /v1/runs/{id}. In that case show an honest processing
  // state and render the completed output once; the browser UI already handles a response with no deltas.
  const pollUntilComplete = async (runId: string) => {
    publish(r.runId, { type: "activity", label: "Waiting for the complete response…" });
    for (;;) {
      if (r.abort.signal.aborted) {
        await stopRun(r.conn, runId).catch(() => undefined);
        const reason = String((r.abort.signal.reason as Error | undefined)?.message ?? "");
        await finish(reason === "timeout" ? "timeout" : "cancelled", reason === "timeout" ? { errorCode: "timeout" } : {});
        return;
      }
      const status = await getRunStatus(r.conn, runId);
      if (status.status === "completed") {
        await finish("completed", { content: status.output ?? "", usage: status.usage });
        return;
      }
      if (status.status === "failed") {
        await finish("failed", { content: status.output ?? "", errorCode: "run_failed", usage: status.usage });
        return;
      }
      if (status.status === "cancelled") {
        await finish("cancelled", {});
        return;
      }
      if (status.status === "interrupted") {
        await finish("interrupted", { errorCode: "interrupted" });
        return;
      }
      await wait(1000);
    }
  };

  try {
    let startedRunId = "";
    try {
      const started = await startAgentRun(r.agentId, r.orgId, r.conn, r.request, { expectedConfigVersionId: r.configVersionId });
      startedRunId = started.runId;
      hermesRunId = startedRunId;
    } catch (err) {
      if (err instanceof HermesError && ["unreachable", "auth_failed", "not_found", "timeout"].includes(err.kind)) {
        await markAgentDegraded(r.agentId, err.message);
      }
      await finish("failed", { errorCode: "start_failed" });
      return;
    }
    await safeDb(async (db) => {
      await db.query("update agent_runs set status = 'running', hermes_run_id = $2 where id = $1", [r.runId, hermesRunId]);
      if (r.knowledgeEntryIds?.length || r.knowledgeDocumentIds?.length) {
        await markEmployeeKnowledgeUsed(db, r.orgId, r.agentId, r.knowledgeEntryIds ?? [], r.knowledgeDocumentIds ?? []);
      }
    });

    let supportsEvents = true;
    try {
      supportsEvents = (await getCapabilities(r.conn)).supportsEvents;
    } catch {
      // If capability discovery fails now, try the event stream; it has its own error handling.
    }
    if (!supportsEvents) {
      await pollUntilComplete(startedRunId);
      return;
    }

    for await (const ev of streamRunEvents(r.conn, startedRunId, r.abort.signal)) {
      switch (ev.type) {
        case "delta": {
          content += ev.text;
          publish(r.runId, { type: "delta", text: ev.text });
          if (Date.now() - lastPersist > 1500) {
            lastPersist = Date.now();
            const snapshot = content;
            void safeDb((db) => db.query("update chat_messages set content = $2 where id = $1 and status = 'streaming'", [r.assistantMessageId, snapshot]));
          }
          break;
        }
        case "tool_started": {
          const label = toolActivityLabel(ev.tool);
          publish(r.runId, { type: "activity", label });
          const id = crypto.randomUUID();
          openTools.push({ id, tool: ev.tool, callId: ev.callId, started: Date.now() });
          await safeDb((db) =>
            db.query("insert into tool_executions (id, run_id, org_id, tool_name, label) values ($1, $2, $3, $4, $5)", [
              id,
              r.runId,
              r.orgId,
              ev.tool.slice(0, 120),
              label,
            ]),
          );
          break;
        }
        case "tool_completed": {
          const idx = openTools.findIndex((t) => (ev.callId ? t.callId === ev.callId : t.tool === ev.tool));
          if (idx >= 0) {
            const t = openTools.splice(idx, 1)[0];
            await safeDb((db) =>
              db.query("update tool_executions set status = $2, finished_at = now(), duration_ms = $3 where id = $1", [
                t.id,
                ev.error ? "failed" : "completed",
                ev.durationMs ?? Date.now() - t.started,
              ]),
            );
          }
          break;
        }
        case "approval_request": {
          const title = `${workforceRoleShortName(r.agentRole)} wants to use ${ev.tool ?? "a tool"}`;
          let approvalId: string | null = null;
          await safeDb(async (db) => {
            const { rows } = await db.query<{ id: string }>(
              `insert into approval_requests (org_id, agent_instance_id, requested_by, kind, title, action, target_type, target_label,
                 reason, expected_effect, risk, expires_at, idempotency_key)
               values ($1, $2, $3, 'tool_action', $4, $5, 'agent_run', $6, $7, $8, 'high', now() + interval '30 minutes', $9)
               on conflict (idempotency_key) do nothing returning id`,
              [
                r.orgId,
                r.agentId,
                r.userId,
                title.slice(0, 200),
                JSON.stringify({ hermesRunId, hermesApprovalId: ev.approvalId ?? null, tool: ev.tool ?? null, runId: r.runId }),
                ev.tool ?? "Agent tool",
                (ev.summary ?? "The employee paused and needs a human decision before continuing.").slice(0, 2000),
                "If approved, the employee runs this step once. If rejected, the step is blocked.",
                `hermes-approval:${hermesRunId}:${ev.approvalId ?? openTools.length}`,
              ],
            );
            approvalId = rows[0]?.id ?? null;
            if (approvalId) {
              await db.query("insert into approval_events (approval_id, org_id, actor_kind, event) values ($1, $2, 'agent', 'created')", [approvalId, r.orgId]);
              await notifyOrgRoles(db, r.orgId, ["owner", "admin"], {
                kind: "approval_requested",
                severity: "warning",
                title,
                body: "An AI employee is waiting for approval.",
                link: "/approvals",
              });
            }
          });
          if (approvalId) publish(r.runId, { type: "approval", approvalId, title });
          publish(r.runId, { type: "activity", label: "Waiting for your approval…" });
          break;
        }
        case "completed": {
          // The run's final output is authoritative; streamed deltas are only a preview.
          await finish("completed", { content: ev.output ?? content, usage: ev.usage });
          return;
        }
        case "failed": {
          await finish("failed", { content: content || ev.partialOutput || "", errorCode: "run_failed", usage: ev.usage });
          return;
        }
        case "cancelled":
          await finish("cancelled", {});
          return;
        case "interrupted":
          await finish("interrupted", { errorCode: "interrupted" });
          return;
        default:
          break;
      }
    }
    await finish("failed", { errorCode: "stream_ended" });
  } catch (err) {
    const reason = r.abort.signal.aborted ? String((r.abort.signal.reason as Error | undefined)?.message ?? "") : "";
    if (reason === "stopped_by_user" || reason === "timeout") {
      if (hermesRunId) await stopRun(r.conn, hermesRunId).catch(() => undefined);
      await finish(reason === "timeout" ? "timeout" : "cancelled", reason === "timeout" ? { errorCode: "timeout" } : {});
      return;
    }
    if (err instanceof HermesError && (err.kind === "unreachable" || err.kind === "auth_failed")) {
      await markAgentDegraded(r.agentId, err.message);
    }
    await finish("failed", { errorCode: "connection_lost" });
  } finally {
    clearTimeout(timeout);
  }
}

/** Stops a run the signed-in user started. */
export async function stopChatRun(ctx: OrgContext, runId: string): Promise<void> {
  const run = await withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ id: string; user_id: string; status: string; hermes_run_id: string | null; agent_instance_id: string }>(
      "select id, user_id, status, hermes_run_id, agent_instance_id from agent_runs where id = $1 and org_id = $2",
      [runId, ctx.org.orgId],
    );
    return rows[0];
  });
  if (!run || run.user_id !== ctx.user.id) throw new AppError("not_found", "Run not found.");
  if (!["queued", "running"].includes(run.status)) return;
  if (abortChannel(runId)) return;
  // The run is not attached to this server process (e.g. after a restart): ask Hermes directly.
  const conn = await withSystem((db) => loadConnection(db, run.agent_instance_id));
  if (conn && run.hermes_run_id) await stopRun(conn, run.hermes_run_id).catch(() => undefined);
  await withSystem(async (db) => {
    await db.query("update agent_runs set status = 'cancelled', finished_at = now() where id = $1 and status in ('queued', 'running')", [runId]);
    await db.query("update chat_messages set status = 'cancelled' where run_id = $1 and status = 'streaming'", [runId]);
  });
}

/** Marks runs that were in flight when the server stopped, so nothing is shown as still running. */
export async function reconcileOrphanedRuns() {
  await withSystem(async (db) => {
    await db.query(
      `update agent_runs set status = 'interrupted', finished_at = now(), error_code = 'interrupted'
       where status in ('queued', 'running') and started_at < now() - make_interval(secs => $1)`,
      [Math.ceil(env().HERMES_RUN_TIMEOUT_MS / 1000) + 60],
    );
    await db.query(
      `update chat_messages m set status = 'failed', error_code = 'interrupted'
       from agent_runs r where r.id = m.run_id and m.status = 'streaming' and r.status = 'interrupted'`,
    );
  });
}
