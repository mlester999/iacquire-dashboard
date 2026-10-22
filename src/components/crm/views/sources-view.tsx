import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { attributionReport, type AttributionModel } from "@/server/attribution/report";
import { listCosts, sourcesSeen } from "@/server/attribution/costs";
import { SourcesReport } from "@/components/crm/attribution/sources-report";

const RANGES = [7, 30, 90, 365] as const;

/** The report window ends a minute from now, so a lead created while the page loads is counted. */
const windowEnd = () => new Date(Date.now() + 60_000);

/**
 * Reports → Lead sources & ROI. Where leads came from and what became of them, counted from records that exist. Money appears only where its inputs do:
 * deal value is shown as deal value (never as revenue), and cost per lead and return on spend need costs somebody entered and verified payments.
 */
export async function SourcesView({ actor, scope, searchParams }: { actor: CrmActor; scope: CrmScope; searchParams: Record<string, string | string[] | undefined> }) {
  const one = (k: string) => (Array.isArray(searchParams[k]) ? (searchParams[k] as string[])[0] : (searchParams[k] as string | undefined));
  const days = RANGES.find((r) => String(r) === one("range")) ?? 30;
  const model: AttributionModel = one("model") === "latest" ? "latest" : "first";
  const endsAt = windowEnd();
  const startsAt = new Date(endsAt.getTime() - days * 86_400_000);
  const [report, costs, sources] = await Promise.all([attributionReport(actor, { startsAt, endsAt, model }), listCosts(actor).catch(() => []), sourcesSeen(actor).catch(() => [])]);
  await auditSupportView(actor, "sources-report");
  return (
    <SourcesReport
      scope={scope}
      days={days}
      model={model}
      report={JSON.parse(JSON.stringify(report))}
      costs={JSON.parse(JSON.stringify(costs))}
      sources={sources}
      canEnterCosts={actor.can("analytics.export") && !scope.readOnly}
    />
  );
}
