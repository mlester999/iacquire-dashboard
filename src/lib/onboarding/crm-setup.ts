// The client's CRM setup guide: steps, statuses and answers, computed from facts the server read from real rows. Pure (no I/O), so the
// server and the screen derive exactly the same statuses, and the screen can re-derive them as the person answers a question.
//
// Honesty rules:
//   - A status comes from evidence only. "Verified" needs a passed capability test or connector evidence (a live provider test, a calendar
//     that produced a real open time, a Blueprint manifest that matches, a completed workflow run). Saving a key, a number or an answer never
//     verifies anything.
//   - Steps for a capability GoHighLevel owns are left out (they are managed there), and so are scheduling steps for a business that doesn't
//     take appointments. GoHighLevel is never required.
//   - The client never activates the system: the last step hands off to the agency's final review.
import { z } from "zod";

export const CRM_SETUP_STATUSES = ["not_started", "in_progress", "needs_client_action", "needs_agency_action", "configured", "verified", "failed"] as const;
export type CrmSetupStatus = (typeof CRM_SETUP_STATUSES)[number];

export const CRM_SETUP_STATUS_LABEL: Record<CrmSetupStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  needs_client_action: "Needs client action",
  needs_agency_action: "Needs agency action",
  configured: "Configured",
  verified: "Verified",
  failed: "Failed",
};

export const CRM_SETUP_STATUS_TONE: Record<CrmSetupStatus, "neutral" | "primary" | "success" | "warning" | "danger" | "violet"> = {
  not_started: "neutral",
  in_progress: "primary",
  needs_client_action: "warning",
  needs_agency_action: "violet",
  configured: "primary",
  verified: "success",
  failed: "danger",
};

/** Every step, in order. The guide shows the ones that apply (applicableSteps). */
export const CRM_SETUP_STEP_KEYS = ["provider", "blueprint", "fields", "pipelines", "tags", "calendar", "scheduling", "communications", "workflows", "ai_roles", "verify", "review"] as const;
export type CrmSetupStepKey = (typeof CRM_SETUP_STEP_KEYS)[number];
export const isCrmSetupStep = (v: unknown): v is CrmSetupStepKey => typeof v === "string" && (CRM_SETUP_STEP_KEYS as readonly string[]).includes(v);

export const CALENDAR_SOURCES = ["google", "microsoft", "caldav", "ics", "iacquire"] as const;
export type CalendarSource = (typeof CALENDAR_SOURCES)[number];
export const CALENDAR_SOURCE_LABEL: Record<CalendarSource, string> = {
  google: "Google Calendar",
  microsoft: "Microsoft 365 / Outlook",
  caldav: "Apple iCloud or another CalDAV calendar",
  ics: "A read-only calendar feed (ICS)",
  iacquire: "No outside calendar: use the iAcquire calendar only",
};

export const GUIDE_CHANNELS = ["email", "sms", "whatsapp"] as const;
export type GuideChannel = (typeof GUIDE_CHANNELS)[number];
export const GUIDE_CHANNEL_LABEL: Record<GuideChannel, string> = { email: "Email", sms: "SMS", whatsapp: "WhatsApp" };

/** What the person told the guide. Every field is optional: unanswered questions fall back to onboarding answers, then to "not started". */
export const crmSetupAnswersSchema = z.strictObject({
  appointments: z.boolean().nullable().optional(),
  calendarSource: z.enum(CALENDAR_SOURCES).nullable().optional(),
  channels: z.array(z.enum(GUIDE_CHANNELS)).max(GUIDE_CHANNELS.length).refine((c) => new Set(c).size === c.length, "Choose each channel once.").optional(),
});
export type CrmSetupAnswers = z.infer<typeof crmSetupAnswersSchema>;

/** Stored answers that no longer validate are dropped field by field, never trusted. */
export function cleanAnswers(raw: unknown): CrmSetupAnswers {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: CrmSetupAnswers = {};
  for (const key of ["appointments", "calendarSource", "channels"] as const) {
    if (!(key in src)) continue;
    const one = crmSetupAnswersSchema.safeParse({ [key]: src[key] });
    if (one.success) Object.assign(out, one.data);
  }
  return out;
}

