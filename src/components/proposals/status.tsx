import { Badge } from "@/components/ui/primitives";
import { SEEN_LABELS, type SeenLevel } from "@/lib/proposals/share";
import { STATUS_EXPLAIN, STATUS_LABELS, type ProposalStatus } from "@/lib/proposals/state";

type Tone = NonNullable<React.ComponentProps<typeof Badge>["tone"]>;

/** Colour is never the only signal: every status also has its words. */
export const STATUS_TONE: Record<ProposalStatus, Tone> = {
  draft: "neutral",
  pending_approval: "warning",
  changes_requested: "warning",
  rejected: "danger",
  approved: "primary",
  sent: "primary",
  accepted: "success",
  declined: "danger",
  expired: "warning",
  withdrawn: "outline",
};

/** The tooltip is the sentence the proposal page prints, so "Accepted" never reads as more than the record says. */
export function StatusBadge({ status, className }: { status: ProposalStatus; className?: string }) {
  return <Badge tone={STATUS_TONE[status]} className={className} title={STATUS_EXPLAIN[status]}>{STATUS_LABELS[status]}</Badge>;
}

export function AiBadge({ className }: { className?: string }) {
  return <Badge tone="violet" className={className} title="Written by the AI. A person has to read, edit and approve it before it can be sent.">AI-written draft</Badge>;
}

const SEEN_TONE: Record<SeenLevel, Tone> = { none: "outline", opened: "neutral", viewed: "neutral", verified: "primary" };

/** How far the customer's link has been seen, in the three honest levels. "Link opened" is never described as read. */
export function SeenBadge({ level, className }: { level: SeenLevel; className?: string }) {
  return <Badge tone={SEEN_TONE[level]} className={className} title={SEEN_LABELS[level].explain}>{SEEN_LABELS[level].label}</Badge>;
}
