import { z } from "zod";
import type { AiSignals, Dimension, EvidenceRef, LeadFacts } from "@/lib/lead-scoring/types";

// The criteria a lead can be scored on. A criterion reads one kind of authorized CRM data and says either "I don't know" (no record, so
// nothing is held against the lead) or "known", with a fraction from -1 to 1 of its weight. Points are fraction x weight. Nothing here
// reads a name, a photo, a message's words or anything about who the person is: only what they did and what the business recorded.

export type Outcome =
  | { state: "unknown" }
  | { state: "known"; fraction: number; detail: string; phrase: string; evidence: EvidenceRef[] };

const unknown: Outcome = { state: "unknown" };
const known = (fraction: number, detail: string, phrase: string, evidence: EvidenceRef[] = []): Outcome => ({ state: "known", fraction: Math.max(-1, Math.min(1, fraction)), detail, phrase, evidence });
const iso = (d: Date | null) => (d ? d.toISOString() : undefined);
const daysBetween = (from: Date, to: Date) => Math.max(0, (to.getTime() - from.getTime()) / 86_400_000);

export interface CriterionDef {
  key: string;
  label: string;
  dimension: Dimension;
  /** positive: adds up to `weight`. penalty: subtracts up to `weight`. */
  kind: "positive" | "penalty";
  weight: number;
  /** On unless the workspace turns it off. Fit criteria are off until the workspace configures them. */
  defaultEnabled: boolean;
  source: "rule" | "ai";
  /** What a person can do to find out, shown when the criterion is unknown. */
  hint: string;
  evaluate(f: LeadFacts, params: Record<string, unknown>): Outcome;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean) : []);

// ---------------------------------------------------------------------------
// Built-in criteria
// ---------------------------------------------------------------------------

const INBOUND_VIA = new Set(["inbound_message", "website_form", "form", "booking", "call"]);
const OUTBOUND_VIA = new Set(["manual", "import", "api", "agent", "workflow"]);