type Owner = "native" | "ghl";
type Level = "verified" | "failed" | "unverified";

/** Real facts about one workspace, read by the server. Client-safe: summaries only, never agency-only detail or anyone's contact data. */
export interface CrmSetupFacts {
  mode: "native" | "ghl" | "hybrid";
  switching: boolean;
  owners: { config: Owner; calendars: Owner; conversations: Owner; workflows: Owner };
  ghl: { mapped: boolean; check: "verified" | "failed" | "unverified" | "attested" | null };
  provider: { chosenAt: string | null; canChoose: boolean; lockedReason: string | null };
  blueprint: {
    level: Level;
    summary: string;
    applied: Array<{ name: string; version: number; status: string; appliedAt: string }>;
    partial: boolean;
    /**
     * The Blueprint's own setup checklist (CRM → Settings → Blueprints & setup, src/server/crm/blueprints/checklist.ts): `required` items
     * still pending, items done of the counted total, and the first pending required items' labels (labels only, never their detail).
     */
    open: { required: number; done: number; total: number; labels: string[] };
  };
  dataModel: {
    /** Null when no Blueprint gives an expected manifest. */
    level: Level | null;
    missing: { pipeline: number; stage: number; tag: number; customField: number; form: number };
    /** What the live Blueprints created or linked, per type. A step can only "match your Blueprint" when its type was expected. */
    expected: { pipeline: number; stage: number; tag: number; customField: number; form: number };
    /** Of the expected custom fields, the contact fields. */
    expectedContactFields: number;
    contactFields: number;
    pipelines: number;
    pipelinesWithStages: number;
    stages: number;
    tags: number;
  };
  calendar: {
    level: Level;
    summary: string;
    /**
     * `readsBusy`: conflict checking is on, so busy times are read. `fresh` / `synced`: a successful busy read in the last day / ever (a
     * failed or no-op sync attempt never counts).
     */
    connections: Array<{ provider: "google" | "microsoft" | "caldav" | "ics"; status: "connected" | "needs_reauth" | "error"; readsBusy: boolean; fresh: boolean; synced: boolean }>;
    activeCalendars: number;
    draftCalendars: number;
    verifiedCalendars: number;
    bookableCalendars: number;
    firstIssue: string | null;
  };
  channels: Record<GuideChannel, { level: Level; summary: string; native: boolean; credentialStored: boolean; tested: boolean; enabled: boolean }>;
  workflows: { level: Level; summary: string; total: number; drafts: number; active: number; awaitingApproval: number; proven: number; failing: number };
  ai: { level: Level; summary: string; enabled: number; ready: number; failing: number; notReady: number };
  checks: { applicable: number; verified: number; failed: number; lastRunAt: string | null };
  setup: { state: "in_setup" | "ready_for_review" | "activated" | null; percent: number | null; clientActions: number; readyRequestedAt: string | null };
  /** Answers from company onboarding, used until the guide's own question is answered. */
  prefill: { appointments: boolean | null; channels: GuideChannel[] };
}

export interface CrmSetupLink {
  label: string;
  /** A path below the CRM ("/fields"), or a portal path when `portal` ("/setup"). */
  path: string;
  portal?: boolean;
}

export type CrmSetupQuestion = "provider" | "appointments" | "calendarSource" | "channels";

