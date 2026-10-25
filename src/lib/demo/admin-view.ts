// How the agency's Prospects screens read a prospect: the words for each status, which buttons a person may see for a prospect in a given state, how the list's filters travel in an
// address, and how a timeline line is put into words. Pure: the screens and the tests share it, and the server still decides every action again when it is pressed (the buttons
// shown are a convenience, never the permission).
import { DEMO_EVENT_LABELS, type DemoEventKind } from "./events";
import { canTransition, PROSPECT_STATUSES, type AccessState, type ProspectStatus } from "./rules";

export const STATUS_LABEL: Record<ProspectStatus, string> = {
  unverified: "Waiting to confirm",
  active: "Demo open",
  expired: "Demo ended",
  consultation_requested: "Asked for a consultation",
  purchase_started: "Pressed Buy now",
  converted: "Client",
  declined: "Not a fit",
  blocked: "Blocked",
};

export type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "violet";
export const STATUS_TONE: Record<ProspectStatus, Tone> = {
  unverified: "neutral",
  active: "success",
  expired: "neutral",
  consultation_requested: "primary",
  purchase_started: "violet",
  converted: "success",
  declined: "warning",
  blocked: "danger",
};

// ---------------------------------------------------------------------------
// The switches
// ---------------------------------------------------------------------------

export interface SwitchState {
  /** DEMO_ENABLED in this deployment's environment. */
  environment: boolean;
  /** DEMO_PUBLIC_DISABLED: the emergency stop. */
  emergencyStop: boolean;
  /** The Super Admin's own switch, in the demo settings. */
  enabled: boolean;
  aiEnabled: boolean;
  /** Whether a language model could be reached just now (the chat's own check). Left out where the page did not look: the sentence then says what the chat needs, not what it has. */
  modelReady?: boolean;
}

/** What visitors get right now, in one sentence, from the switches in the order the server checks them. */
export function visitorsSee(s: SwitchState): { tone: "success" | "warning" | "danger"; text: string } {
  if (s.emergencyStop) return { tone: "danger", text: "The emergency stop is on. Every public demo page says it is temporarily unavailable." };
  if (!s.environment) return { tone: "warning", text: "The demo is off for this deployment (DEMO_ENABLED), so visitors are told it is not open, whatever the settings say." };
  if (!s.enabled) return { tone: "warning", text: "The demo is switched off in the demo settings, so visitors are told it is not open." };
  if (!s.aiEnabled) return { tone: "success", text: "The demo is open with the guided tour. The AI chat is switched off." };
  if (s.modelReady === true) return { tone: "success", text: "The demo is open. The AI chat is on and a language model is connected." };
  if (s.modelReady === false) return { tone: "warning", text: "The demo is open. The AI chat is switched on, but no language model is connected right now, so visitors get the guided tour only." };
  return { tone: "success", text: "The demo is open. The AI chat is switched on, and still needs a connected language model to answer." };
}

// ---------------------------------------------------------------------------
// The list's filters
// ---------------------------------------------------------------------------

