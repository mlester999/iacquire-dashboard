import { requireOrgContext } from "@/server/tenancy/context";
import { fillDays, getAnalytics, parseRange } from "@/server/queries/analytics";
import { AnalyticsView } from "@/components/analytics/analytics-view";

export const metadata = { title: "Analytics" };

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string }> }) {
  const params = await searchParams;
  const ctx = await requireOrgContext("analytics.view");
  const range = parseRange(params);
  const data = await getAnalytics(ctx, range);
  return (
    <AnalyticsView
      data={JSON.parse(JSON.stringify(data))}
      leadsByDay={fillDays(data.leads.byDay, range, ctx.org.timezone)}
      messagesByDay={fillDays(data.messagesByDay, range, ctx.org.timezone)}
      range={{ key: params.range ?? "30d", from: range.from.toISOString(), to: range.to.toISOString(), days: range.days }}
      timeZone={ctx.org.timezone}
      canExport={ctx.can("analytics.export")}
      canChat={ctx.can("agents.use")}
    />
  );
}
