import { requireAgency } from "@/server/tenancy/context";
import { AqiInsightsDashboard } from "@/components/admin/aqi-insights";

export const metadata = { title: "AQi Insights" };
export const dynamic = "force-dynamic";

export default async function AqiInsightsPage() {
  // The API enforces the same rule; this keeps an unauthorized page from rendering at all.
  await requireAgency("super_admin");
  return <AqiInsightsDashboard />;
}
