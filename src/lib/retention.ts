// Retention programs: the default programs a workspace can switch on, and the rules for the wording of their messages.
// Pure functions and constants only. Nothing here reads the database; the server code in src/server/retention does.
import { reviewIncentiveFindings } from "@/lib/reputation/incentives";

export const PROGRAM_KINDS = ["welcome", "onboarding_checkin", "service_followup", "feedback_request", "reengagement"] as const;
export type ProgramKind = (typeof PROGRAM_KINDS)[number];
export type ProgramTrigger = "customer_created" | "appointment_showed" | "inactive";
export type ProgramPurpose = "service" | "marketing";

export interface ProgramStep {
  key: string;
  /** Days after the trigger moment. 0 means as soon as the rules allow. */
  delayDays: number;
  body: string;
}

export interface ProgramDefinition {
  kind: ProgramKind;
  name: string;
  description: string;
  trigger: ProgramTrigger;
  purpose: ProgramPurpose;
  steps: ProgramStep[];
  businessHoursOnly: boolean;
  inactiveDays: number | null;
  /** Plain statement of who gets it and when, shown beside the switch. */
  audience: string;
}

export const MAX_STEPS = 4;
export const MAX_BODY = 480;
/** Re-engagement is promotional, so at most this many people are enrolled per day however many qualify, to avoid a sudden blast. */
export const DAILY_ENROLLMENT_CAP = 10;
/** A step that is this overdue when it is finally looked at (after an outage or a pause) is skipped rather than sent late. */
export const STALE_STEP_DAYS = 7;
/** A customer who was re-engaged is not enrolled again for this long. */
export const REENGAGEMENT_COOLDOWN_DAYS = 180;

export const DEFAULT_PROGRAMS: ProgramDefinition[] = [
  {
    kind: "welcome",
    name: "Welcome new customers",
    description: "A short thank-you when someone becomes a customer.",
    trigger: "customer_created",
    purpose: "service",
    businessHoursOnly: true,
    inactiveDays: null,
    audience: "People who become customers after you switch this on. Existing customers are never messaged.",
    steps: [{ key: "welcome", delayDays: 0, body: "Hi {name}, thank you for choosing {business}. We're glad to have you. If you have any questions, just reply here." }],
  },
  {
    kind: "onboarding_checkin",
    name: "Check in after they start",
    description: "A friendly check-in a few days and a couple of weeks after someone becomes a customer.",
    trigger: "customer_created",
    purpose: "service",
    businessHoursOnly: true,
    inactiveDays: null,
    audience: "People who become customers after you switch this on.",
    steps: [
      { key: "checkin_3", delayDays: 3, body: "Hi {name}, it's {business} checking in. How is everything going so far? Reply here if there's anything we can help with." },
      { key: "checkin_14", delayDays: 14, body: "Hi {name}, a quick check-in from {business}. Is everything working the way you expected? We're happy to help if not." },
    ],
  },
  {
    kind: "service_followup",
    name: "Follow up after an appointment",
    description: "A thank-you and an offer to help, after an appointment your calendar marks as attended.",
    trigger: "appointment_showed",
    purpose: "service",
    businessHoursOnly: true,
    inactiveDays: null,
    audience: "People whose appointment is marked attended after you switch this on.",
    steps: [{ key: "thanks", delayDays: 2, body: "Hi {name}, thanks for meeting with {business}. If you have any questions after our visit, reply here and we'll help." }],
  },
  {
    kind: "feedback_request",
    name: "Ask for feedback",
    description: "One request for feedback after an attended appointment.",
    trigger: "appointment_showed",
    purpose: "service",
    businessHoursOnly: true,
    inactiveDays: null,
    audience: "People whose appointment is marked attended after you switch this on.",
    steps: [{ key: "feedback", delayDays: 5, body: "Hi {name}, we'd love to hear how we did. Reply with a quick note about your experience with {business}. It helps us improve." }],
  },
  {
    kind: "reengagement",
    name: "Reconnect with quiet customers",
    description: "A gentle note to customers you haven't spoken to in a while. This is promotional, so it only reaches people who agreed to marketing messages.",
    trigger: "inactive",
    purpose: "marketing",
    businessHoursOnly: true,
    inactiveDays: 90,
    audience: "Customers with no conversation for the number of days below, who have agreed to marketing messages. At most 10 people a day, and nobody more than once every 180 days.",
    steps: [{ key: "reconnect", delayDays: 0, body: "Hi {name}, it's been a while since we last spoke. If there's anything {business} can help you with, reply here. Reply STOP to opt out." }],
  },
];

