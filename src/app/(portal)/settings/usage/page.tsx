import { Bot, Cpu, Gauge, Info, MessagesSquare, Search, Sparkles, TriangleAlert } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { withUser } from "@/server/db";
import { usageSummary } from "@/server/usage";
import { formatNumber } from "@/lib/utils";
import { getClientFairUse } from "@/server/fairuse/service";
import { FairUseCard } from "@/components/fairuse/fair-use-card";
import { InfoChip } from "@/components/ui/status";
import { Notice, Panel } from "@/components/settings/panel";
import { UsageMeter } from "@/components/settings/usage-meter";

export const metadata = { title: "Usage" };

function Meter({ icon, label, used, limit, warnAt, hint }: { icon: React.ReactNode; label: string; used: number; limit: number | null; warnAt: number; hint: string }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : null;
  const tone = limit === null ? "neutral" : pct !== null && pct >= 100 ? "danger" : pct !== null && pct >= warnAt ? "warning" : "success";
  const stateLabel = limit === null ? "No cap" : tone === "danger" ? "Limit reached" : tone === "warning" ? "Near limit" : "On track";
  return <UsageMeter icon={icon} label={label} value={formatNumber(used)} limit={limit !== null ? formatNumber(limit) : null} percent={pct} tone={tone} stateLabel={stateLabel} hint={hint} />;
}

export default async function UsagePage() {
  const ctx = await requireOrgContext("usage.view");
  const [s, fairUse] = await Promise.all([withUser(ctx.user.id, (db) => usageSummary(db, ctx.org.orgId)), getClientFairUse(ctx)]);
  const l = s.limits;
  return (
    <div className="space-y-6">
      <Panel
        icon={<Gauge />}
        title="This month's usage"
        description={`Counted from your workspace activity. You'll be notified at ${l.warn_at_percent}% of a limit.`}
        aside={
          s.failedRuns > 0 ? (
            <InfoChip icon={<TriangleAlert aria-hidden />}>
              {formatNumber(s.failedRuns)} failed AI {s.failedRuns === 1 ? "run" : "runs"} this month
            </InfoChip>
          ) : (
            <InfoChip>No failed AI runs this month</InfoChip>
          )
        }
        bodyClassName="space-y-4"
      >
        <div className="grid gap-3 md:grid-cols-2">
          <Meter icon={<Bot />} label="AI employee messages" used={s.agentMessages} limit={l.monthly_agent_messages} warnAt={l.warn_at_percent} hint="Every message you send to an AI employee." />
          <Meter icon={<MessagesSquare />} label="AI replies to your customers" used={s.customerReplies} limit={l.monthly_customer_replies} warnAt={l.warn_at_percent} hint="Replies your AI employees prepared for customers by text, WhatsApp, email and website chat. No cap is set unless iAcquire sets one." />
          <Meter icon={<Cpu />} label="AI tokens" used={s.tokens} limit={l.monthly_tokens} warnAt={l.warn_at_percent} hint="Reported by the AI service for completed responses." />
          <Meter icon={<Search />} label="Lead research today" used={s.leadResearchToday} limit={l.daily_lead_research} warnAt={l.warn_at_percent} hint="Research requests run by your Lead Hunter today." />
          <Meter icon={<Sparkles />} label="iAcquire Assistant AI answers" used={s.helpRequests} limit={l.monthly_help_requests} warnAt={l.warn_at_percent} hint="Only AI-written help answers count; help-center answers are free." />
        </div>
        <Notice tone="neutral" icon={<Info />}>
          {l.hard_stop ? "When a limit is reached, new requests of that type pause until the next period." : "Limits are advisory for your workspace; iAcquire monitors usage."} {l.fair_use_note ?? ""}
        </Notice>
      </Panel>
      <FairUseCard rows={fairUse} />
    </div>
  );
}
