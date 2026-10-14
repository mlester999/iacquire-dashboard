import { requireOrgContext } from "@/server/tenancy/context";
import { getRetention } from "@/server/queries/business";
import { RetentionView } from "@/components/retention/retention-view";
import { HeartHandshake } from "lucide-react";
import { PageHero } from "@/components/ui/workspace";

export const metadata = { title: "Customer Retention" };

export default async function RetentionPage() {
  const ctx = await requireOrgContext("retention.view");
  const data = await getRetention(ctx);
  return (
    <div className="space-y-6">
      <PageHero eyebrow="Customer relationships" title="Keep the customers you've worked hard to earn." description="Track the full relationship: onboarding, feedback, open issues, renewals and opportunities to help again. Automation is connected by iAcquire when you're ready." icon={<HeartHandshake className="size-4"/>} tone="neutral"/>
      <RetentionView data={JSON.parse(JSON.stringify(data))} canEdit={ctx.can("retention.edit")} canTask={ctx.can("tasks.manage")} timeZone={ctx.org.timezone} />
    </div>
  );
}
