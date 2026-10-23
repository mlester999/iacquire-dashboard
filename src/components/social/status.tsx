import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { PLATFORM_LABELS, type Platform } from "@/lib/social/rules";
import { STATUS_EXPLAIN, STATUS_LABELS, type PostStatus } from "@/lib/social/state";

type Tone = NonNullable<React.ComponentProps<typeof Badge>["tone"]>;

/** Colour is never the only signal: every status also has its words. */
export const STATUS_TONE: Record<PostStatus, Tone> = {
  draft: "neutral",
  pending_approval: "warning",
  changes_requested: "warning",
  approved: "primary",
  scheduled: "primary",
  publishing: "primary",
  needs_reconciliation: "warning",
  published: "success",
  failed: "danger",
  cancelled: "outline",
  rejected: "danger",
};

/** The left edge of a calendar chip: a second cue beside the words, with enough contrast against the chip. */
export const STATUS_EDGE: Record<PostStatus, string> = {
  draft: "border-l-ink-2",
  pending_approval: "border-l-warning-ink",
  changes_requested: "border-l-warning-ink",
  approved: "border-l-primary-ink",
  scheduled: "border-l-primary-ink",
  publishing: "border-l-primary-ink",
  needs_reconciliation: "border-l-warning-ink",
  published: "border-l-success-ink",
  failed: "border-l-danger-ink",
  cancelled: "border-l-line-strong",
  rejected: "border-l-danger-ink",
};

export function StatusBadge({ status, className }: { status: PostStatus; className?: string }) {
  return <Badge tone={STATUS_TONE[status]} className={className} title={STATUS_EXPLAIN[status]}>{STATUS_LABELS[status]}</Badge>;
}

export function PlatformMark({ platform, className }: { platform: Platform; className?: string }) {
  const facebook = platform === "facebook";
  return (
    <span className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold text-white", facebook ? "bg-[#1d4ed8]" : "bg-[#a21caf]", className)} aria-hidden>
      {facebook ? "f" : "IG"}
    </span>
  );
}

export const platformName = (p: Platform) => PLATFORM_LABELS[p];