export interface CrmSetupStep {
  key: CrmSetupStepKey;
  title: string;
  /** One sentence on why the step matters. */
  intro: string;
  status: CrmSetupStatus;
  /** What the evidence shows right now. */
  summary: string;
  /** Who acts next, when someone has to. */
  next: string | null;
  questions: CrmSetupQuestion[];
  links: CrmSetupLink[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The answer that counts: the guide's own, else what onboarding said. */
export function effectiveAnswers(facts: CrmSetupFacts, answers: CrmSetupAnswers): { appointments: boolean | null; calendarSource: CalendarSource | null; channels: GuideChannel[] | null } {
  const appointments = answers.appointments ?? facts.prefill.appointments;
  const fromConnection = facts.calendar.connections[0]?.provider ?? null;
  return {
    appointments: appointments ?? null,
    calendarSource: answers.calendarSource ?? fromConnection,
    channels: answers.channels ?? (facts.prefill.channels.length ? facts.prefill.channels : null),
  };
}

/** The steps that apply to this workspace, in order. */
export function applicableSteps(facts: CrmSetupFacts, answers: CrmSetupAnswers): CrmSetupStepKey[] {
  const a = effectiveAnswers(facts, answers);
  return CRM_SETUP_STEP_KEYS.filter((k) => {
    switch (k) {
      case "blueprint":
      case "fields":
      case "pipelines":
      case "tags":
        return facts.owners.config === "native";
      case "calendar":
        return facts.owners.calendars === "native";
      case "scheduling":
        return facts.owners.calendars === "native" && a.appointments !== false;
      case "communications":
        return facts.owners.conversations === "native";
      case "workflows":
        return facts.owners.workflows === "native";
      default:
        return true;
    }
  });
}

/**
 * Resumes exactly where the person left off. If that step no longer applies (they said they don't take appointments, say), the next step
 * after it that does; failing that, the first one.
 */
export function resolveGuideStep(saved: string | null | undefined, applicable: CrmSetupStepKey[]): CrmSetupStepKey {
  if (!applicable.length) return "provider";
  if (isCrmSetupStep(saved)) {
    if (applicable.includes(saved)) return saved;
    const after = CRM_SETUP_STEP_KEYS.slice(CRM_SETUP_STEP_KEYS.indexOf(saved) + 1).find((k) => applicable.includes(k));
    if (after) return after;
  }
  return applicable[0];
}

const step = (key: CrmSetupStepKey, title: string, intro: string, s: { status: CrmSetupStatus; summary: string; next?: string | null; questions?: CrmSetupQuestion[]; links?: CrmSetupLink[] }): CrmSetupStep => ({
  key, title, intro, status: s.status, summary: s.summary, next: s.next ?? null, questions: s.questions ?? [], links: s.links ?? [],
});

function providerStep(f: CrmSetupFacts): CrmSetupStep {
  const title = "CRM provider";
  const intro = "Where your contacts, pipelines, calendars and conversations live. iAcquire CRM is the default; GoHighLevel is never required.";
  const links: CrmSetupLink[] = [{ label: "CRM Provider settings", path: "/settings/provider" }];
  const questions: CrmSetupQuestion[] = f.provider.canChoose ? ["provider"] : [];
  if (f.switching) return step("provider", title, intro, { status: "in_progress", summary: "A provider switch is in progress. Automations that could act twice are paused until it finishes.", links });
  if (f.mode === "native") return step("provider", title, intro, { status: "configured", summary: "Your CRM is iAcquire CRM. No GoHighLevel account is needed.", questions, links });
  const hybrid = f.mode === "hybrid" ? " Each capability has exactly one owner (see CRM Provider settings)." : "";
  if (f.ghl.check === "verified") return step("provider", title, intro, { status: "verified", summary: `Your GoHighLevel location is connected and its read access was verified.${hybrid}`, questions, links });
  if (f.ghl.check === "failed") return step("provider", title, intro, { status: "failed", summary: `The last check of your GoHighLevel connection failed.${hybrid}`, next: "iAcquire will fix the connection.", questions, links });
  return step("provider", title, intro, {
    status: "needs_agency_action",
    summary: f.ghl.mapped ? `iAcquire is verifying your GoHighLevel location.${hybrid}` : `iAcquire needs to connect your GoHighLevel location.${hybrid}`,
    next: "iAcquire connects and verifies the location.",
    questions,
    links,
  });
}

function blueprintStep(f: CrmSetupFacts): CrmSetupStep {
  const title = "Industry Blueprint";
  const intro = "A ready-made CRM for your industry: pipelines, tags, fields, forms, templates and draft workflows.";
  const links: CrmSetupLink[] = [{ label: "Blueprints & setup", path: "/settings/blueprints" }];
  const open = f.blueprint.open;
  if (f.blueprint.level === "verified") {
    // Applied and intact is not the whole story: the Blueprint's own checklist (the same one Blueprints & setup shows) must have nothing
    // required left, or the two screens would disagree about the same workspace.
    if (open.required > 0) {
      const more = open.required > open.labels.length ? ` and ${open.required - open.labels.length} more` : "";
      return step("blueprint", title, intro, {
        status: "needs_client_action",
        summary: `${f.blueprint.summary} ${plural(open.required, "setup item it needs is", "setup items it needs are")} still open: ${open.labels.join(", ")}${more}.`,
        next: "Finish them in Blueprints & setup.",
        links,
      });
    }
    return step("blueprint", title, intro, { status: "verified", summary: f.blueprint.summary, links });
  }
  if (f.blueprint.level === "failed") return step("blueprint", title, intro, { status: "failed", summary: f.blueprint.summary, next: "iAcquire reviews the Blueprint with you.", links });
  // Not applied yet, applied in part, or rolled back: applying Blueprints is the agency's job (super admins, after a preview).
  return step("blueprint", title, intro, {
    status: "needs_agency_action",
    summary: f.blueprint.summary,
    next: "iAcquire applies and finishes your Blueprint. You don't need to do anything here.",
    links,
  });
}

function dataStep(f: CrmSetupFacts, key: "fields" | "pipelines" | "tags"): CrmSetupStep {
  const d = f.dataModel;
  // "Matching your Blueprint" needs the Blueprint to have expected records of this type: a manifest that verified overall says nothing
  // about tags when it contained none (or about contact fields when it had only opportunity fields).
  const matched = d.level === "verified";
  const verifiedByManifest = key === "fields" ? matched && d.expectedContactFields > 0
    : key === "pipelines" ? matched && d.expected.pipeline > 0 && d.expected.stage > 0
    : matched && d.expected.tag > 0;
  if (key === "fields") {
    const title = "Contact fields";
    const intro = "The details you keep about each contact beyond name, email and phone.";
    const links: CrmSetupLink[] = [{ label: "Custom Fields", path: "/fields" }];
    if (d.missing.customField) return step(key, title, intro, { status: "failed", summary: `${plural(d.missing.customField, "custom field")} from your Blueprint ${d.missing.customField === 1 ? "was" : "were"} removed.`, next: "Restore them, or ask iAcquire to re-apply the Blueprint.", links });
    if (!d.contactFields) return step(key, title, intro, { status: "not_started", summary: "No custom contact fields yet. Add the details your team needs, or wait for your Blueprint.", links });
    return step(key, title, intro, {
      status: verifiedByManifest ? "verified" : "configured",
      summary: `${plural(d.contactFields, "contact field")}${verifiedByManifest ? ", matching your Blueprint" : ""}.`,
      links,
    });
  }
  if (key === "pipelines") {
    const title = "Pipelines";
    const intro = "The stages a deal moves through, from new lead to won or lost.";
    const links: CrmSetupLink[] = [{ label: "Pipelines", path: "/pipelines" }];
    const removed = d.missing.pipeline + d.missing.stage;
    if (removed) return step(key, title, intro, { status: "failed", summary: `${plural(removed, "pipeline or stage", "pipelines or stages")} from your Blueprint ${removed === 1 ? "was" : "were"} removed.`, next: "Restore them, or ask iAcquire to re-apply the Blueprint.", links });
    if (!d.pipelines) return step(key, title, intro, { status: "not_started", summary: "No pipeline yet.", links });
    if (!d.pipelinesWithStages) return step(key, title, intro, { status: "in_progress", summary: "Your pipeline needs at least two stages.", next: "Add stages in Pipelines.", links });
    return step(key, title, intro, {
      status: verifiedByManifest ? "verified" : "configured",
      summary: `${plural(d.pipelines, "pipeline")} with ${plural(d.stages, "stage")}${verifiedByManifest ? ", matching your Blueprint" : ""}.`,
      links,
    });
  }
  const title = "Tags";
  const intro = "Labels that group contacts, start automations and build Smart Lists.";
  const links: CrmSetupLink[] = [{ label: "Tags & Segments", path: "/tags" }];
  if (d.missing.tag) return step(key, title, intro, { status: "failed", summary: `${plural(d.missing.tag, "tag")} from your Blueprint ${d.missing.tag === 1 ? "was" : "were"} removed.`, next: "Restore them, or ask iAcquire to re-apply the Blueprint.", links });
  if (!d.tags) return step(key, title, intro, { status: "not_started", summary: "No tags yet.", links });
  return step(key, title, intro, { status: verifiedByManifest ? "verified" : "configured", summary: `${plural(d.tags, "tag")}${verifiedByManifest ? ", matching your Blueprint" : ""}.`, links });
}

function calendarStep(f: CrmSetupFacts, answers: CrmSetupAnswers): CrmSetupStep {
  const title = "Calendar connection";
  const intro = "So the times offered to customers are really free. Each person who takes appointments connects their own calendar.";
  const a = effectiveAnswers(f, answers);
  const links: CrmSetupLink[] = [{ label: "Calendar Connections", path: "/calendar-connections" }];
  const questions: CrmSetupQuestion[] = a.appointments === false ? ["appointments"] : ["appointments", "calendarSource"];
  const broken = f.calendar.connections.filter((c) => c.status !== "connected");
  if (broken.length) return step("calendar", title, intro, { status: "failed", summary: "A connected calendar stopped working: it needs to be connected again.", next: "Reconnect it in Calendar Connections.", questions, links });
  if (a.appointments === false) return step("calendar", title, intro, { status: "configured", summary: "You said you don't take appointments, so no calendar is needed. Change your answer any time.", questions, links: [] });
  if (a.appointments === null) return step("calendar", title, intro, { status: "not_started", summary: "Tell us whether customers book appointments with you.", questions, links });
  if (!a.calendarSource) return step("calendar", title, intro, { status: "not_started", summary: "Tell us which calendar you use.", questions, links });
  if (a.calendarSource === "iacquire") return step("calendar", title, intro, { status: "configured", summary: "You'll use the iAcquire calendar only, so there is nothing to connect. Bookings and busy times live in iAcquire.", questions, links: [] });
  const mine = f.calendar.connections.filter((c) => c.provider === a.calendarSource);
  if (!mine.length) return step("calendar", title, intro, { status: "needs_client_action", summary: "Not connected yet.", next: "Connect it in Calendar Connections, signed in as the person who takes the appointments.", questions, links });
  // Verified only by a successful read of busy times: a sync attempt that failed, or a connection with conflict checking off, proves nothing.
  if (mine.some((c) => c.readsBusy && c.fresh)) return step("calendar", title, intro, { status: "verified", summary: `Connected, and it synced successfully in the last day${mine.length > 1 ? ` (${plural(mine.length, "connection")})` : ""}.`, questions, links });
  const readers = mine.filter((c) => c.readsBusy);
  if (!readers.length) return step("calendar", title, intro, { status: "needs_client_action", summary: "Connected, but conflict checking is off, so busy times aren't read.", next: "Turn it on in Calendar Connections.", questions, links });
  if (readers.some((c) => c.synced)) return step("calendar", title, intro, { status: "in_progress", summary: "Connected, but it hasn't synced successfully in the last day. It syncs automatically; reconnect it if this persists.", questions, links });
  return step("calendar", title, intro, { status: "in_progress", summary: "Connected. Waiting for the first successful sync.", questions, links });
}

function schedulingStep(f: CrmSetupFacts): CrmSetupStep {
  const title = "Scheduling";
  const intro = "An active calendar with working hours, appointment types and a booking page that offers real open times.";
  const c = f.calendar;
  const links: CrmSetupLink[] = [
    { label: "Calendars & Types", path: "/calendars" },
    { label: "Availability", path: "/availability" },
    { label: "Booking Pages", path: "/booking-pages" },
  ];
  if (!c.activeCalendars && !c.draftCalendars) return step("scheduling", title, intro, { status: "not_started", summary: "No calendar yet.", next: "Create a calendar, or wait for your Blueprint's calendars.", links });
  if (!c.activeCalendars) return step("scheduling", title, intro, { status: "needs_client_action", summary: `${plural(c.draftCalendars, "calendar is a draft", "calendars are drafts")} and take${c.draftCalendars === 1 ? "s" : ""} no bookings yet.`, next: "Assign hosts and hours, then verify and activate it in Calendars & Types.", links });
  if (!c.verifiedCalendars) return step("scheduling", title, intro, { status: "needs_client_action", summary: c.firstIssue ?? "Your calendar doesn't pass every check yet.", next: "Fix what's listed, then check again.", links });
  if (c.bookableCalendars) return step("scheduling", title, intro, { status: "verified", summary: "A customer could book now: the booking page is on and a real open time was found.", links });
  return step("scheduling", title, intro, { status: "configured", summary: "Your calendar passes every check, including a real open time. Turn on its booking page to take bookings online.", links });
}

function communicationsStep(f: CrmSetupFacts, answers: CrmSetupAnswers): CrmSetupStep {
  const title = "Communication providers";
  const intro = "The email, SMS and WhatsApp senders your team and AI employees reply from. Each one is verified by a live test that sends nothing.";
  const links: CrmSetupLink[] = [{ label: "Communication Settings", path: "/settings/communications" }];
  const questions: CrmSetupQuestion[] = ["channels"];
  const wanted = effectiveAnswers(f, answers).channels;
  if (!wanted) return step("communications", title, intro, { status: "not_started", summary: "Choose the channels you'll use.", questions, links });
  if (!wanted.length) return step("communications", title, intro, { status: "configured", summary: "You chose no messaging channels. Conversations stay in the inbox you already use.", questions, links });
  const parts = wanted.map((c) => `${GUIDE_CHANNEL_LABEL[c]}: ${f.channels[c].summary}`);
  const levels = wanted.map((c) => f.channels[c]);
  if (levels.some((l) => l.level === "failed")) return step("communications", title, intro, { status: "failed", summary: parts.join(" "), next: "iAcquire fixes the failing connection and runs its test again.", questions, links });
  // The same rule as the Blueprint checklist: a channel counts once it passed its live test *and* sending is on. A passed test with
  // sending switched off is set up, not in use.
  if (levels.every((l) => l.level === "verified" && l.enabled)) return step("communications", title, intro, { status: "verified", summary: parts.join(" "), questions, links });
  if (levels.every((l) => l.level === "verified")) return step("communications", title, intro, { status: "configured", summary: parts.join(" "), next: "Switch sending on in Communication Settings when you're ready to use it.", questions, links });
  if (levels.some((l) => l.level === "verified" || l.credentialStored || l.tested)) return step("communications", title, intro, { status: "in_progress", summary: parts.join(" "), next: "iAcquire connects the rest and runs each live test.", questions, links });
  return step("communications", title, intro, { status: "needs_agency_action", summary: parts.join(" "), next: "iAcquire connects each sender with you and runs its live test.", questions, links });
}

function workflowsStep(f: CrmSetupFacts): CrmSetupStep {
  const title = "Approved workflows";
  const intro = "Follow-ups and reminders that run on their own once you approve them. Nothing runs before you activate it.";
  const w = f.workflows;
  const links: CrmSetupLink[] = [{ label: "Workflows", path: "/workflows" }, { label: "Workflow Activity", path: "/workflows/activity" }];
  if (!w.total) return step("workflows", title, intro, { status: "not_started", summary: w.summary, links });
  if (w.failing) return step("workflows", title, intro, { status: "failed", summary: w.summary, next: "Review the failed run in Workflow Activity.", links });
  if (!w.active || w.awaitingApproval) return step("workflows", title, intro, { status: "needs_client_action", summary: w.summary, next: "Review, approve and activate the workflows you want to run.", links });
  if (w.level === "verified") return step("workflows", title, intro, { status: "verified", summary: w.summary, links });
  return step("workflows", title, intro, { status: "configured", summary: w.summary, next: "Each workflow is confirmed after its first completed run (a test run counts).", links });
}

function aiStep(f: CrmSetupFacts): CrmSetupStep {
  const title = "AI roles";
  const intro = "Your AI employees and what each one may do.";
  const links: CrmSetupLink[] = [{ label: "AI Employees", path: "/workforce", portal: true }];
  const a = f.ai;
  if (!a.enabled) return step("ai_roles", title, intro, { status: "not_started", summary: a.summary, links });
  if (a.failing) return step("ai_roles", title, intro, { status: "failed", summary: a.summary, next: "iAcquire is fixing the connection.", links });
  if (a.level === "verified") return step("ai_roles", title, intro, { status: "verified", summary: a.summary, links });
  return step("ai_roles", title, intro, { status: "needs_agency_action", summary: a.summary, next: "iAcquire sets up each AI employee's private profile and runs its live check.", links });
}

function verifyStep(f: CrmSetupFacts): CrmSetupStep {
  const title = "Verify integrations";
  const intro = "The system checks behind your Setup Center: each passes only on real evidence from the connected system.";
  const links: CrmSetupLink[] = [{ label: "Setup Center", path: "/setup", portal: true }];
  const k = f.checks;
  if (!k.applicable) return step("verify", title, intro, { status: "not_started", summary: "No system checks apply yet.", links });
  if (k.failed) return step("verify", title, intro, { status: "failed", summary: `${plural(k.failed, "check is", "checks are")} failing. iAcquire has been told.`, links });
  if (k.verified === k.applicable) return step("verify", title, intro, { status: "verified", summary: `All ${plural(k.applicable, "check")} passed.`, links });
  if (!k.lastRunAt) return step("verify", title, intro, { status: "not_started", summary: "The checks haven't run yet. Run them below.", links });
  return step("verify", title, intro, { status: "in_progress", summary: `${k.verified} of ${plural(k.applicable, "check")} passed so far.`, next: "Finish the steps above, then check again.", links });
}

function reviewStep(f: CrmSetupFacts): CrmSetupStep {
  const title = "Review & activate";
  const intro = "iAcquire reviews everything and approves your system for activation. Nothing is switched on from here.";
  const links: CrmSetupLink[] = [{ label: "Setup Center", path: "/setup", portal: true }];
  const s = f.setup;
  if (!s.state) return step("review", title, intro, { status: "not_started", summary: "Your setup checklist hasn't started yet.", links });
  if (s.state === "activated") return step("review", title, intro, { status: "verified", summary: "iAcquire approved your system for activation.", links });
  if (s.state === "ready_for_review") return step("review", title, intro, { status: "needs_agency_action", summary: "Your setup is in final review with iAcquire.", links });
  if (s.clientActions) return step("review", title, intro, { status: "needs_client_action", summary: `${plural(s.clientActions, "request waits", "requests wait")} for you in the Setup Center.`, next: "Answer them in the Setup Center.", links });
  return step("review", title, intro, {
    status: "needs_agency_action",
    summary: `${s.percent === null ? "Setup is under way" : `Setup is ${s.percent}% complete`}. iAcquire finishes the remaining steps and does the final review; you can't activate the system yourself.${s.readyRequestedAt ? " You told iAcquire you're ready." : ""}`,
    links,
  });
}

/** Every applicable step with its status, from the facts and the answers. */
export function buildCrmSetupSteps(facts: CrmSetupFacts, answers: CrmSetupAnswers): CrmSetupStep[] {
  const keys = applicableSteps(facts, answers);
  return keys.map((k) => {
    switch (k) {
      case "provider": return providerStep(facts);
      case "blueprint": return blueprintStep(facts);
      case "fields":
      case "pipelines":
      case "tags": return dataStep(facts, k);
      case "calendar": return calendarStep(facts, answers);
      case "scheduling": return schedulingStep(facts);
      case "communications": return communicationsStep(facts, answers);
      case "workflows": return workflowsStep(facts);
      case "ai_roles": return aiStep(facts);
      case "verify": return verifyStep(facts);
      case "review": return reviewStep(facts);
    }
  });
}

/** Steps that are done (configured or verified), of the ones that apply, leaving out the agency's final review. */
export function guideProgress(steps: CrmSetupStep[]): { done: number; verified: number; total: number } {
  const counted = steps.filter((s) => s.key !== "review");
  return {
    done: counted.filter((s) => s.status === "configured" || s.status === "verified").length,
    verified: counted.filter((s) => s.status === "verified").length,
    total: counted.length,
  };
}