const BUILTIN: CriterionDef[] = [
  // ---- Intent -------------------------------------------------------------
  {
    key: "inbound_inquiry", label: "Reached out themselves", dimension: "intent", kind: "positive", weight: 8, defaultEnabled: true, source: "rule", hint: "Record how the lead first came in.",
    evaluate: (f) => {
      const via = f.contact.createdVia;
      if (INBOUND_VIA.has(via)) return known(1, "They contacted the business first (message, form, booking or call).", "contacted you first");
      if (OUTBOUND_VIA.has(via)) return known(0.25, "The contact was added by the team or an import, not by the customer.", "added by your team");
      return unknown;
    },
  },
  {
    key: "appointment_intent", label: "Appointment", dimension: "intent", kind: "positive", weight: 10, defaultEnabled: true, source: "rule", hint: "Offer a time to meet.",
    evaluate: (f) => {
      const a = f.appointments;
      if (a.upcoming > 0) return known(1, "They have an appointment coming up.", "has an appointment booked", a.nextId ? [{ kind: "appointment", id: a.nextId, at: iso(a.nextAt) }] : []);
      if (a.showed > 0) return known(0.9, "They attended an appointment.", "attended an appointment");
      if (a.booked > 0 && a.cancelled >= a.booked) return known(0.2, "Their appointments were cancelled.", "cancelled an appointment");
      return unknown;
    },
  },
  {
    key: "deal_progress", label: "Deal progress", dimension: "intent", kind: "positive", weight: 8, defaultEnabled: true, source: "rule", hint: "Create a deal when they ask for a quote.",
    evaluate: (f) => {
      const o = f.opportunities;
      if (o.won > 0) return known(1, "They have bought before.", "has bought before");
      if (o.open > 0) {
        const p = o.stageProgress ?? 0.3;
        return known(0.25 + 0.75 * p, "They have an open deal in your pipeline.", "has an open deal", o.openId ? [{ kind: "opportunity", id: o.openId }] : []);
      }
      if (o.lost > 0) return known(0, "Their last deal was lost.", "lost a previous deal");
      return unknown;
    },
  },
  {
    key: "ai_intent", label: "What they said they want", dimension: "intent", kind: "positive", weight: 8, defaultEnabled: true, source: "ai", hint: "Reply to their message so there is more to go on.",
    evaluate: (f) => {
      const s = f.ai;
      if (!s || s.intent === "unknown") return unknown;
      const map: Record<Exclude<AiSignals["intent"], "unknown">, [number, string, string]> = {
        ready_to_buy: [1, "Their messages show they are ready to go ahead.", "says they are ready"],
        evaluating: [0.6, "Their messages show they are comparing options.", "is comparing options"],
        support_request: [0.3, "Their messages are a request for help, not a purchase.", "asked for help"],
        just_browsing: [0.15, "Their messages say they are only looking.", "is only browsing"],
      };
      const [fraction, detail, phrase] = map[s.intent];
      return known(fraction, detail, phrase, (s.evidence.intent ?? []).map((id) => ({ kind: "message" as const, id })));
    },
  },
  {
    key: "wants_next_step", label: "Asked for a next step", dimension: "intent", kind: "positive", weight: 6, defaultEnabled: true, source: "ai", hint: "Ask whether they would like a quote or a visit.",
    evaluate: (f) => {
      const s = f.ai;
      if (!s || (s.intent === "unknown" && !s.wants.length)) return unknown;
      const ev = (s.evidence.wants ?? []).map((id) => ({ kind: "message" as const, id }));
      if (s.wants.some((w) => w === "quote" || w === "appointment" || w === "callback")) return known(1, `They asked for ${s.wants.filter((w) => w !== "information").join(" / ")}.`, "asked for a quote or visit", ev);
      if (s.wants.includes("information")) return known(0.4, "They asked for information.", "asked for information", ev);
      return known(0, "They did not ask for a next step.", "asked for nothing yet", ev);
    },
  },
  // ---- Engagement ---------------------------------------------------------
  {
    key: "recent_activity", label: "Recent contact from them", dimension: "engagement", kind: "positive", weight: 10, defaultEnabled: true, source: "rule", hint: "Nothing yet from them.",
    evaluate: (f) => {
      const times = [f.conversations.lastInboundAt, f.calls.lastInboundAt].filter((d): d is Date => !!d);
      if (!times.length) return unknown;
      const last = new Date(Math.max(...times.map((d) => d.getTime())));
      const days = daysBetween(last, f.asOf);
      const ev: EvidenceRef[] = [f.conversations.lastInboundId && f.conversations.lastInboundAt && last.getTime() === f.conversations.lastInboundAt.getTime()
        ? { kind: "message", id: f.conversations.lastInboundId, at: iso(last) }
        : { kind: "call", id: f.calls.lastInboundId ?? undefined, at: iso(last) }];
      const [fraction, phrase] = days <= 1 ? [1, "was in touch today"] : days <= 3 ? [0.8, "was in touch in the last 3 days"] : days <= 7 ? [0.6, "was in touch this week"] : days <= 14 ? [0.35, "was in touch in the last 2 weeks"] : days <= 30 ? [0.15, "was last in touch this month"] : [0, "has been quiet for over a month"];
      return known(fraction as number, `Last heard from them ${days < 1 ? "today" : `${Math.floor(days)} day${Math.floor(days) === 1 ? "" : "s"} ago`}.`, phrase as string, ev);
    },
  },
  {
    key: "two_way_conversation", label: "Two-way conversation", dimension: "engagement", kind: "positive", weight: 8, defaultEnabled: true, source: "rule", hint: "Start a conversation.",
    evaluate: (f) => {
      const { inboundCount: i, outboundCount: o } = f.conversations;
      if (i === 0 && o === 0) return unknown;
      if (i >= 2 && o >= 1) return known(1, `${i} messages from them and ${o} from you.`, "is in a real conversation");
      if (i >= 1 && o >= 1) return known(0.6, "They have written and you have answered.", "has exchanged messages");
      if (i >= 2) return known(0.5, `${i} messages from them with no reply yet.`, "wrote more than once");
      if (i === 1) return known(0.3, "They have sent one message.", "sent a message");
      return known(0, "You have written to them and they have not answered.", "has not answered yet");
    },
  },
  {
    key: "responsiveness", label: "Answers when contacted", dimension: "engagement", kind: "positive", weight: 7, defaultEnabled: true, source: "rule", hint: "Not enough back-and-forth yet.",
    evaluate: (f) => {
      const c = f.conversations;
      if (c.repliedWithin24h) return known(1, "They answered one of your messages within a day.", "answers quickly");
      if (c.outboundCount >= 2 && c.inboundCount === 0) return known(0, `${c.outboundCount} messages from you and no answer.`, "has not answered");
      return unknown;
    },
  },
  // ---- Urgency ------------------------------------------------------------
  {
    key: "timeline", label: "How soon they want to act", dimension: "urgency", kind: "positive", weight: 8, defaultEnabled: true, source: "ai", hint: "Ask when they would like to start.",
    evaluate: (f) => {
      const s = f.ai;
      if (!s || s.timeline === "unknown") return unknown;
      const map: Record<Exclude<AiSignals["timeline"], "unknown">, [number, string, string]> = {
        immediate: [1, "They want to act right away.", "wants it done now"],
        this_week: [0.8, "They want to act this week.", "wants to act this week"],
        this_month: [0.5, "They want to act this month.", "wants to act this month"],
        later: [0.15, "They are planning for later.", "is planning for later"],
      };
      const [fraction, detail, phrase] = map[s.timeline];
      return known(fraction, detail, phrase, (s.evidence.timeline ?? []).map((id) => ({ kind: "message" as const, id })));
    },
  },
  {
    key: "appointment_soon", label: "Appointment soon", dimension: "urgency", kind: "positive", weight: 4, defaultEnabled: true, source: "rule", hint: "Offer an appointment time.",
    evaluate: (f) => {
      const next = f.appointments.nextAt;
      if (!next || f.appointments.upcoming === 0) return unknown;
      const days = daysBetween(f.asOf, next);
      if (days <= 7) return known(1, "Their appointment is within a week.", "meets you within a week", f.appointments.nextId ? [{ kind: "appointment", id: f.appointments.nextId, at: iso(next) }] : []);
      if (days <= 30) return known(0.5, "Their appointment is within a month.", "has an appointment this month", f.appointments.nextId ? [{ kind: "appointment", id: f.appointments.nextId, at: iso(next) }] : []);
      return known(0.2, "Their appointment is more than a month away.", "has a later appointment");
    },
  },
  {
    key: "call_activity", label: "Phoned the business", dimension: "urgency", kind: "positive", weight: 3, defaultEnabled: true, source: "rule", hint: "No recent calls.",
    evaluate: (f) => {
      const last = f.calls.lastInboundAt;
      if (!last || f.calls.inboundCount === 0) return unknown;
      const days = daysBetween(last, f.asOf);
      const ev: EvidenceRef[] = [{ kind: "call", id: f.calls.lastInboundId ?? undefined, at: iso(last) }];
      if (days <= 3) return known(1, f.calls.missedInboundCount > 0 ? "They phoned recently and were missed." : "They phoned recently.", f.calls.missedInboundCount > 0 ? "phoned and was missed" : "phoned recently", ev);
      if (days <= 14) return known(0.5, "They phoned in the last two weeks.", "phoned recently", ev);
      return known(0.1, "Their last call was over two weeks ago.", "phoned a while ago", ev);
    },
  },
  // ---- Completeness (not counted as a qualifying signal) --------------------
  {
    key: "profile_completeness", label: "How much we know", dimension: "completeness", kind: "positive", weight: 10, defaultEnabled: true, source: "rule", hint: "Add a name, phone, email and location.",
    evaluate: (f) => {
      const c = f.contact;
      const parts = [c.hasName, c.hasPhone, c.hasEmail, Boolean(c.city || c.region || c.country || c.postalCode)];
      const have = parts.filter(Boolean).length;
      return known(have / parts.length, `${have} of 4 basics on file (name, phone, email, location).`, have >= 3 ? "has complete details" : "has few details on file");
    },
  },
  // ---- Penalties ------------------------------------------------------------
  {
    key: "no_show_history", label: "Missed appointments", dimension: "engagement", kind: "penalty", weight: 12, defaultEnabled: true, source: "rule", hint: "",
    evaluate: (f) => {
      const n = f.appointments.noShow;
      if (n <= 0) return unknown;
      return known(-Math.min(1, n / 2), `${n} appointment${n === 1 ? "" : "s"} marked as not attended.`, "has missed an appointment");
    },
  },
  {
    key: "unanswered_outreach", label: "Several messages with no answer", dimension: "engagement", kind: "penalty", weight: 8, defaultEnabled: true, source: "rule", hint: "",
    evaluate: (f) => {
      const c = f.conversations;
      if (c.unansweredOutbound < 3) return unknown;
      const last = c.lastInboundAt;
      if (last && daysBetween(last, f.asOf) <= 14) return unknown;
      return known(-1, `${c.unansweredOutbound} messages from you since they last wrote.`, "has not answered several messages");
    },
  },
  {
    key: "cannot_be_contacted", label: "Cannot be contacted", dimension: "engagement", kind: "penalty", weight: 10, defaultEnabled: true, source: "rule", hint: "",
    evaluate: (f) => (f.reachable ? unknown : known(-1, "They opted out, bounced, or have no phone or email on file for any channel.", "cannot be contacted", [{ kind: "consent" }])),
  },
  {
    key: "lost_deal", label: "Lost a previous deal", dimension: "intent", kind: "penalty", weight: 6, defaultEnabled: true, source: "rule", hint: "",
    evaluate: (f) => (f.opportunities.lost > 0 && f.opportunities.open === 0 && f.opportunities.won === 0 ? known(-1, "Their most recent deal was lost.", "lost a previous deal") : unknown),
  },
  // ---- Fit (off until the workspace configures them) ------------------------
  {
    key: "service_area", label: "In your service area", dimension: "fit", kind: "positive", weight: 10, defaultEnabled: false, source: "rule", hint: "Add the lead's city, region or postal code.",
    evaluate: (f, p) => {
      const countries = list(p.countries), regions = list(p.regions), cities = list(p.cities), prefixes = list(p.postalPrefixes);
      if (!countries.length && !regions.length && !cities.length && !prefixes.length) return unknown;
      const c = f.contact;
      const have = c.city || c.region || c.country || c.postalCode;
      if (!have) return unknown;
      const hit =
        (cities.length > 0 && !!c.city && cities.includes(c.city.toLowerCase())) ||
        (regions.length > 0 && !!c.region && regions.includes(c.region.toLowerCase())) ||
        (countries.length > 0 && !!c.country && countries.includes(c.country.toLowerCase())) ||
        (prefixes.length > 0 && !!c.postalCode && prefixes.some((x) => c.postalCode!.toLowerCase().startsWith(x)));
      return hit ? known(1, "They are inside your service area.", "is in your service area", [{ kind: "contact" }]) : known(0, "They are outside your service area.", "is outside your service area", [{ kind: "contact" }]);
    },
  },
  {
    key: "source_quality", label: "Where they came from", dimension: "fit", kind: "positive", weight: 6, defaultEnabled: false, source: "rule", hint: "Record the lead source.",
    evaluate: (f, p) => {
      const high = list(p.high), low = list(p.low);
      const src = f.contact.source.trim().toLowerCase();
      if (!src || (!high.length && !low.length)) return unknown;
      if (high.includes(src)) return known(1, `Source "${f.contact.source}" is one of your best.`, "came from a strong source", [{ kind: "contact" }]);
      if (low.includes(src)) return known(0.2, `Source "${f.contact.source}" is one of your weakest.`, "came from a weak source", [{ kind: "contact" }]);
      return unknown;
    },
  },
  {
    key: "tag_signal", label: "Your own tags", dimension: "fit", kind: "positive", weight: 8, defaultEnabled: false, source: "rule", hint: "Tag leads the way you qualify them.",
    evaluate: (f, p) => {
      const positive = list(p.positive), negative = list(p.negative);
      if (!positive.length && !negative.length) return unknown;
      const tags = new Set(f.tags);
      const neg = negative.filter((t) => tags.has(t));
      if (neg.length) return known(0, `Tagged "${neg[0]}".`, `is tagged ${neg[0]}`, [{ kind: "tag" }]);
      const pos = positive.filter((t) => tags.has(t));
      if (pos.length) return known(1, `Tagged "${pos[0]}".`, `is tagged ${pos[0]}`, [{ kind: "tag" }]);
      return unknown;
    },
  },
  {
    key: "deal_value", label: "Deal size", dimension: "fit", kind: "positive", weight: 8, defaultEnabled: false, source: "rule", hint: "Put a value on the deal.",
    evaluate: (f, p) => {
      const min = typeof p.minValue === "number" ? p.minValue : null;
      const target = typeof p.targetValue === "number" ? p.targetValue : null;
      const v = f.opportunities.maxOpenValue;
      if (v === null || (min === null && target === null)) return unknown;
      const ev: EvidenceRef[] = f.opportunities.openId ? [{ kind: "opportunity", id: f.opportunities.openId }] : [];
      if (target !== null && v >= target) return known(1, "The deal is at or above your target size.", "has a deal at your target size", ev);
      if (min !== null && v >= min) return known(0.6, "The deal meets your minimum size.", "has a deal above your minimum", ev);
      return known(0.2, "The deal is below your minimum size.", "has a small deal", ev);
    },
  },
];

