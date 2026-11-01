import { AGENT_BY_KEY, AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { isValidTimeZone } from "@/lib/calendars/slots";
import type { ReadinessState } from "@/lib/workforce-readiness";

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
  /** The activation checks (hosts, hours, time zone, types, connections, a real open time within two weeks), read now; null when they could not be read. */
  checks: CalendarCheckFact[] | null;
  bookingPageOn: boolean;
}

export type ProvisioningFact = "none" | "requested" | "in_progress" | "awaiting_health_check" | "succeeded" | "failed" | "cancelled";

export interface EmployeeFact {
  role: AgentRoleKey;
  /** The role is part of the client's plan (the employee is switched on for this workspace). */
  entitled: boolean;
  /** Provisioning of the employee's own profile, from its persisted job. */
  provisioning: ProvisioningFact;
  provisioningDetail: string | null;
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
}

export interface LaunchFacts {
  /** The questionnaire was submitted (the workspace's onboarding completed). */
  submitted: boolean;
  /** The setup payment is confirmed (paid or waived). Null: not asked (a sample workspace has no setup fee). */
  paymentCleared: boolean | null;
  /** Whether the person looking can open billing, so the payment line can link to it. */
  canOpenBilling: boolean;
  profile: { companyName: boolean; industry: boolean; description: boolean; timezone: string | null; timezoneAnswered: boolean };
  knowledge: { approved: number; pending: number };
  crm: { mode: "native" | "ghl" | "hybrid"; blueprintApplied: boolean; pipelineReady: boolean; providerConnected: boolean };
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

function crmStep(f: LaunchFacts): LaunchStep {
  const c = f.crm;
  const items: LaunchItem[] = [];
  if (c.mode === "native") {
    items.push(item(c.blueprintApplied
      ? { key: "crm.blueprint", label: "Industry CRM setup", state: "done", required: true, owner: "iacquire", detail: "Your pipeline, stages, tags and fields for your industry are in place." }
      : { key: "crm.blueprint", label: "Industry CRM setup", state: "in_progress", required: true, owner: "iacquire", detail: "iAcquire applies the CRM setup for your industry. Nothing is needed from you." }));
    items.push(item(c.pipelineReady
      ? { key: "crm.pipeline", label: "Sales pipeline", state: "done", required: true, owner: "iacquire", detail: "An active pipeline with stages is ready for your leads and deals." }
      : { key: "crm.pipeline", label: "Sales pipeline", state: c.blueprintApplied ? "action_required" : "in_progress", required: true, owner: "iacquire",
        detail: c.blueprintApplied ? "The CRM setup is applied but has no active pipeline stage. iAcquire needs to review it." : "The pipeline arrives with the CRM setup." }));
  } else {
    items.push(item(c.providerConnected
      ? { key: "crm.provider", label: "CRM connection", state: "done", required: true, owner: "iacquire", detail: "Your CRM provider connection is verified." }
      : { key: "crm.provider", label: "CRM connection", state: "in_progress", required: true, owner: "iacquire", detail: "iAcquire links and verifies your CRM. Nothing is needed from you." }));
  }
  return { key: "crm", title: "CRM and pipeline", ...summarize(items) };
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
    items.push(item({ key: "calendar.connection", label: "Google or Microsoft connection", state: "action_required", required: true, owner: "you", detail: "A video appointment needs a connected Google or Microsoft account to make the meeting link.", action: { label: "Connect a calendar", href: "/crm/calendar-connections" } }));
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
const CHANNEL_HREF: Record<ChannelFact["channel"], string> = { sms: "/inbox/settings", whatsapp: "/inbox/settings", email: "/inbox/settings" };

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
  const items = wanted.map((c) => item(channelIsReady(c)
    ? { key: `integrations.${c.channel}`, label: CHANNEL_LABEL[c.channel], state: "done", required: true, owner: "you", detail: `${CHANNEL_LABEL[c.channel]} is connected and verified.` }
    : { key: `integrations.${c.channel}`, label: CHANNEL_LABEL[c.channel], state: "action_required", required: true, owner: "you",
      detail: c.channel === "email" ? "Connect and verify your sending address."
        : c.registration === "pending" ? `${CHANNEL_LABEL[c.channel]} registration is with the carrier. Nothing is sent until it is approved.`
        : c.registration === "rejected" ? `${CHANNEL_LABEL[c.channel]} registration was rejected. Review it and send it again. Nothing is sent until it is approved.`
        : `Connect ${CHANNEL_LABEL[c.channel]}. Nothing is sent until it is verified.`,
      action: { label: `Connect ${CHANNEL_LABEL[c.channel]}`, href: CHANNEL_HREF[c.channel] } }));
  return { key: "integrations", title: "Required integrations", ...summarize(items) };
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
  if (e.provisioning === "failed") return { key, label, state: "failed", required: true, owner: "iacquire", detail: "Setting up its profile failed. iAcquire can review the recorded error and retry safely." };
  if (e.provisioning === "requested") return { key, label, state: "in_progress", required: true, owner: "system", detail: "Its dedicated profile is queued. It is not ready until its identity and tools are verified." };
  if (e.provisioning === "in_progress") return { key, label, state: "in_progress", required: true, owner: "system", detail: "Its dedicated profile is being created. Verification has not passed yet." };
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
  const missing = (role: AgentRoleKey): EmployeeFact => ({ role, entitled: true, provisioning: "succeeded", provisioningDetail: null, readiness: { state: "pending_setup", chatAvailable: false, workReady: false, description: "This employee has not been created. iAcquire needs to review the workspace.", blocking: [] }, heldForReview: false, configVersion: null });
  const items = AGENT_ROLE_KEYS.map((role) => employeeItem(f, byRole.get(role) ?? missing(role)));
  return { key: "employees", title: "Your six AI employees", ...summarize(items) };
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
    else if (v.state === "passed" && v.configVersion === e.configVersion) items.push(item({ key, label, state: "done", required: true, owner: "system", detail: v.detail ?? "A read-only check on your real records completed. Nothing was changed or sent." }));
    // A result for an older configuration says nothing about this one, whether it passed or failed: the check runs again (the sweep starts it by itself).
    else if (v.configVersion !== e.configVersion) items.push(item({ key, label, state: "action_required", required: true, owner: "you", detail: "Its configuration changed since the last check, so the check needs to run again.", action: { label: "Run final checks", intent: "run_checks" } }));
    else if (v.state === "failed") items.push(item({ key, label, state: "failed", required: true, owner: "you", detail: v.detail ?? "The check did not pass.", action: { label: "Run final checks", intent: "run_checks" } }));
    else items.push(item({ key, label, state: "action_required", required: true, owner: "you", detail: "Not checked yet. The check reads your real records and changes nothing.", action: { label: "Run final checks", intent: "run_checks" } }));
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