export const defaultFor = (kind: ProgramKind): ProgramDefinition => DEFAULT_PROGRAMS.find((p) => p.kind === kind)!;
export const isProgramKind = (v: unknown): v is ProgramKind => typeof v === "string" && (PROGRAM_KINDS as readonly string[]).includes(v);

const PLACEHOLDER = /\{([a-z_]+)\}/g;
const ALLOWED_PLACEHOLDERS = new Set(["name", "business"]);

/**
 * The place in a message where the customer's own private feedback link goes. The link opens their page: the business's public review links, and a way to say privately how
 * it went. It is created when the message is prepared, and only the words around it are what the owner approves.
 */
export const FEEDBACK_LINK = "{feedback_link}";
/** The programs whose messages may carry it: asking for feedback, and following up after an attended appointment. Both are service messages. */
export const FEEDBACK_LINK_PROGRAMS: readonly ProgramKind[] = ["feedback_request", "service_followup"];
export const hasFeedbackLink = (body: string) => body.includes(FEEDBACK_LINK);
export const programMayCarryLink = (kind: ProgramKind | undefined, purpose: ProgramPurpose) => kind !== undefined && FEEDBACK_LINK_PROGRAMS.includes(kind) && purpose === "service";

export interface StepIssue {
  step: number;
  message: string;
}

/**
 * Checks the wording a person typed. Marketing messages must tell the customer how to stop them; every message must be short and plain. {feedback_link} is allowed only in the
 * programs that ask for feedback or follow up after a visit (pass the program's `kind`), only once, and a message that carries it may not offer anything in return for feedback
 * or a review, or ask for a particular rating (rule R4).
 */