export const BUILTIN_CRITERIA: readonly CriterionDef[] = BUILTIN;
export const BUILTIN_KEYS = new Set(BUILTIN.map((c) => c.key));
export const criterionByKey = (key: string): CriterionDef | undefined => BUILTIN.find((c) => c.key === key);

// ---------------------------------------------------------------------------
// Custom-field criteria
// ---------------------------------------------------------------------------

export const FIELD_PREFIX = "field:";
export const fieldKeyOf = (criterionKey: string) => (criterionKey.startsWith(FIELD_PREFIX) ? criterionKey.slice(FIELD_PREFIX.length) : null);

/**
 * Fields that must never feed a score: anything about who a person is rather than what they did or asked for. Matched against the field's key
 * and label. Saving a criterion on such a field is refused, and the engine skips one that is already stored.
 */
const PROTECTED = /(^|[^a-z])(age|birth|birthday|dob|gender|sex|race|racial|ethnic|ethnicity|religio\w*|nationalit\w*|national[_ -]?origin|citizenship|immigration|disabilit\w*|handicap\w*|medical|health|pregnan\w*|marital|married|family[_ -]?status|sexual\w*|orientation|political\w*|union|genetic\w*|veteran|ssn|social[_ -]?security)([^a-z]|$)/i;
export const isProtectedField = (key: string, label?: string | null) => PROTECTED.test(key) || PROTECTED.test(label ?? "");

