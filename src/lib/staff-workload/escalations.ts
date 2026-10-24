// One list of everything that has been escalated or has run past its time, from the places that already track it, with how long it has lasted. Pure: the services read the
// rows, this orders and words them.

export const ESCALATION_KINDS = ["support_escalated", "support_overdue", "incident", "workload"] as const;
export type EscalationKind = (typeof ESCALATION_KINDS)[number];

export const ESCALATION_KIND_TEXT: Record<EscalationKind, string> = {
  support_escalated: "Escalated support request",
  support_overdue: "Support response overdue",
  incident: "Critical incident nobody has acknowledged",
  workload: "Person Overloaded or Critical",
};

export interface EscalationEntry {
  kind: EscalationKind;
  id: string;
  /** The client workspace the entry is about, when it is about one. Withheld (null) from a viewer who cannot open it. */
  orgId: string | null;
  orgName: string | null;
  title: string;
  /** When it began: the escalation, the response target, the incident, or the stretch of overload. */
  since: string;
  /** A critical one is listed before any other, whatever its age. */
  critical: boolean;
  assigneeId: string | null;
  /** The reason a person gave, for an escalated support request. */
  note: string | null;
  link: string;
}

/** Critical first, then the longest-running first, then by kind and id so the order never changes between two reads. */
export function sortEscalations(entries: readonly EscalationEntry[]): EscalationEntry[] {
  return [...entries].sort((a, b) =>
    Number(b.critical) - Number(a.critical)
    || Date.parse(a.since) - Date.parse(b.since)
    || ESCALATION_KINDS.indexOf(a.kind) - ESCALATION_KINDS.indexOf(b.kind)
    || a.id.localeCompare(b.id),
  );
}
