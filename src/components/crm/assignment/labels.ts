// Words for lead assignment, shared by the rules list, the editor and the history. No I/O.
import type { AssignmentEntity, AssignmentOutcome, AssignmentStrategy } from "@/server/crm/assignment";

export const ENTITY_LABEL: Record<AssignmentEntity, { one: string; many: string }> = {
  contact: { one: "contact", many: "contacts" },
  opportunity: { one: "deal", many: "deals" },
};

export const STRATEGY_INFO: Record<AssignmentStrategy, { label: string; description: string }> = {
  round_robin: { label: "Round robin", description: "Takes turns: the available person who was assigned least recently gets the next one." },
  weighted: { label: "Weighted", description: "Takes turns in proportion to each person's weight. A weight of 2 gets about twice as many as a weight of 1." },
  priority: { label: "Priority", description: "The available person with the highest priority gets it. People with the same priority take turns." },
  keep_existing_owner: { label: "Keep existing owner", description: "Keeps the current owner. A deal without one goes to its contact's owner; a contact without one goes to its company's owner." },
};

export const OUTCOME_INFO: Record<AssignmentOutcome, { label: string; tone: "success" | "primary" | "warning" | "neutral" }> = {
  assigned: { label: "Assigned", tone: "success" },
  fallback: { label: "Fallback", tone: "primary" },
  kept_owner: { label: "Owner kept", tone: "neutral" },
  unassigned: { label: "Left unassigned", tone: "warning" },
};
