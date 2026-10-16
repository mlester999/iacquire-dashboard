import { requireOrgContext } from "@/server/tenancy/context";
import { getRetention } from "@/server/queries/business";
import { getLifecycleOverview, listPrograms, recentActivity } from "@/server/retention/service";
import { RetentionView } from "@/components/retention/retention-view";
import { RetentionAutomation } from "@/components/retention/programs-panel";
import { HeartHandshake } from "lucide-react";
import { PageHero, SectionLabel } from "@/components/ui/workspace";
import { ButtonLink } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status";

export const metadata = { title: "Customer Retention" };

export default async function RetentionPage() {
  const ctx = await requireOrgContext("retention.view");
  const [data, programs, lifecycle, activity] = await Promise.all([getRetention(ctx), listPrograms(ctx), getLifecycleOverview(ctx), recentActivity(ctx)]);
  return (
    <div className="space-y-8">
      <PageHero eyebrow="Customer relationships" title="Keep the customers you've worked hard to earn." description="Keep customer health, feedback and renewals in view. Prepare thoughtful follow-ups with wording you approve and controls for consent, quiet hours and credits." icon={<HeartHandshake className="size-4"/>} tone="neutral" action={<><ButtonLink href="#retention-accounts" variant="secondary">Customer accounts <StatusPill tone="neutral" size="sm" dot={false}>{data.accounts.length}</StatusPill></ButtonLink><ButtonLink href="#retention-programs" variant="secondary">Automated programs <StatusPill tone={programs.some((program) => program.state === "on") ? "success" : "neutral"} size="sm">{programs.filter((program) => program.state === "on").length} on</StatusPill></ButtonLink></>}/>
      <section id="retention-accounts" aria-label="Customer accounts" className="scroll-mt-28 space-y-4">
        <SectionLabel title="Customer accounts" description="Health, onboarding, feedback and renewals you track by hand." />
        <RetentionView data={JSON.parse(JSON.stringify(data))} canEdit={ctx.can("retention.edit")} canTask={ctx.can("tasks.manage")} timeZone={ctx.org.timezone} />
      </section>
      <RetentionAutomation
        programs={JSON.parse(JSON.stringify(programs))}
        lifecycle={JSON.parse(JSON.stringify(lifecycle))}
        activity={JSON.parse(JSON.stringify(activity))}
        canEdit={ctx.can("retention.edit")}
        canActivate={ctx.can("retention.activate")}
        canEditContacts={ctx.can("contacts.edit")}
      />
    </div>
  );
}
