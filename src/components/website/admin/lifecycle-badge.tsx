import { Badge } from "@/components/ui/primitives";
import { LIFECYCLE_LABEL, type Lifecycle } from "@/lib/website/lifecycle";

const TONE: Record<Lifecycle, "neutral" | "primary" | "success" | "warning" | "danger" | "violet" | "outline"> = {
  draft: "neutral", ready_for_review: "warning", changes_requested: "warning", approved: "primary", published: "success", publication_failed: "danger", archived: "outline",
};

export function LifecycleBadge({ state }: { state: Lifecycle }) {
  return <Badge tone={TONE[state]}>{LIFECYCLE_LABEL[state]}</Badge>;
}
