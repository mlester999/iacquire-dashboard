import { AGENT_BY_KEY, AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { isValidTimeZone } from "@/lib/calendars/slots";
import type { ReadinessState } from "@/lib/workforce-readiness";
import { countWord } from "@/lib/onboarding/engine";

// One honest answer to "is this client ready to launch?", built only from facts that were read from the workspace's own records. Pure: no I/O. Nothing here is inferred from a
// queued job, a drafted calendar or a green badge: a step is done only when the thing it names is true, and "100% Ready to Launch" means every applicable, required setup and
// verification check has passed. Optional or unpurchased things are listed but never block it, and a requirement that does not apply to this business (no appointments, a role
// that is not in the plan) is shown as not applicable instead of blocking setup.

export type LaunchState = "not_started" | "questionnaire_submitted" | "provisioning" | "action_required" | "ready_for_review" | "ready_to_launch";

export const LAUNCH_STATE_LABEL: Record<LaunchState, string> = {
  not_started: "Not started",
  questionnaire_submitted: "Questionnaire submitted",
  provisioning: "Provisioning",
  action_required: "Action required",
  ready_for_review: "Ready for review",
  ready_to_launch: "100% Ready to Launch",
};

export type ItemState = "done" | "in_progress" | "action_required" | "awaiting_review" | "failed" | "not_applicable";
export const ITEM_STATE_LABEL: Record<ItemState, string> = {
  done: "Done",
  in_progress: "In progress",
  action_required: "Action required",
  awaiting_review: "Waiting for review",
  failed: "Failed",
  not_applicable: "Not applicable",
};

/** Who has to move next on an item that is not done. */
export type ItemOwner = "you" | "iacquire" | "system";

/** A button that does the next step inside the guided setup (an intent the page runs) or a link to the screen where it is done. */
export type LaunchIntent = "assign_host" | "apply_hours" | "activate_calendar" | "run_checks";
export interface LaunchAction {
  label: string;
  href?: string;
  intent?: LaunchIntent;
}

export interface LaunchItem {
  key: string;
  label: string;
  state: ItemState;
  /** Only required items count towards "100%". An optional item is shown and never blocks. */
  required: boolean;
  detail: string;
  owner: ItemOwner;
  action?: LaunchAction;
  /** What the client's own part of this step involves (for example the records they add for a domain). Guidance only: it is never a state and never counts as verified. */
  guidance?: string[];
}

export type StepKey = "profile" | "knowledge" | "crm" | "calendar" | "integrations" | "employees" | "verification";
export type StepState = "done" | "in_progress" | "action_required" | "awaiting_review" | "not_applicable";

export interface LaunchStep {
  key: StepKey;
  title: string;
  state: StepState;
  summary: string;
  items: LaunchItem[];
}

export interface LaunchReadiness {
  state: LaunchState;
  label: string;
  headline: string;
  detail: string;
  /** Required, applicable checks that passed over all of them, whole numbers, 100 only when `state` is ready_to_launch. */
  percent: number;
  passed: number;
  total: number;
  steps: LaunchStep[];
  /** Required items that need someone to act (or failed), in step order. */
  blocking: LaunchItem[];
}

// ---------------------------------------------------------------------------
// Facts: what the workspace's own records say. The server reads them; this file only judges them.
// ---------------------------------------------------------------------------

export interface CalendarCheckFact {
  key: "hosts" | "hours" | "timezone" | "types" | "connections" | "slot";
  ok: boolean;
  detail: string;
}

export interface CalendarFacts {
  id: string;
  status: "draft" | "active";
  /** Active hosts assigned to the calendar. */
  hosts: number;
  /** Of those, the hosts that have weekly hours saved. */
  hostsWithHours: number;
  /** The calendar carries suggested weekly hours (from the onboarding answers or a Blueprint) that can be offered to a host for approval. */
  hasSuggestedHours: boolean;
  /** Appointment types that can be booked. */
  types: number;
  /** An appointment type needs a video link from a connected Google or Microsoft account. */
  needsVideoConnection: boolean;
  /** Which provider's account the video appointment types need (Google Meet, Microsoft Teams). Empty when it is not known; absent in older facts. */
  videoProviders?: Array<"google" | "microsoft">;
  /** The activation checks (hosts, hours, time zone, types, connections, a real open time within two weeks), read now; null when they could not be read. */
  checks: CalendarCheckFact[] | null;
  bookingPageOn: boolean;
}

/** "retrying" is a failed attempt that still has attempts left and a retry time: it is tried again by itself, so it is not yet a failure anyone must look at. */
export type ProvisioningFact = "none" | "requested" | "in_progress" | "awaiting_health_check" | "succeeded" | "failed" | "retrying" | "cancelled";

export interface EmployeeFact {
  role: AgentRoleKey;
  /** The role is part of the client's plan (the employee is switched on for this workspace). */
  entitled: boolean;
  /** Provisioning of the employee's own profile, from its persisted job. */
  provisioning: ProvisioningFact;
  /** The job's recorded note. For iAcquire's eyes: the client never reads it. */
  provisioningDetail: string | null;
  /** Attempts the profile job has used, the most it gets, and when the next automatic try is due (null: none is scheduled). */
  attempts: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  /** The employee's last connection check ran and did not pass. */
  healthFailed: boolean;
  /** What that check recorded. For iAcquire's eyes: the client never reads it. */
  healthDetail: string | null;
  readiness: { state: ReadinessState; chatAvailable: boolean; workReady: boolean; description: string; blocking: string[] };
  /** A configuration change for this employee is held for iAcquire's review. */
  heldForReview: boolean;
  /** The applied configuration version the checks below were run against. */
  configVersion: number | null;
}

export type VerificationFact =
  | { role: AgentRoleKey; state: "none" }
  | { role: AgentRoleKey; state: "running" }
  | { role: AgentRoleKey; state: "passed" | "failed"; /** The configuration version the check was run against. */ configVersion: number | null; detail: string | null };

export interface ChannelFact {
  channel: "sms" | "whatsapp" | "email";
  /** The client named it as a way customers reach them. */
  wanted: boolean;
  enabled: boolean;
  registration: string;
  /**
   * What the client wrote as the sender of this channel (their questionnaire answer), or null when they gave none. A hint for the person who connects the channel: it is never
   * verified and never counts towards "connected". Absent (undefined) when the facts did not read it.
   */
  statedSender?: string | null;
  /** A provider credential is stored for the channel. Absent when the facts did not read it. */
  credentialStored?: boolean;
}

/**
 * What the CRM setup evidence says (src/server/setup/native-evidence.ts), judged by the server from the workspace's own records. "none" is nothing applied and nothing failed yet.
 * Only "verified" counts: the newest application of every live Blueprint finished and every record it created is still in the CRM.
 */
export type CrmBlueprintFact = "none" | "verified" | "partial" | "failed" | "missing_records" | "waiting_for_a_person";

export interface LaunchFacts {
  /** The questionnaire was submitted (the workspace's onboarding completed). */
  submitted: boolean;
  /** The setup payment is confirmed (paid or waived). Null: not asked (a sample workspace has no setup fee). */
  paymentCleared: boolean | null;
  /** Whether the person looking can open billing, so the payment line can link to it. */
  canOpenBilling: boolean;
  profile: { companyName: boolean; industry: boolean; description: boolean; timezone: string | null; timezoneAnswered: boolean };
  knowledge: { approved: number; pending: number };
  crm: {
    mode: "native" | "ghl" | "hybrid";
    blueprint: CrmBlueprintFact;
    /** The evidence's client-safe summary for a Blueprint that is not verified. Never the agency's detail. */
    blueprintSummary?: string | null;
    /** The automatic industry setup is switched on in this deployment (it reads the same either way: iAcquire is setting it up). */
    automaticSetup?: boolean;
    /** A non-archived pipeline with at least two non-archived stages, one of them open. */
    pipelineReady: boolean;
    /** Tags, contact fields and forms in the CRM, and whether they match what the Blueprint created. */
    records?: { state: "in_place" | "missing" | "pending"; tags: number; contactFields: number; forms: number };
    providerConnected: boolean;
  };
  /** True: appointments are wanted. False: not wanted. Null: the questionnaire does not say. */
  appointments: { wanted: boolean | null; calendar: CalendarFacts | null; externalCalendarConnected: boolean };
  channels: ChannelFact[];
  employees: EmployeeFact[];
  verification: VerificationFact[];
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

const item = (i: LaunchItem): LaunchItem => i;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function profileStep(f: LaunchFacts): LaunchStep {
  const p = f.profile;
  const complete = p.companyName && p.industry && p.description;
  const zoneOk = p.timezoneAnswered && Boolean(p.timezone) && isValidTimeZone(p.timezone as string);
  const items = [
    item(complete
      ? { key: "profile.company", label: "Company details", state: "done", required: true, owner: "you", detail: "Name, industry and what the business does are saved." }
      : { key: "profile.company", label: "Company details", state: "action_required", required: true, owner: "you", detail: "The company name, industry and description are not all saved yet.", action: { label: "Finish company setup", href: "/onboarding" } }),
    item(zoneOk
      ? { key: "profile.timezone", label: "Business time zone", state: "done", required: true, owner: "you", detail: `Your business time zone is ${p.timezone}.` }
      : { key: "profile.timezone", label: "Business time zone", state: "action_required", required: true, owner: "you", detail: "Confirm the time zone your business works in. Booking times and replies depend on it.", action: { label: "Confirm time zone", href: "/onboarding" } }),
  ];
  return { key: "profile", title: "Business profile", ...summarize(items) };
}

function knowledgeStep(f: LaunchFacts): LaunchStep {
  const { approved, pending } = f.knowledge;
  const items: LaunchItem[] = [];
  if (approved > 0) {
    items.push(item({ key: "knowledge.approved", label: "Approved company knowledge", state: "done", required: true, owner: "you", detail: `${plural(approved, "section is", "sections are")} approved. Your employees use only approved knowledge.` }));
  } else if (pending > 0) {
    // Sensitive wording (prices, policies, promises) is held for iAcquire's review before an employee may use it: the client has done their part.
    items.push(item({ key: "knowledge.approved", label: "Approved company knowledge", state: "awaiting_review", required: true, owner: "iacquire", detail: `${plural(pending, "section is", "sections are")} waiting for iAcquire's review. Nothing is used until it is approved.`, action: { label: "See your knowledge", href: "/knowledge" } }));
  } else {
    items.push(item({ key: "knowledge.approved", label: "Approved company knowledge", state: "action_required", required: true, owner: "you", detail: "No company knowledge has been saved yet.", action: { label: "Add your knowledge", href: "/knowledge" } }));
  }
  if (approved > 0 && pending > 0) {
    items.push(item({ key: "knowledge.pending", label: "More knowledge waiting", state: "awaiting_review", required: false, owner: "iacquire", detail: `${plural(pending, "more section is", "more sections are")} waiting for iAcquire's review. This does not hold up launch.`, action: { label: "See your knowledge", href: "/knowledge" } }));
  }
  return { key: "knowledge", title: "Knowledge and approvals", ...summarize(items) };
}

/** The industry CRM setup, judged from the Blueprint evidence: only a verified one is done, and everything that is not verified is iAcquire's to fix, never the client's. */
function blueprintItem(c: LaunchFacts["crm"]): LaunchItem {
  const base = { key: "crm.blueprint", label: "Industry CRM setup", required: true, owner: "iacquire" } as const;
  const summary = c.blueprintSummary?.trim();
  switch (c.blueprint) {
    case "verified":
      return { ...base, state: "done", detail: "Your pipeline, stages, tags and fields for your industry are in place, and each one was found in your CRM." };
    case "waiting_for_a_person":
      return { ...base, state: "action_required", detail: "A person at iAcquire has to apply your industry starter. Nothing has been added to your CRM yet, and nothing is needed from you." };
    case "failed":
      return { ...base, state: "action_required", detail: summary || "Your industry CRM setup did not finish. iAcquire will review it and apply it again. Nothing is needed from you." };
    case "partial":
      return { ...base, state: "action_required", detail: summary || "Your industry CRM setup was only partly applied. iAcquire will finish it. Nothing is needed from you." };
    case "missing_records":
      return { ...base, state: "action_required", detail: summary || "Some items your CRM setup created are no longer in your CRM. iAcquire will review this with you." };
    case "none":
      return { ...base, state: "in_progress", detail: c.automaticSetup
        ? "Your industry CRM is being set up by iAcquire's automatic setup. Nothing is needed from you."
        : "Your industry CRM is being set up by iAcquire. Nothing is needed from you." };
  }
}

function crmRecordsItem(c: LaunchFacts["crm"]): LaunchItem {
  const base = { key: "crm.records", label: "Tags, contact fields and forms", required: false, owner: "iacquire" } as const;
  const r = c.records;
  if (r?.state === "in_place") return { ...base, state: "done", detail: `Your CRM has ${plural(r.tags, "tag", "tags")}, ${plural(r.contactFields, "contact field", "contact fields")} and ${plural(r.forms, "form", "forms")}, and every one your setup created is there.` };
  if (r?.state === "missing") {
    // Missing records and an unverified Industry CRM setup are the same condition on the server, and that setup line is the one that holds launch up: this line must not say the opposite.
    const heldUp = c.blueprint !== "verified" ? "The Industry CRM setup line above is what holds launch up." : "This does not hold up launch.";
    return { ...base, state: "action_required", detail: `Some tags, fields or forms from your setup are missing from your CRM. iAcquire will review this with you. ${heldUp}` };
  }
  return { ...base, state: "in_progress", detail: "Your tags, contact fields and forms arrive with the CRM setup." };
}

function crmStep(f: LaunchFacts): LaunchStep {
  const c = f.crm;
  const items: LaunchItem[] = [];
  if (c.mode === "native") {
    items.push(item(blueprintItem(c)));
    // A pipeline that exists is done whatever the Blueprint says; one that does not exist is waited for while the setup has not run (or is waiting for a person), and reviewed once it has.
    const waiting = c.blueprint === "none" || c.blueprint === "waiting_for_a_person" || c.blueprint === "failed";
    items.push(item(c.pipelineReady
      ? { key: "crm.pipeline", label: "Sales pipeline", state: "done", required: true, owner: "iacquire", detail: "An active pipeline with at least two stages, one of them open, is ready for your leads and deals." }
      : { key: "crm.pipeline", label: "Sales pipeline", state: waiting ? "in_progress" : "action_required", required: true, owner: "iacquire",
        detail: waiting ? "The pipeline arrives with the CRM setup." : "Your CRM has no active pipeline with at least two stages, one of them open. iAcquire needs to review it." }));
    items.push(item(crmRecordsItem(c)));
  } else {
    items.push(item(c.providerConnected
      ? { key: "crm.provider", label: "CRM connection", state: "done", required: true, owner: "iacquire", detail: "Your CRM provider connection is verified." }
      : { key: "crm.provider", label: "CRM connection", state: "in_progress", required: true, owner: "iacquire", detail: "iAcquire links and verifies your CRM. Nothing is needed from you." }));
  }
  return { key: "crm", title: "CRM and pipeline", ...summarize(items) };
}

/** Where the guided setup sends the person after a Google or Microsoft sign-in: back here (the server accepts only this path and the CRM's own pages). */
export const OAUTH_RETURN_TO_SETUP = "/setup";

/**
 * The button for a missing meeting-tool connection. When the appointment types name exactly one provider, it starts that provider's sign-in and comes back to Setup. When they name
 * both, or the facts do not say, it opens the connections screen, which offers each provider.
 */
function calendarConnectAction(cal: CalendarFacts): LaunchAction {
  const providers = cal.videoProviders ?? [];
  if (providers.length === 1) {
    const provider = providers[0];
    return { label: `Connect ${provider === "google" ? "Google" : "Microsoft"}`, href: `/api/crm/calendar-oauth/${provider}/start?return=${OAUTH_RETURN_TO_SETUP}` };
  }
  return { label: "Connect a calendar", href: "/crm/calendar-connections" };
}

function calendarStep(f: LaunchFacts): LaunchStep {
  const a = f.appointments;
  const title = "Calendar and availability";
  if (a.wanted === false) {
    return { key: "calendar", title, state: "not_applicable", summary: "You said you do not book appointments, so no calendar is needed.", items: [item({ key: "calendar.not_needed", label: "Booking calendar", state: "not_applicable", required: false, owner: "you", detail: "Not needed for your business. If that changes, say so in your company setup." })] };
  }
  if (a.wanted === null) {
    return { key: "calendar", title, ...summarize([item({ key: "calendar.question", label: "Appointments", state: "action_required", required: true, owner: "you", detail: "Tell us whether your business books appointments.", action: { label: "Answer in company setup", href: "/onboarding" } })]) };
  }
  if (f.crm.mode !== "native") {
    return { key: "calendar", title, ...summarize([item(a.externalCalendarConnected
      ? { key: "calendar.external", label: "Booking calendar", state: "done", required: true, owner: "iacquire", detail: "Your calendar connection is verified." }
      : { key: "calendar.external", label: "Booking calendar", state: "in_progress", required: true, owner: "iacquire", detail: "iAcquire connects and verifies your calendar. Nothing is needed from you." })]) };
  }
  const cal = a.calendar;
  if (!cal) {
    return { key: "calendar", title, ...summarize([item({ key: "calendar.draft", label: "Booking calendar", state: "action_required", required: true, owner: "you", detail: "No booking calendar exists yet. Create one with your appointment types.", action: { label: "Open Calendars & Types", href: "/crm/calendars" } })]) };
  }
  const failed = (key: CalendarCheckFact["key"]) => cal.checks?.find((c) => c.key === key && !c.ok) ?? null;
  const items: LaunchItem[] = [];
  items.push(item(cal.hosts > 0
    ? { key: "calendar.host", label: "Host", state: "done", required: true, owner: "you", detail: `${plural(cal.hosts, "person takes", "people take")} appointments on this calendar.` }
    : { key: "calendar.host", label: "Host", state: "action_required", required: true, owner: "you", detail: "Choose who takes your appointments. We never pick a host for you.", action: { label: "Make me the host", intent: "assign_host" } }));
  if (cal.hosts === 0) {
    items.push(item({ key: "calendar.hours", label: "Host availability", state: "in_progress", required: true, owner: "you", detail: "Set after you choose a host. We never invent working hours." }));
  } else if (cal.hostsWithHours >= cal.hosts) {
    items.push(item({ key: "calendar.hours", label: "Host availability", state: "done", required: true, owner: "you", detail: "Every host has weekly hours saved." }));
  } else {
    const missing = cal.hosts - cal.hostsWithHours;
    items.push(item({ key: "calendar.hours", label: "Host availability", state: "action_required", required: true, owner: "you",
      detail: cal.hasSuggestedHours
        ? `${plural(missing, "host has", "hosts have")} no weekly hours. Approve the hours from your company setup, or set your own.`
        : `${plural(missing, "host has", "hosts have")} no weekly hours. Set them in Availability.`,
      action: cal.hasSuggestedHours ? { label: "Approve suggested hours", intent: "apply_hours" } : { label: "Set hours", href: "/crm/availability" } }));
  }
  items.push(item(cal.types > 0
    ? { key: "calendar.types", label: "Appointment types", state: "done", required: true, owner: "you", detail: `${plural(cal.types, "appointment type is", "appointment types are")} ready to book.` }
    : { key: "calendar.types", label: "Appointment types", state: "action_required", required: true, owner: "you", detail: "Add at least one appointment type.", action: { label: "Open Calendars & Types", href: `/crm/calendars/${cal.id}` } }));
  if (cal.needsVideoConnection && !a.externalCalendarConnected) {
    items.push(item({ key: "calendar.connection", label: "Google or Microsoft connection", state: "action_required", required: true, owner: "you", detail: "A video appointment needs a connected Google or Microsoft account to make the meeting link.", action: calendarConnectAction(cal) }));
  }
  // The checks that need everything above: shown once there is a host, read live, never remembered.
  const slot = failed("slot");
  const others = (["timezone", "connections"] as const).map(failed).filter((c): c is CalendarCheckFact => c !== null);
  if (cal.status === "active") {
    items.push(item({ key: "calendar.verified", label: "Real open time verified", state: slot ? "failed" : "done", required: true, owner: "you", detail: slot ? slot.detail : "A real open time was found within the next two weeks." }));
    items.push(item({ key: "calendar.active", label: "Calendar active", state: "done", required: true, owner: "you", detail: "The calendar is active. Its booking page stays off until you turn it on." }));
  } else if (cal.hosts > 0 && cal.hostsWithHours >= cal.hosts && cal.types > 0) {
    const problem = slot ?? others[0] ?? null;
    items.push(item({ key: "calendar.verified", label: "Real open time verified", state: problem ? "action_required" : cal.checks ? "done" : "in_progress", required: true, owner: "you",
      detail: problem ? problem.detail : cal.checks ? "A real open time was found within the next two weeks." : "Run the checks to prove a real time would be offered.",
      ...(problem ? { action: { label: problem.key === "connections" ? "Review connections" : "Review hours", href: problem.key === "connections" ? "/crm/calendar-connections" : "/crm/availability" } } : {}) }));
    items.push(item({ key: "calendar.active", label: "Calendar active", state: "action_required", required: true, owner: "you", detail: "Check and activate the calendar. This does not turn on a public booking page.", action: { label: "Check and activate", intent: "activate_calendar" } }));
  } else {
    items.push(item({ key: "calendar.verified", label: "Real open time verified", state: "in_progress", required: true, owner: "you", detail: "Runs after a host, weekly hours and an appointment type are in place." }));
    items.push(item({ key: "calendar.active", label: "Calendar active", state: "in_progress", required: true, owner: "you", detail: "Activation follows the checks. The calendar takes no bookings until then." }));
  }
  items.push(item({ key: "calendar.public", label: "Public booking page", state: "done", required: false, owner: "you", detail: cal.bookingPageOn ? "Your public booking page is on." : "Your public booking page is off. Customers cannot book until you turn it on yourself." }));
  return { key: "calendar", title, ...summarize(items) };
}

const CHANNEL_LABEL: Record<ChannelFact["channel"], string> = { sms: "SMS", whatsapp: "WhatsApp", email: "Email" };
/** Where a client sees each channel's status. Setting a channel up (the credential, the provider test, switching it on) is iAcquire's job, so nothing here is a "connect" button. */
const CHANNEL_HREF: Record<ChannelFact["channel"], string> = { sms: "/settings/messaging", whatsapp: "/settings/messaging", email: "/settings/messaging" };
const CHANNEL_SENDER_NOUN: Record<ChannelFact["channel"], string> = { sms: "text number", whatsapp: "WhatsApp number", email: "sending address" };

/**
 * What the client's own part of connecting a channel involves, in plain words. Guidance only: it describes the outside steps and proves nothing, so it is never a state and
 * never makes a channel look connected. The panel shows it only for a channel the client said they want that is not connected yet.
 */
export function connectionSteps(channel: ChannelFact["channel"]): string[] {
  switch (channel) {
    case "email":
      return ["iAcquire sends you the DNS records for your sending domain. You add them where your domain is managed.", "Nothing is sent from your domain until iAcquire has verified it."];
    case "sms":
      return ["Confirm the business details iAcquire needs to register your number with the carrier.", "Approve the registration and number fees iAcquire tells you about before anything is charged.", "Texts start only after the carrier approves the registration."];
    case "whatsapp":
      return ["Have an approved Meta (Facebook) Business account for your company.", "iAcquire connects your WhatsApp Business number once Meta approves it.", "Nothing is sent on WhatsApp until the connection is verified."];
  }
}

export function channelIsReady(c: Pick<ChannelFact, "channel" | "enabled" | "registration">): boolean {
  if (!c.enabled) return false;
  // Email has no registration; SMS and WhatsApp count once their carrier registration is approved (the database refuses to enable them otherwise).
  return c.channel === "email" || c.registration === "approved" || c.registration === "not_required";
}

function integrationsStep(f: LaunchFacts): LaunchStep {
  const wanted = f.channels.filter((c) => c.wanted);
  if (!wanted.length) {
    return { key: "integrations", title: "Required integrations", state: "not_applicable", summary: "You have not asked for a customer channel, so nothing needs connecting yet.", items: [item({ key: "integrations.none", label: "Customer channels", state: "not_applicable", required: false, owner: "you", detail: "Email, SMS and WhatsApp are connected only when you choose them in your company setup." })] };
  }
  return { key: "integrations", title: "Required integrations", ...summarize(wanted.map((c) => item(channelItem(c)))) };
}

/**
 * One customer channel the client asked for. The split of who moves next follows who can: the client gives the sender and any carrier or Meta paperwork; iAcquire stores the
 * provider credential, runs the provider's test and switches the channel on, so those are never a button for the client. What the client wrote as their sender is shown as what
 * they said and never makes the channel look connected: only the recorded provider test and an approved registration do (channelIsReady).
 */
function channelItem(c: ChannelFact): LaunchItem {
  const key = `integrations.${c.channel}`;
  const label = CHANNEL_LABEL[c.channel];
  if (channelIsReady(c)) return { key, label, state: "done", required: true, owner: "iacquire", detail: `${label} is connected and verified.` };
  const stated = c.statedSender?.trim() ? ` You told us your ${CHANNEL_SENDER_NOUN[c.channel]}: ${c.statedSender.trim()}. iAcquire still verifies it.` : "";
  const guidance = connectionSteps(c.channel);
  if (c.registration === "rejected") {
    return { key, label, state: "action_required", required: true, owner: "you", guidance,
      detail: `${label} registration was rejected. Review the details with iAcquire and send them again. Nothing is sent until it is approved.${stated}`,
      action: { label: "See channel status", href: CHANNEL_HREF[c.channel] } };
  }
  // A text number can be left blank in the questionnaire (iAcquire helps get one); an email address or a WhatsApp number cannot be connected without the client's own.
  if (c.statedSender === null && c.channel !== "sms") {
    return { key, label, state: "action_required", required: true, owner: "you", guidance,
      detail: `Tell us which ${CHANNEL_SENDER_NOUN[c.channel]} to use. iAcquire connects and verifies it, and nothing is sent until it is verified.`,
      action: { label: "Add your sender", href: "/onboarding" } };
  }
  if (c.registration === "pending") {
    return { key, label, state: "in_progress", required: true, owner: "iacquire", guidance,
      detail: `${label} registration is with ${c.channel === "whatsapp" ? "Meta" : "the carrier"}, and iAcquire is following it. Nothing is sent until it is approved.${stated}` };
  }
  return { key, label, state: "in_progress", required: true, owner: "iacquire", guidance,
    detail: c.credentialStored
      ? `iAcquire has saved the credentials for ${label} and still has to test it and switch it on. Nothing is sent until it is verified and switched on.${stated}`
      : `iAcquire connects, tests and switches on your ${label} sender. Nothing is sent until it is verified.${stated}` };
}

function employeeItem(f: LaunchFacts, e: EmployeeFact): LaunchItem {
  const meta = AGENT_BY_KEY[e.role];
  const key = `employees.${e.role}`;
  const label = meta.shortName;
  if (!e.entitled) return { key, label, state: "not_applicable", required: false, owner: "iacquire", detail: "Not part of your plan, so it does not hold up launch." };
  if (e.role === "appointment_setter" && f.appointments.wanted === false) return { key, label, state: "not_applicable", required: false, owner: "you", detail: "You do not book appointments, so this employee has nothing to prepare yet." };
  if (e.readiness.workReady) return { key, label, state: "done", required: true, owner: "system", detail: "Its profile, identity, tools and connection are verified, and what its role needs from your business is in place." };
  if (f.paymentCleared === false && e.provisioning === "none") {
    return { key, label, state: "action_required", required: true, owner: "you", detail: "Starts after your setup payment is confirmed.", ...(f.canOpenBilling ? { action: { label: "Open billing", href: "/settings/billing" } } : {}) };
  }
  if (e.heldForReview) return { key, label, state: "awaiting_review", required: true, owner: "iacquire", detail: "A configuration change is waiting for iAcquire's review. Nothing runs on it until it is approved." };
  // The attempt count is what the job recorded; the raw failure note and the check's own words are for iAcquire and are never put in front of the client.
  if (e.provisioning === "failed") {
    const used = e.attempts > 0 ? ` (${e.attempts} of ${e.maxAttempts} attempts used)` : "";
    return { key, label, state: "failed", required: true, owner: "iacquire", detail: `Setting up its profile did not finish${used}. iAcquire can review it and retry. Nothing is needed from you.` };
  }
  if (e.provisioning === "retrying") {
    const next = Math.min(e.attempts + 1, e.maxAttempts);
    return { key, label, state: "in_progress", required: true, owner: "system", detail: `Attempt ${next} of ${e.maxAttempts}: setting up its profile hit a temporary problem and is being tried again automatically. Nothing is needed from you, and iAcquire is told if it does not recover.` };
  }
  if (e.provisioning === "requested") return { key, label, state: "in_progress", required: true, owner: "system", detail: "Its dedicated profile is queued. It is not ready until its identity and tools are verified." };
  if (e.provisioning === "in_progress") return { key, label, state: "in_progress", required: true, owner: "system", detail: "Its dedicated profile is being created. Verification has not passed yet." };
  // A check that ran and did not pass is a failure someone has to look at, never "being verified": waiting stays in progress only while no check has failed.
  if (e.healthFailed) return { key, label, state: "action_required", required: true, owner: "iacquire", detail: "Its profile exists, but its last connection check did not pass, so it is not ready. iAcquire can review it and retry. Nothing is needed from you." };
  if (e.provisioning === "awaiting_health_check") return { key, label, state: "in_progress", required: true, owner: "system", detail: "Its profile exists. Its connection and tool inventory are being verified." };
  if (e.readiness.chatAvailable && e.readiness.blocking.length) {
    return { key, label, state: "action_required", required: true, owner: "you", detail: `Verified and waiting for what its role needs: ${e.readiness.blocking.join("; ")}.` };
  }
  if (e.provisioning === "cancelled" || e.provisioning === "none") return { key, label, state: "in_progress", required: true, owner: "iacquire", detail: "Not started. iAcquire will start it once setup allows." };
  return { key, label, state: "action_required", required: true, owner: "iacquire", detail: e.readiness.description };
}

function employeesStep(f: LaunchFacts): LaunchStep {
  const byRole = new Map(f.employees.map((e) => [e.role, e]));
  // A role with no record at all is an employee that was never created: that is something iAcquire must look at, never a quiet "not applicable".
  const missing = (role: AgentRoleKey): EmployeeFact => ({ role, entitled: true, provisioning: "succeeded", provisioningDetail: null, attempts: 0, maxAttempts: 3, nextRetryAt: null, healthFailed: false, healthDetail: null, readiness: { state: "pending_setup", chatAvailable: false, workReady: false, description: "This employee has not been created. iAcquire needs to review the workspace.", blocking: [] }, heldForReview: false, configVersion: null });
  const items = AGENT_ROLE_KEYS.map((role) => employeeItem(f, byRole.get(role) ?? missing(role)));
  // The title counts what the plan includes, the way the review does, so the two screens agree.
  const included = AGENT_ROLE_KEYS.filter((role) => byRole.get(role)?.entitled ?? true).length;
  const title = included === AGENT_ROLE_KEYS.length ? `Your ${countWord(included)} AI employees` : included === 0 ? "Your AI employees" : `Your ${countWord(included)} AI employee${included === 1 ? "" : "s"}`;
  return { key: "employees", title, ...summarize(items) };
}

function verificationStep(f: LaunchFacts): LaunchStep {
  const verification = new Map(f.verification.map((v) => [v.role, v]));
  const employees = new Map(f.employees.map((e) => [e.role, e]));
  const items: LaunchItem[] = [];
  for (const role of AGENT_ROLE_KEYS) {
    const e = employees.get(role);
    const key = `verification.${role}`;
    const label = AGENT_BY_KEY[role].shortName;
    if (!e || !e.entitled || (role === "appointment_setter" && f.appointments.wanted === false)) {
      items.push(item({ key, label, state: "not_applicable", required: false, owner: "system", detail: "Not part of your plan, so nothing to check." }));
      continue;
    }
    if (!e.readiness.workReady) {
      // A check that waits on a review waits on that review, not on "provisioning": the two must not be mixed up in the overall state.
      items.push(item(e.heldForReview
        ? { key, label, state: "awaiting_review", required: true, owner: "iacquire", detail: "The check runs after iAcquire reviews this employee's configuration change." }
        : { key, label, state: "in_progress", required: true, owner: "system", detail: "The check runs once this employee is ready for authorized work." }));
      continue;
    }
    const v = verification.get(role) ?? { role, state: "none" as const };
    if (v.state === "running") items.push(item({ key, label, state: "in_progress", required: true, owner: "system", detail: "A read-only check on your real records is running." }));
    else if (v.state === "none") items.push(item({ key, label, state: "action_required", required: true, owner: "you", detail: "Not checked yet. The check reads your real records and changes nothing.", action: { label: "Run final checks", intent: "run_checks" } }));
    // A result for an older configuration says nothing about this one, whether it passed or failed: the check runs again (the sweep starts it by itself).
    else if (v.configVersion !== e.configVersion) items.push(item({ key, label, state: "action_required", required: true, owner: "you", detail: "Its configuration changed since the last check, so the check needs to run again.", action: { label: "Run final checks", intent: "run_checks" } }));
    else if (v.state === "passed") items.push(item({ key, label, state: "done", required: true, owner: "system", detail: v.detail ?? "A read-only check on your real records completed. Nothing was changed or sent." }));
    else items.push(item({ key, label, state: "failed", required: true, owner: "you", detail: v.detail ?? "The check did not pass.", action: { label: "Run final checks", intent: "run_checks" } }));
  }
  return { key: "verification", title: "Functional verification", ...summarize(items) };
}

// ---------------------------------------------------------------------------
// Roll-up
// ---------------------------------------------------------------------------

function summarize(items: LaunchItem[]): { state: StepState; summary: string; items: LaunchItem[] } {
  const applicable = items.filter((i) => i.state !== "not_applicable");
  if (!applicable.length) return { state: "not_applicable", summary: "Does not apply to your business.", items };
  const required = applicable.filter((i) => i.required);
  const watched = required.length ? required : applicable;
  const done = watched.filter((i) => i.state === "done").length;
  let state: StepState;
  if (watched.some((i) => i.state === "action_required" || i.state === "failed")) state = "action_required";
  else if (watched.some((i) => i.state === "in_progress")) state = "in_progress";
  else if (watched.some((i) => i.state === "awaiting_review")) state = "awaiting_review";
  else state = "done";
  return { state, summary: state === "done" ? "Complete." : `${done} of ${watched.length} checks passed.`, items };
}

export function deriveLaunchReadiness(f: LaunchFacts): LaunchReadiness {
  const steps: LaunchStep[] = [profileStep(f), knowledgeStep(f), crmStep(f), calendarStep(f), integrationsStep(f), employeesStep(f), verificationStep(f)];
  const required = steps.flatMap((s) => s.items).filter((i) => i.required && i.state !== "not_applicable");
  const passed = required.filter((i) => i.state === "done").length;
  const total = required.length;
  const blocking = required.filter((i) => i.state === "action_required" || i.state === "failed");
  const base = { passed, total, steps, blocking };

  if (!f.submitted) {
    return { ...base, state: "not_started", label: LAUNCH_STATE_LABEL.not_started, headline: "Start with your company information", detail: "Answer a few short questions about your business once. Everything else is set up from your answers.", percent: 0 };
  }
  const percentOf = (n: number, d: number) => (d === 0 ? 0 : Math.floor((n / d) * 100));
  if (f.paymentCleared === false) {
    return { ...base, state: "questionnaire_submitted", label: LAUNCH_STATE_LABEL.questionnaire_submitted, headline: "Questionnaire submitted", detail: "Your answers are saved. Your AI team and the rest of your setup start after your setup payment is confirmed.", percent: percentOf(passed, total) };
  }
  const youBlocking = blocking.filter((i) => i.owner === "you").length;
  const iacquireBlocking = blocking.filter((i) => i.owner !== "you").length;
  if (blocking.length) {
    const parts = [youBlocking ? `${plural(youBlocking, "thing needs", "things need")} you` : null, iacquireBlocking ? `${plural(iacquireBlocking, "needs", "need")} iAcquire's attention` : null].filter(Boolean).join(" and ");
    return { ...base, state: "action_required", label: LAUNCH_STATE_LABEL.action_required, headline: "Action required", detail: `${parts}. Everything else keeps running.`, percent: percentOf(passed, total) };
  }
  const running = required.filter((i) => i.state === "in_progress").length;
  if (running) {
    return { ...base, state: "provisioning", label: LAUNCH_STATE_LABEL.provisioning, headline: "Setting up your business", detail: `${passed} of ${total} checks have passed. ${plural(running, "check is", "checks are")} still running; nothing is needed from you right now.`, percent: percentOf(passed, total) };
  }
  const waiting = required.filter((i) => i.state === "awaiting_review").length;
  if (waiting) {
    return { ...base, state: "ready_for_review", label: LAUNCH_STATE_LABEL.ready_for_review, headline: "Ready for review", detail: `Every automatic check has passed. ${plural(waiting, "item is", "items are")} waiting for iAcquire's review before you can launch.`, percent: percentOf(passed, total) };
  }
  // Every applicable, required check passed. A workspace with nothing required to check never reaches "100%": that would be a green badge with nothing behind it.
  if (total === 0) {
    return { ...base, state: "provisioning", label: LAUNCH_STATE_LABEL.provisioning, headline: "Setting up your business", detail: "Nothing has been checked yet.", percent: 0 };
  }
  return { ...base, state: "ready_to_launch", label: LAUNCH_STATE_LABEL.ready_to_launch, headline: "100% Ready to Launch", detail: "Every applicable setup and verification check has passed. Nothing customer-facing is switched on until you turn it on.", percent: 100 };
}
