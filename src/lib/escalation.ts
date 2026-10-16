import type { OrgRole } from "@/lib/permissions";

/** Situations where an AI employee must hand a conversation to a person. */
export const ESCALATION_CATEGORIES = [
  "ready_to_close",
  "human_requested",
  "phone_consultation",
  "complaint",
  "refund_concern",
  "sensitive_negotiation",
  "frustrated_customer",
  "unanswered_question",
  "unsafe_or_uncertain",
] as const;
export type EscalationCategory = (typeof ESCALATION_CATEGORIES)[number];
export const isEscalationCategory = (value: unknown): value is EscalationCategory =>
  typeof value === "string" && (ESCALATION_CATEGORIES as readonly string[]).includes(value);

export type EscalationUrgency = "urgent" | "normal";

export const ESCALATION_LABELS: Record<EscalationCategory, string> = {
  ready_to_close: "Ready to close",
  human_requested: "Customer asked for a person",
  phone_consultation: "Wants a phone consultation",
  complaint: "Complaint",
  refund_concern: "Refund concern",
  sensitive_negotiation: "Sensitive negotiation",
  frustrated_customer: "Frustrated customer",
  unanswered_question: "Question the AI could not answer",
  unsafe_or_uncertain: "Unsafe or uncertain request",
};

/** Starting urgency; a person or the AI can raise it, never lower a complaint or refund below urgent. */
export const DEFAULT_URGENCY: Record<EscalationCategory, EscalationUrgency> = {
  ready_to_close: "urgent",
  human_requested: "normal",
  phone_consultation: "normal",
  complaint: "urgent",
  refund_concern: "urgent",
  sensitive_negotiation: "normal",
  frustrated_customer: "urgent",
  unanswered_question: "normal",
  unsafe_or_uncertain: "urgent",
};

/** Staff only receive customer information for categories they are authorized for. */
export const ROLE_DEFAULT_CATEGORIES: Record<OrgRole, readonly EscalationCategory[]> = {
  owner: ESCALATION_CATEGORIES,
  admin: ESCALATION_CATEGORIES,
  member: ["human_requested", "unanswered_question"],
  sales_rep: ["ready_to_close", "human_requested", "phone_consultation", "sensitive_negotiation"],
  support: ["human_requested", "complaint", "refund_concern", "frustrated_customer", "unanswered_question"],
  viewer: [],
  appointment_setter: ["human_requested", "phone_consultation", "unanswered_question"],
};

export const OWNER_PRIORITY_MODES = ["first_priority", "notify_only", "urgent_only"] as const;
export type OwnerPriorityMode = (typeof OWNER_PRIORITY_MODES)[number];
export const OWNER_PRIORITY_LABELS: Record<OwnerPriorityMode, { label: string; description: string }> = {
  first_priority: { label: "First priority", description: "You get each escalation first. If you decline, are away or busy, or do not respond in time, eligible staff are asked." },
  notify_only: { label: "Notify me only", description: "You are told about every escalation and handle them yourself. Staff are not asked to step in." },
  urgent_only: { label: "Urgent matters only", description: "You get first priority on urgent escalations. Routine ones go straight to eligible staff." },
};

export const AVAILABILITY = ["available", "busy", "away"] as const;
export type Availability = (typeof AVAILABILITY)[number];
export const RESPONSIBILITIES = ["sales", "support", "scheduling", "billing", "general"] as const;
export type Responsibility = (typeof RESPONSIBILITIES)[number];