export const STATUS_FILTERS = ["all", ...PROSPECT_STATUSES] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export interface ListQuery {
  status: StatusFilter;
  /** A user id, "none" for nobody, or "" for anyone. */
  owner: string;
  search: string;
  after: { createdAt: string; id: string } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const one = (v: string | string[] | undefined): string => (typeof v === "string" ? v : "");

/** What the address asks for, reduced to values the list will accept: anything else is the default. */
export function parseListQuery(q: Record<string, string | string[] | undefined>): ListQuery {
  const status = one(q.status);
  const owner = one(q.owner);
  const afterAt = one(q.at);
  const afterId = one(q.id);
  return {
    status: (STATUS_FILTERS as readonly string[]).includes(status) ? (status as StatusFilter) : "all",
    owner: owner === "none" || UUID.test(owner) ? owner : "",
    search: one(q.q).replace(/\s+/g, " ").trim().slice(0, 100),
    after: ISO.test(afterAt) && UUID.test(afterId) ? { createdAt: afterAt, id: afterId } : null,
  };
}

/** The address of the list for a query (the defaults are left out). */
export function listHref(query: Partial<ListQuery>): string {
  const p = new URLSearchParams();
  if (query.status && query.status !== "all") p.set("status", query.status);
  if (query.owner) p.set("owner", query.owner);
  if (query.search) p.set("q", query.search);
  if (query.after) {
    p.set("at", query.after.createdAt);
    p.set("id", query.after.id);
  }
  const s = p.toString();
  return s ? `/admin/prospects?${s}` : "/admin/prospects";
}

// ---------------------------------------------------------------------------
// Which buttons
// ---------------------------------------------------------------------------

export interface ActionFacts {
  status: ProspectStatus;
  access: AccessState;
  erased: boolean;
  verified: boolean;
  messageCount: number;
  consultationRequested: boolean;
  consultationDone: boolean;
  conversionInProgress: boolean;
  converted: boolean;
  extension: { hoursLeft: number; messagesLeft: number };
}

export interface ActionSet {
  readTranscript: boolean;
  extend: boolean;
  expireNow: boolean;
  block: boolean;
  decline: boolean;
  reopen: boolean;
  assign: boolean;
  note: boolean;
  consultationDone: boolean;
  convert: boolean;
  exportData: boolean;
  erase: boolean;
}

const NONE: ActionSet = { readTranscript: false, extend: false, expireNow: false, block: false, decline: false, reopen: false, assign: false, note: false, consultationDone: false, convert: false, exportData: false, erase: false };
const EXTENDABLE: readonly ProspectStatus[] = ["active", "expired", "consultation_requested", "purchase_started"];

/**
 * The actions worth offering for a prospect in this state to a person with these permissions. Reading the conversation needs only the view permission; everything else needs the
 * manage permission. An erased prospect has nothing left to act on; a client is final.
 */
export function availableActions(f: ActionFacts, caps: { view: boolean; manage: boolean }): ActionSet {
  const out = { ...NONE };
  out.readTranscript = caps.view && !f.erased && f.messageCount > 0;
  if (!caps.manage || f.erased) return out;
  const live = !f.converted;
  out.extend = f.verified && EXTENDABLE.includes(f.status) && (f.extension.hoursLeft > 0 || f.extension.messagesLeft > 0);
  out.expireNow = f.access === "open";
  out.block = live && canTransition(f.status, "blocked");
  out.decline = live && canTransition(f.status, "declined");
  out.reopen = f.status === "blocked" || f.status === "declined";
  out.assign = true;
  out.note = true;
  out.consultationDone = f.consultationRequested && !f.consultationDone;
  out.convert = live && f.verified && !f.conversionInProgress && !["blocked", "declined", "unverified"].includes(f.status);
  out.exportData = true;
  out.erase = true;
  return out;
}

/**
 * What the browser is told about the owner's invitation after a prospect becomes a client. The invitation is emailed like for any client; its link (a way into the new workspace)
 * is handed to the Super Admin's browser ONLY when that email did not really leave (it failed, or this environment only captures email), so they can pass it on by hand. When the
 * email was sent, the link never reaches a browser.
 */
export function inviteOutcome(delivery: { status: string; error?: string | null }, link: string): { emailStatus: string; emailError: string | null; inviteLink: string | null } {
  const sent = delivery.status === "sent";
  return { emailStatus: delivery.status, emailError: sent ? null : (delivery.error ?? null), inviteLink: sent ? null : link };
}

// ---------------------------------------------------------------------------
// Words for a moment and a window
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "5 hours", "2 days", "30 minutes": the largest whole unit. */
export function spanWords(ms: number): string {
  const abs = Math.abs(ms);
  const [n, unit] = abs >= DAY ? [Math.floor(abs / DAY), "day"] : abs >= HOUR ? [Math.floor(abs / HOUR), "hour"] : [Math.max(1, Math.floor(abs / MINUTE)), "minute"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Where a prospect's window stands, read from the clock. */
export function windowWords(p: { verifiedAt: string | null; windowEndsAt: string | null; access: AccessState }, now: Date): string {
  if (p.access === "erased") return "Details erased";
  if (!p.verifiedAt || !p.windowEndsAt) return "Not started";
  const left = new Date(p.windowEndsAt).getTime() - now.getTime();
  if (p.access === "open" && left > 0) return `Open, ${spanWords(left)} left`;
  if (p.access === "converted") return "Became a client";
  if (p.access === "blocked") return "Stopped by the team";
  return `Ended ${spanWords(left)} ago`;
}

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

const RELEASE_TEXT: Record<string, string> = {
  provider_failed: "the AI provider did not answer",
  no_model: "no AI model was available",
  reply_blocked: "the answer failed a safety check",
  input_blocked: "the message looked like an attempt to change the assistant's rules",
  timeout: "no answer came in time",
  internal: "something went wrong on our side",
};

const text = (v: unknown, max = 600): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface EventWords {
  label: string;
  /** Lines under the label. May include words a team member typed (a note, a reason); never anything a prospect typed. */
  lines: string[];
}

/** One timeline line in words. Unknown kinds and missing fields fall back to the label alone. */
export function describeEvent(kind: DemoEventKind, detail: Record<string, unknown>): EventWords {
  const label = DEMO_EVENT_LABELS[kind] ?? kind;
  const lines: string[] = [];
  const reason = text(detail.reason);
  switch (kind) {
    case "extended": {
      const hours = num(detail.hours) ?? 0;
      const messages = num(detail.extraMessages) ?? 0;
      lines.push(`Added ${hours} hour${hours === 1 ? "" : "s"} and ${messages} message${messages === 1 ? "" : "s"}.`);
      if (reason) lines.push(`Reason: ${reason}`);
      break;
    }
    case "expired":
      if (detail.early === true) lines.push("Ended early by the team.");
      if (reason) lines.push(`Reason: ${reason}`);
      break;
    case "blocked":
    case "declined":
      if (reason) lines.push(`Reason: ${reason}`);
      break;
    case "reopened":
      if (typeof detail.to === "string") lines.push(`Back to ${STATUS_LABEL[detail.to as ProspectStatus] ?? detail.to}.`);
      break;
    case "note":
      if (text(detail.note)) lines.push(text(detail.note));
      break;
    case "assigned":
      lines.push(detail.ownerUserId ? "Assigned to a team member." : "No longer assigned to anyone.");
      break;
    case "transcript_viewed": {
      const n = num(detail.lines);
      if (n !== null) lines.push(`${n} line${n === 1 ? "" : "s"} read.`);
      break;
    }
    case "message_blocked":
    case "message_released": {
      const why = text(detail.reason, 40);
      lines.push(`Not counted: ${RELEASE_TEXT[why] ?? "the message was given back"}.`);
      break;
    }
    case "limit_reached": {
      const n = num(detail.messagesUsed);
      if (n !== null) lines.push(`${n} messages used.`);
      break;
    }
    case "verified": {
      const h = num(detail.windowHours);
      const m = num(detail.messageLimit);
      if (h !== null && m !== null) lines.push(`${h}-hour window, ${m} messages.`);
      break;
    }
    case "erased": {
      const why = text(detail.why, 40);
      if (why) lines.push(why === "retention" ? "Erased when the retention period ended." : "Erased because the person asked.");
      break;
    }
    default:
      break;
  }
  return { label, lines };
}
