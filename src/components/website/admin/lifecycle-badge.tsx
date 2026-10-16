import { StatusPill, type StatusTone } from "@/components/ui/status";
import { LIFECYCLE_LABEL, type Lifecycle } from "@/lib/website/lifecycle";

const TONE: Record<Lifecycle, StatusTone> = {
  draft: "neutral", ready_for_review: "violet", changes_requested: "warning", approved: "primary", published: "success", publication_failed: "danger", archived: "neutral",
};

/** Where a website is on its way to going live, as a tinted pill with a state dot. */
export function LifecycleBadge({ state, size }: { state: Lifecycle; size?: "sm" | "md" }) {
  return <StatusPill tone={TONE[state]} size={size}>{LIFECYCLE_LABEL[state]}</StatusPill>;
}