export function validateSteps(steps: ProgramStep[], purpose: ProgramPurpose, kind?: ProgramKind): StepIssue[] {
  const issues: StepIssue[] = [];
  const linkAllowed = programMayCarryLink(kind, purpose);
  if (steps.length < 1 || steps.length > MAX_STEPS) issues.push({ step: -1, message: `A program has between 1 and ${MAX_STEPS} messages.` });
  const keys = new Set<string>();
  let last = -1;
  steps.forEach((s, i) => {
    if (!/^[a-z0-9_]{1,40}$/.test(s.key)) issues.push({ step: i, message: "Each message needs a short internal name." });
    if (keys.has(s.key)) issues.push({ step: i, message: "Two messages share the same internal name." });
    keys.add(s.key);
    if (!Number.isInteger(s.delayDays) || s.delayDays < 0 || s.delayDays > 365) issues.push({ step: i, message: "Choose a delay between 0 and 365 days." });
    if (s.delayDays < last) issues.push({ step: i, message: "Messages must be in order, earliest first." });
    last = Math.max(last, s.delayDays);
    const body = s.body.trim();
    if (!body) issues.push({ step: i, message: "Write the message." });
    if (body.length > MAX_BODY) issues.push({ step: i, message: `Keep it under ${MAX_BODY} characters.` });
    for (const m of body.matchAll(PLACEHOLDER)) {
      if (m[0] === FEEDBACK_LINK) {
        if (!linkAllowed) issues.push({ step: i, message: `${FEEDBACK_LINK} can only be used in the "Ask for feedback" and "Follow up after an appointment" programs. Remove it, or use {name} or {business}.` });
      } else if (!ALLOWED_PLACEHOLDERS.has(m[1])) {
        issues.push({ step: i, message: `{${m[1]}} isn't something we can fill in. Use {name} or {business}${linkAllowed ? `, or ${FEEDBACK_LINK} for the customer's own feedback link` : ""}.` });
      }
    }
    if (body.split(FEEDBACK_LINK).length > 2) issues.push({ step: i, message: `Use ${FEEDBACK_LINK} once in a message.` });
    if (hasFeedbackLink(body)) {
      const wording = reviewIncentiveFindings(body)[0];
      if (wording) issues.push({ step: i, message: wording.message });
    }
    if (purpose === "marketing" && !/\bstop\b/i.test(body)) issues.push({ step: i, message: "A promotional message must tell the customer how to opt out, for example \"Reply STOP to opt out.\"" });
  });
  return issues;
}

/** Fills in the two placeholders. A missing first name becomes "there", so a message never reads "Hi ,". Braces in a name are dropped: a name can't write a placeholder. */
export function renderStep(body: string, v: { name: string; business: string }): string {
  const first = v.name.trim().split(/\s+/)[0].replace(/[{}]/g, "");
  return body
    .replace(/\{name\}/g, first || "there")
    .replace(/\{business\}/g, v.business.trim().replace(/[{}]/g, "") || "our team")
    .slice(0, 900);
}

/**
 * A step that carries {feedback_link}, ready to queue: the placeholder becomes {{review.link}} (the message keeps it; the dispatcher fills in the customer's own link for the
 * provider call only, so nobody who reads the conversation can answer as the customer), and the name and business are filled in around it.
 */
export function renderLinkedStep(body: string, v: { name: string; business: string }, linkToken: string): string {
  return body.split(FEEDBACK_LINK).map((part) => renderStep(part, v)).join(linkToken);
}

export const stepDueAt = (base: Date, delayDays: number) => new Date(base.getTime() + delayDays * 86_400_000);

export const PROGRAM_STATE_LABEL = { off: "Off", needs_approval: "Needs your approval", on: "On", lapsed: "Paused: authorization lapsed" } as const;
export type ProgramState = keyof typeof PROGRAM_STATE_LABEL;

/** Stop reasons: once one of these blocks a message, the rest of that customer's program is cancelled rather than retried. */
export const STOP_REASONS = new Set(["human_owner", "suppressed", "no_consent", "automation_paused", "org_inactive", "agent_not_ready", "retention_limit", "contact_unreachable", "credits", "budget"]);

const REASONS: Record<string, string> = {
  human_owner: "A person has taken over the conversation",
  suppressed: "They opted out of messages",
  no_consent: "They haven't agreed to this kind of message",
  automation_paused: "Customer messaging was paused",
  org_inactive: "The workspace isn't active",
  agent_not_ready: "The AI employee wasn't ready",
  retention_limit: "They already had the most program messages allowed this month",
  retention_too_soon: "Too soon after their last program message",
  contact_unreachable: "There's no way to reach them",
  credits: "There weren't enough service credits",
  budget: "It would have gone over your spending limit",
  authorization_needed: "Waiting for your approval",
  too_late: "It was too late to send, so it was skipped",
  program_off: "The program was switched off",
  customer_replied: "They replied",
  customer_booked: "They booked an appointment",
  customer_opted_out: "They opted out",
  human_took_over: "A person took over",
  contact_excluded: "You excluded this customer",
  // Low private feedback stops the automatic program messages that had not gone out yet, so an unhappy customer is not sent a cheerful check-in the next day.
  // It never changes which public review links they see.
  negative_feedback: "They shared low private feedback, so a person follows up instead",
  // A message with a private feedback link has two more rules than a plain one: the customer must have agreed to service messages on the channel it goes by, and they are
  // not asked again within the cool-down that every review request and survey shares.
  surveys_not_enabled: "Satisfaction surveys aren't switched on for this workspace",
  link_needs_consent: "A private link is only sent to someone who agreed to service messages on that channel",
  recently_requested: "They were already asked for feedback or a review in the last 30 days",
  incentive_wording: "The wording offers something for feedback or a review, which isn't allowed",
  link_not_allowed: "This program can't carry a private feedback link",
  contact_removed: "The contact was removed",
  contact_merged: "The contact was merged into another record",
  no_longer_customer: "They're no longer marked as a customer",
  appointment_changed: "The appointment changed",
  step_removed: "That message was removed from the program",
  whatsapp_window_closed: "WhatsApp doesn't allow this message right now",
  channel_not_ready: "That channel isn't set up yet",
  no_contact_channel: "There's no phone number or email on file",
  needs_approval: "It needed a person's approval first",
};

/** A reason code in plain words for the people reading the activity list. Unknown codes are shown as a sentence, never as a code. */
export const reasonText = (code: string | null | undefined): string => (code ? (REASONS[code] ?? code.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())) : "");