export const FIELD_OPS = ["present", "eq", "in", "gte", "lte"] as const;
export type FieldOp = (typeof FIELD_OPS)[number];

const fieldDef = (key: string, dimension: Dimension, weight: number, label?: string): CriterionDef => ({
  key: `${FIELD_PREFIX}${key}`, label: label ?? key, dimension, kind: "positive", weight, defaultEnabled: false, source: "rule", hint: `Fill in "${label ?? key}".`,
  evaluate: (f, p) => {
    const raw = f.fields[key];
    const empty = raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0);
    if (empty) return unknown;
    const op = (typeof p.op === "string" && (FIELD_OPS as readonly string[]).includes(p.op) ? p.op : "present") as FieldOp;
    const name = label ?? key;
    const ev: EvidenceRef[] = [{ kind: "field" }];
    switch (op) {
      case "present":
        return known(1, `"${name}" is filled in.`, `has "${name}" on file`, ev);
      case "eq": {
        const want = p.value;
        const ok = Array.isArray(raw) ? raw.map(String).includes(String(want)) : String(raw).toLowerCase() === String(want).toLowerCase();
        return ok ? known(1, `"${name}" is ${String(want)}.`, `${name} is ${String(want)}`, ev) : known(0, `"${name}" is not ${String(want)}.`, `${name} is not ${String(want)}`, ev);
      }
      case "in": {
        const values = list(p.values);
        const have = (Array.isArray(raw) ? raw : [raw]).map((x) => String(x).toLowerCase());
        const ok = values.length > 0 && have.some((x) => values.includes(x));
        return ok ? known(1, `"${name}" is one of your preferred values.`, `${name} matches`, ev) : known(0, `"${name}" is not one of your preferred values.`, `${name} does not match`, ev);
      }
      case "gte":
      case "lte": {
        const n = typeof raw === "number" ? raw : Number(raw);
        const limit = typeof p.value === "number" ? p.value : Number(p.value);
        if (!Number.isFinite(n) || !Number.isFinite(limit)) return unknown;
        const ok = op === "gte" ? n >= limit : n <= limit;
        return ok ? known(1, `"${name}" is ${op === "gte" ? "at least" : "at most"} ${limit}.`, `${name} meets your threshold`, ev) : known(0, `"${name}" is ${op === "gte" ? "below" : "above"} ${limit}.`, `${name} misses your threshold`, ev);
      }
    }
  },
});

