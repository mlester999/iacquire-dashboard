// Pure messaging rules shared by the server and the interface. No I/O here, so every rule is easy to test.

export const CHANNELS = ["sms", "whatsapp", "email"] as const;
export type Channel = (typeof CHANNELS)[number];
export const isChannel = (v: unknown): v is Channel => typeof v === "string" && (CHANNELS as readonly string[]).includes(v);

export const CHANNEL_LABELS: Record<Channel, string> = { sms: "SMS", whatsapp: "WhatsApp", email: "Email" };

export type MessageStatus = "received" | "note" | "draft" | "queued" | "sending" | "sent" | "delivered" | "read" | "failed" | "blocked";
export const MESSAGE_STATUS_LABELS: Record<MessageStatus, string> = {
  received: "Received",
  note: "Internal note",
  draft: "Draft",
  queued: "Queued",
  sending: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Failed",
  blocked: "Blocked",
};

/** Delivery only ever moves forward. A late "sent" event never undoes "delivered". */
const DELIVERY_RANK: Record<string, number> = { queued: 1, sending: 2, sent: 3, delivered: 4, read: 5 };
export function advancesDelivery(current: MessageStatus, next: "sent" | "delivered" | "read" | "failed" | "undelivered"): MessageStatus | null {
  if (next === "failed" || next === "undelivered") {
    // A failure report is final unless the message was already confirmed delivered or read.
    return ["delivered", "read", "failed"].includes(current) ? null : "failed";
  }
  if (current === "failed" || current === "blocked" || current === "draft") return null;
  return (DELIVERY_RANK[next] ?? 0) > (DELIVERY_RANK[current] ?? 0) ? next : null;
}

export const BLOCK_REASON_LABELS: Record<string, string> = {
  needs_approval: "Waiting for approval",
  human_owner: "A person has taken over this conversation",
  escalation_pending: "A person is being asked to take over",
  automation_paused: "Automation is paused",
  org_inactive: "This workspace is not active",
  agent_not_ready: "The AI employee has not passed its connection check",
  suppressed: "The customer opted out or the address is suppressed",
  no_consent: "No consent on record for this kind of message",
  channel_not_ready: "This channel is not verified or enabled",
  whatsapp_window_closed: "WhatsApp's reply window has closed; an approved template is required",
  quiet_hours: "Quiet hours",
  outside_business_hours: "Outside business hours",
  followup_limit: "The follow-up limit has been reached",
  followup_too_soon: "Too soon after the previous message",
  credits: "Not enough service credits",
  budget: "Monthly spending limit reached",
  rate_not_published: "No usage rate has been published for this channel yet",
  provider_not_enabled: "Sending through the provider is not enabled",
  provider_error: "The provider rejected the message",
  test_destination_required: "Test messages can only go to approved test destinations",
  contact_unreachable: "The contact has no address for this channel",
};

// ---------------------------------------------------------------------------
// Identifier normalization. A contact is only ever matched on an exact normalized identifier.
// ---------------------------------------------------------------------------

const E164 = /^\+[1-9][0-9]{6,14}$/;

/** Returns an E.164 number, or null when it cannot be determined without guessing the country. */
export function normalizePhone(raw: string | null | undefined, defaultCallingCode?: string): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/[\s().-]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (!s.startsWith("+")) {
    if (!defaultCallingCode || !/^\d{1,3}$/.test(defaultCallingCode)) return null;
    s = `+${defaultCallingCode}${s.replace(/^0+/, "")}`;
  }
  return E164.test(s) ? s : null;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  return s.length <= 320 && /^[^\s@<>()[\]\\,;:]+@[^\s@<>()[\]\\,;:]+\.[^\s@<>()[\]\\,;:]{2,}$/.test(s) ? s : null;
}

export function normalizeAddress(channel: Channel, raw: string | null | undefined, defaultCallingCode?: string): string | null {
  return channel === "email" ? normalizeEmail(raw) : normalizePhone(raw, defaultCallingCode);
}

export const identityKind = (channel: Channel): "phone" | "email" => (channel === "email" ? "email" : "phone");

// ---------------------------------------------------------------------------
// Opt-out keywords (carrier convention: the whole message is the keyword)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "OPT-OUT"]);
const START_WORDS = new Set(["START", "UNSTOP", "SUBSCRIBE", "OPTIN", "OPT-IN"]);

export function detectOptKeyword(text: string): "stop" | "start" | null {
  const word = text.trim().toUpperCase().replace(/[.!?\s]+$/g, "");
  if (STOP_WORDS.has(word)) return "stop";
  if (START_WORDS.has(word)) return "start";
  return null;
}

// ---------------------------------------------------------------------------
// SMS segments (GSM-7 160/153 characters, UCS-2 70/67)
// ---------------------------------------------------------------------------

const GSM7 = new Set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà".split(""));
const GSM7_EXT = new Set("^{}\\[~]|€".split(""));

export function smsSegments(text: string): number {
  if (!text) return 0;
  let units = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM7.has(ch)) units += 1;
    else if (GSM7_EXT.has(ch)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return units <= 160 ? 1 : Math.ceil(units / 153);
  const ucs2 = [...text].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  return ucs2 <= 70 ? 1 : Math.ceil(ucs2 / 67);
}

// ---------------------------------------------------------------------------
// Follow-up presets
// ---------------------------------------------------------------------------

