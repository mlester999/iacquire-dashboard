// Lead scoring vocabulary: what the engine reads (LeadFacts), what it produces (ScoreResult), and the labels the screens show.
// Pure types and small helpers; nothing here touches a database or a clock.

export const LEAD_LABELS = ["hot", "warm", "cold", "insufficient_data"] as const;
export type LeadLabel = (typeof LEAD_LABELS)[number];
export const isLeadLabel = (v: unknown): v is LeadLabel => typeof v === "string" && (LEAD_LABELS as readonly string[]).includes(v);

export const LEAD_LABEL_TEXT: Record<LeadLabel, string> = { hot: "Hot", warm: "Warm", cold: "Cold", insufficient_data: "Insufficient data" };
export const LEAD_LABEL_HELP: Record<LeadLabel, string> = {
  hot: "Strong signs of interest and timing. Worth a prompt personal follow-up.",
  warm: "Some real interest. Follow up soon.",
  cold: "What we know points to low interest or poor fit right now.",
  insufficient_data: "Not enough is known yet to score this lead. This is not the same as cold.",
};

export const DIMENSIONS = ["fit", "intent", "engagement", "urgency", "completeness"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export const DIMENSION_TEXT: Record<Dimension, string> = { fit: "Fit", intent: "Intent", engagement: "Engagement", urgency: "Urgency", completeness: "Completeness" };
export const DIMENSION_HELP: Record<Dimension, string> = {
  fit: "How well the lead matches the customers you want, by the criteria you set.",
  intent: "How clearly they have asked for, or moved toward, your service.",
  engagement: "How recently and how much they have been in touch.",
  urgency: "How soon they want to act.",
  completeness: "How much of their basic information you have.",
};

export interface EvidenceRef {
  /** What kind of record the evidence is. Ids and times only: the text of a message is never copied into an assessment. */
  kind: "message" | "call" | "appointment" | "opportunity" | "field" | "tag" | "contact" | "consent";
  id?: string;
  at?: string;
}

export interface Factor {
  key: string;
  label: string;
  dimension: Dimension;
  /** Points earned; negative for a penalty. */
  points: number;
  /** The most this factor could have earned (its weight), 0 for a penalty. */
  maxPoints: number;
  direction: "positive" | "negative" | "neutral";
  /** One sentence for the explanation panel. */
  detail: string;
  /** A short clause for the summary line ("booked an appointment"). */
  phrase: string;
  source: "rule" | "ai";
  evidence: EvidenceRef[];
}

export interface MissingItem {
  key: string;
  label: string;
  dimension: Dimension;
  /** What to do to find out. */
  hint: string;
}

export interface AiSignals {
  intent: "ready_to_buy" | "evaluating" | "just_browsing" | "support_request" | "unknown";
  timeline: "immediate" | "this_week" | "this_month" | "later" | "unknown";
  wants: Array<"quote" | "appointment" | "callback" | "information">;
  budgetMentioned: boolean | null;
  decisionMaker: "yes" | "no" | "unknown";
  /** Which of the customer's messages (by id) each signal came from. */
  evidence: Partial<Record<"intent" | "timeline" | "wants" | "budget" | "decisionMaker", string[]>>;
}

export type CustomFieldValue = string | number | boolean | string[] | null;

export interface LeadFacts {
  asOf: Date;
  contact: {
    createdAt: Date;
    createdVia: string;
    source: string;
    leadStatus: string;
    hasName: boolean;
    hasPhone: boolean;
    hasEmail: boolean;
    city: string | null;
    region: string | null;
    country: string | null;
    postalCode: string | null;
    preferredChannel: string | null;
  };
  /** Tag names, lower-cased. */
  tags: string[];
  /** Active custom fields only, keyed by the field's key. */
  fields: Record<string, CustomFieldValue>;
  /** At least one channel the business is allowed to use for this contact (not opted out, not suppressed, an address on file). */
  reachable: boolean;
  conversations: {
    inboundCount: number;
    outboundCount: number;
    lastInboundAt: Date | null;
    /** The customer answered one of our messages within a day. */
    repliedWithin24h: boolean;
    /** Messages we sent since the customer last wrote. */
    unansweredOutbound: number;
    lastInboundId: string | null;
  };
  calls: { inboundCount: number; missedInboundCount: number; lastInboundAt: Date | null; lastInboundId: string | null };
  appointments: { upcoming: number; nextAt: Date | null; nextId: string | null; showed: number; noShow: number; cancelled: number; booked: number };
  opportunities: { open: number; won: number; lost: number; maxOpenValue: number | null; stageProgress: number | null; openId: string | null };
  /** Signals a model extracted from the customer's own messages; null when extraction is off, unavailable or not worth running. */
  ai: AiSignals | null;
}

export interface DimensionTotal {
  earned: number;
  max: number;
  known: number;
  unknown: number;
}

export interface ScoreResult {
  /** 0..100, or null when there is not enough to score. */
  score: number | null;
  label: LeadLabel;
  ruleScoreSource: "rules";
  rulePoints: number;
  aiPoints: number;
  factors: Factor[];
  missing: MissingItem[];
  dimensions: Record<Dimension, DimensionTotal>;
  knownSignals: number;
  summary: string;
  nextAction: { kind: NextActionKind; label: string };
  /** Whether a status the team set (unqualified or inactive) capped the score. */
  capped: boolean;
  /** Canonical string of what decided the result; the server hashes it so unchanged inputs create no new assessment. */
  fingerprint: string;
}

export const NEXT_ACTION_KINDS = ["return_missed_call", "call_now", "follow_up_soon", "nurture", "collect_details", "confirm_appointment", "review_manually"] as const;
export type NextActionKind = (typeof NEXT_ACTION_KINDS)[number];

export const ENGINE_VERSION = "rules-1";

/** Never an AI-chosen number: the model supplies enumerated signals, and these rules turn them into points. */
export const UNKNOWN_DISCOUNT = 0.5;
