import { Gauge } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { withUser } from "@/server/db";
import { usageSummary } from "@/server/usage";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, ProgressBar } from "@/components/ui/primitives";
import { formatNumber } from "@/lib/utils";
import { getClientFairUse } from "@/server/fairuse/service";
import { FairUseCard } from "@/components/fairuse/fair-use-card";

export const metadata = { title: "Usage" };

function Meter({ label, used, limit, warnAt, hint }: { label: string; used: number; limit: number | null; warnAt: number; hint: string }) {
  const pct = limit ? (used / limit) * 100 : 0;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <p className="text-[14px] font-medium">{label}</p>
        <p className="text-[13px] tabular-nums text-ink-2">
          {formatNumber(used)} {limit !== null ? `/ ${formatNumber(limit)}` : "· no cap"}
        </p>
      </div>
      {limit !== null && <ProgressBar value={pct} tone={pct >= 100 ? "danger" : pct >= warnAt ? "warning" : "primary"} label={label} />}
      <p className="mt-1 text-[12px] text-muted">{hint}</p>
    </div>
  );
}

export default async function UsagePage() {
  const ctx = await requireOrgContext("usage.view");
  const [s, fairUse] = await Promise.all([withUser(ctx.user.id, (db) => usageSummary(db, ctx.org.orgId)), getClientFairUse(ctx)]);
  const l = s.limits;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-2">
              <Gauge className="size-4" /> This month&apos;s usage
            </CardTitle>
            <CardDescription>Counted from your workspace activity. You&apos;ll be notified at {l.warn_at_percent}% of a limit.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <Meter label="AI employee messages" used={s.agentMessages} limit={l.monthly_agent_messages} warnAt={l.warn_at_percent} hint="Every message you send to an AI employee." />
          <Meter label="AI tokens" used={s.tokens} limit={l.monthly_tokens} warnAt={l.warn_at_percent} hint="Reported by the AI service for completed responses." />
          <Meter label="Lead research today" used={s.leadResearchToday} limit={l.daily_lead_research} warnAt={l.warn_at_percent} hint="Research requests run by your Lead Hunter today." />
          <Meter label="iAcquire Assistant AI answers" used={s.helpRequests} limit={l.monthly_help_requests} warnAt={l.warn_at_percent} hint="Only AI-written help answers count; help-center answers are free." />
          <p className="rounded-xl bg-surface-2 p-3 text-[12.5px] text-muted">
            {l.hard_stop ? "When a limit is reached, new requests of that type pause until the next period." : "Limits are advisory for your workspace; iAcquire monitors usage."} {l.fair_use_note ?? ""} Failed AI runs this month: {s.failedRuns}.
          </p>
        </CardContent>
      </Card>
      <FairUseCard rows={fairUse} />
    </div>
  );
}