export type FollowUpPreset = "gentle" | "balanced" | "persistent" | "off" | "custom";
export interface FollowUpSchedule {
  /** Days after the last customer-visible message for each attempt. */
  days: number[];
  channel: Channel | "same";
  businessHoursOnly: boolean;
}

export const FOLLOW_UP_PRESETS: Record<Exclude<FollowUpPreset, "off" | "custom">, { label: string; description: string; days: number[] }> = {
  gentle: { label: "Gentle", description: "At most two follow-ups.", days: [1, 4] },
  balanced: { label: "Balanced", description: "At most three follow-ups over ten days: day 1, day 3 and day 7.", days: [1, 3, 7] },
  persistent: { label: "Persistent", description: "More active, still limited by quiet hours, consent and agency maximums.", days: [1, 2, 4, 7, 10] },
};

export interface CustomFollowUp {
  attempts: number;
  /** Days between attempts, repeated if shorter than `attempts`. */
  daysBetween: number[];
  channel: Channel | "same";
  businessHoursOnly: boolean;
}

/** Turns a preset (or a custom plan) into attempt days, never exceeding the agency's maximum attempts. */
export function buildSchedule(preset: FollowUpPreset, custom: CustomFollowUp | null, agencyMaxAttempts: number): FollowUpSchedule | null {
  if (preset === "off") return null;
  let days: number[];
  let channel: Channel | "same" = "same";
  let businessHoursOnly = true;
  if (preset === "custom") {
    if (!custom || !Number.isInteger(custom.attempts) || custom.attempts < 1) return null;
    const gaps = custom.daysBetween.filter((d) => Number.isInteger(d) && d >= 1 && d <= 30);
    if (!gaps.length) return null;
    let day = 0;
    days = Array.from({ length: custom.attempts }, (_, i) => (day += gaps[Math.min(i, gaps.length - 1)]));
    channel = custom.channel;
    businessHoursOnly = custom.businessHoursOnly;
  } else {
    days = [...FOLLOW_UP_PRESETS[preset].days];
  }
  days = days.slice(0, Math.max(0, agencyMaxAttempts));
  return days.length ? { days, channel, businessHoursOnly } : null;
}

// ---------------------------------------------------------------------------
// Local time rules (quiet hours, business hours)
// ---------------------------------------------------------------------------

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export type BusinessHours = Partial<Record<Weekday, Array<[string, string]>>>;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const toMinutes = (hhmm: string): number => {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};

export function localParts(date: Date, timeZone: string): { weekday: Weekday; minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday").slice(0, 3).toLowerCase() as Weekday;
  return { weekday: WEEKDAYS.includes(weekday) ? weekday : "mon", minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** No hours defined means the business is treated as always open; the interface warns when that is the case. */
export function isWithinBusinessHours(hours: BusinessHours | null | undefined, now: Date, timeZone: string): boolean {
  if (!hours || !Object.keys(hours).length) return true;
  const { weekday, minutes } = localParts(now, timeZone);
  return (hours[weekday] ?? []).some(([from, to]) => minutes >= toMinutes(from) && minutes < toMinutes(to));
}

/** `start` to `end` may wrap past midnight (for example 21:00 to 08:00). */
export function isQuietHours(start: string, end: string, now: Date, timeZone: string): boolean {
  const { minutes } = localParts(now, timeZone);
  const s = toMinutes(start.slice(0, 5));
  const e = toMinutes(end.slice(0, 5));
  if (s === e) return false;
  return s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}

/** The next moment (in 15-minute steps, within a week) that is outside quiet hours and, if required, inside business hours. */
export function nextSendWindow(opts: { from: Date; timeZone: string; quietStart: string; quietEnd: string; businessHours?: BusinessHours | null; businessHoursOnly: boolean }): Date {
  const step = 15 * 60 * 1000;
  let t = new Date(Math.ceil(opts.from.getTime() / step) * step);
  for (let i = 0; i < 7 * 24 * 4; i += 1) {
    const quiet = isQuietHours(opts.quietStart, opts.quietEnd, t, opts.timeZone);
    const open = !opts.businessHoursOnly || isWithinBusinessHours(opts.businessHours, t, opts.timeZone);
    if (!quiet && open) return t;
    t = new Date(t.getTime() + step);
  }
  return t;
}

export function validateBusinessHours(input: unknown): BusinessHours | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const out: BusinessHours = {};
  for (const [day, ranges] of Object.entries(input)) {
    if (!(WEEKDAYS as string[]).includes(day) || !Array.isArray(ranges) || ranges.length > 4) return null;
    const clean: Array<[string, string]> = [];
    for (const range of ranges) {
      if (!Array.isArray(range) || range.length !== 2 || typeof range[0] !== "string" || typeof range[1] !== "string") return null;
      if (!HHMM.test(range[0]) || !HHMM.test(range[1]) || toMinutes(range[0]) >= toMinutes(range[1])) return null;
      clean.push([range[0], range[1]]);
    }
    out[day as Weekday] = clean;
  }
  return out;
}

export const DEFAULT_FOLLOWUP_TEXT = (businessName: string, step: number) =>
  step === 1
    ? `Hi, this is the AI assistant for ${businessName}, following up on your enquiry. Is there anything I can help with? Reply STOP to opt out.`
    : `Hi again from the AI assistant at ${businessName}. Just checking whether you still need help. Reply STOP to opt out.`;
