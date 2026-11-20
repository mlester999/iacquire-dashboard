import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import type { GrowthPartnerControlState } from "@/server/ai-growth-partner/service";
import { cn } from "@/lib/utils";

type PartnerOverviewState = Pick<GrowthPartnerControlState, "status" | "currentVersion"> | null;

function statusSummary(state: PartnerOverviewState): string {
  if (state?.status === "configured") return "Business Brain ready";
  if (state?.status === "paused") return "AI Growth Partner is paused";
  if (state?.status === "provisioning") return "AI Growth Partner is being set up";
  if (state?.status === "migration_required") return "AI Growth Partner needs setup review";
  return "AI Growth Partner is ready to be set up";
}

export function PartnerOverviewCard({
  state,
  hasEnabledLegacyProfile,
  canConfigure,
}: {
  state: PartnerOverviewState;
  hasEnabledLegacyProfile: boolean;
  canConfigure: boolean;
}) {
  return (
    <div className="min-w-0 space-y-3">
      <Card data-aqi-target="overview.ai-team" className="border border-primary/20 bg-[linear-gradient(145deg,var(--surface),var(--primary-soft))]">
        <CardHeader>
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-ink">
              <Sparkles className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <CardTitle>AI Growth Partner</CardTitle>
              <CardDescription>Workspace readiness and Business Brain</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p role="status" className="rounded-xl bg-surface-2 px-3 py-2 text-[13px] text-ink-2">{statusSummary(state)}</p>
          {state?.currentVersion != null && <p className="text-[12px] text-muted">Active Business Brain v{state.currentVersion}</p>}
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="/growth-partner" variant="brand" size="sm">
              Open AI Growth Partner <ArrowRight className="size-3.5" aria-hidden />
            </ButtonLink>
            <ButtonLink href="/growth-partner/conversation" variant="secondary" size="sm">
              Permanent Conversation <ArrowRight className="size-3.5" aria-hidden />
            </ButtonLink>
          </div>
        </CardContent>
      </Card>

      {hasEnabledLegacyProfile && canConfigure && (
        <Link href="/employees" className={cn("flex min-h-12 items-center gap-2 rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[13px] font-medium text-ink-2 transition hover:border-line-strong hover:bg-surface-2 hover:text-ink")}>
          Previous role profiles <span className="ml-auto text-[12px] text-muted">Review</span><ArrowRight className="size-3.5" aria-hidden />
        </Link>
      )}
    </div>
  );
}