// ---------------------------------------------------------------------------
// Presets: starting points for common kinds of business. Each is a set of criterion overrides; the workspace edits them.
// ---------------------------------------------------------------------------

export interface CriterionOverride {
  enabled?: boolean;
  weight?: number;
  params?: Record<string, unknown>;
  /** For field criteria: where it sits and what to call it. */
  dimension?: Dimension;
  label?: string;
}

export const PRESET_KEYS = ["general", "real_estate", "home_services", "agency_b2b", "custom"] as const;
export type PresetKey = (typeof PRESET_KEYS)[number];
export const PRESET_TEXT: Record<PresetKey, { label: string; help: string }> = {
  general: { label: "General", help: "Scores on what the lead did: how they came in, how recently and how much they have been in touch, bookings, deals and what they asked for." },
  real_estate: { label: "Real estate", help: "Adds budget, pre-approval and property fields if you have them, plus your service area." },
  home_services: { label: "Home services", help: "Adds service type, emergencies and whether they own the property, plus your service area." },
  agency_b2b: { label: "Agency / B2B", help: "Adds company size, budget and decision-maker fields if you have them, plus deal size." },
  custom: { label: "Custom", help: "Your own criteria only." },
};

const FIELD_PRESETS: Record<Exclude<PresetKey, "general" | "custom">, Record<string, CriterionOverride>> = {
  real_estate: {
    service_area: { enabled: true, weight: 10 },
    "field:budget": { enabled: true, weight: 6, dimension: "fit", label: "Budget", params: { op: "present" } },
    "field:pre_approved": { enabled: true, weight: 8, dimension: "intent", label: "Pre-approved", params: { op: "eq", value: "true" } },
    "field:property_type": { enabled: true, weight: 3, dimension: "fit", label: "Property type", params: { op: "present" } },
  },
  home_services: {
    service_area: { enabled: true, weight: 12 },
    "field:service_type": { enabled: true, weight: 4, dimension: "fit", label: "Service type", params: { op: "present" } },
    "field:emergency": { enabled: true, weight: 8, dimension: "urgency", label: "Emergency", params: { op: "eq", value: "true" } },
    "field:property_owner": { enabled: true, weight: 6, dimension: "fit", label: "Property owner", params: { op: "eq", value: "true" } },
  },
  agency_b2b: {
    deal_value: { enabled: true, weight: 8 },
    "field:company_size": { enabled: true, weight: 4, dimension: "fit", label: "Company size", params: { op: "present" } },
    "field:budget": { enabled: true, weight: 6, dimension: "fit", label: "Budget", params: { op: "present" } },
    "field:decision_maker": { enabled: true, weight: 6, dimension: "fit", label: "Decision maker", params: { op: "eq", value: "true" } },
  },
};

