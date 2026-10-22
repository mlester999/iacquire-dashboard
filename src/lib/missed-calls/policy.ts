import { z } from "zod";
import { CALL_CLASSES, type CallClass } from "@/lib/missed-calls/state";

// A workspace's missed-call recovery policy. The defaults are the safe ones: the policy is OFF, nothing is drafted or sent automatically, the
// only actions switched on are the ones that cannot reach a customer (a call-back task for the team and an in-app notice), and a text is
// only ever sent to a caller who has a consent on record.

export const POLICY_MODES = ["manual", "assisted", "automatic"] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];
export const POLICY_MODE_LABELS: Record<PolicyMode, string> = {
  manual: "Team only",
  assisted: "Draft for approval",
  automatic: "Send automatically",
};
export const POLICY_MODE_HELP: Record<PolicyMode, string> = {
  manual: "Creates a call-back task and notifies your team. Nothing is ever sent to the caller.",
  assisted: "Also drafts a text for a teammate to approve before it is sent.",
  automatic: "Also sends one eligible text after the delay, within your business hours, quiet hours and consent rules.",
};

export const NOTIFY_ROLES = ["owner", "admin", "member", "sales_rep", "support", "appointment_setter"] as const;
export const MESSAGE_CHANNELS = ["sms", "email"] as const;
export type RecoveryChannel = (typeof MESSAGE_CHANNELS)[number];
export const AFTER_HOURS_BEHAVIORS = ["wait_for_open", "send_after_hours_text"] as const;
export type AfterHoursBehavior = (typeof AFTER_HOURS_BEHAVIORS)[number];
export const AFTER_HOURS_LABELS: Record<AfterHoursBehavior, string> = {
  wait_for_open: "Wait until we are open",
  send_after_hours_text: "Send the after-hours text right away",
};
export const SMS_CONSENT_BASES = ["recorded", "inbound_call"] as const;
export type SmsConsentBasis = (typeof SMS_CONSENT_BASES)[number];
export const SMS_CONSENT_BASIS_LABELS: Record<SmsConsentBasis, string> = {
  recorded: "Only people with consent on record",
  inbound_call: "Anyone who phoned us may get one service text about their call",
};

export interface MissedCallPolicy {
  enabled: boolean;
  mode: PolicyMode;
  activatedAt: string | null;
  activatedBy: string | null;
  classes: CallClass[];
  abandonedMaxSeconds: number;
  delayMinutes: number;
  maxAttempts: number;
  attemptGapMinutes: number;
  responseWindowHours: number;
  caseExpiryHours: number;
  afterHoursBehavior: AfterHoursBehavior;
  actionTask: boolean;
  taskDueMinutes: number;
  actionNotify: boolean;
  notifyRoles: Array<(typeof NOTIFY_ROLES)[number]>;
  assignUserId: string | null;
  actionOpportunity: boolean;
  actionFollowUp: boolean;
  actionMessage: boolean;
  messageChannels: RecoveryChannel[];
  messageOpen: string | null;
  messageAfterHours: string | null;
  smsConsentBasis: SmsConsentBasis;
  consentAckAt: string | null;
  actionAiCallback: boolean;
  routeAppointmentSetter: boolean;
  version: number;
}

export const DEFAULT_POLICY: MissedCallPolicy = {
  enabled: false,
  mode: "manual",
  activatedAt: null,
  activatedBy: null,
  classes: ["ring_no_answer", "voicemail", "abandoned", "provider_failed"],
  abandonedMaxSeconds: 8,
  delayMinutes: 2,
  maxAttempts: 2,
  attemptGapMinutes: 240,
  responseWindowHours: 48,
  caseExpiryHours: 72,
  afterHoursBehavior: "wait_for_open",
  actionTask: true,
  taskDueMinutes: 60,
  actionNotify: true,
  notifyRoles: ["owner", "admin"],
  assignUserId: null,
  actionOpportunity: true,
  actionFollowUp: true,
  actionMessage: false,
  messageChannels: ["sms"],
  messageOpen: null,
  messageAfterHours: null,
  smsConsentBasis: "recorded",
  consentAckAt: null,
  actionAiCallback: false,
  routeAppointmentSetter: false,
  version: 0,
};

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

export const DEFAULT_MESSAGE_OPEN = "Hi, this is {{business_name}}. Sorry we missed your call. How can we help? Reply here and we'll get right back to you. Reply STOP to opt out.";
export const DEFAULT_MESSAGE_AFTER_HOURS = "Hi, this is {{business_name}}. Sorry we missed your call. We're closed right now. Reply here with what you need and we'll follow up when we open. Reply STOP to opt out.";
const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;
export const ALLOWED_PLACEHOLDERS = ["business_name"] as const;

