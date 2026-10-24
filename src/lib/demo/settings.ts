// The demo funnel's settings: their defaults, their ranges and the check a Super Admin's change goes through. Pure. The ranges are the ones migration 0100 enforces as check
// constraints, and tests/demo-settings.test.ts keeps the two in step.
//
// Every number below is a PROPOSAL pending the founder's confirmation (docs/demo-funnel.md lists them). The demo itself is off until a Super Admin switches it on AND the
// environment switch DEMO_ENABLED agrees; the AI chat is a second switch, off by default, and the scripted tour is what ships working.

import { isDomainName } from "./email";

export interface DemoSettings {
  enabled: boolean;
  aiEnabled: boolean;
  /** Hours from confirming the address that the demo stays open. */
  windowHours: number;
  /** AI messages a prospect may send in that window. */
  messageLimit: number;
  /** The most hours, in all, a Super Admin may add to one prospect's window. */
  maxExtensionHours: number;
  /** The most messages, in all, a Super Admin may add to one prospect. */
  maxExtraMessages: number;
  /** Demos that may be started per UTC day, platform-wide. */
  dailyStartCap: number;
  /** AI messages that may be answered per UTC day, platform-wide (the platform pays for each). */
  dailyMessageCap: number;
  /** Where "Book a free consultation" goes: https only. Null: the button is not shown. */
  consultationUrl: string | null;
  /** Days after a window ended (or the last visit) that a transcript and a prospect's details are kept. */
  retentionDays: number;
  blockedEmailDomains: string[];
}

export const DEMO_DEFAULTS: DemoSettings = {
  enabled: false,
  aiEnabled: false,
  windowHours: 24,
  messageLimit: 10,
  maxExtensionHours: 72,
  maxExtraMessages: 20,
  dailyStartCap: 50,
  dailyMessageCap: 300,
  consultationUrl: null,
  retentionDays: 90,
  blockedEmailDomains: [],
};

/** Inclusive ranges, as migration 0100 has them. */
export const DEMO_RANGES = {
  windowHours: [1, 168],
  messageLimit: [1, 100],
  maxExtensionHours: [0, 720],
  maxExtraMessages: [0, 200],
  dailyStartCap: [0, 10_000],
  dailyMessageCap: [0, 100_000],
  retentionDays: [7, 730],
} as const;

export const MAX_BLOCKED_DOMAINS = 500;
export const MAX_URL_CHARS = 500;

const LABELS: Record<keyof typeof DEMO_RANGES, string> = {
  windowHours: "Hours a demo stays open",
  messageLimit: "AI messages per demo",
  maxExtensionHours: "Most hours that can be added to a demo",
  maxExtraMessages: "Most messages that can be added to a demo",
  dailyStartCap: "Demos that can start per day",
  dailyMessageCap: "AI messages per day, in all",
  retentionDays: "Days conversations and details are kept",
};

export type DemoSettingsPatch = Partial<DemoSettings>;
export type SettingsProblems = Partial<Record<keyof DemoSettings, string>>;

/** A consultation address: https only, no spaces, nothing that is not a plain web address. */
export function isConsultationUrl(raw: string): boolean {
  if (raw.length > MAX_URL_CHARS || /\s/.test(raw) || !/^https:\/\//i.test(raw)) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname.includes(".") && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Checks a change before it is saved. Only the fields present are checked. Returns the cleaned patch or one plain sentence per bad field. */
export function checkSettingsPatch(input: unknown): { ok: true; value: DemoSettingsPatch } | { ok: false; problems: SettingsProblems } {
  const problems: SettingsProblems = {};
  const value: DemoSettingsPatch = {};
  const src = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  for (const key of ["enabled", "aiEnabled"] as const) {
    if (src[key] === undefined) continue;
    if (typeof src[key] === "boolean") value[key] = src[key] as boolean;
    else problems[key] = "Choose on or off.";
  }
  for (const key of Object.keys(DEMO_RANGES) as Array<keyof typeof DEMO_RANGES>) {
    if (src[key] === undefined) continue;
    const [min, max] = DEMO_RANGES[key];
    const n = src[key];
    if (typeof n === "number" && Number.isInteger(n) && n >= min && n <= max) value[key] = n;
    else problems[key] = `${LABELS[key]} must be a whole number from ${min} to ${max}.`;
  }
  if (src.consultationUrl !== undefined) {
    const raw = src.consultationUrl;
    if (raw === null || (typeof raw === "string" && raw.trim() === "")) value.consultationUrl = null;
    else if (typeof raw === "string" && isConsultationUrl(raw.trim())) value.consultationUrl = raw.trim();
    else problems.consultationUrl = "The consultation link must be a web address that starts with https://.";
  }
  if (src.blockedEmailDomains !== undefined) {
    const list = src.blockedEmailDomains;
    if (!Array.isArray(list) || list.length > MAX_BLOCKED_DOMAINS || !list.every((d) => typeof d === "string")) {
      problems.blockedEmailDomains = `Give up to ${MAX_BLOCKED_DOMAINS} domains.`;
    } else {
      const cleaned = [...new Set((list as string[]).map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
      const bad = cleaned.find((d) => !isDomainName(d));
      if (bad) problems.blockedEmailDomains = `"${bad.slice(0, 60)}" is not a domain name such as example.com.`;
      else value.blockedEmailDomains = cleaned;
    }
  }
  return Object.keys(problems).length ? { ok: false, problems } : { ok: true, value };
}