export const presetOverrides = (preset: PresetKey): Record<string, CriterionOverride> => (preset === "general" || preset === "custom" ? {} : FIELD_PRESETS[preset]);

// ---------------------------------------------------------------------------
// The effective criteria of a profile
// ---------------------------------------------------------------------------

const MAX_FIT_WEIGHT_TOTAL = 40;
const overrideSchema = z.strictObject({
  enabled: z.boolean().optional(),
  weight: z.number().min(0).max(25).optional(),
  params: z.record(z.string().max(40), z.union([z.string().max(120), z.number(), z.boolean(), z.array(z.string().max(120)).max(50)])).optional(),
  dimension: z.enum(["fit", "intent", "engagement", "urgency"]).optional(),
  label: z.string().trim().min(1).max(60).optional(),
});
export const criteriaConfigSchema = z.record(z.string().regex(/^(field:[a-z][a-z0-9_]{0,39}|[a-z][a-z0-9_]{1,39})$/), overrideSchema).superRefine((value, ctx) => {
  const keys = Object.keys(value);
  if (keys.length > 40) ctx.addIssue({ code: "custom", message: "At most 40 criteria." });
  for (const key of keys) {
    if (!key.startsWith(FIELD_PREFIX) && !BUILTIN_KEYS.has(key)) ctx.addIssue({ code: "custom", message: `"${key}" is not a scoring criterion.`, path: [key] });
    const fk = fieldKeyOf(key);
    if (fk && isProtectedField(fk, value[key].label)) ctx.addIssue({ code: "custom", message: `A field about "${fk}" can't be used to score a lead.`, path: [key] });
  }
});