/** Why a wording is not acceptable, or null. Plain text only: no links, no placeholders other than the business name. */
export function wordingProblem(text: string): string | null {
  const t = text.trim();
  if (t.length < 10) return "Write at least a short sentence.";
  if (t.length > 480) return "Keep it under 480 characters.";
  for (const m of t.matchAll(PLACEHOLDER)) {
    if (!(ALLOWED_PLACEHOLDERS as readonly string[]).includes(m[1])) return `{{${m[1]}}} is not available. You can use {{business_name}}.`;
  }
  if (/\{\{|\}\}/.test(t.replace(PLACEHOLDER, ""))) return "A {{ }} placeholder is incomplete.";
  if (/https?:\/\/|www\./i.test(t)) return "Links are not allowed in an automatic missed-call text.";
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t)) return "Remove the control characters.";
  return null;
}

export function renderWording(template: string, values: { businessName: string }): string {
  const name = values.businessName.trim() || "our team";
  return template.replace(PLACEHOLDER, (_m, key: string) => (key === "business_name" ? name : "")).replace(/\s+/g, " ").trim();
}

export const policyWording = (p: Pick<MissedCallPolicy, "messageOpen" | "messageAfterHours">, afterHours: boolean): string =>
  (afterHours ? p.messageAfterHours ?? DEFAULT_MESSAGE_AFTER_HOURS : p.messageOpen ?? DEFAULT_MESSAGE_OPEN);

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const wording = z.string().trim().max(480).nullable().optional();

export const policyInputSchema = z.strictObject({
  enabled: z.boolean().optional(),
  mode: z.enum(POLICY_MODES).optional(),
  classes: z.array(z.enum(CALL_CLASSES)).min(1).max(CALL_CLASSES.length).optional(),
  abandonedMaxSeconds: z.number().int().min(1).max(60).optional(),
  delayMinutes: z.number().int().min(0).max(1440).optional(),
  maxAttempts: z.number().int().min(1).max(5).optional(),
  attemptGapMinutes: z.number().int().min(15).max(10080).optional(),
  responseWindowHours: z.number().int().min(1).max(336).optional(),
  caseExpiryHours: z.number().int().min(6).max(720).optional(),
  afterHoursBehavior: z.enum(AFTER_HOURS_BEHAVIORS).optional(),
  actionTask: z.boolean().optional(),
  taskDueMinutes: z.number().int().min(5).max(10080).optional(),
  actionNotify: z.boolean().optional(),
  notifyRoles: z.array(z.enum(NOTIFY_ROLES)).min(1).max(6).optional(),
  assignUserId: uuid.nullable().optional(),
  actionOpportunity: z.boolean().optional(),
  actionFollowUp: z.boolean().optional(),
  actionMessage: z.boolean().optional(),
  messageChannels: z.array(z.enum(MESSAGE_CHANNELS)).min(1).max(2).optional(),
  messageOpen: wording,
  messageAfterHours: wording,
  smsConsentBasis: z.enum(SMS_CONSENT_BASES).optional(),
  /** Required (true) whenever the basis is "inbound_call": the business confirms it has checked the rules where its callers are. */
  acknowledgeCallerConsent: z.boolean().optional(),
  actionAiCallback: z.boolean().optional(),
  routeAppointmentSetter: z.boolean().optional(),
  /** The version the editor started from; a stale save is refused. */
  expectedVersion: z.number().int().min(0),
});
export type PolicyInput = z.infer<typeof policyInputSchema>;

/**
 * Problems that depend on more than one field. Returns the reasons (empty when the policy as a whole is allowed). The server applies the same
 * rules, so a request that skips this still cannot save an unsafe combination.
 */
export function policyProblems(next: MissedCallPolicy, ack: { acknowledged: boolean }): string[] {
  const problems: string[] = [];
  if (next.mode !== "manual" && !next.actionMessage) problems.push("Turn on the text follow-up to use \"Draft for approval\" or \"Send automatically\".");
  if (next.actionMessage && next.mode === "manual") problems.push("A text follow-up needs \"Draft for approval\" or \"Send automatically\".");
  for (const [label, text] of [["The text during opening hours", next.messageOpen], ["The text outside opening hours", next.messageAfterHours]] as const) {
    if (text) {
      const p = wordingProblem(text);
      if (p) problems.push(`${label}: ${p}`);
    }
  }
  if (next.smsConsentBasis === "inbound_call" && !ack.acknowledged && !next.consentAckAt) {
    problems.push("Confirm that you have checked the messaging rules where your callers are before texting people who only phoned you.");
  }
  if (next.actionTask === false && next.actionNotify === false && next.mode === "manual" && next.enabled) {
    problems.push("Turn on a task or a notice, or nobody would hear about a missed call.");
  }
  return problems;
}