export interface EffectiveCriterion {
  def: CriterionDef;
  enabled: boolean;
  weight: number;
  params: Record<string, unknown>;
}

/** The criteria that apply to a profile: built-ins with the preset's and the workspace's overrides, plus field criteria. Protected fields are dropped. */
export function effectiveCriteria(preset: PresetKey, config: Record<string, CriterionOverride>): EffectiveCriterion[] {
  const merged: Record<string, CriterionOverride> = { ...presetOverrides(preset) };
  for (const [k, v] of Object.entries(config)) merged[k] = { ...merged[k], ...v, params: { ...merged[k]?.params, ...v.params } };
  const out: EffectiveCriterion[] = [];
  for (const def of BUILTIN) {
    const o = merged[def.key] ?? {};
    const base = preset === "custom" && !(def.key in merged) && def.dimension !== "completeness" ? false : def.defaultEnabled;
    out.push({ def, enabled: o.enabled ?? base, weight: o.weight ?? def.weight, params: o.params ?? {} });
  }
  for (const [key, o] of Object.entries(merged)) {
    const fk = fieldKeyOf(key);
    if (!fk || isProtectedField(fk, o.label)) continue;
    out.push({ def: fieldDef(fk, o.dimension ?? "fit", o.weight ?? 6, o.label), enabled: o.enabled ?? true, weight: o.weight ?? 6, params: o.params ?? {} });
  }
  return out;
}

/** Problems with a configuration as a whole (the server shows them and refuses the save). */
export function configProblems(preset: PresetKey, config: Record<string, CriterionOverride>): string[] {
  const problems: string[] = [];
  const parsed = criteriaConfigSchema.safeParse(config);
  if (!parsed.success) return parsed.error.issues.map((i) => i.message);
  const fitTotal = effectiveCriteria(preset, config).filter((c) => c.enabled && c.def.dimension === "fit" && c.def.kind === "positive").reduce((s, c) => s + c.weight, 0);
  if (fitTotal > MAX_FIT_WEIGHT_TOTAL) problems.push(`Fit criteria add up to ${fitTotal} points; keep them to ${MAX_FIT_WEIGHT_TOTAL} or less so fit cannot outweigh what the lead actually did.`);
  return problems;
}
